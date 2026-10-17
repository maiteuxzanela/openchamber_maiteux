/**
 * Deterministic tests for the Google quota provider aggregator (index.js).
 *
 * No domain mocks: each case builds a REAL temporary HOME/XDG_CONFIG_HOME
 * sandbox containing a real versioned Antigravity account store
 * (*.store.pointer.json + generation/{config,state}.json) and, when needed, a
 * real Gemini CLI auth.json. The HTTP boundary is controlled by a transport
 * recorder installed at the global `fetch` seam (not vi.mock). This proves
 * source isolation: a failing Gemini CLI OAuth refresh must never abort nor
 * mask a healthy Antigravity pool.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME
};
const realFetch = globalThis.fetch;

let sandbox;
let configDir;
let dataDir;

const STORE_DIRECTORY_BASENAME = 'antigravity-accounts.gen-parity';
const FAR_FUTURE_EXPIRES = 4102444800000;

const accountsPath = () => path.join(configDir, 'antigravity-accounts.json');
const generationDir = () => path.join(configDir, STORE_DIRECTORY_BASENAME);
const authFilePath = () => path.join(dataDir, 'auth.json');

const SAMPLE_CACHED_QUOTA = {
  gemini: {
    windows: [
      { window: '5h', remainingFraction: 0.8, resetTime: '2026-10-10T17:03:21Z' },
      { window: 'weekly', remainingFraction: 0.4, resetTime: '2026-10-15T15:31:37Z' }
    ]
  },
  'non-gemini': {
    windows: [
      { window: '5h', remainingFraction: 1, resetTime: '2026-10-10T18:31:54Z' },
      { window: 'weekly', remainingFraction: 1, resetTime: '2026-10-17T13:31:54Z' }
    ]
  }
};

// A stale on-disk snapshot pinned at 4% remaining usage, the value the live
// `retrieveUserQuotaSummary` must override.
const CACHED_QUOTA_AT_FOUR_PERCENT = {
  gemini: {
    windows: [
      { window: '5h', remainingFraction: 0.96, resetTime: '2026-10-10T17:03:21Z' },
      { window: 'weekly', remainingFraction: 0.96, resetTime: '2026-10-15T15:31:37Z' }
    ]
  },
  'non-gemini': {
    windows: [
      { window: '5h', remainingFraction: 1, resetTime: '2026-10-10T18:31:54Z' },
      { window: 'weekly', remainingFraction: 1, resetTime: '2026-10-17T13:31:54Z' }
    ]
  }
};

const writeVersionedStore = (cachedQuota = SAMPLE_CACHED_QUOTA) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(generationDir(), { recursive: true });
  fs.writeFileSync(
    `${accountsPath()}.store.pointer.json`,
    JSON.stringify({ schemaVersion: 3, id: 'gen-parity', directoryBasename: STORE_DIRECTORY_BASENAME }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(generationDir(), 'config.json'),
    JSON.stringify({
      accounts: [{ id: 'acct-antigravity' }],
      commonAuthPool: {
        rows: { 'acct-antigravity': { quota: { cachedQuota } } }
      },
      antigravityRouting: { activeIndex: 0, activeRowByFamily: { gemini: { id: 'acct-antigravity' } } }
    }, null, 2),
    'utf8'
  );
  fs.writeFileSync(
    path.join(generationDir(), 'state.json'),
    JSON.stringify({
      accounts: {
        'acct-antigravity': {
          access: 'antigravity-access',
          refresh: 'antigravity-refresh|antigravity-project',
          expires: FAR_FUTURE_EXPIRES,
          commonAuthProviderState: {
            metadata: { email: 'antigravity@test', projectId: 'antigravity-project' }
          }
        }
      }
    }, null, 2),
    'utf8'
  );
};

const writeGeminiCliAuth = () => {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    authFilePath(),
    JSON.stringify({
      google: {
        oauth: {
          access: 'gemini-expired-access',
          refresh: 'gemini-refresh|gemini-project',
          expires: 1
        }
      }
    }, null, 2),
    'utf8'
  );
};

const loadIndex = async () => {
  vi.resetModules();
  return import('./index.js');
};

const installFetchRecorder = (handler) => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const record = { url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null };
    calls.push(record);
    const reply = handler(record, calls.length) ?? {};
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  return calls;
};

const modelsReply = () => ({
  body: {
    models: {
      'gemini-3.8-flash': { quotaInfo: { remainingFraction: 0.5 } },
      'claude-sonnet-5-5': { quotaInfo: { remainingFraction: 1 } }
    }
  }
});

const summaryReply = ({ weeklyRemaining = 0.73, fiveHourRemaining = 0.953209 } = {}) => ({
  body: {
    groups: [
      {
        displayName: 'gemini',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: weeklyRemaining, resetTime: '2026-10-15T15:31:37Z' },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: fiveHourRemaining, resetTime: '2026-10-10T17:03:21Z' }
        ]
      },
      {
        displayName: '3p',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: '2026-10-17T13:31:54Z' },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: '2026-10-10T18:31:54Z' }
        ]
      }
    ]
  }
});

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'google-quota-index-'));
  configDir = path.join(sandbox, 'opencode');
  dataDir = path.join(sandbox, '.local', 'share', 'opencode');
  process.env.HOME = sandbox;
  process.env.XDG_CONFIG_HOME = sandbox;
  fs.mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalEnv.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = originalEnv.HOME;
  if (originalEnv.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
  vi.resetModules();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('Google quota provider metadata', () => {
  it('exposes provider metadata constants', async () => {
    const mod = await loadIndex();
    expect(mod.providerId).toBe('google');
    expect(mod.providerName).toBe('Google');
    expect(typeof mod.isConfigured).toBe('function');
  });
});

describe('Google quota provider — deterministic sandbox', () => {
  it('isConfigured is false when no auth exists and true once the versioned store is present', async () => {
    const before = await loadIndex();
    expect(before.isConfigured()).toBe(false);

    writeVersionedStore();
    const after = await loadIndex();
    expect(after.isConfigured()).toBe(true);
  });

  it('resolves a single antigravity source from the versioned store with cachedQuota', async () => {
    writeVersionedStore();

    const mod = await loadIndex();
    const sources = mod.resolveGoogleAuthSources();

    expect(sources).toHaveLength(1);
    expect(sources[0].sourceId).toBe('antigravity');
    expect(sources[0].email).toBe('antigravity@test');
    expect(sources[0].accessToken).toBe('antigravity-access');
    expect(sources[0].cachedQuota).toEqual(SAMPLE_CACHED_QUOTA);
  });

  it('surfaces 5h + weekly windows and enriches models from cachedQuota', async () => {
    writeVersionedStore();
    installFetchRecorder(() => modelsReply());

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.windows['5h']).toBeDefined();
    expect(result.usage.windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    expect(result.usage.windows['5h'].usedPercent).toBe(20);
    expect(result.usage.windows.weekly).toBeDefined();
    expect(result.usage.windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(result.usage.windows.weekly.usedPercent).toBe(60);

    const geminiModel = result.usage.models['antigravity/gemini-3.8-flash'];
    expect(geminiModel).toBeDefined();
    // 5h from the live model fetch, weekly injected from cachedQuota.
    expect(geminiModel.windows['5h'].usedPercent).toBe(50);
    expect(geminiModel.windows.weekly.usedPercent).toBe(60);
  });

  it('a failing Gemini CLI OAuth refresh does not abort nor mask a healthy Antigravity pool', async () => {
    writeVersionedStore();
    writeGeminiCliAuth();
    const calls = installFetchRecorder((record) => {
      if (record.url.includes('oauth2.googleapis.com')) return { status: 400 };
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      if (record.url.includes('retrieveUserQuota')) return { body: { buckets: [] } };
      return { status: 404 };
    });

    const mod = await loadIndex();
    const sources = mod.resolveGoogleAuthSources();
    expect(sources.map((source) => source.sourceId)).toEqual(['gemini', 'antigravity']);

    const result = await mod.fetchGoogleQuota();

    // The Gemini refresh was attempted (and rejected) at the transport seam...
    expect(calls.some((call) => call.url.includes('oauth2.googleapis.com'))).toBe(true);
    // ...yet the provider still reports a healthy payload from Antigravity.
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(result.usage.models['antigravity/gemini-3.8-flash']).toBeDefined();
    expect(result.usage.windows['5h']).toBeDefined();
    expect(result.usage.windows.weekly).toBeDefined();
    // No obsolete sandbox/autopush hosts were ever contacted.
    expect(calls.every((call) => !/sandbox|autopush/i.test(call.url))).toBe(true);
  });

  it('a thrown Gemini CLI refresh error is isolated and does not abort a healthy Antigravity pool', async () => {
    writeVersionedStore();
    writeGeminiCliAuth();
    const calls = installFetchRecorder((record) => {
      if (record.url.includes('oauth2.googleapis.com')) {
        throw new Error('gemini transport down');
      }
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      return { body: { buckets: [] } };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(calls.some((call) => call.url.includes('oauth2.googleapis.com'))).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.usage.models['antigravity/gemini-3.8-flash']).toBeDefined();
    expect(result.usage.windows.weekly).toBeDefined();
  });

  it('reports ok:false / configured:true when configured but no models can be fetched', async () => {
    writeVersionedStore();
    installFetchRecorder(() => ({ status: 503 }));

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(typeof result.error).toBe('string');
    expect(result.usage).toBeNull();
  });

  it('reports ok:false / configured:false when nothing is configured', async () => {
    installFetchRecorder(() => ({ status: 500 }));

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
  });
});

describe('Google quota provider — live retrieveUserQuotaSummary integration', () => {
  it('uses the live summary windows and ignores a stale 4% cachedQuota', async () => {
    writeVersionedStore(CACHED_QUOTA_AT_FOUR_PERCENT);
    const calls = installFetchRecorder((record) => {
      if (record.url.includes('retrieveUserQuotaSummary')) return summaryReply();
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      if (record.url.includes('retrieveUserQuota')) return { body: { buckets: [] } };
      return { status: 404 };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);
    expect(calls.some((call) => call.url.includes('retrieveUserQuotaSummary'))).toBe(true);

    // Live gemini-weekly remainingFraction 0.73 -> 27% used, NOT the stale 4%.
    expect(result.usage.windows.weekly.usedPercent).toBe(27);
    expect(result.usage.windows.weekly.remainingPercent).toBe(73);
    expect(result.usage.windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(result.usage.windows['5h'].usedPercent).toBe(5);
    expect(result.usage.windows['5h'].windowSeconds).toBe(5 * 60 * 60);

    // The stale cached 4% must not survive anywhere in the provider windows.
    expect(result.usage.windows.weekly.usedPercent).not.toBe(4);

    const geminiModel = result.usage.models['antigravity/gemini-3.8-flash'];
    expect(geminiModel.windows.weekly.usedPercent).toBe(27);
    expect(geminiModel.windows['5h'].usedPercent).toBe(5);

    // Non-gemini (3p) models take the live 3p family windows.
    const claudeModel = result.usage.models['antigravity/claude-sonnet-5-5'];
    expect(claudeModel.windows.weekly.usedPercent).toBe(50);
    expect(claudeModel.windows['5h'].usedPercent).toBe(0);
  });

  it('merges a partial daily summary with the primary response and still prefers live over cached', async () => {
    writeVersionedStore(CACHED_QUOTA_AT_FOUR_PERCENT);
    const dailySummary = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
    const calls = installFetchRecorder((record) => {
      if (record.url === dailySummary) {
        // Partial response: only the 3p group, no gemini (issue #499).
        return {
          body: {
            groups: [{
              displayName: '3p',
              buckets: [
                { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 },
                { bucketId: '3p-5h', window: '5h', remainingFraction: 1 }
              ]
            }]
          }
        };
      }
      if (record.url.includes('retrieveUserQuotaSummary')) return summaryReply();
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      return { status: 404 };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(calls.filter((call) => call.url.includes('retrieveUserQuotaSummary'))).toHaveLength(2);
    expect(result.usage.windows.weekly.usedPercent).toBe(27);
    expect(result.usage.models['antigravity/claude-sonnet-5-5'].windows.weekly.usedPercent).toBe(50);
  });

  it('preserves the cachedQuota fallback when retrieveUserQuotaSummary is unavailable', async () => {
    writeVersionedStore(CACHED_QUOTA_AT_FOUR_PERCENT);
    const calls = installFetchRecorder((record) => {
      if (record.url.includes('retrieveUserQuotaSummary')) return { status: 500 };
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      if (record.url.includes('retrieveUserQuota')) return { body: { buckets: [] } };
      return { status: 404 };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(true);
    // Both summary endpoints were attempted before falling back.
    expect(calls.filter((call) => call.url.includes('retrieveUserQuotaSummary'))).toHaveLength(2);
    expect(result.usage.windows.weekly.usedPercent).toBe(4);
    expect(result.usage.windows['5h'].usedPercent).toBe(4);

    const geminiModel = result.usage.models['antigravity/gemini-3.8-flash'];
    expect(geminiModel.windows.weekly.usedPercent).toBe(4);
  });

  it('preserves the cachedQuota fallback when the summary transport throws (offline)', async () => {
    writeVersionedStore(CACHED_QUOTA_AT_FOUR_PERCENT);
    installFetchRecorder((record) => {
      if (record.url.includes('retrieveUserQuotaSummary')) throw new Error('offline');
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      return { status: 404 };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.ok).toBe(true);
    expect(result.usage.windows.weekly.usedPercent).toBe(4);
  });

  it('does not backfill a missing live window from the stale cachedQuota (live data is authoritative)', async () => {
    writeVersionedStore(CACHED_QUOTA_AT_FOUR_PERCENT);
    installFetchRecorder((record) => {
      if (record.url.includes('retrieveUserQuotaSummary')) {
        // Live summary exposes the weekly bucket only; the 5h bucket is absent.
        return {
          body: {
            groups: [{
              displayName: 'gemini',
              buckets: [{
                bucketId: 'gemini-weekly',
                window: 'weekly',
                remainingFraction: 0.73,
                resetTime: '2026-10-15T15:31:37Z'
              }]
            }]
          }
        };
      }
      if (record.url.includes('fetchAvailableModels')) return modelsReply();
      return { status: 404 };
    });

    const mod = await loadIndex();
    const result = await mod.fetchGoogleQuota();

    expect(result.usage.windows.weekly.usedPercent).toBe(27);
    // The stale cached 5h (4%) must NOT be injected to fill the gap, otherwise
    // the sidebar could keep showing the frozen 4% marker.
    expect(result.usage.windows['5h']).toBeUndefined();
  });
});
