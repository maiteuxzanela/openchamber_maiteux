#!/usr/bin/env bun
/**
 * Deterministic, mock-free suite for the Multirepo Diff built-in extension
 * (TICKET-HARNESS-40).
 *
 * Layers exercised for real:
 *   1. production helpers imported as real ES modules from
 *      `src/service/git.ts`, `src/service/ledger.ts` and `src/panel/i18n.ts`;
 *   2. the COMPILED service bundle produced by `bun run extensions:build`,
 *      spawned as a real child process under plain `node` and reached over real
 *      HTTP on 127.0.0.1;
 *   3. real git repositories created in an isolated temp dir and a real SQLite
 *      ledger created in that same temp dir (never the production ensemble.db);
 *   4. mutation probes: the compiled bundle is copied, deliberately broken and
 *      re-spawned to prove the suite fails when production behaviour regresses.
 *
 * No module is stubbed, faked or monkey-patched. Nothing outside the temp
 * fixture root is written; the suite never touches the real workspace repos.
 *
 * Run:  bun packages/extensions/multirepo-diff/tests/test_multirepo_diff.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  buildPatch,
  isInside,
  languageFor,
  normalizeStatus,
  parseStatusZ,
  parseUnifiedDiff,
  readTextFileCapped,
  resetRepoRootCache,
  revertFile,
  synthesizeUntrackedPatch,
} from '../src/service/git.ts';
import {
  LedgerUnavailableError,
  databaseCandidates,
  readLedger,
  resolveDatabasePath,
} from '../src/service/ledger.ts';
import { LOCALES, createTranslator, normalizeLocale } from '../src/panel/i18n.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(HERE, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..', '..');
const BUILT_ROOT = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions', 'multirepo-diff');
const BUILT_SERVICE = path.join(BUILT_ROOT, 'service', 'main.js');
const BUILT_PANEL = path.join(BUILT_ROOT, 'panel', 'main.js');
const NODE_BIN = process.env.NODE_BIN || 'node';

const SERVICE_TOKEN = 'suite-secret-token';
const ROOM_ACTIVE = 'team_suite_active';
const ROOM_ARCHIVED = 'team_suite_archived';
const ROOM_EMPTY = 'team_suite_empty';
const ROOM_OVERFLOW = 'team_suite_overflow';

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  LC_ALL: 'C',
  LANG: 'C',
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * Tiny deterministic runner
 * ------------------------------------------------------------------ */

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
    const text = String(error && error.stack ? error.stack : error);
    console.error(text.split('\n').map((line) => `       ${line}`).join('\n'));
  }
};
const group = (title) => console.log(`\n== ${title} ==`);

/* ------------------------------------------------------------------ *
 * Filesystem / git / HTTP helpers
 * ------------------------------------------------------------------ */

const write = (root, relative, content) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
};

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Keep the leading space of porcelain codes (" M"): trimming would silently
// turn an unstaged modification into a staged one.
const gitStatus = (cwd, relativePath) =>
  git(cwd, ['status', '--porcelain=v1', '--', relativePath]).replace(/\r?\n$/, '');

const repoRootOf = (dir) => path.resolve(git(dir, ['rev-parse', '--show-toplevel']).trim());

const initRepo = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main', '.']);
  git(dir, ['config', 'user.email', 'suite@example.test']);
  git(dir, ['config', 'user.name', 'Suite']);
  return dir;
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const request = (port, options) =>
  new Promise((resolve, reject) => {
    const method = options.method ?? 'GET';
    const token = Object.prototype.hasOwnProperty.call(options, 'token') ? options.token : SERVICE_TOKEN;
    const rawBody =
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : null;
    const headers = { ...(options.headers ?? {}) };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    if (rawBody !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(rawBody, 'utf8');
    }
    const req = http.request(
      { host: '127.0.0.1', port, method, path: options.path, headers },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (rawBody !== null) req.write(rawBody);
    req.end();
  });

const expectError = (response, status, code) => {
  assert.equal(response.status, status, `expected HTTP ${status}, got ${response.status}: ${response.text}`);
  assert.ok(response.json, `expected a JSON error body, got: ${response.text}`);
  assert.equal(response.json.error.code, code);
  assert.equal(typeof response.json.error.message, 'string');
  assert.ok(response.json.error.message.length > 0);
};

/* ------------------------------------------------------------------ *
 * Service lifecycle
 * ------------------------------------------------------------------ */

const children = [];
let FIXTURE = null;

const startService = async (entry, dbPath, port) => {
  const child = spawn(NODE_BIN, [entry], {
    env: {
      ...GIT_ENV,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
      OPENCHAMBER_MULTIREPO_DB: dbPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderrText = '';
  child.stdoutText = '';
  child.stderr.on('data', (chunk) => {
    child.stderrText += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    child.stdoutText += String(chunk);
  });
  children.push(child);
  return child;
};

const waitHealthy = async (child, port) => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`service exited before becoming healthy (code ${child.exitCode}): ${child.stderrText}`);
    }
    try {
      const response = await request(port, { path: '/health' });
      if (response.status === 200 && response.json?.ok === true) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`service did not become healthy on port ${port}`);
    await delay(50);
  }
};

const stopService = async (child) => {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const outcome = await Promise.race([exited, delay(5_000).then(() => ({ timeout: true }))]);
  if (outcome.timeout) {
    child.kill('SIGKILL');
    assert.fail('service ignored SIGTERM and had to be killed');
  }
  return outcome;
};

const unexpectedErrors = (child) =>
  child.stderrText
    .split('\n')
    .filter((line) => line.includes('unexpected error') || line.includes('unhandled rejection'))
    .filter(Boolean);

const cleanup = () => {
  for (const child of children) {
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  if (FIXTURE?.root) {
    try {
      fs.rmSync(FIXTURE.root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
};

process.on('exit', cleanup);
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

/* ------------------------------------------------------------------ *
 * Fixture: real git repositories + real SQLite ledger
 * ------------------------------------------------------------------ */

const buildFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-multirepo-'));

  // --- repo alpha: every interesting dirty state -----------------------
  const alphaDir = path.join(root, 'alpha-repo');
  initRepo(alphaDir);
  write(alphaDir, 'keep.txt', 'keep\n');
  write(alphaDir, 'modify.ts', 'export const a = 1;\nexport const b = 2;\n');
  write(alphaDir, 'delete.txt', 'bye\n');
  write(alphaDir, 'rename-old.txt', 'rename me\n');
  write(alphaDir, 'other-unrelated.txt', 'untouched\n');
  const blobOriginal = Buffer.from('BIN\u0000DATA\n', 'utf8');
  fs.writeFileSync(path.join(alphaDir, 'blob.bin'), blobOriginal);
  git(alphaDir, ['add', '-A']);
  git(alphaDir, ['commit', '-qm', 'base commit']);
  assert.equal(gitStatus(alphaDir, '.'), '');

  write(alphaDir, 'modify.ts', 'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n');
  fs.rmSync(path.join(alphaDir, 'delete.txt'));
  git(alphaDir, ['mv', 'rename-old.txt', 'rename-new.txt']);
  write(alphaDir, 'added.txt', 'new line\n');
  git(alphaDir, ['add', 'added.txt']);
  write(alphaDir, 'untracked.txt', 'l1\nl2');
  write(alphaDir, 'nested/deep/file.md', 'deep\n');
  const blobModified = Buffer.from('BIN\u0000CHANGED\n', 'utf8');
  fs.writeFileSync(path.join(alphaDir, 'blob.bin'), blobModified);
  write(alphaDir, 'other-unrelated.txt', 'dirty but not ledger\n');
  fs.symlinkSync('/etc/passwd', path.join(alphaDir, 'escape-link'));

  // --- repo beta: unborn HEAD (git init, staged addition) --------------
  const betaDir = path.join(root, 'beta-unborn');
  initRepo(betaDir);
  write(betaDir, 'first.md', '# first\n');
  git(betaDir, ['add', 'first.md']);

  // --- repo broken: valid toplevel, corrupt index -> status must fail --
  const brokenDir = path.join(root, 'broken-git');
  initRepo(brokenDir);
  write(brokenDir, 'seed.txt', 'seed\n');
  git(brokenDir, ['add', '-A']);
  git(brokenDir, ['commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(brokenDir, '.git', 'index'), 'garbage');

  // --- repo gamma: a real git repo that does NOT belong to the room ----
  const gammaDir = path.join(root, 'gamma-not-in-room');
  initRepo(gammaDir);
  write(gammaDir, 'gamma.txt', 'gamma\n');
  git(gammaDir, ['add', '-A']);
  git(gammaDir, ['commit', '-qm', 'gamma']);

  // --- repo unit: isolated helpers for direct git.ts revert proof ------
  const unitDir = path.join(root, 'unit-repo');
  initRepo(unitDir);
  write(unitDir, 'u.txt', 'base\n');
  git(unitDir, ['add', '-A']);
  git(unitDir, ['commit', '-qm', 'unit base']);

  // --- loose paths: outside every git repository -----------------------
  const looseDir = path.join(root, 'loose');
  const looseFile = write(looseDir, 'loose.txt', 'not tracked anywhere\n');
  const overflowDir = path.join(root, 'loose-many');
  const overflowFiles = [];
  for (let index = 0; index < 22; index += 1) {
    overflowFiles.push(write(overflowDir, `file-${String(index).padStart(2, '0')}.txt`, `loose ${index}\n`));
  }

  const alphaRoot = repoRootOf(alphaDir);
  const betaRoot = repoRootOf(betaDir);
  const brokenRoot = repoRootOf(brokenDir);
  const gammaRoot = repoRootOf(gammaDir);
  const unitRoot = repoRootOf(unitDir);

  const ledgerFiles = [
    path.join(alphaRoot, 'modify.ts'),
    path.join(alphaRoot, 'keep.txt'),
    path.join(alphaRoot, 'delete.txt'),
    path.join(alphaRoot, 'rename-new.txt'),
    path.join(alphaRoot, 'added.txt'),
    path.join(alphaRoot, 'untracked.txt'),
    path.join(alphaRoot, 'blob.bin'),
    path.join(alphaRoot, 'nested/deep/file.md'),
    path.join(betaRoot, 'first.md'),
    path.join(brokenRoot, 'seed.txt'),
    looseFile,
  ];

  const dbPath = path.join(root, 'ledger.db');
  createLedgerDb(dbPath, { ledgerFiles, overflowFiles, brokenRoot });

  return {
    root,
    dbPath,
    alphaDir,
    alphaRoot,
    betaDir,
    betaRoot,
    brokenDir,
    brokenRoot,
    gammaDir,
    gammaRoot,
    unitDir,
    unitRoot,
    looseFile,
    overflowFiles,
    ledgerFiles,
    blobOriginal,
    blobModified,
  };
};

const createLedgerDb = (dbPath, fixture) => {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE team (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lead_agent TEXT,
        status TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE team_member (
        team_id TEXT NOT NULL,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ready',
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        PRIMARY KEY (team_id, name)
      );
      CREATE TABLE team_modified_file (
        team_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        PRIMARY KEY (team_id, file_path)
      );
    `);

    const insertTeam = db.prepare(
      'INSERT INTO team (id, name, lead_agent, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    );
    insertTeam.run(ROOM_OVERFLOW, 'suite-overflow', 'dante', 'active', 5_000_000, 5_000_100);
    insertTeam.run(ROOM_ACTIVE, 'suite-active', 'dante', 'active', 4_000_000, 4_000_100);
    insertTeam.run(ROOM_ARCHIVED, 'suite-archived', null, 'archived', 3_000_000, 3_000_100);
    insertTeam.run(ROOM_EMPTY, 'suite-empty', null, 'active', 2_000_000, 2_000_100);

    const insertMember = db.prepare(
      'INSERT INTO team_member (team_id, name, session_id, agent, status, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insertMember.run(ROOM_ACTIVE, 'dante', 'sess-dante', 'dante', 'ready', 1, 1);
    insertMember.run(ROOM_ACTIVE, 'hugo', 'sess-hugo', 'hugo', 'standby', 1, 1);
    insertMember.run(ROOM_ACTIVE, 'clara', 'sess-clara', 'clara', 'standby', 1, 1);
    insertMember.run(ROOM_ARCHIVED, 'dante', 'sess-dante-arch', 'dante', 'shutdown', 1, 1);
    insertMember.run(ROOM_ARCHIVED, 'cris', 'sess-cris-arch', 'cris', 'shutdown', 1, 1);
    insertMember.run(ROOM_OVERFLOW, 'dante', 'sess-dante-overflow', 'dante', 'ready', 1, 1);

    const insertFile = db.prepare(
      'INSERT INTO team_modified_file (team_id, file_path, time_created) VALUES (?, ?, ?)',
    );
    fixture.ledgerFiles.forEach((file, index) => insertFile.run(ROOM_ACTIVE, file, 100_000 - index));
    fixture.overflowFiles.forEach((file, index) => insertFile.run(ROOM_OVERFLOW, file, 90_000 - index));
  } finally {
    db.close();
  }
};

/* ------------------------------------------------------------------ *
 * Read helpers used by the integration layer
 * ------------------------------------------------------------------ */

const roomsQuery = (query) => {
  const qs = new URLSearchParams(query).toString();
  return `/api/multirepo/rooms${qs ? `?${qs}` : ''}`;
};

const getRooms = (port, query = {}, token) =>
  request(port, { path: roomsQuery(query), ...(token !== undefined ? { token } : {}) });

const getDiff = (port, params, token) => {
  const qs = new URLSearchParams(params).toString();
  return request(port, { path: `/api/multirepo/diff?${qs}`, ...(token !== undefined ? { token } : {}) });
};

const postRevert = (port, payload, token) =>
  request(port, {
    method: 'POST',
    path: '/api/multirepo/revert',
    body: payload,
    ...(token !== undefined ? { token } : {}),
  });

const findRoom = (body, id) => body.rooms.find((room) => room.id === id);
const findRepo = (room, name) => room.repos.find((repo) => repo.name === name);
const findFile = (repo, relativePath) => repo.files.find((file) => file.path === relativePath);
const assertClean = (cwd, relativePath) => assert.equal(gitStatus(cwd, relativePath), '', `${relativePath} must be clean`);

/* ------------------------------------------------------------------ *
 * Mutation helpers (compiled bundle copies)
 * ------------------------------------------------------------------ */

const writeMutant = (root, name, mutate) => {
  const dir = path.join(root, 'mutants', name);
  fs.mkdirSync(dir, { recursive: true });
  const source = fs.readFileSync(BUILT_SERVICE, 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation "${name}" did not change the bundle`);
  const entry = path.join(dir, 'main.js');
  fs.writeFileSync(entry, mutated);
  return entry;
};

/* ------------------------------------------------------------------ *
 * Panel / i18n static extraction
 * ------------------------------------------------------------------ */

const extractEnKeys = (source) => {
  const start = source.indexOf('const en = {');
  const end = source.indexOf('} as const;', start);
  assert.ok(start >= 0 && end > start, 'en dictionary block must exist');
  return [...source.slice(start, end).matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((match) => match[1]);
};

const extractDictBlocks = (source) => {
  const blocks = new Map();
  const pattern = /^const (\w+): Dict = \{\n([\s\S]*?)^\};/gm;
  for (const match of source.matchAll(pattern)) blocks.set(match[1], match[2]);
  return blocks;
};

const dictKeys = (block) => [...block.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((match) => match[1]);

const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const dictValues = (block) => {
  const values = new Map();
  for (const match of block.matchAll(/^ {2}([A-Za-z0-9_]+):\s*(.*?),?\s*$/gm)) {
    values.set(match[1], match[2]);
  }
  return values;
};

/* ================================================================== *
 * SUITE
 * ================================================================== */

const main = async () => {
  group('Layer 1 - production helpers (real modules, no mocks)');

  await run('parseStatusZ understands normal, untracked and rename records', () => {
    const raw = ` M a.txt\u0000R  new.txt\u0000old.txt\u0000?? u.txt\u0000`;
    assert.deepEqual(parseStatusZ(raw), [
      { path: 'a.txt', previousPath: null, code: ' M' },
      { path: 'new.txt', previousPath: 'old.txt', code: 'R ' },
      { path: 'u.txt', previousPath: null, code: '??' },
    ]);
    assert.deepEqual(parseStatusZ(''), []);
  });

  await run('normalizeStatus maps every porcelain family', () => {
    const cases = [
      [null, 'clean'],
      ['', 'clean'],
      ['??', 'untracked'],
      [' M', 'modified'],
      ['M ', 'modified'],
      ['A ', 'added'],
      [' D', 'deleted'],
      ['R ', 'renamed'],
      ['RM', 'renamed'],
      ['C ', 'copied'],
      ['UU', 'unmerged'],
      ['AA', 'unmerged'],
      ['DD', 'unmerged'],
      ['T ', 'modified'],
      ['  ', 'clean'],
    ];
    for (const [code, expected] of cases) assert.equal(normalizeStatus(code), expected, `code ${JSON.stringify(code)}`);
  });

  await run('isInside rejects the sibling-prefix trap', () => {
    assert.equal(isInside('/tmp/root', '/tmp/root'), true);
    assert.equal(isInside('/tmp/root', '/tmp/root/a/b'), true);
    assert.equal(isInside('/tmp/root', '/tmp/rooted/a'), false);
    assert.equal(isInside('/tmp/root', '/tmp/root/../rooted/a'), false);
  });

  await run('languageFor maps extensions and special filenames', () => {
    assert.equal(languageFor('src/a.ts'), 'typescript');
    assert.equal(languageFor('x.MJS'), 'javascript');
    assert.equal(languageFor('README.md'), 'markdown');
    assert.equal(languageFor('Dockerfile'), 'dockerfile');
    assert.equal(languageFor('Makefile'), 'makefile');
    assert.equal(languageFor('blob.bin'), 'text');
  });

  await run('synthesizeUntrackedPatch produces an exact new-file diff', () => {
    const patch = synthesizeUntrackedPatch('dir/a.txt', 'l1\nl2');
    assert.equal(
      patch,
      [
        'diff --git a/dir/a.txt b/dir/a.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/dir/a.txt',
        '@@ -0,0 +1,2 @@',
        '+l1',
        '+l2',
        '',
      ].join('\n'),
    );
    assert.equal(synthesizeUntrackedPatch('empty.txt', ''), '');
  });

  await run('parseUnifiedDiff numbers hunks and keeps no-newline markers as meta', () => {
    const patch = [
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    const parsed = parseUnifiedDiff(patch);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.hunks.length, 1);
    const hunk = parsed.hunks[0];
    assert.equal(hunk.header, '@@ -1 +1 @@');
    assert.equal(hunk.oldStart, 1);
    assert.equal(hunk.oldLines, 1);
    assert.equal(hunk.newStart, 1);
    assert.equal(hunk.newLines, 1);
    assert.deepEqual(hunk.lines, [
      { type: 'del', text: 'old', oldNumber: 1, newNumber: null },
      { type: 'meta', text: '\\ No newline at end of file', oldNumber: null, newNumber: null },
      { type: 'add', text: 'new', oldNumber: null, newNumber: 1 },
      { type: 'meta', text: '\\ No newline at end of file', oldNumber: null, newNumber: null },
    ]);
  });

  await run('parseUnifiedDiff truncates at maxLines', () => {
    const body = ['@@ -1,3 +1,3 @@'];
    for (let index = 0; index < 5; index += 1) body.push(` line ${index}`);
    const parsed = parseUnifiedDiff(body.join('\n'), 3);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.hunks[0].lines.length, 3);
  });

  await run('databaseCandidates honors the explicit override and XDG order', () => {
    const saved = {
      OPENCHAMBER_MULTIREPO_DB: process.env.OPENCHAMBER_MULTIREPO_DB,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      HOME: process.env.HOME,
    };
    try {
      process.env.OPENCHAMBER_MULTIREPO_DB = 'rel/ledger.db';
      assert.deepEqual(databaseCandidates(), [path.resolve('rel/ledger.db')]);
      delete process.env.OPENCHAMBER_MULTIREPO_DB;
      process.env.XDG_CONFIG_HOME = '/xdg/config';
      process.env.XDG_DATA_HOME = '/xdg/data';
      assert.deepEqual(databaseCandidates(), [
        '/xdg/config/opencode/ensemble.db',
        '/xdg/data/opencode/ensemble.db',
        '/xdg/data/opencode/opencode.db',
      ]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // Fixture is built here because unit tests of the ledger need a real DB.
  FIXTURE = buildFixture();
  const fixture = FIXTURE;

  await run('resolveDatabasePath finds the explicit DB and rejects impostors', () => {
    const saved = process.env.OPENCHAMBER_MULTIREPO_DB;
    try {
      process.env.OPENCHAMBER_MULTIREPO_DB = fixture.dbPath;
      const resolved = resolveDatabasePath();
      assert.equal(resolved.database, path.resolve(fixture.dbPath));

      process.env.OPENCHAMBER_MULTIREPO_DB = path.join(fixture.root, 'does-not-exist.db');
      assert.throws(
        () => resolveDatabasePath(),
        (error) => error instanceof LedgerUnavailableError && error.code === 'database-unavailable',
      );

      const impostor = path.join(fixture.root, 'impostor.db');
      const db = new DatabaseSync(impostor);
      db.exec('CREATE TABLE other (x INTEGER)');
      db.close();
      process.env.OPENCHAMBER_MULTIREPO_DB = impostor;
      assert.throws(
        () => resolveDatabasePath(),
        (error) => error instanceof LedgerUnavailableError && error.code === 'database-unavailable',
      );
    } finally {
      if (saved === undefined) delete process.env.OPENCHAMBER_MULTIREPO_DB;
      else process.env.OPENCHAMBER_MULTIREPO_DB = saved;
    }
  });

  await run('resolveDatabasePath skips a schema-less candidate and picks the capable one', () => {
    const saved = {
      OPENCHAMBER_MULTIREPO_DB: process.env.OPENCHAMBER_MULTIREPO_DB,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    };
    const configHome = path.join(fixture.root, 'xdg-config');
    const dataHome = path.join(fixture.root, 'xdg-data');
    const decoy = path.join(configHome, 'opencode', 'ensemble.db');
    const capable = path.join(dataHome, 'opencode', 'ensemble.db');
    fs.mkdirSync(path.dirname(decoy), { recursive: true });
    fs.mkdirSync(path.dirname(capable), { recursive: true });
    const decoyDb = new DatabaseSync(decoy);
    decoyDb.exec('CREATE TABLE team (id TEXT)');
    decoyDb.close();
    fs.copyFileSync(fixture.dbPath, capable);
    try {
      delete process.env.OPENCHAMBER_MULTIREPO_DB;
      process.env.XDG_CONFIG_HOME = configHome;
      process.env.XDG_DATA_HOME = dataHome;
      assert.equal(resolveDatabasePath().database, path.resolve(capable));
    } finally {
      if (saved.OPENCHAMBER_MULTIREPO_DB === undefined) delete process.env.OPENCHAMBER_MULTIREPO_DB;
      else process.env.OPENCHAMBER_MULTIREPO_DB = saved.OPENCHAMBER_MULTIREPO_DB;
      if (saved.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = saved.XDG_CONFIG_HOME;
      if (saved.XDG_DATA_HOME === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
    }
  });

  await run('readLedger filters rooms and keeps the newest-first file order', () => {
    const saved = process.env.OPENCHAMBER_MULTIREPO_DB;
    try {
      process.env.OPENCHAMBER_MULTIREPO_DB = fixture.dbPath;
      const active = readLedger('active');
      assert.deepEqual(
        active.rooms.map((room) => room.id),
        [ROOM_OVERFLOW, ROOM_ACTIVE, ROOM_EMPTY],
      );
      const activeFiles = active.filesByRoom.get(ROOM_ACTIVE);
      assert.deepEqual(activeFiles, fixture.ledgerFiles);
      assert.equal(active.filesByRoom.get(ROOM_ARCHIVED), undefined);

      const archived = readLedger('archived');
      assert.deepEqual(
        archived.rooms.map((room) => room.id),
        [ROOM_ARCHIVED],
      );

      const all = readLedger('all');
      assert.deepEqual(
        all.rooms.map((room) => room.id),
        [ROOM_OVERFLOW, ROOM_ACTIVE, ROOM_ARCHIVED, ROOM_EMPTY],
      );
      assert.equal(all.database, path.resolve(fixture.dbPath));
    } finally {
      if (saved === undefined) delete process.env.OPENCHAMBER_MULTIREPO_DB;
      else process.env.OPENCHAMBER_MULTIREPO_DB = saved;
    }
  });

  await run('readTextFileCapped counts lines, detects binary and truncation', async () => {
    const textPath = write(fixture.root, 'reader/a.txt', 'a\nb\n');
    assert.deepEqual(await readTextFileCapped(textPath), {
      binary: false,
      lines: 2,
      text: 'a\nb\n',
      truncated: false,
    });
    const noTrailing = write(fixture.root, 'reader/b.txt', 'a\nb');
    assert.equal((await readTextFileCapped(noTrailing)).lines, 2);
    const empty = write(fixture.root, 'reader/empty.txt', '');
    assert.deepEqual(await readTextFileCapped(empty), { binary: false, lines: 0, text: '', truncated: false });
    const binaryPath = path.join(fixture.root, 'reader', 'bin.dat');
    fs.writeFileSync(binaryPath, Buffer.from([0x41, 0x00, 0x42]));
    const binary = await readTextFileCapped(binaryPath);
    assert.equal(binary.binary, true);
    assert.equal(binary.text, null);
    assert.equal(binary.lines, 0);
    const capped = await readTextFileCapped(textPath, 3);
    assert.equal(capped.binary, false);
    assert.equal(capped.text, 'a\nb');
    assert.equal(capped.truncated, true);
    await assert.rejects(readTextFileCapped(path.join(fixture.root, 'reader', 'nope.txt')));
  });

  await run('buildPatch honors combined/staged/worktree and context', async () => {
    resetRepoRootCache();
    const combined = await buildPatch(fixture.alphaRoot, 'modify.ts', 'combined', 3);
    assert.equal(combined.truncated, false);
    assert.match(combined.patch, /@@ -1,2 \+1,3 @@/);
    assert.match(combined.patch, /-export const b = 2;/);

    const staged = await buildPatch(fixture.alphaRoot, 'modify.ts', 'staged', 3);
    assert.equal(staged.patch, '');

    const worktree = await buildPatch(fixture.alphaRoot, 'modify.ts', 'worktree', 3);
    assert.match(worktree.patch, /@@ -1,2 \+1,3 @@/);

    const addedStaged = await buildPatch(fixture.alphaRoot, 'added.txt', 'staged', 3);
    assert.match(addedStaged.patch, /new file mode 100644/);
    const addedWorktree = await buildPatch(fixture.alphaRoot, 'added.txt', 'worktree', 3);
    assert.equal(addedWorktree.patch, '');

    const narrow = await buildPatch(fixture.alphaRoot, 'modify.ts', 'combined', 0);
    assert.match(narrow.patch, /@@ -2 \+2,2 @@/);
    assert.doesNotMatch(narrow.patch, /^ export const a = 1;$/m);

    const unborn = await buildPatch(fixture.betaRoot, 'first.md', 'combined', 3);
    assert.match(unborn.patch, /new file mode 100644/);
    assert.match(unborn.patch, /\+# first/);
  });

  await run('revertFile restores, deletes and unwinds renames on real git', async () => {
    resetRepoRootCache();
    const root = fixture.unitRoot;
    write(root, 'u.txt', 'changed\n');
    assert.equal(await revertFile(root, 'u.txt', null, true), 'restored');
    assert.equal(fs.readFileSync(path.join(root, 'u.txt'), 'utf8'), 'base\n');
    assertClean(root, 'u.txt');

    write(root, 'new.txt', 'temporary\n');
    assert.equal(await revertFile(root, 'new.txt', null, true), 'deleted');
    assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
    assertClean(root, 'new.txt');

    git(root, ['mv', 'u.txt', 'moved.txt']);
    assert.equal(await revertFile(root, 'moved.txt', 'u.txt', true), 'deleted');
    assert.equal(fs.existsSync(path.join(root, 'moved.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, 'u.txt'), 'utf8'), 'base\n');
    assertClean(root, 'moved.txt');
    assertClean(root, 'u.txt');
  });

  group('Layer 2 - panel artifacts and i18n (static source, deterministic)');

  await run('built artifacts exist with the expected sizes', () => {
    for (const file of [BUILT_SERVICE, BUILT_PANEL, path.join(BUILT_ROOT, 'panel', 'index.html'), path.join(BUILT_ROOT, 'panel', 'style.css')]) {
      assert.ok(fs.existsSync(file), `missing built artifact: ${file}`);
      assert.ok(fs.statSync(file).size > 0, `empty built artifact: ${file}`);
    }
    assert.ok(fs.statSync(BUILT_PANEL).size > 50_000);
    assert.ok(fs.statSync(BUILT_SERVICE).size > 10_000);
  });

  await run('panel HTML wires only local assets and never talks to the network', () => {
    const html = fs.readFileSync(path.join(PACKAGE_ROOT, 'panel', 'index.html'), 'utf8');
    assert.match(html, /href="style\.css"/);
    assert.match(html, /src="main\.js"/);
    assert.doesNotMatch(html, /src="https?:/);
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'panel', 'main.ts'), 'utf8');
    assert.match(source, /host\.serviceRequest\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /XMLHttpRequest/);
    assert.doesNotMatch(source, /OPENCHAMBER_SERVICE_TOKEN/);
    assert.doesNotMatch(source, /Authorization/);
    const builtPanel = fs.readFileSync(BUILT_PANEL, 'utf8');
    assert.match(builtPanel, /serviceRequest/);
    assert.doesNotMatch(builtPanel, /\bfetch\s*\(/);
    assert.doesNotMatch(builtPanel, /XMLHttpRequest/);
  });

  await run('registry and manifest advertise the panel and the service', () => {
    const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages', 'extensions', 'registry.json'), 'utf8'));
    const entry = registry.extensions.find((candidate) => candidate.id === 'openchamber-builtin-multirepo-diff');
    assert.ok(entry, 'multirepo-diff must be in the built-in registry');
    assert.deepEqual(entry.files, ['panel/index.html', 'panel/style.css']);
    assert.equal(entry.build.length, 2);
    const manifest = JSON.parse(fs.readFileSync(path.join(BUILT_ROOT, 'package.json'), 'utf8'));
    assert.equal(manifest.openchamber.contributes.panel.id, 'openchamber-builtin-multirepo-diff');
    assert.equal(manifest.openchamber.contributes.service.entry, 'service/main.js');
  });

  await run('i18n ships every English key in all 11 non-English dictionaries', () => {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'panel', 'i18n.ts'), 'utf8');
    const enKeys = extractEnKeys(source);
    assert.equal(enKeys.length, 74, 'the en dictionary must expose 74 keys');
    assert.equal(new Set(enKeys).size, enKeys.length, 'en keys must be unique');
    const blocks = extractDictBlocks(source);
    assert.deepEqual([...blocks.keys()], ['de', 'fr', 'zhCN', 'zhTW', 'uk', 'es', 'ptBR', 'ko', 'pl', 'ja', 'tr']);
    assert.equal(LOCALES.length, 12);
    for (const [name, block] of blocks) {
      const keys = dictKeys(block);
      assert.deepEqual([...keys].sort(), [...enKeys].sort(), `locale ${name} must translate every key`);
      assert.equal(new Set(keys).size, keys.length, `locale ${name} must not duplicate keys`);
    }
  });

  await run('i18n placeholders are preserved and pt-BR labels are exact', () => {
    const source = fs.readFileSync(path.join(PACKAGE_ROOT, 'src', 'panel', 'i18n.ts'), 'utf8');
    const enBlock = source.slice(source.indexOf('const en = {'), source.indexOf('} as const;'));
    const enValues = dictValues(enBlock);
    const blocks = extractDictBlocks(source);
    for (const [name, block] of blocks) {
      const values = dictValues(block);
      for (const [key, rawValue] of values) {
        assert.deepEqual(placeholders(rawValue), placeholders(enValues.get(key) ?? ''), `${name}.${key} placeholders`);
      }
    }
    const pt = createTranslator('pt-BR');
    assert.equal(pt('revertFile'), 'Reverter Este Arquivo');
    assert.equal(pt('revertRepo'), 'Reverter Este Repositório');
    assert.equal(pt('revertRoom'), 'Reverter Tudo Desta Sala');
    const body = pt('revertRepoBody', { count: 3, repo: 'alpha' });
    assert.match(body, /3/);
    assert.match(body, /alpha/);
    assert.doesNotMatch(body, /\{\w+\}/);
  });

  await run('normalizeLocale maps aliases and falls back to English', () => {
    assert.equal(normalizeLocale('pt-BR'), 'pt-BR');
    assert.equal(normalizeLocale('pt'), 'pt-BR');
    assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
    assert.equal(normalizeLocale('zh'), 'zh-CN');
    assert.equal(normalizeLocale('zh-TW'), 'zh-TW');
    assert.equal(normalizeLocale('de-AT'), 'de');
    assert.equal(normalizeLocale('EN-us'), 'en');
    assert.equal(normalizeLocale('xx-YY'), 'en');
    assert.equal(normalizeLocale(''), 'en');
    assert.equal(normalizeLocale(undefined), 'en');
    assert.equal(createTranslator('zz')('revertFile'), createTranslator('en')('revertFile'));
  });

  group('Layer 3 - compiled service over real HTTP, git and SQLite');

  const port = await freePort();
  const service = await startService(BUILT_SERVICE, fixture.dbPath, port);
  await waitHealthy(service, port);

  await run('health requires the bearer token and reports readiness', async () => {
    expectError(await request(port, { path: '/health', token: null }), 401, 'unauthorized');
    expectError(await request(port, { path: '/health', token: 'wrong' }), 401, 'unauthorized');
    const ok = await request(port, { path: '/health' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true });
  });

  await run('rooms rejects unauthenticated requests', async () => {
    expectError(await getRooms(port, {}, null), 401, 'unauthorized');
    expectError(await getRooms(port, {}, 'wrong-token'), 401, 'unauthorized');
  });

  await run('rooms lists every active room with real git counts', async () => {
    const response = await getRooms(port, { status: 'active' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers['content-type']), /application\/json/);
    assert.equal(response.json.database, path.resolve(fixture.dbPath));
    assert.ok(!Number.isNaN(Date.parse(response.json.generatedAt)));
    assert.deepEqual(
      response.json.rooms.map((room) => room.id),
      [ROOM_OVERFLOW, ROOM_ACTIVE, ROOM_EMPTY],
    );

    const room = findRoom(response.json, ROOM_ACTIVE);
    assert.equal(room.name, 'suite-active');
    assert.equal(room.status, 'active');
    assert.equal(room.leadAgent, 'dante');
    assert.equal(room.createdAt, new Date(4_000_000).toISOString());
    assert.equal(room.updatedAt, new Date(4_000_100).toISOString());
    assert.equal(room.memberCount, 3);
    assert.deepEqual(
      room.repos.map((repo) => repo.name),
      ['alpha-repo', 'beta-unborn', 'broken-git'],
    );

    const alpha = findRepo(room, 'alpha-repo');
    assert.equal(alpha.root, fixture.alphaRoot);
    assert.equal(alpha.branch, 'main');
    assert.match(alpha.head, /^[0-9a-f]{40}$/);
    assert.equal(alpha.dirty, true);
    assert.equal(alpha.error, null);
    assert.equal(alpha.truncatedFiles, 0);
    assert.deepEqual(alpha.counts, {
      files: 8,
      added: 1,
      modified: 2,
      deleted: 1,
      renamed: 1,
      untracked: 2,
      clean: 1,
    });
    assert.deepEqual(
      alpha.files.map((file) => file.path),
      ['added.txt', 'blob.bin', 'delete.txt', 'keep.txt', 'modify.ts', 'nested/deep/file.md', 'rename-new.txt', 'untracked.txt'],
    );
    for (const file of alpha.files) {
      assert.equal(file.absolutePath, path.join(alpha.root, ...file.path.split('/')));
    }

    const added = findFile(alpha, 'added.txt');
    assert.deepEqual(
      { status: added.status, code: added.code, staged: added.staged, unstaged: added.unstaged, additions: added.additions, deletions: added.deletions, binary: added.binary },
      { status: 'added', code: 'A ', staged: true, unstaged: false, additions: 1, deletions: 0, binary: false },
    );
    const modified = findFile(alpha, 'modify.ts');
    assert.deepEqual(
      { status: modified.status, additions: modified.additions, deletions: modified.deletions },
      { status: 'modified', additions: 2, deletions: 1 },
    );
    const deleted = findFile(alpha, 'delete.txt');
    assert.deepEqual(
      { status: deleted.status, code: deleted.code, additions: deleted.additions, deletions: deleted.deletions },
      { status: 'deleted', code: ' D', additions: 0, deletions: 1 },
    );
    const renamed = findFile(alpha, 'rename-new.txt');
    assert.deepEqual(
      { status: renamed.status, code: renamed.code, previousPath: renamed.previousPath, staged: renamed.staged },
      { status: 'renamed', code: 'R ', previousPath: 'rename-old.txt', staged: true },
    );
    const untracked = findFile(alpha, 'untracked.txt');
    assert.deepEqual(
      { status: untracked.status, code: untracked.code, additions: untracked.additions, deletions: untracked.deletions },
      { status: 'untracked', code: '??', additions: 2, deletions: 0 },
    );
    const binary = findFile(alpha, 'blob.bin');
    assert.deepEqual(
      { status: binary.status, binary: binary.binary, additions: binary.additions, deletions: binary.deletions },
      { status: 'modified', binary: true, additions: null, deletions: null },
    );
    const clean = findFile(alpha, 'keep.txt');
    assert.deepEqual(
      { status: clean.status, code: clean.code, staged: clean.staged, unstaged: clean.unstaged, additions: clean.additions },
      { status: 'clean', code: null, staged: false, unstaged: false, additions: 0 },
    );

    const beta = findRepo(room, 'beta-unborn');
    assert.equal(beta.root, fixture.betaRoot);
    assert.equal(beta.branch, null);
    assert.equal(beta.head, null);
    assert.equal(beta.dirty, true);
    assert.deepEqual(beta.counts, { files: 1, added: 1, modified: 0, deleted: 0, renamed: 0, untracked: 0, clean: 0 });
    assert.equal(findFile(beta, 'first.md').status, 'added');
    assert.equal(findFile(beta, 'first.md').additions, 1);

    const broken = findRepo(room, 'broken-git');
    assert.equal(broken.root, fixture.brokenRoot);
    assert.match(broken.error, /^cannot read git status:/);
    assert.equal(broken.dirty, false);
    assert.deepEqual(broken.files, []);
    assert.deepEqual(broken.counts, { files: 0, added: 0, modified: 0, deleted: 0, renamed: 0, untracked: 0, clean: 0 });

    assert.deepEqual(room.totals, { repos: 3, files: 9, dirtyFiles: 8 });
    assert.deepEqual(room.errors, [{ path: fixture.looseFile, reason: 'not-a-git-repository' }]);
  });

  await run('rooms filters archived/all and caps the loose-path warnings', async () => {
    const archived = await getRooms(port, { status: 'archived' });
    assert.equal(archived.status, 200);
    assert.deepEqual(archived.json.rooms.map((room) => room.id), [ROOM_ARCHIVED]);
    const archivedRoom = findRoom(archived.json, ROOM_ARCHIVED);
    assert.equal(archivedRoom.status, 'archived');
    assert.equal(archivedRoom.memberCount, 2);
    assert.deepEqual(archivedRoom.repos, []);
    assert.deepEqual(archivedRoom.totals, { repos: 0, files: 0, dirtyFiles: 0 });

    const all = await getRooms(port, { status: 'all' });
    assert.deepEqual(
      all.json.rooms.map((room) => room.id),
      [ROOM_OVERFLOW, ROOM_ACTIVE, ROOM_ARCHIVED, ROOM_EMPTY],
    );
    const empty = findRoom(all.json, ROOM_EMPTY);
    assert.deepEqual(empty.repos, []);
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.totals, { repos: 0, files: 0, dirtyFiles: 0 });

    const overflow = findRoom(all.json, ROOM_OVERFLOW);
    assert.equal(overflow.errors.length, 21);
    for (const entry of overflow.errors.slice(0, 20)) assert.equal(entry.reason, 'not-a-git-repository');
    assert.deepEqual(overflow.errors[20], { path: '', reason: '2 additional paths omitted' });

    expectError(await getRooms(port, { status: 'pending' }), 400, 'invalid-status');
  });

  await run('diff exposes structured hunks for a modified file', async () => {
    const response = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'modify.ts' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const body = response.json;
    assert.deepEqual(
      {
        room: body.room,
        repo: body.repo,
        file: body.file,
        status: body.status,
        view: body.view,
        staged: body.staged,
        unstaged: body.unstaged,
        additions: body.additions,
        deletions: body.deletions,
        binary: body.binary,
        truncated: body.truncated,
        language: body.language,
      },
      {
        room: ROOM_ACTIVE,
        repo: fixture.alphaRoot,
        file: 'modify.ts',
        status: 'modified',
        view: 'combined',
        staged: false,
        unstaged: true,
        additions: 2,
        deletions: 1,
        binary: false,
        truncated: false,
        language: 'typescript',
      },
    );
    assert.equal(body.hunks.length, 1);
    assert.deepEqual(body.hunks[0], {
      header: '@@ -1,2 +1,3 @@',
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 3,
      lines: [
        { type: 'context', text: 'export const a = 1;', oldNumber: 1, newNumber: 1 },
        { type: 'del', text: 'export const b = 2;', oldNumber: 2, newNumber: null },
        { type: 'add', text: 'export const b = 3;', oldNumber: null, newNumber: 2 },
        { type: 'add', text: 'export const c = 4;', oldNumber: null, newNumber: 3 },
      ],
    });
    assert.match(body.patch, /^diff --git a\/modify\.ts b\/modify\.ts$/m);
  });

  await run('diff view=staged/worktree and context=0 are faithful', async () => {
    const staged = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'modify.ts', view: 'staged' });
    assert.equal(staged.status, 200);
    assert.equal(staged.json.hunks.length, 0);
    assert.equal(staged.json.patch, '');

    const worktree = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'modify.ts', view: 'worktree' });
    assert.equal(worktree.json.hunks.length, 1);

    const addedStaged = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'added.txt', view: 'staged' });
    assert.match(addedStaged.json.patch, /new file mode 100644/);
    const addedWorktree = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'added.txt', view: 'worktree' });
    assert.equal(addedWorktree.json.patch, '');

    const narrow = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'modify.ts', context: '0' });
    assert.equal(narrow.json.hunks.length, 1);
    assert.equal(narrow.json.hunks[0].header, '@@ -2 +2,2 @@ export const a = 1;');
    assert.equal(narrow.json.hunks[0].oldLines, 1);
    assert.equal(narrow.json.hunks[0].newLines, 2);
    assert.deepEqual(
      narrow.json.hunks[0].lines.map((line) => line.type),
      ['del', 'add', 'add'],
    );
  });

  await run('diff synthesizes untracked files and reports clean/binary files', async () => {
    const untracked = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'untracked.txt' });
    assert.equal(untracked.status, 200);
    assert.equal(untracked.json.status, 'untracked');
    assert.equal(untracked.json.staged, false);
    assert.equal(untracked.json.unstaged, true);
    assert.equal(untracked.json.additions, 2);
    assert.equal(untracked.json.deletions, 0);
    assert.equal(untracked.json.binary, false);
    assert.equal(untracked.json.language, 'text');
    assert.equal(
      untracked.json.patch,
      [
        'diff --git a/untracked.txt b/untracked.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/untracked.txt',
        '@@ -0,0 +1,2 @@',
        '+l1',
        '+l2',
        '',
      ].join('\n'),
    );
    assert.deepEqual(untracked.json.hunks, [
      {
        header: '@@ -0,0 +1,2 @@',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 2,
        lines: [
          { type: 'add', text: 'l1', oldNumber: null, newNumber: 1 },
          { type: 'add', text: 'l2', oldNumber: null, newNumber: 2 },
        ],
      },
    ]);

    const nested = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'nested/deep/file.md' });
    assert.equal(nested.json.status, 'untracked');
    assert.equal(nested.json.additions, 1);
    assert.equal(nested.json.language, 'markdown');

    const clean = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'keep.txt' });
    assert.deepEqual(
      { status: clean.json.status, patch: clean.json.patch, hunks: clean.json.hunks, additions: clean.json.additions, deletions: clean.json.deletions },
      { status: 'clean', patch: '', hunks: [], additions: 0, deletions: 0 },
    );

    const binary = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'blob.bin' });
    assert.deepEqual(
      { status: binary.json.status, binary: binary.json.binary, additions: binary.json.additions, deletions: binary.json.deletions, patch: binary.json.patch, hunks: binary.json.hunks },
      { status: 'modified', binary: true, additions: null, deletions: null, patch: '', hunks: [] },
    );
  });

  await run('diff renders deletions, renames and unborn-repo additions', async () => {
    const deleted = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'delete.txt' });
    assert.equal(deleted.json.status, 'deleted');
    assert.equal(deleted.json.additions, 0);
    assert.equal(deleted.json.deletions, 1);
    assert.deepEqual(deleted.json.hunks[0].lines, [
      { type: 'del', text: 'bye', oldNumber: 1, newNumber: null },
    ]);
    assert.match(deleted.json.patch, /deleted file mode 100644/);

    const renamed = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'rename-new.txt' });
    assert.equal(renamed.json.status, 'renamed');
    assert.equal(renamed.json.additions, 1);
    assert.equal(renamed.json.deletions, 0);
    assert.match(renamed.json.patch, /new file mode 100644/);
    assert.match(renamed.json.patch, /\+rename me/);

    const unborn = await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.betaRoot, file: 'first.md' });
    assert.equal(unborn.json.status, 'added');
    assert.equal(unborn.json.additions, 1);
    assert.equal(unborn.json.deletions, 0);
    assert.equal(unborn.json.language, 'markdown');
    assert.match(unborn.json.patch, /\+# first/);

    const absolute = await getDiff(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: path.join(fixture.alphaRoot, 'modify.ts'),
    });
    assert.equal(absolute.status, 200);
    assert.equal(absolute.json.file, 'modify.ts');
  });

  await run('diff rejects missing params, bad enums and unknown rooms', async () => {
    expectError(await getDiff(port, { repo: fixture.alphaRoot, file: 'keep.txt' }), 400, 'missing-room');
    expectError(await getDiff(port, { room: ROOM_ACTIVE, file: 'keep.txt' }), 400, 'missing-repo');
    expectError(await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot }), 400, 'missing-file');
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'keep.txt', view: 'sideways' }),
      400,
      'invalid-view',
    );
    for (const context of ['51', '-1', 'abc', '3x', '3.5']) {
      expectError(
        await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'keep.txt', context }),
        400,
        'invalid-context',
      );
    }
    expectError(
      await getDiff(port, { room: 'team_does_not_exist', repo: fixture.alphaRoot, file: 'keep.txt' }),
      404,
      'unknown-room',
    );
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.gammaRoot, file: 'gamma.txt' }),
      404,
      'repo-not-in-room',
    );
  });

  await run('diff blocks traversal, absolute escapes and symlink escapes', async () => {
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: '../../etc/passwd' }),
      403,
      'path-outside-repo',
    );
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: '/etc/passwd' }),
      403,
      'path-outside-repo',
    );
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'escape-link' }),
      403,
      'path-outside-repo',
    );
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'missing.txt' }),
      404,
      'file-not-found',
    );
    expectError(
      await getDiff(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'bad\u0000.txt' }),
      400,
      'invalid-payload',
    );
    expectError(await request(port, { path: '/api/multirepo/unknown' }), 404, 'not-found');
  });

  group('Layer 4 - revert semantics (atomic, scoped, no collateral)');

  await run('revert scope=file restores a modified file and is idempotent', async () => {
    const response = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'modify.ts',
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.scope, 'file');
    assert.deepEqual(response.json.reverted, [
      { repo: fixture.alphaRoot, path: 'modify.ts', status: 'modified', action: 'restored' },
    ]);
    assert.deepEqual(response.json.skipped, []);
    assert.deepEqual(response.json.counts, { reverted: 1, skipped: 0 });
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'modify.ts'), 'utf8'), 'export const a = 1;\nexport const b = 2;\n');
    assertClean(fixture.alphaRoot, 'modify.ts');

    const again = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'modify.ts',
    });
    assert.equal(again.status, 200);
    assert.deepEqual(again.json.reverted, []);
    assert.deepEqual(again.json.skipped, [
      { repo: fixture.alphaRoot, path: 'modify.ts', reason: 'already-clean' },
    ]);
    assert.deepEqual(again.json.counts, { reverted: 0, skipped: 1 });
  });

  await run('revert scope=file deletes untracked/staged additions and unwinds renames', async () => {
    const untracked = await postRevert(port, {
      room: ROOM_ACTIVE,
      file: path.join(fixture.alphaRoot, 'untracked.txt'),
    });
    assert.equal(untracked.status, 200);
    assert.equal(untracked.json.scope, 'file');
    assert.deepEqual(untracked.json.reverted, [
      { repo: fixture.alphaRoot, path: 'untracked.txt', status: 'untracked', action: 'deleted' },
    ]);
    assert.equal(fs.existsSync(path.join(fixture.alphaRoot, 'untracked.txt')), false);
    assertClean(fixture.alphaRoot, 'untracked.txt');

    const added = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'added.txt',
    });
    assert.deepEqual(added.json.reverted, [
      { repo: fixture.alphaRoot, path: 'added.txt', status: 'added', action: 'deleted' },
    ]);
    assert.equal(fs.existsSync(path.join(fixture.alphaRoot, 'added.txt')), false);
    assertClean(fixture.alphaRoot, 'added.txt');

    const renamed = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'rename-new.txt',
    });
    assert.deepEqual(renamed.json.reverted, [
      { repo: fixture.alphaRoot, path: 'rename-new.txt', status: 'renamed', action: 'deleted' },
    ]);
    assert.equal(fs.existsSync(path.join(fixture.alphaRoot, 'rename-new.txt')), false);
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'rename-old.txt'), 'utf8'), 'rename me\n');
    assertClean(fixture.alphaRoot, 'rename-new.txt');
    assertClean(fixture.alphaRoot, 'rename-old.txt');
  });

  await run('revert scope=file restores deletions and binary content byte-for-byte', async () => {
    const deleted = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'delete.txt',
    });
    assert.deepEqual(deleted.json.reverted, [
      { repo: fixture.alphaRoot, path: 'delete.txt', status: 'deleted', action: 'restored' },
    ]);
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'delete.txt'), 'utf8'), 'bye\n');

    const binary = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'blob.bin',
    });
    assert.deepEqual(binary.json.reverted, [
      { repo: fixture.alphaRoot, path: 'blob.bin', status: 'modified', action: 'restored' },
    ]);
    assert.deepEqual(fs.readFileSync(path.join(fixture.alphaRoot, 'blob.bin')), fixture.blobOriginal);
    assertClean(fixture.alphaRoot, 'blob.bin');
  });

  await run('revert scope=repo touches only the room ledger and preserves foreign dirt', async () => {
    assert.equal(gitStatus(fixture.alphaRoot, 'other-unrelated.txt'), ' M other-unrelated.txt');
    const response = await postRevert(port, {
      room: ROOM_ACTIVE,
      scope: 'repo',
      repo: fixture.alphaRoot,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.scope, 'repo');
    assert.deepEqual(response.json.reverted, [
      { repo: fixture.alphaRoot, path: 'nested/deep/file.md', status: 'untracked', action: 'deleted' },
    ]);
    const skippedPaths = response.json.skipped.map((entry) => entry.path);
    assert.deepEqual(skippedPaths, [
      'added.txt',
      'blob.bin',
      'delete.txt',
      'keep.txt',
      'modify.ts',
      'rename-new.txt',
      'untracked.txt',
    ]);
    assert.ok(response.json.skipped.every((entry) => entry.reason === 'already-clean'));
    assert.deepEqual(response.json.counts, { reverted: 1, skipped: 7 });

    // The unrelated dirty file was never in the ledger: it must stay dirty.
    assert.equal(gitStatus(fixture.alphaRoot, 'other-unrelated.txt'), ' M other-unrelated.txt');
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'other-unrelated.txt'), 'utf8'), 'dirty but not ledger\n');
  });

  await run('revert scope=room reverts every repo and skips non-git paths', async () => {
    const response = await postRevert(port, { room: ROOM_ACTIVE, scope: 'room' });
    assert.equal(response.status, 200);
    assert.equal(response.json.scope, 'room');
    assert.deepEqual(response.json.reverted, [
      { repo: fixture.betaRoot, path: 'first.md', status: 'added', action: 'deleted' },
    ]);
    assert.equal(response.json.skipped.length, 10);
    assert.equal(response.json.skipped.filter((entry) => entry.reason === 'not-a-git-repository').length, 1);
    assert.equal(response.json.skipped.filter((entry) => entry.reason.startsWith('cannot read git status:')).length, 1);
    assert.deepEqual(response.json.counts, { reverted: 1, skipped: 10 });
    assert.equal(fs.existsSync(path.join(fixture.betaRoot, 'first.md')), false);
    assertClean(fixture.betaRoot, 'first.md');
    assert.equal(fs.existsSync(fixture.looseFile), true, 'loose files outside git must never be deleted');
    assert.equal(gitStatus(fixture.alphaRoot, 'other-unrelated.txt'), ' M other-unrelated.txt');
  });

  await run('rooms cache is invalidated by a successful revert', async () => {
    const before = await getRooms(port, { status: 'active', refresh: '1' });
    const activeBefore = findRoom(before.json, ROOM_ACTIVE);
    assert.equal(findRepo(activeBefore, 'alpha-repo').dirty, false);
    assert.equal(findRepo(activeBefore, 'beta-unborn').dirty, false);
    assert.deepEqual(activeBefore.totals, { repos: 3, files: 9, dirtyFiles: 0 });

    // Re-dirty a ledger file, force-refresh the cache, revert, then read again
    // WITHOUT refresh: the invalidation inside the revert path must win.
    write(fixture.alphaRoot, 'keep.txt', 'dirty again\n');
    const primed = await getRooms(port, { status: 'active', refresh: '1' });
    assert.equal(findRepo(findRoom(primed.json, ROOM_ACTIVE), 'alpha-repo').dirty, true);
    const reverted = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'keep.txt',
    });
    assert.equal(reverted.status, 200);
    const after = await getRooms(port, { status: 'active' });
    const alphaAfter = findRepo(findRoom(after.json, ROOM_ACTIVE), 'alpha-repo');
    assert.equal(alphaAfter.dirty, false);
    assert.equal(findFile(alphaAfter, 'keep.txt').status, 'clean');
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'keep.txt'), 'utf8'), 'keep\n');
  });

  await run('revert is idempotent at room scope', async () => {
    const response = await postRevert(port, { room: ROOM_ACTIVE, scope: 'room' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.json.reverted, []);
    assert.equal(response.json.counts.reverted, 0);
    assert.equal(response.json.counts.skipped, 11);
  });

  await run('revert rejects malformed payloads and unknown scopes', async () => {
    expectError(await request(port, { method: 'POST', path: '/api/multirepo/revert', rawBody: 'not json' }), 400, 'invalid-payload');
    expectError(await request(port, { method: 'POST', path: '/api/multirepo/revert', rawBody: '[]' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { scope: 'room' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { room: ROOM_ACTIVE, scope: 'galaxy' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { room: ROOM_ACTIVE, scope: 'file' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { room: ROOM_ACTIVE, scope: 'repo' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { room: ROOM_ACTIVE, file: 'keep.txt' }), 400, 'invalid-payload');
    expectError(await postRevert(port, { room: 'team_nope', scope: 'room' }), 404, 'unknown-room');
    expectError(
      await postRevert(port, { room: ROOM_ACTIVE, scope: 'repo', repo: fixture.gammaRoot }),
      404,
      'repo-not-in-room',
    );
    expectError(
      await postRevert(port, { room: ROOM_ACTIVE, scope: 'repo', repo: path.join(fixture.root, 'not-a-repo') }),
      404,
      'unknown-repo',
    );
    expectError(
      await postRevert(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'other-unrelated.txt' }),
      404,
      'file-not-in-room',
    );
    expectError(
      await postRevert(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: fixture.betaRoot + '/first.md' }),
      403,
      'path-outside-repo',
    );
    expectError(await postRevert(port, { room: ROOM_EMPTY, scope: 'room' }), 409, 'nothing-to-revert');
  });

  await run('concurrent reverts on the same repo are serialized without corruption', async () => {
    write(fixture.alphaRoot, 'keep.txt', 'racy\n');
    const [left, right] = await Promise.all([
      postRevert(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'keep.txt' }),
      postRevert(port, { room: ROOM_ACTIVE, repo: fixture.alphaRoot, file: 'keep.txt' }),
    ]);
    assert.equal(left.status, 200);
    assert.equal(right.status, 200);
    for (const response of [left, right]) {
      assert.equal(response.json.counts.reverted + response.json.counts.skipped, 1);
    }
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'keep.txt'), 'utf8'), 'keep\n');
    assertClean(fixture.alphaRoot, 'keep.txt');
  });

  group('Layer 5 - mutation probes (bundle copies, real processes)');

  await run('mutation: auth bypass is caught by the 401 assertions', async () => {
    const entry = writeMutant(fixture.root, 'no-auth', (source) => {
      const from = 'if (req.headers.authorization !== `Bearer ${token}`) {';
      assert.ok(source.includes(from), 'auth anchor must exist in the compiled bundle');
      return source.replace(from, 'if (false) {');
    });
    const mutantPort = await freePort();
    const mutant = await startService(entry, fixture.dbPath, mutantPort);
    await waitHealthy(mutant, mutantPort);
    const response = await getRooms(mutantPort, {}, null);
    assert.equal(response.status, 200, 'the mutant must expose the bypass the baseline test rejects');
    assert.ok(Array.isArray(response.json.rooms));
    await stopService(mutant);
  });

  await run('mutation: removing the path guards is caught by the 403 assertions', async () => {
    const entry = writeMutant(fixture.root, 'no-path-guard', (source) => {
      const anchors = [
        'if (!isInside(root, absolute) || absolute === path3.resolve(root)) {',
        'if (!isInside(realRoot, real))',
        'if (!isInside(realRoot, realParent))',
      ];
      let mutated = source;
      for (const anchor of anchors) {
        assert.ok(mutated.includes(anchor), `path-guard anchor missing: ${anchor}`);
        mutated = mutated.split(anchor).join(anchor.includes('resolve(root)') ? 'if (false) {' : 'if (false)');
      }
      return mutated;
    });
    const mutantPort = await freePort();
    const mutant = await startService(entry, fixture.dbPath, mutantPort);
    await waitHealthy(mutant, mutantPort);
    const response = await getDiff(mutantPort, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: '/etc/passwd',
    });
    assert.equal(response.status, 200, 'the mutant must leak the outside path the baseline test blocks');
    assert.equal(response.json.status, 'clean');
    await stopService(mutant);
  });

  await run('mutation: dropping cache invalidation is caught by the stale-read assertion', async () => {
    const entry = writeMutant(fixture.root, 'no-cache-invalidation', (source) => {
      const anchor = 'invalidateRoomsCache();';
      assert.ok(source.includes(anchor), 'cache-invalidation anchor must exist');
      return source.replace(anchor, 'void 0;');
    });
    const mutantPort = await freePort();
    const mutant = await startService(entry, fixture.dbPath, mutantPort);
    await waitHealthy(mutant, mutantPort);

    const probe = async (targetPort) => {
      const primed = await getRooms(targetPort, { status: 'active', refresh: '1' });
      assert.equal(findRepo(findRoom(primed.json, ROOM_ACTIVE), 'alpha-repo').dirty, true);
      const reverted = await postRevert(targetPort, {
        room: ROOM_ACTIVE,
        repo: fixture.alphaRoot,
        file: 'keep.txt',
      });
      assert.equal(reverted.status, 200);
      const after = await getRooms(targetPort, { status: 'active' });
      return findRepo(findRoom(after.json, ROOM_ACTIVE), 'alpha-repo').dirty;
    };

    // Baseline service invalidates the cache: immediate read is fresh.
    write(fixture.alphaRoot, 'keep.txt', 'cache baseline dirty\n');
    assert.equal(await probe(port), false, 'baseline must invalidate the rooms cache');
    // Mutant keeps the stale entry for the 2s TTL: immediate read stays dirty.
    write(fixture.alphaRoot, 'keep.txt', 'cache mutant dirty\n');
    assert.equal(await probe(mutantPort), true, 'mutant must expose the stale cache the baseline test rejects');
    await stopService(mutant);
  });

  await run('mutation: dropping the rename pair revert is caught by the rename assertion', async () => {
    const entry = writeMutant(fixture.root, 'no-rename-pair', (source) => {
      const anchor = '  if (previousPath && previousPath !== relativePath) {';
      assert.ok(source.includes(anchor), 'rename-pair anchor must exist');
      return source.replace(anchor, '  if (false) {');
    });
    const mutantPort = await freePort();
    const mutant = await startService(entry, fixture.dbPath, mutantPort);
    await waitHealthy(mutant, mutantPort);

    // Baseline restores the origin.
    git(fixture.alphaRoot, ['mv', 'rename-old.txt', 'rename-new.txt']);
    const baseline = await postRevert(port, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'rename-new.txt',
    });
    assert.equal(baseline.status, 200);
    assert.equal(fs.readFileSync(path.join(fixture.alphaRoot, 'rename-old.txt'), 'utf8'), 'rename me\n');
    assertClean(fixture.alphaRoot, 'rename-old.txt');

    // Mutant leaves the origin deleted, which the baseline suite would catch.
    git(fixture.alphaRoot, ['mv', 'rename-old.txt', 'rename-new.txt']);
    const broken = await postRevert(mutantPort, {
      room: ROOM_ACTIVE,
      repo: fixture.alphaRoot,
      file: 'rename-new.txt',
    });
    assert.equal(broken.status, 200);
    assert.equal(fs.existsSync(path.join(fixture.alphaRoot, 'rename-new.txt')), false);
    assert.equal(fs.existsSync(path.join(fixture.alphaRoot, 'rename-old.txt')), false, 'mutant must not restore the origin');
    assert.match(gitStatus(fixture.alphaRoot, 'rename-old.txt'), /^ ?D/);
    await stopService(mutant);
  });

  group('Layer 6 - lifecycle and failure modes');

  await run('the service refuses to boot without port/token', () => {
    const env = { ...process.env };
    delete env.OPENCHAMBER_SERVICE_PORT;
    delete env.OPENCHAMBER_SERVICE_TOKEN;
    const result = spawnSync(NODE_BIN, [BUILT_SERVICE], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 1);
    assert.match(`${result.stderr}${result.stdout}`, /OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN/);
  });

  await run('a missing/unusable ledger yields 503 database-unavailable', async () => {
    for (const dbPath of [path.join(fixture.root, 'absent.db'), path.join(fixture.root, 'impostor.db')]) {
      const failingPort = await freePort();
      const failing = await startService(BUILT_SERVICE, dbPath, failingPort);
      await waitHealthy(failing, failingPort);
      const health = await request(failingPort, { path: '/health' });
      assert.deepEqual(health.json, { ok: true });
      expectError(await getRooms(failingPort, { status: 'active' }), 503, 'database-unavailable');
      const stopped = await stopService(failing);
      assert.equal(stopped.code, 0);
    }
  });

  await run('SIGTERM shuts the service down with exit 0 and frees the port', async () => {
    const stopped = await stopService(service);
    assert.equal(stopped.code, 0);
    assert.deepEqual(unexpectedErrors(service), []);
    await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()));
    });
  });

  for (const child of children) {
    if (child.exitCode === null) {
      const stopped = await stopService(child);
      assert.equal(stopped.code, 0);
    }
    assert.deepEqual(unexpectedErrors(child), []);
  }
};

try {
  await main();
} catch (error) {
  state.fail += 1;
  state.failures.push('<suite setup>');
  console.error('\nFATAL suite setup failure:');
  console.error(String(error && error.stack ? error.stack : error));
} finally {
  cleanup();
}

console.log(`\n${state.pass} passed, ${state.fail} failed`);
if (state.fail > 0) {
  console.error(`Failures:\n${state.failures.map((name) => ` - ${name}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('MULTIREPO-DIFF DETERMINISTIC SUITE: GREEN');
}
