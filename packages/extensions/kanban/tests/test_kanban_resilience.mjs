#!/usr/bin/env bun
/**
 * Deterministic, mock-free resilience suite for the Kanban extension
 * (TICKET-HARNESS-46).
 *
 * Two layers are exercised for real:
 *   1. the real resilient read/write functions exported by
 *      `packages/extensions/kanban/src/service/schema.ts` (imported as a real
 *      ES module, no stubs), and
 *   2. the COMPILED extension bundle produced by `bun run extensions:build`,
 *      spawned as a real child process over real HTTP on 127.0.0.1.
 *
 * The integration half snapshots `projeto_jev/kanban.json` byte-for-byte,
 * injects controlled corrupt fixtures and restores the exact original bytes in
 * a finally + exit/signal guard (same pattern as test_kanban_service.mjs).
 * Nothing is faked: warnings are captured through the real `warn` sink, the
 * service is the real bundle, and persistence is verified on the real file.
 *
 * Run:  bun packages/extensions/kanban/tests/test_kanban_resilience.mjs
 * (Bun is required only to import the TypeScript source module; the compiled
 * service itself runs under plain `node`, exactly as in production.)
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

import {
  canonicalizeDoc,
  canonicalizeTicket,
  kanbanSchema,
  normalizePriority,
  normalizeStatus,
  normalizeTicketForRead,
  parseKanbanDocument,
  PRIORITY,
  STATUS,
  ticketSchema,
} from '../src/service/schema.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_PACKAGE = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions', 'kanban');
const SERVICE_ENTRY = path.join(BUILT_PACKAGE, 'service', 'main.js');

const PROJECTS = [
  { id: 'projeto_jev', title: 'agent_quality_guard', path: '/home/maiteuxzanela/projeto JEV', writable: true },
  { id: 'jez_collections', title: 'JEZ Collections', path: '/mnt/94CCB337CCB3130A/JEZ collections' },
  { id: 'panela_sobra', title: 'Panela de Sobra', path: '/home/maiteuxzanela/PanelaBuild' },
  { id: 'faturamento_medico', title: 'Faturamento Médico', path: '/mnt/94CCB337CCB3130A/Faturamento' },
  { id: 'predictera', title: 'Predictera', path: '/mnt/94CCB337CCB3130A/predictera' },
  { id: 'opencode_chambers_harness', title: 'OpenChambers Harness', path: '/mnt/94CCB337CCB3130A/opencode_chambers_harness' },
];

const ISO = '2026-01-02T03:04:05.000Z';

// ---------------------------------------------------------------------------
// Tiny deterministic runner (matches the kanban service suite style).
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
const isoValid = (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value);

const collect = () => {
  const warnings = [];
  return { warnings, warn: (warning) => warnings.push(warning) };
};

const ticket = (overrides = {}) => ({
  id: 'KB-BASE',
  title: 'Base',
  status: 'open',
  priority: 'media',
  summary: 'resumo',
  body: 'corpo',
  order: 0,
  created_at: ISO,
  completed_at: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
// HTTP helpers (real loopback service, no client fakes).
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
      try { json = JSON.parse(raw); } catch { /* error paths may be non-JSON */ }
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

const startService = async () => {
  const port = await freePort();
  const token = `kb-resilience-${randomUUID()}`;
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
  const waitHealthy = async (timeoutMs = 15000) => {
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
    throw new Error(`kanban service never became healthy (${lastError})\n--- service stderr ---\n${stderr}`);
  };
  try {
    await waitHealthy();
  } catch (error) {
    await stop();
    throw error;
  }
  return { port, token, stop, stderr: () => stderr };
};

const waitForStderr = async (service, needle, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (service.stderr().includes(needle)) return true;
    await sleep(25);
  }
  return false;
};

// ---------------------------------------------------------------------------
// Fixture + byte-exact restore guard for the single writable project.
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

const corruptFixture = () => ({
  meta: { version: 1, project: targetProject.id, title: '   ', updated_at: 'not-a-date' },
  tickets: [
    // done synonym + missing completed_at (date invariant repair)
    { id: 'KB-46-SYN', title: 'Sinônimo concluído', status: 'Concluído', priority: 'ALTA', summary: 's', body: 'b', order: 0, created_at: ISO, completed_at: null },
    // open synonym + stale completed_at (must be cleared)
    { id: 'KB-46-DIRTY', title: 'Aberto sujo', status: 'pending', priority: 'media', summary: 's', body: 'b', order: 1, created_at: ISO, completed_at: ISO },
    // entirely canonical ticket must survive untouched
    { id: 'KB-46-VALID', title: 'Válido', status: 'open', priority: 'baixa', summary: 's', body: 'b', order: 2, created_at: ISO, completed_at: null },
    // defective entries: isolation keeps the rest of the file alive
    'ticket quebrado',
    null,
    // duplicate id: first occurrence wins
    { id: 'KB-46-DUP', title: 'Primeiro', status: 'open', priority: 'media', summary: 's', body: 'b', order: 4, created_at: ISO, completed_at: null },
    { id: 'KB-46-DUP', title: 'Segundo', status: 'done', priority: 'media', summary: 's', body: 'b', order: 5, created_at: ISO, completed_at: ISO },
    // missing id (index 7 -> ticket-8) + 'finished' synonym
    { title: 'Sem id', status: 'finished', priority: 'mid', summary: 's', body: 'b', order: 6, created_at: ISO, completed_at: null },
  ],
});

const writeFixture = async (doc, markerOffset) => {
  await fsp.writeFile(targetFile, `${JSON.stringify(doc, null, 2)}\n`);
  // Force a distinct mtime so the service cache (keyed on mtimeMs) cannot
  // serve a stale document; deterministic, no sleeps.
  const stamp = new Date(Date.now() + markerOffset * 1000);
  await fsp.utimes(targetFile, stamp, stamp);
};

const readKanbanFile = async () => JSON.parse(await fsp.readFile(targetFile, 'utf8'));
const tmpLeftovers = async (dir) => (await fsp.readdir(dir)).filter((name) => name.startsWith('.kanban.json.') && name.endsWith('.tmp'));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
const unitTests = async () => {
  console.log('Unit: resilient schema layer (real src module)');

  await run('unit: normalizeStatus maps every done synonym', async () => {
    for (const value of ['done', 'DONE', 'Done', 'concluido', 'concluído', 'Concluído', 'completed', ' CLOSED ', 'finished', 'finalizado']) {
      assert.equal(normalizeStatus(value), 'done', `expected done for ${JSON.stringify(value)}`);
    }
  });

  await run('unit: normalizeStatus maps every open synonym', async () => {
    for (const value of ['open', 'OPEN', 'aberto', 'Aberto', 'pending', 'in_progress', 'todo', 'active', 'em_andamento', 'em_progresso', '  PENDING  ']) {
      assert.equal(normalizeStatus(value), 'open', `expected open for ${JSON.stringify(value)}`);
    }
  });

  await run('unit: normalizeStatus degrades unknown and non-strings to open', async () => {
    for (const value of [null, undefined, 42, true, {}, [], 'blocked', '', '   ', 'em revisão']) {
      assert.equal(normalizeStatus(value), 'open', `expected safe fallback for ${JSON.stringify(value)}`);
    }
  });

  await run('unit: strict STATUS contract remains intact (published layer)', async () => {
    assert.equal(STATUS.parse('concluido'), 'done');
    assert.equal(STATUS.parse('Concluído'), 'done');
    assert.equal(STATUS.parse('completed'), 'done');
    assert.equal(STATUS.parse('finalizado'), 'done');
    assert.equal(STATUS.parse('pending'), 'open');
    assert.equal(STATUS.parse('in_progress'), 'open');
    assert.equal(STATUS.parse('todo'), 'open');
    // Synonyms deliberately NOT accepted by the strict contract.
    for (const value of ['closed', 'finished', 'active', 'em_andamento']) {
      assert.equal(STATUS.safeParse(value).success, false, `strict STATUS must reject ${value}`);
    }
    assert.equal(PRIORITY.parse('urgente'), 'alta');
    assert.equal(PRIORITY.parse('HIGH'), 'alta');
    assert.equal(PRIORITY.parse('mid'), 'media');
    assert.equal(PRIORITY.parse('l'), 'baixa');
  });

  await run('unit: strict ticketSchema still enforces the status/date invariant', async () => {
    assert.equal(ticketSchema.safeParse(ticket()).success, true);
    assert.equal(ticketSchema.safeParse(ticket({ status: 'done', completed_at: null })).success, false);
    assert.equal(ticketSchema.safeParse(ticket({ status: 'open', completed_at: ISO })).success, false);
    assert.equal(ticketSchema.safeParse(ticket({ status: 'closed' })).success, false);
  });

  await run('unit: normalizeTicketForRead heals done without completed_at', async () => {
    const sink = collect();
    const healed = normalizeTicketForRead(ticket({ status: 'done', completed_at: null }), 0, sink.warn);
    assert.ok(healed, 'ticket should be recoverable');
    assert.equal(healed.status, 'done');
    assert.ok(isoValid(healed.completed_at), 'healed completed_at must be a valid ISO timestamp');
    assert.ok(ticketSchema.safeParse(healed).success);
    assert.equal(sink.warnings.length, 1);
    assert.equal(sink.warnings[0].code, 'ticket-recovered');
    assert.match(sink.warnings[0].message, /done without completed_at/);
  });

  await run('unit: normalizeTicketForRead clears completed_at on open tickets', async () => {
    const sink = collect();
    const healed = normalizeTicketForRead(ticket({ status: 'open', completed_at: ISO }), 0, sink.warn);
    assert.ok(healed);
    assert.equal(healed.status, 'open');
    assert.equal(healed.completed_at, null);
    assert.ok(ticketSchema.safeParse(healed).success);
    assert.equal(sink.warnings[0].code, 'ticket-recovered');
    assert.match(sink.warnings[0].message, /open with completed_at/);
  });

  await run('unit: normalizeTicketForRead repairs synonyms, missing id, priority and defaults', async () => {
    const sink = collect();
    const raw = { id: '   ', title: 42, status: '  Concluído ', priority: 'HIGH', summary: null, body: undefined, order: -3, created_at: 'nope' };
    const healed = normalizeTicketForRead(raw, 4, sink.warn);
    assert.ok(healed);
    assert.equal(healed.id, 'ticket-5', 'missing id must fall back to ticket-<index+1>');
    assert.equal(healed.status, 'done');
    assert.equal(healed.priority, 'alta');
    assert.equal(healed.title, '');
    assert.equal(healed.summary, '');
    assert.equal(healed.body, '');
    assert.equal(healed.order, 4, 'invalid order must fall back to the index');
    assert.ok(isoValid(healed.created_at));
    assert.ok(isoValid(healed.completed_at), 'done recovery must stamp a timestamp');
    assert.ok(ticketSchema.safeParse(healed).success);
    assert.equal(sink.warnings.at(-1).code, 'ticket-recovered');
  });

  await run('unit: normalizeTicketForRead discards non-object entries without throwing', async () => {
    for (const raw of [null, 'string', 7, true, []]) {
      const sink = collect();
      assert.equal(normalizeTicketForRead(raw, 2, sink.warn), null);
      assert.equal(sink.warnings.length, 1);
      assert.equal(sink.warnings[0].code, 'ticket-discarded');
      assert.equal(sink.warnings[0].index, 2);
    }
  });

  await run('unit: parseKanbanDocument isolates one bad ticket and keeps the rest', async () => {
    const sink = collect();
    const raw = {
      meta: { version: 1, project: 'projeto_jev', title: 'agent_quality_guard', updated_at: ISO },
      tickets: [
        ticket({ id: 'A', status: 'open' }),
        ticket({ id: 'B', status: 'done', completed_at: null }),
        ticket({ id: 'C', status: 'closed', completed_at: ISO }),
        null,
        ticket({ id: 'D', status: 'open' }),
      ],
    };
    const doc = parseKanbanDocument(raw, sink.warn);
    assert.deepEqual(doc.tickets.map((item) => item.id), ['A', 'B', 'C', 'D']);
    assert.equal(doc.tickets.find((item) => item.id === 'B').status, 'done');
    assert.ok(isoValid(doc.tickets.find((item) => item.id === 'B').completed_at));
    assert.equal(doc.tickets.find((item) => item.id === 'C').status, 'done');
    assert.ok(isoValid(doc.tickets.find((item) => item.id === 'C').completed_at));
    assert.ok(kanbanSchema.safeParse(doc).success, 'whole repaired document must satisfy the strict schema');
    assert.ok(sink.warnings.some((warning) => warning.code === 'ticket-discarded'));
    assert.ok(sink.warnings.filter((warning) => warning.code === 'ticket-recovered').length >= 2);
  });

  await run('unit: parseKanbanDocument keeps the first duplicate id and drops the rest', async () => {
    const sink = collect();
    const raw = {
      meta: { version: 1, project: 'projeto_jev', title: 'x', updated_at: ISO },
      tickets: [
        ticket({ id: 'DUP', title: 'primeiro' }),
        ticket({ id: 'DUP', title: 'segundo', status: 'done', completed_at: ISO }),
        ticket({ id: 'DUP', title: 'terceiro' }),
      ],
    };
    const doc = parseKanbanDocument(raw, sink.warn);
    assert.equal(doc.tickets.length, 1);
    assert.equal(doc.tickets[0].title, 'primeiro');
    const duplicates = sink.warnings.filter((warning) => warning.code === 'duplicate-ticket-id');
    assert.equal(duplicates.length, 2);
    assert.deepEqual(duplicates.map((warning) => warning.index), [1, 2]);
  });

  await run('unit: parseKanbanDocument repairs meta but preserves instructions', async () => {
    const sink = collect();
    const raw = {
      meta: { version: 1, project: 'projeto_jev', title: '', updated_at: 'never', instructions: 'manter' },
      tickets: [],
    };
    const doc = parseKanbanDocument(raw, sink.warn);
    assert.equal(doc.meta.title, 'projeto_jev');
    assert.ok(isoValid(doc.meta.updated_at));
    assert.equal(doc.meta.instructions, 'manter');
    assert.equal(sink.warnings.filter((warning) => warning.code === 'meta-recovered').length, 1);
  });

  await run('unit: parseKanbanDocument throws on meta-level corruption', async () => {
    const corrupt = [
      null,
      'not-json',
      [],
      {},
      { meta: null, tickets: [] },
      { meta: { version: 2, project: 'projeto_jev' }, tickets: [] },
      { meta: { version: 1, project: 'ghost' }, tickets: [] },
      { meta: { version: 1, project: 'projeto_jev' }, tickets: 'nope' },
      { meta: { version: 1, project: 'projeto_jev' }, tickets: {} },
    ];
    for (const raw of corrupt) {
      assert.throws(() => parseKanbanDocument(raw, () => {}), Error, `expected throw for ${JSON.stringify(raw)}`);
    }
  });

  await run('unit: canonicalizeDoc auto-heals, validates and is idempotent', async () => {
    const dirty = {
      meta: { version: 1, project: 'projeto_jev', title: 't', updated_at: 'never' },
      tickets: [
        ticket({ id: 'X', status: 'Concluído', priority: 'HIGH', completed_at: null }),
        ticket({ id: 'Y', status: 'pending', created_at: 'bad', completed_at: ISO }),
        ticket({ id: 'Z', status: 'done', priority: 'mid', completed_at: ISO }),
      ],
    };
    const healed = canonicalizeDoc(dirty);
    assert.ok(kanbanSchema.safeParse(healed).success);
    assert.deepEqual(healed.tickets.map((item) => item.status), ['done', 'open', 'done']);
    assert.deepEqual(healed.tickets.map((item) => item.priority), ['alta', 'media', 'media']);
    assert.ok(isoValid(healed.tickets[0].completed_at));
    assert.equal(healed.tickets[1].completed_at, null);
    assert.ok(isoValid(healed.tickets[1].created_at));
    assert.ok(isoValid(healed.meta.updated_at));
    const again = canonicalizeDoc(healed);
    assert.deepEqual(again, healed, 'canonicalizeDoc must be idempotent');
  });

  await run('unit: canonicalizeTicket does not mutate its input and keeps canonical dates', async () => {
    const source = ticket({ status: 'done', completed_at: ISO });
    const frozen = structuredClone(source);
    const healed = canonicalizeTicket(source);
    assert.deepEqual(source, frozen, 'input ticket must not be mutated');
    assert.equal(healed.completed_at, ISO, 'already valid timestamps are preserved');
    assert.equal(normalizePriority(healed.priority), 'media');
  });
};

const integrationTests = async () => {
  console.log('\nIntegration: compiled bundle over real HTTP + real kanban.json');

  const original = await fsp.readFile(targetFile, 'utf8');
  const backupDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kb-resilience-backup-'));
  await fsp.writeFile(path.join(backupDir, 'kanban.json'), original);
  restore = () => { fs.writeFileSync(targetFile, original); };

  await writeFixture(corruptFixture(), 1);

  let service = null;
  try {
    assert.ok(fs.existsSync(SERVICE_ENTRY), `missing compiled service bundle: ${SERVICE_ENTRY} (run bun run extensions:build)`);
    service = await startService();
    const { port, token } = service;

    await run('http: GET sanitizes corrupt tickets without aborting the document', async () => {
      const res = await httpRequest(port, token, 'GET', `/api/kanban?project=${targetProject.id}`);
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);
      assert.equal(res.json.project, targetProject.id);
      assert.equal(res.json.meta.title, targetProject.id, 'empty meta.title must be recovered to the project id');
      assert.ok(isoValid(res.json.meta.updated_at), 'invalid meta.updated_at must be healed');

      const { tickets } = res.json;
      assert.equal(tickets.length, 5, 'two defective entries discarded, duplicate collapsed');
      for (const item of tickets) {
        assert.equal('body' in item, false, 'the sliced list must omit body (TICKET-HARNESS-88)');
        assert.ok(ticketSchema.safeParse({ ...item, body: '' }).success, `invalid sanitized ticket ${JSON.stringify(item)}`);
      }

      // The body still has to be reachable on demand.
      const detail = await httpRequest(port, token, 'GET', `/api/kanban/ticket?project=${targetProject.id}&ticketId=KB-46-VALID`);
      assert.equal(detail.status, 200, `body lookup failed: ${detail.raw}`);
      assert.deepEqual(detail.json.ticket, corruptFixture().tickets[2], 'the on-demand body must match the document');

      const syn = tickets.find((item) => item.id === 'KB-46-SYN');
      assert.equal(syn.status, 'done');
      assert.ok(isoValid(syn.completed_at), 'done synonym must receive a valid completed_at');
      assert.equal(syn.priority, 'alta');

      const dirty = tickets.find((item) => item.id === 'KB-46-DIRTY');
      assert.equal(dirty.status, 'open');
      assert.equal(dirty.completed_at, null, 'open ticket must not keep a stale completed_at');

      const valid = tickets.find((item) => item.id === 'KB-46-VALID');
      const { body: _canonicalBody, ...canonicalMeta } = corruptFixture().tickets[2];
      assert.deepEqual(valid, canonicalMeta, 'canonical ticket fields must pass through untouched (body is served on demand)');

      const dup = tickets.find((item) => item.id === 'KB-46-DUP');
      assert.equal(dup.title, 'Primeiro', 'first duplicate must win');

      const noId = tickets.find((item) => item.id === 'ticket-8');
      assert.ok(noId, 'missing id must fall back to ticket-<index+1>');
      assert.equal(noId.status, 'done');
      assert.ok(isoValid(noId.completed_at));

      for (const item of tickets) {
        assert.ok(item.status === 'open' || item.status === 'done');
        assert.ok(['alta', 'media', 'baixa'].includes(item.priority));
      }

      // Structured warnings are a real side effect of the compiled bundle.
      assert.ok(await waitForStderr(service, 'ticket-recovered'), `missing ticket-recovered warning. stderr:\n${service.stderr()}`);
      assert.ok(await waitForStderr(service, 'ticket-discarded'), 'missing ticket-discarded warning');
      assert.ok(await waitForStderr(service, 'duplicate-ticket-id'), 'missing duplicate-ticket-id warning');
      assert.ok(await waitForStderr(service, 'meta-recovered'), 'missing meta-recovered warning');
    });

    await run('http: meta corruption still answers 500 schema-invalid and never overwrites', async () => {
      await writeFixture({
        meta: { version: 2, project: targetProject.id, title: 'x', updated_at: ISO },
        tickets: [],
      }, 2);
      const before = await fsp.readFile(targetFile);
      const res = await httpRequest(port, token, 'GET', `/api/kanban?project=${targetProject.id}`);
      assert.equal(res.status, 500);
      assert.equal(res.json.error.code, 'schema-invalid');
      assert.match(res.json.error.message, /meta\.version/);
      const after = await fsp.readFile(targetFile);
      assert.deepEqual(after, before, 'a failed read must never rewrite kanban.json');
    });

    await run('http: toggle auto-heals the persisted document to canonical literals', async () => {
      await writeFixture(corruptFixture(), 3);
      const res = await httpRequest(port, token, 'POST', '/api/toggle', JSON.stringify({
        project: targetProject.id, ticketId: 'KB-46-VALID', done: true,
      }));
      assert.equal(res.status, 200, `toggle failed: ${res.raw}`);
      assert.equal(res.json.ticket.id, 'KB-46-VALID');
      assert.equal(res.json.ticket.status, 'done');
      assert.ok(isoValid(res.json.ticket.completed_at));

      const doc = await readKanbanFile();
      assert.ok(kanbanSchema.safeParse(doc).success, 'persisted document must satisfy the strict contract');
      assert.equal(doc.tickets.length, 5);
      assert.deepEqual(doc.tickets.map((item) => item.id), ['KB-46-SYN', 'KB-46-DIRTY', 'KB-46-VALID', 'KB-46-DUP', 'ticket-8']);

      const syn = doc.tickets.find((item) => item.id === 'KB-46-SYN');
      assert.equal(syn.status, 'done');
      assert.ok(isoValid(syn.completed_at));
      const dirty = doc.tickets.find((item) => item.id === 'KB-46-DIRTY');
      assert.equal(dirty.status, 'open');
      assert.equal(dirty.completed_at, null);
      const noId = doc.tickets.find((item) => item.id === 'ticket-8');
      assert.equal(noId.status, 'done');
      assert.ok(isoValid(noId.completed_at));
      assert.equal(doc.meta.title, targetProject.id);
      assert.ok(isoValid(doc.meta.updated_at));

      const raw = await fsp.readFile(targetFile, 'utf8');
      for (const dirtyLiteral of ['Concluído', 'concluido', 'pending', 'finished', 'closed', 'Segundo', 'ticket quebrado']) {
        assert.equal(raw.includes(dirtyLiteral), false, `persisted file still contains dirty literal ${JSON.stringify(dirtyLiteral)}`);
      }
      assert.deepEqual(await tmpLeftovers(targetProject.path), []);
    });
  } finally {
    if (service) await service.stop();
    performRestore();
  }
};

const main = async () => {
  const unitOnly = process.env.KANBAN_RESILIENCE_UNIT_ONLY === '1';
  console.log(`Kanban resilience suite | built=${path.relative(REPO_ROOT, BUILT_PACKAGE)}${unitOnly ? ' | unit-only' : ''}`);
  await unitTests();
  if (!unitOnly) await integrationTests();
  console.log(`\n${state.pass} passed, ${state.fail} failed`);
  if (state.fail > 0) {
    console.error(`Failures: ${state.failures.join(', ')}`);
    process.exitCode = 1;
  }
};

await main();
