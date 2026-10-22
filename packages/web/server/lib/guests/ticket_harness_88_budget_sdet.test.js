/**
 * SDET suite for TICKET-HARNESS-88 — host-side response budget + build lockstep.
 *
 * The implementation suites cover `response-budget.js`, `service.js`, the Kanban
 * panel and the CLI. This suite closes the gaps they leave:
 *
 *   1. the REAL `proxyGuestRequest` transport (request.js) against a REAL local
 *      HTTP server — no `globalThis.fetch` replacement, no stubs;
 *   2. the exact 2 MiB boundary (accepts exactly the limit, refuses limit + 1);
 *   3. chunked vs declared-Content-Length upstreams (both must never truncate);
 *   4. the warning band (1.5 MiB < size < 2 MiB) still reads verbatim;
 *   5. compiled-artifact lockstep: the Node runtime resolution of
 *      `@openchamber/sdk` (dist) and both shipped Kanban bundles agree with the
 *      source constants and advertise contract version 2.
 *
 * Run: bun test packages/web/server/lib/guests/ticket_harness_88_budget_sdet.test.js
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { guestAuthPersistPath, patchGuestAuth } from './auth-store.js';
import { proxyGuestRequest } from './request.js';
import { RESPONSE_TOO_LARGE, readWithinBudget, responseTooLargeResult } from './response-budget.js';
import { GUEST_REQUEST_RESPONSE_MAX, GUEST_REQUEST_RESPONSE_WARN } from '@openchamber/sdk';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(HERE, '..', '..', '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const BUILT_KANBAN = path.join(REPO_ROOT, 'packages', 'web', 'server', 'built-in-extensions', 'kanban');

const LIMIT = 2_097_152;
const WARN = 1_572_864;

/* ------------------------------------------------------------------ *
 * Real HTTP upstream
 * ------------------------------------------------------------------ */

const asciiJson = (length) => 'x'.repeat(length);

let server;
let origin;
let receivedAuth = [];
let persistDir;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    receivedAuth.push(req.headers.authorization);
    const url = new URL(req.url, 'http://127.0.0.1');
    const declared = url.searchParams.get('declared') === '1';
    const skip = url.searchParams.get('contentLength') === '0';
    const length = Number(url.searchParams.get('len') ?? '0');

    if (url.pathname === '/payload') {
      const body = asciiJson(length);
      const headers = { 'Content-Type': 'application/json' };
      // `contentLength=0` forces Transfer-Encoding: chunked (no declared size),
      // which must go through the streaming path of the reader.
      if (!skip) headers['Content-Length'] = String(Buffer.byteLength(body));
      res.writeHead(200, headers);
      res.end(body);
      return;
    }

    if (url.pathname === '/declared-mismatch') {
      // Announces more bytes than it sends: the reader must trust the announced
      // size only as an early signal and still never hand back a prefix.
      res.writeHead(200, { 'Content-Length': String(LIMIT + 10) });
      res.end('{"ok":true}');
      return;
    }

    if (url.pathname === '/unicode') {
      // 1.2M characters, 2.4M UTF-8 bytes: the protocol schema counts
      // characters, so this must never be sliced at all.
      const body = 'é'.repeat(length);
      res.writeHead(200, { 'Content-Length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end('{"error":"missing"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  persistDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-sdet-budget-'));
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(persistDir, { recursive: true, force: true });
});

const tokenGuest = {
  id: 'sdet-budget',
  integration: { name: 'SDET', description: 'budget probe', token: { apiOrigin: 'http://127.0.0.1' } },
};

const proxied = async (target) => {
  const guest = {
    ...tokenGuest,
    integration: { ...tokenGuest.integration, token: { apiOrigin: origin } },
  };
  const persistPath = guestAuthPersistPath(persistDir);
  await patchGuestAuth(guest.id, { accessToken: 'sdet-token', target: { apiOrigin: origin } }, persistPath);
  return proxyGuestRequest({ guest, persistPath, method: 'GET', path: target });
};

const assertStructured413 = (result) => {
  expect(result.status).toBe(413);
  // Never a prefix of the upstream answer: the body is a small, complete JSON
  // error document the consumer can explain.
  expect(result.body.length).toBeLessThan(1_024);
  const parsed = JSON.parse(result.body); // throws if the body was sliced
  expect(parsed.error.code).toBe(RESPONSE_TOO_LARGE);
  expect(parsed.error.limit).toBe(LIMIT);
  expect(parsed.error.received).toBeGreaterThan(LIMIT);
};

/* ================================================================== *
 * 1. Shared constants (source of truth)
 * ================================================================== */

describe('TICKET-HARNESS-88: the shared budget', () => {
  test('is 2 MiB with a 1.5 MiB warning, exported from the SDK', () => {
    expect(GUEST_REQUEST_RESPONSE_MAX).toBe(2_097_152);
    expect(GUEST_REQUEST_RESPONSE_WARN).toBe(1_572_864);
    expect(WARN * (4 / 3)).toBe(LIMIT);
  });
});

/* ================================================================== *
 * 2. Exact boundary, two transport framings
 * ================================================================== */

describe('TICKET-HARNESS-88 · F4: exact ceiling boundary', () => {
  test('a chunked body of exactly 2 MiB is accepted whole', async () => {
    const result = await readWithinBudget(new Response(new Response(asciiJson(LIMIT)).body));
    expect(result.ok).toBe(true);
    expect(result.text.length).toBe(LIMIT);
  });

  test('a chunked body of 2 MiB + 1 is refused, never sliced', async () => {
    const upstream = asciiJson(LIMIT + 1);
    const result = await readWithinBudget(new Response(new Response(upstream).body));
    expect(result.ok).toBe(false);
    expect(result.received).toBeGreaterThan(LIMIT);
  });

  test('the structured rejection is a complete JSON document at any size', () => {
    for (const received of [LIMIT + 1, 1_100_000_000]) {
      const result = responseTooLargeResult(received);
      expect(result.status).toBe(413);
      const parsed = JSON.parse(result.body);
      expect(parsed.error.received).toBe(received);
      expect(parsed.error.limit).toBe(LIMIT);
      expect(parsed.error.message).toContain('2097152');
    }
  });

  test('a declared Content-Length in bytes never rejects a body under the CHARACTER ceiling', async () => {
    // 1.2M characters of `é` = 2.4M UTF-8 bytes. The protocol ceiling is
    // characters (`z.string().max(GUEST_REQUEST_RESPONSE_MAX)`), so this body
    // is within budget even though its byte count is above 2 MiB.
    const response = await fetch(`${origin}/unicode?len=1200000`);
    expect(response.headers.get('content-length')).toBe('2400000');
    const result = await readWithinBudget(response);
    expect(result.ok).toBe(true);
    expect(result.text.length).toBe(1_200_000);
  });
});

/* ================================================================== *
 * 3. The REAL guest transport (request.js) against a REAL HTTP server
 * ================================================================== */

describe('TICKET-HARNESS-88 · F4: real proxyGuestRequest transport', () => {
  test('forwards the bearer and returns a small answer verbatim', async () => {
    receivedAuth = [];
    const result = await proxied('/payload?len=25');
    expect(result).toEqual({ status: 200, body: 'x'.repeat(25) });
    expect(receivedAuth).toEqual(['sdet-token']);
  });

  test('the warning band (1.6 MiB) still reads verbatim without blocking', async () => {
    const length = 1_600_000;
    expect(length).toBeGreaterThan(WARN);
    expect(length).toBeLessThan(LIMIT);
    const result = await proxied(`/payload?len=${length}`);
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(length);
    expect(result.body).toBe(asciiJson(length));
  });

  test('exactly 2 MiB is served whole through the real transport', async () => {
    const result = await proxied(`/payload?len=${LIMIT}&contentLength=0`);
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(LIMIT);
  });

  test('2 MiB + 1 chunked becomes a structured 413, never a truncated JSON', async () => {
    receivedAuth = [];
    const result = await proxied(`/payload?len=${LIMIT + 1}&contentLength=0`);
    assertStructured413(result);
    // Measured by decoding: the reported number is CHARACTERS.
    expect(JSON.parse(result.body).error.unit).toBe('characters');
    // The rejection is produced after reading, not by an auth failure.
    expect(receivedAuth).toEqual(['sdet-token']);
  });

  test('2 MiB + 1 with Content-Length is refused after counting, never sliced', async () => {
    const result = await proxied(`/payload?len=${LIMIT + 1}`);
    assertStructured413(result);
    // A declared size below 3x the ceiling only proves bytes, not characters, so
    // the reader counts them: ASCII 1 byte = 1 character.
    const parsed = JSON.parse(result.body);
    expect(parsed.error.received).toBe(LIMIT + 1);
    expect(parsed.error.unit).toBe('characters');
  });

  test('an oversized declared Content-Length is refused structurally even if the body is tiny', async () => {
    const result = await proxied('/declared-mismatch');
    assertStructured413(result);
    const parsed = JSON.parse(result.body);
    expect(parsed.error.received).toBe(LIMIT + 10);
    // The number came from the announced byte length, and says so.
    expect(parsed.error.unit).toBe('bytes');
  });

  test('a 1.2 MiB-character accented answer is served whole, never a false 413', async () => {
    const result = await proxied('/unicode?len=1200000');
    expect(result.status).toBe(200);
    expect(result.body.length).toBe(1_200_000);
    expect(result.body.startsWith('ééé')).toBe(true);
  });
});

/* ================================================================== *
 * 4. Compiled artifacts are in lockstep with the source of truth
 * ================================================================== */

const read = (file) => readFileSync(file, 'utf8');

describe('TICKET-HARNESS-88 · F1/F7: build lockstep', () => {
  test('the Node runtime resolves the SDK dist with the same 2 MiB / 1.5 MiB budget', () => {
    // The hosted server may run under `node`, which honours the package
    // `exports` → dist and does NOT read tsconfig paths. That artifact must be
    // rebuilt in lockstep with src, otherwise the daemon keeps the old 256 KB.
    const out = execFileSync(
      'node',
      ['--input-type=module', '-e',
        "import('@openchamber/sdk').then((m) => process.stdout.write(`${m.GUEST_REQUEST_RESPONSE_MAX} ${m.GUEST_REQUEST_RESPONSE_WARN}`))"],
      { cwd: path.join(REPO_ROOT, 'packages', 'web'), encoding: 'utf8' },
    );
    expect(out.trim()).toBe(`${LIMIT} ${WARN}`);
  });

  test('the shipped Kanban service bundle announces contract version 2 and serves bodies on demand', () => {
    const source = read(path.join(BUILT_KANBAN, 'service', 'main.js'));
    expect(source).toMatch(/KANBAN_CONTRACT_VERSION = 2/);
    expect(source).toContain('contractVersion: KANBAN_CONTRACT_VERSION');
    expect(source).toContain('/api/kanban/ticket');
    expect(source).toContain('includeBody');
  });

  test('the shipped Kanban panel bundle speaks v2, guards the version and fetches bodies', () => {
    const source = read(path.join(BUILT_KANBAN, 'panel', 'main.js'));
    expect(source).toContain('contract-version-mismatch');
    expect(source).toContain('/api/kanban/ticket');
    // Panel constant: `Zt=2` is the minified CONTRACT_VERSION of this bundle.
    expect(source).toMatch(/Zt=2[,;]/);
    expect(source).toContain('build lockstep');
  });

  test('the panel stylesheet ships the partial-failure and retry affordances', () => {
    const css = read(path.join(BUILT_KANBAN, 'panel', 'style.css'));
    expect(css).toContain('.kb-project-error');
    expect(css).toContain('.kb-body-retry');
  });
});
