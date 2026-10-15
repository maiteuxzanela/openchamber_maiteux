/**
 * Deterministic tests for resolveAntigravityAuth().
 *
 * No mocks: each case writes a real antigravity-accounts.json into an isolated
 * temporary HOME/XDG_CONFIG_HOME sandbox and re-imports the module so its
 * load-time path constants resolve inside that sandbox.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
};

let sandbox;
let configDir;

const accountsPath = () => path.join(configDir, 'antigravity-accounts.json');

const writeAccounts = (payload) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(accountsPath(), JSON.stringify(payload, null, 2), 'utf8');
};

const loadResolveAntigravityAuth = async () => {
  vi.resetModules();
  const mod = await import('./auth.js');
  return mod.resolveAntigravityAuth;
};

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-auth-'));
  configDir = path.join(sandbox, 'opencode');
  process.env.HOME = sandbox;
  process.env.XDG_CONFIG_HOME = sandbox;
});

afterEach(() => {
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
  vi.resetModules();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const quotaFor = (window, remainingFraction, resetTime) => ({
  gemini: { windows: [{ window, remainingFraction, resetTime }] },
});

const primaryQuota = quotaFor('5h', 0.1, '2026-10-01T00:00:00.000Z');
const geminiQuota = quotaFor('weekly', 0.75, '2026-10-08T00:00:00.000Z');

describe('resolveAntigravityAuth', () => {
  it('selects the activeIndexByFamily.gemini account even when activeIndex points elsewhere', async () => {
    writeAccounts({
      activeIndex: 0,
      activeIndexByFamily: { gemini: 1 },
      accounts: [
        {
          email: 'primary@antigravity.test',
          refreshToken: 'primary-refresh|primary-project',
          projectId: 'primary-project',
          cachedQuota: primaryQuota,
        },
        {
          email: 'gemini@antigravity.test',
          refreshToken: 'gemini-refresh|gemini-project|gemini-managed',
          cachedQuota: geminiQuota,
        },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth).not.toBeNull();
    expect(auth.sourceId).toBe('antigravity');
    expect(auth.sourceLabel).toBe('Antigravity');
    expect(auth.email).toBe('gemini@antigravity.test');
    expect(auth.refreshToken).toBe('gemini-refresh');
    expect(auth.projectId).toBe('gemini-project');
    expect(auth.cachedQuota).toEqual(geminiQuota);
    expect(auth.cachedQuota).not.toEqual(primaryQuota);
  });

  it('falls back to activeIndex when activeIndexByFamily is absent', async () => {
    writeAccounts({
      activeIndex: 1,
      accounts: [
        { email: 'primary@antigravity.test', refreshToken: 'primary-refresh|primary-project', cachedQuota: primaryQuota },
        { email: 'active@antigravity.test', refreshToken: 'active-refresh|active-project', cachedQuota: geminiQuota },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('active@antigravity.test');
    expect(auth.refreshToken).toBe('active-refresh');
    expect(auth.cachedQuota).toEqual(geminiQuota);
  });

  it('falls back to activeIndex when activeIndexByFamily lacks the gemini key', async () => {
    writeAccounts({
      activeIndex: 0,
      activeIndexByFamily: { claude: 1 },
      accounts: [
        { email: 'primary@antigravity.test', refreshToken: 'primary-refresh|primary-project', cachedQuota: primaryQuota },
        { email: 'gemini@antigravity.test', refreshToken: 'gemini-refresh|gemini-project', cachedQuota: geminiQuota },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('primary@antigravity.test');
    expect(auth.refreshToken).toBe('primary-refresh');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('defaults to index 0 when neither activeIndexByFamily nor activeIndex exist', async () => {
    writeAccounts({
      accounts: [
        { email: 'primary@antigravity.test', refreshToken: 'primary-refresh|primary-project', cachedQuota: primaryQuota },
        { email: 'gemini@antigravity.test', refreshToken: 'gemini-refresh|gemini-project', cachedQuota: geminiQuota },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('primary@antigravity.test');
    expect(auth.refreshToken).toBe('primary-refresh');
  });

  it('falls back to the first account carrying a refresh token when the target has none', async () => {
    writeAccounts({
      activeIndexByFamily: { gemini: 1 },
      accounts: [
        { email: 'with-refresh@antigravity.test', refreshToken: 'rt-0|p-0', cachedQuota: primaryQuota },
        { email: 'no-refresh@antigravity.test', cachedQuota: geminiQuota },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('with-refresh@antigravity.test');
    expect(auth.refreshToken).toBe('rt-0');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('sources cachedQuota from the first account that has one when the target carries none', async () => {
    writeAccounts({
      activeIndexByFamily: { gemini: 1 },
      accounts: [
        { email: 'quota-holder@antigravity.test', refreshToken: 'rt-0|p-0', cachedQuota: primaryQuota },
        { email: 'target@antigravity.test', refreshToken: 'rt-1|p-1' },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('target@antigravity.test');
    expect(auth.refreshToken).toBe('rt-1');
    expect(auth.projectId).toBe('p-1');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('prefers an explicit projectId over the refresh-token project segment', async () => {
    writeAccounts({
      activeIndexByFamily: { gemini: 0 },
      accounts: [
        { email: 'explicit@antigravity.test', refreshToken: 'rt|from-refresh', projectId: 'explicit-project', cachedQuota: primaryQuota },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.projectId).toBe('explicit-project');
    expect(auth.refreshToken).toBe('rt');
  });

  it('returns null when the accounts file carries no refresh token anywhere', async () => {
    writeAccounts({
      activeIndexByFamily: { gemini: 0 },
      accounts: [
        { email: 'a@antigravity.test', cachedQuota: primaryQuota },
        { email: 'b@antigravity.test' },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });

  it('returns null when the accounts array is empty', async () => {
    writeAccounts({ activeIndexByFamily: { gemini: 0 }, accounts: [] });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });

  it('returns null when no antigravity-accounts.json exists in the sandbox', async () => {
    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });
});
