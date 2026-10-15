#!/usr/bin/env node
/**
 * Deterministic, mock-free integration suite for the Kanban built-in guest
 * service (TICKET-HARNESS-14, task T6).
 *
 * It exercises the REAL shipped artifacts:
 *   - the build output produced by `bun run extensions:build`
 *     (packages/web/server/built-in-extensions/kanban/**), and
 *   - the real kanban.json files of the 6 fixed projects,
 *   - the real HTTP service spawned as a child process on 127.0.0.1.
 *
 * No module is stubbed, faked or monkey-patched. The write path (POST
 * /api/toggle) needs a writable project, and the service's project paths are
 * fixed by design (CONTRACT_KANBAN §3). To keep the run isolated, the suite
 * snapshots `projeto_jev/kanban.json` (the designated empty-template repo)
 * byte-for-byte, writes a controlled fixture, and restores the exact original
 * bytes in a finally/exit/signal guard. Nothing else on disk is mutated.
 *
 * Run:  node packages/extensions/kanban/tests/test_kanban_service.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_ROOT = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions');
const BUILT_PACKAGE = path.join(BUILT_ROOT, 'kanban');
const SERVICE_ENTRY = path.join(BUILT_PACKAGE, 'service', 'main.js');
const BUILT_REGISTRY = path.join(BUILT_ROOT, 'registry.json');

const EXTENSION_ID = 'openchamber-builtin-kanban';

// Canonical project list (CONTRACT_KANBAN §3). Ids are immutable route keys.
const PROJECTS = [
  { id: 'projeto_jev', title: 'Projeto JEV', path: '/home/maiteuxzanela/projeto JEV', writable: true },
  { id: 'jez_collections', title: 'JEZ Collections', path: '/mnt/94CCB337CCB3130A/JEZ collections' },
  { id: 'panela_sobra', title: 'Panela de Sobra', path: '/home/maiteuxzanela/PanelaBuild' },
  { id: 'faturamento_medico', title: 'Faturamento Médico', path: '/mnt/94CCB337CCB3130A/Faturamento' },
  { id: 'predictera', title: 'Predictera', path: '/mnt/94CCB337CCB3130A/predictera' },
  { id: 'opencode_chambers_harness', title: 'OpenCode Chambers Harness', path: '/mnt/94CCB337CCB3130A/opencode_chambers_harness' },
];

const ISO = z.iso.datetime({ offset: true });
const ticketSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(['open', 'done']),
  priority: z.enum(['alta', 'media', 'baixa']),
  summary: z.string(),
  body: z.string(),
  order: z.number().int().nonnegative(),
  created_at: ISO,
  completed_at: ISO.nullable(),
}).superRefine((ticket, ctx) => {
  if (ticket.status === 'open' && ticket.completed_at !== null) ctx.addIssue({ code: 'custom', message: 'open ticket must have completed_at === null' });
  if (ticket.status === 'done' && ticket.completed_at === null) ctx.addIssue({ code: 'custom', message: 'done ticket must carry completed_at' });
});
const kanbanSchema = z.object({
  meta: z.object({
    version: z.literal(1),
    project: z.enum(PROJECTS.map((project) => project.id)),
    title: z.string().min(1),
    updated_at: ISO,
  }),
  tickets: z.array(ticketSchema),
}).superRefine((doc, ctx) => {
  const seen = new Set();
  for (const ticket of doc.tickets) {
    if (seen.has(ticket.id)) ctx.addIssue({ code: 'custom', message: `duplicate ticket id: ${ticket.id}` });
    seen.add(ticket.id);
  }
});

// ---------------------------------------------------------------------------
// Tiny deterministic runner (no external test framework on purpose).
// ---------------------------------------------------------------------------
const state = { pass: 0, fail: 0, failures: [] };
const run = async (name, fn) => {
  try {
    await fn();
    state.pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    state.fail += 1;
    state.failures.push(name);
    console.error(`  FAIL ${name}`);
    console.error(String(error && error.stack ? error.stack : error).split('\n').map((line) => `       ${line}`).join('\n'));
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// HTTP helpers against the real loopback service.
// ---------------------------------------------------------------------------
const httpRequest = (port, token, method, requestPath, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? null : Buffer.from(body);
  const headers = {};
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = payload.length;
  }
  const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try { json = JSON.parse(raw); } catch { /* non-JSON body is allowed for error paths */ }
      resolve({ status: res.statusCode, json, raw });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const freePort = () => new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close(() => resolve(port));
  });
});

const waitHealthy = async (port, token, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const res = await httpRequest(port, token, 'GET', '/health');
      if (res.status === 200 && res.json && res.json.ok === true) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(100);
  }
  throw new Error(`kanban service never became healthy (${lastError})`);
};

const startService = async () => {
  const port = await freePort();
  const token = `kb-test-${randomUUID()}`;
  const child = spawn('node', [SERVICE_ENTRY], {
    env: { ...process.env, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(4000).then(() => { if (child.exitCode === null) child.kill('SIGKILL'); }),
    ]);
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(2000)]);
  };
  try {
    await waitHealthy(port, token);
  } catch (error) {
    await stop();
    throw new Error(`${error.message}\n--- service stderr ---\n${stderr}`);
  }
  return { port, token, stop, stderr: () => stderr };
};

// ---------------------------------------------------------------------------
// Fixture + restore guard for the single writable project.
// ---------------------------------------------------------------------------
const targetProject = PROJECTS.find((project) => project.writable);
const targetFile = path.join(targetProject.path, 'kanban.json');
let restore = null;
const performRestore = () => {
  const action = restore;
  restore = null;
  if (action) action();
};
process.on('exit', performRestore);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { performRestore(); process.exit(130); });
}
process.on('uncaughtException', (error) => { performRestore(); console.error(error); process.exit(1); });

const fixtureDoc = () => {
  const now = new Date().toISOString();
  return {
    meta: { version: 1, project: targetProject.id, title: targetProject.title, updated_at: now },
    tickets: [
      { id: 'KB-TEST-OPEN', title: 'Fixture aberto', status: 'open', priority: 'alta', summary: 'resumo aberto', body: '## aberto', order: 1, created_at: now, completed_at: null },
      { id: 'KB-TEST-DONE', title: 'Fixture concluído', status: 'done', priority: 'media', summary: 'resumo concluído', body: '## concluído', order: 2, created_at: now, completed_at: now },
    ],
  };
};

const readKanbanFile = async (file) => JSON.parse(await fsp.readFile(file, 'utf8'));
const tmpLeftovers = async (dir) => (await fsp.readdir(dir)).filter((name) => name.startsWith('.kanban.json.') && name.endsWith('.tmp'));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const main = async () => {
  console.log(`Kanban service suite | built=${path.relative(REPO_ROOT, BUILT_PACKAGE)}`);

  // (e) Build integrity of `bun run extensions:build` output.
  await run('build: required artifacts exist', async () => {
    for (const file of ['package.json', 'panel/index.html', 'panel/style.css', 'panel/main.js', 'service/main.js']) {
      assert.ok(fs.existsSync(path.join(BUILT_PACKAGE, file)), `missing built artifact: ${file}`);
    }
    assert.ok(fs.existsSync(BUILT_REGISTRY), 'missing built registry.json');
  });

  await run('build: registry.json declares the kanban built-in', async () => {
    const registry = JSON.parse(await fsp.readFile(BUILT_REGISTRY, 'utf8'));
    assert.equal(registry.version, 1);
    const entry = registry.extensions.find((item) => item.id === EXTENSION_ID);
    assert.ok(entry, 'registry entry missing');
    assert.equal(entry.directory, 'kanban');
  });

  await run('build: copied manifest matches contract and registry id', async () => {
    const manifest = JSON.parse(await fsp.readFile(path.join(BUILT_PACKAGE, 'package.json'), 'utf8'));
    const contributes = manifest.openchamber.contributes;
    assert.equal(manifest.openchamber.apiVersion, 1);
    assert.equal(contributes.panel.id, EXTENSION_ID, 'panel.id must equal the registry id (catalog.js id binding)');
    assert.equal(contributes.panel.entry, 'panel/index.html');
    assert.equal(contributes.page, true);
    assert.equal(contributes.service.entry, 'service/main.js');
    assert.equal(contributes.service.runtime, 'host');
    assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  });

  await run('build: panel entry references an existing built script', async () => {
    const html = await fsp.readFile(path.join(BUILT_PACKAGE, 'panel/index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(scripts.length > 0, 'panel HTML has no script src');
    for (const src of scripts) {
      const resolved = path.resolve(path.join(BUILT_PACKAGE, 'panel'), src);
      assert.ok(fs.existsSync(resolved), `panel script not built: ${src}`);
    }
  });

  await run('build: node --check passes on both generated bundles', async () => {
    for (const bundle of ['panel/main.js', 'service/main.js']) {
      const file = path.join(BUILT_PACKAGE, bundle);
      const result = await new Promise((resolve) => {
        const child = spawn('node', ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('exit', (code) => resolve({ code, stderr }));
      });
      assert.equal(result.code, 0, `node --check failed for ${bundle}: ${result.stderr}`);
    }
  });

  // (a) Canonical schema of the 6 real kanban.json files.
  for (const project of PROJECTS) {
    await run(`schema: ${project.id}/kanban.json conforms`, async () => {
      const file = path.join(project.path, 'kanban.json');
      const doc = await readKanbanFile(file);
      const parsed = kanbanSchema.safeParse(doc);
      assert.ok(parsed.success, `schema issues: ${JSON.stringify(parsed.error?.issues?.slice(0, 3))}`);
      assert.equal(parsed.data.meta.project, project.id, 'meta.project must match the directory id');
    });
  }

  // Prepare isolated write fixture before the service starts.
  const original = await fsp.readFile(targetFile, 'utf8');
  const backupFile = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-backup-')), 'kanban.json');
  await fsp.writeFile(backupFile, original);
  restore = () => {
    fs.writeFileSync(targetFile, original);
  };
  const fixture = fixtureDoc();
  await fsp.writeFile(targetFile, `${JSON.stringify(fixture, null, 2)}\n`);

  let service = null;
  try {
    service = await startService();
    const { port, token } = service;

    // (b) Auth + readiness.
    await run('http: /health requires the bearer token', async () => {
      const unauthorized = await httpRequest(port, null, 'GET', '/health');
      assert.equal(unauthorized.status, 401);
      const authorized = await httpRequest(port, token, 'GET', '/health');
      assert.equal(authorized.status, 200);
      assert.deepEqual(authorized.json, { ok: true });
    });

    // (b) GET /api/projects.
    await run('http: GET /api/projects lists the 6 projects with consistent counts', async () => {
      const res = await httpRequest(port, token, 'GET', '/api/projects');
      assert.equal(res.status, 200);
      assert.equal(res.json.projects.length, 6);
      assert.deepEqual(res.json.projects.map((p) => p.id), PROJECTS.map((p) => p.id));
      for (const entry of res.json.projects) {
        const project = PROJECTS.find((p) => p.id === entry.id);
        assert.equal(entry.title, project.title);
        assert.equal(entry.path, project.path);
        assert.equal(entry.totalTickets, entry.openTickets + entry.doneTickets, `count mismatch for ${entry.id}`);
        assert.ok(entry.totalTickets >= 0 && entry.openTickets >= 0 && entry.doneTickets >= 0);
      }
    });

    // (b) GET /api/kanban for every real project.
    for (const project of PROJECTS) {
      await run(`http: GET /api/kanban reads ${project.id}`, async () => {
        const res = await httpRequest(port, token, 'GET', `/api/kanban?project=${project.id}`);
        assert.equal(res.status, 200);
        assert.equal(res.json.project, project.id);
        assert.ok(Array.isArray(res.json.tickets));
        for (const ticket of res.json.tickets) {
          assert.ok(ticketSchema.safeParse(ticket).success, `invalid ticket ${ticket.id}`);
        }
      });
    }

    // (d) Route-level error contract.
    await run('http: GET /api/kanban rejects missing and unknown project', async () => {
      const missing = await httpRequest(port, token, 'GET', '/api/kanban');
      assert.equal(missing.status, 400);
      assert.equal(missing.json.error.code, 'missing-project');
      const unknown = await httpRequest(port, token, 'GET', '/api/kanban?project=does_not_exist');
      assert.equal(unknown.status, 404);
      assert.equal(unknown.json.error.code, 'unknown-project');
    });

    // (c) Toggle done:true -> persists status + completed_at, no data loss.
    await run('http: POST /api/toggle done:true marks done and persists atomically', async () => {
      const res = await httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({ project: targetProject.id, ticketId: 'KB-TEST-OPEN', done: true }));
      assert.equal(res.status, 200);
      assert.equal(res.json.ok, true);
      assert.equal(res.json.ticket.id, 'KB-TEST-OPEN');
      assert.equal(res.json.ticket.status, 'done');
      assert.ok(ISO.safeParse(res.json.ticket.completed_at).success);
      assert.ok(ISO.safeParse(res.json.updated_at).success);

      const doc = await readKanbanFile(targetFile);
      assert.ok(kanbanSchema.safeParse(doc).success);
      const open = doc.tickets.find((t) => t.id === 'KB-TEST-OPEN');
      assert.equal(open.status, 'done');
      assert.equal(open.completed_at, res.json.ticket.completed_at);
      // remaining ticket untouched => no data loss
      const other = doc.tickets.find((t) => t.id === 'KB-TEST-DONE');
      assert.deepEqual(other, fixture.tickets[1]);
      assert.equal(doc.tickets.length, 2);
      assert.deepEqual(await tmpLeftovers(targetProject.path), []);
    });

    // (c) Toggle back to open clears completed_at.
    await run('http: POST /api/toggle done:false reopens and clears completed_at', async () => {
      const res = await httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({ project: targetProject.id, ticketId: 'KB-TEST-OPEN', done: false }));
      assert.equal(res.status, 200);
      assert.equal(res.json.ticket.status, 'open');
      assert.equal(res.json.ticket.completed_at, null);
      const doc = await readKanbanFile(targetFile);
      assert.ok(kanbanSchema.safeParse(doc).success);
      const open = doc.tickets.find((t) => t.id === 'KB-TEST-OPEN');
      assert.equal(open.status, 'open');
      assert.equal(open.completed_at, null);
      assert.equal(doc.tickets.length, 2);
      assert.deepEqual(await tmpLeftovers(targetProject.path), []);
    });

    // (c) Concurrent toggles must not corrupt the file or lose tickets.
    await run('http: concurrent toggles keep the file valid with no data loss', async () => {
      const jobs = [];
      for (let index = 0; index < 9; index += 1) {
        const ticketId = index % 2 === 0 ? 'KB-TEST-OPEN' : 'KB-TEST-DONE';
        jobs.push(httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({ project: targetProject.id, ticketId, done: index % 3 === 0 })));
      }
      const responses = await Promise.all(jobs);
      for (const res of responses) assert.equal(res.status, 200, `toggle failed: ${res.raw}`);
      const doc = await readKanbanFile(targetFile);
      assert.ok(kanbanSchema.safeParse(doc).success, 'file corrupted by concurrent toggles');
      assert.equal(doc.tickets.length, 2);
      assert.deepEqual(doc.tickets.map((t) => t.id).sort(), ['KB-TEST-DONE', 'KB-TEST-OPEN']);
      assert.deepEqual(await tmpLeftovers(targetProject.path), []);
    });

    // (d) Toggle error contract.
    await run('http: POST /api/toggle returns 404 unknown-project / 404 unknown-ticket', async () => {
      const unknownProject = await httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({ project: 'ghost', ticketId: 'x', done: true }));
      assert.equal(unknownProject.status, 404);
      assert.equal(unknownProject.json.error.code, 'unknown-project');
      const unknownTicket = await httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({ project: targetProject.id, ticketId: 'ghost', done: true }));
      assert.equal(unknownTicket.status, 404);
      assert.equal(unknownTicket.json.error.code, 'unknown-ticket');
    });

    await run('http: POST /api/toggle returns 400 for invalid payloads', async () => {
      const cases = [
        '{ not json',
        JSON.stringify({ project: targetProject.id, ticketId: 'KB-TEST-OPEN', status: 'done' }),
        JSON.stringify({ project: targetProject.id, ticketId: 'KB-TEST-OPEN', done: 'yes' }),
        JSON.stringify({ project: '', ticketId: 'KB-TEST-OPEN', done: true }),
        JSON.stringify({ project: targetProject.id, done: true }),
      ];
      for (const body of cases) {
        const res = await httpRequest(port, token, 'POST', '/api/toggle', body);
        assert.equal(res.status, 400, `expected 400 for ${body}`);
        assert.equal(res.json.error.code, 'invalid-payload');
      }
    });
  } finally {
    if (service) await service.stop();
    performRestore();
  }

  // Guarantee the real file was restored byte-for-byte.
  await run('isolation: original kanban.json restored byte-for-byte', async () => {
    const current = await fsp.readFile(targetFile, 'utf8');
    assert.equal(current, original);
    assert.equal(await fsp.readFile(backupFile, 'utf8'), original);
    await fsp.rm(path.dirname(backupFile), { recursive: true, force: true });
  });

  console.log(`\n${state.pass} passed, ${state.fail} failed`);
  if (state.fail > 0) {
    console.error(`Failing checks: ${state.failures.join(', ')}`);
    process.exitCode = 1;
  }
};

main().catch((error) => {
  performRestore();
  console.error('suite aborted unexpectedly:');
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
