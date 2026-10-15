/**
 * Deterministic tests for the OpenCode Go quota provider.
 *
 * No domain mocks: a real auth.json is written into an isolated temporary
 * HOME sandbox, and the module is imported dynamically so its load-time
 * AUTH_FILE path resolves inside that sandbox. Network is exercised through a
 * real transport recorder at the fetch boundary only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const previousEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  OPENCHAMBER_DATA_DIR: process.env.OPENCHAMBER_DATA_DIR,
};

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-opencode-go-'));
process.env.HOME = sandbox;
process.env.XDG_CONFIG_HOME = sandbox;
process.env.OPENCHAMBER_DATA_DIR = sandbox;

const authPath = path.join(sandbox, '.local', 'share', 'opencode', 'auth.json');

const writeAuth = (payload) => {
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(payload, null, 2), 'utf8');
};

const usageBody = () => JSON.stringify({
  usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } },
});

let aliases;
let fetchOpenCodeGoUsage;
let fetchQuota;
let isConfigured;
let parseOpenCodeGoUsage;

beforeAll(async () => {
  vi.resetModules();
  const mod = await import('./opencode-go.js');
  ({ aliases, fetchOpenCodeGoUsage, fetchQuota, isConfigured, parseOpenCodeGoUsage } = mod);
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(authPath, { force: true });
});

afterAll(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('OpenCode Go quota provider', () => {
  it('parses partial API usage windows', () => {
    const windows = parseOpenCodeGoUsage({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' }, weekly: { percent: 40, resetsAt: '2026-08-19T12:00:00.000Z' } } });
    expect(windows['5h'].usedPercent).toBe(25);
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-08-12T12:00:00.000Z'));
    expect(windows.weekly.usedPercent).toBe(40);
    expect(windows.monthly).toBeUndefined();
  });

  it('returns numeric reset timestamps for all usage windows', async () => {
    const resetsAt = '2026-10-01T00:00:00.000Z';
    const windows = await fetchOpenCodeGoUsage('test-key', async () => new Response(JSON.stringify({
      usage: {
        rolling: { percent: 25, resetsAt },
        weekly: { percent: 40, resetsAt },
        monthly: { percent: 60, resetsAt },
      },
    })));
    expect(Object.keys(windows)).toEqual(['5h', 'weekly', 'monthly']);
    for (const window of Object.values(windows)) {
      expect(window.resetAt).toBe(Date.parse(resetsAt));
    }
  });

  it('preserves valid windows when another reset date is invalid', () => {
    const windows = parseOpenCodeGoUsage({ usage: {
      rolling: { percent: 25, resetsAt: 'invalid' },
      weekly: { percent: 40, resetsAt: '2026-08-19T12:00:00.000Z' },
      monthly: { percent: 60, resetsAt: null },
    } });
    expect(Object.keys(windows)).toEqual(['weekly']);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-08-19T12:00:00.000Z'));
  });

  it('does not expose credentials in authentication errors', async () => {
    await expect(fetchOpenCodeGoUsage('secret', async () => new Response('', { status: 403 }))).rejects.toThrow('authentication failed');
  });

  it('uses the Go usage API with bearer authentication', async () => {
    let request;
    const usage = await fetchOpenCodeGoUsage('secret', async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ usage: { rolling: { percent: 25, resetsAt: '2026-08-12T12:00:00.000Z' } } }));
    });
    expect(request.url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(request.options.headers).toMatchObject({
      Accept: 'application/json',
      Authorization: 'Bearer secret',
      'x-opencode-session': 'openchamber-usage',
    });
    expect(request.options.headers.Cookie).toBeUndefined();
    expect(usage['5h'].usedPercent).toBe(25);
  });

  it('reads the API key from the OpenCode auth file', async () => {
    writeAuth({ 'opencode-go': { key: 'test-key' } });
    const legacyPath = path.join(sandbox, 'quota', 'opencode-go.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, '{not valid json', { mode: 0o600 });
    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      return new Response(usageBody());
    });
    const result = await fetchQuota();
    expect(result).toMatchObject({ providerId: 'opencode-go', ok: true, configured: true });
    expect(calls[0].options.headers.Authorization).toBe('Bearer test-key');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('declares both the opencode and opencode-go aliases', () => {
    expect(aliases).toEqual(['opencode', 'opencode-go']);
  });

  it('recognizes the opencode alias in auth.json', async () => {
    writeAuth({ opencode: { key: 'alias-key' } });
    expect(isConfigured()).toBe(true);

    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      return new Response(usageBody());
    });
    const result = await fetchQuota();
    expect(result).toMatchObject({ providerId: 'opencode-go', ok: true, configured: true });
    expect(calls[0].options.headers.Authorization).toBe('Bearer alias-key');
  });

  it('prefers the opencode alias over opencode-go when both are present', async () => {
    writeAuth({ 'opencode-go': { key: 'go-key' }, opencode: { key: 'alias-key' } });
    expect(isConfigured()).toBe(true);

    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      return new Response(usageBody());
    });
    await fetchQuota();
    expect(calls[0].options.headers.Authorization).toBe('Bearer alias-key');
  });

  it('accepts a raw string token entry under the opencode alias', async () => {
    writeAuth({ opencode: 'raw-token' });
    expect(isConfigured()).toBe(true);

    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      return new Response(usageBody());
    });
    await fetchQuota();
    expect(calls[0].options.headers.Authorization).toBe('Bearer raw-token');
  });

  it('reports unconfigured when neither alias is present', async () => {
    writeAuth({ anthropic: { key: 'unrelated' } });
    expect(isConfigured()).toBe(false);

    const calls = [];
    vi.stubGlobal('fetch', async (url, options) => {
      calls.push({ url, options });
      return new Response(usageBody());
    });
    const result = await fetchQuota();
    expect(result).toMatchObject({ providerId: 'opencode-go', ok: false, configured: false });
    expect(result.error).toBe('Not configured');
    expect(calls).toHaveLength(0);
  });
});
