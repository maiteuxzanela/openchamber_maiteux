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

import {
  ANTIGRAVITY_STORE_POINTER_SUFFIX,
  loadAntigravityAccounts,
  readAntigravityAccountStore,
  resolveAntigravityStorePointer,
  resolveAntigravityTargetIndex,
} from '../../utils/index.js';

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
  if (typeof vi?.resetModules === 'function') {
    vi.resetModules();
  }
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
  if (typeof vi?.resetModules === 'function') {
    vi.resetModules();
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const quotaFor = (window, remainingFraction, resetTime) => ({
  gemini: { windows: [{ window, remainingFraction, resetTime }] },
});

const primaryQuota = quotaFor('5h', 0.1, '2026-10-01T00:00:00.000Z');
const geminiQuota = quotaFor('weekly', 0.75, '2026-10-08T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Versioned account store (*.store.pointer.json + <basename>/{config,state}.json)
// ---------------------------------------------------------------------------

const STORE_DIRECTORY_BASENAME = 'antigravity-accounts.gen-7f3a';
const FAR_FUTURE_EXPIRES = 4102444800000; // 2100-01-01T00:00:00Z in ms

const pointerPath = () => `${accountsPath()}${ANTIGRAVITY_STORE_POINTER_SUFFIX}`;
const generationDir = () => path.join(configDir, STORE_DIRECTORY_BASENAME);

const writePointer = (pointerPayload) => {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(pointerPath(), JSON.stringify(pointerPayload, null, 2), 'utf8');
};

const writeGeneration = (config, state) => {
  fs.mkdirSync(generationDir(), { recursive: true });
  fs.writeFileSync(path.join(generationDir(), 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(path.join(generationDir(), 'state.json'), JSON.stringify(state, null, 2), 'utf8');
};

const writeVersionedStore = ({ pointer, config, state } = {}) => {
  writePointer({
    schemaVersion: 3,
    id: 'gen-7f3a',
    directoryBasename: STORE_DIRECTORY_BASENAME,
    ...pointer,
  });
  writeGeneration(config ?? {}, state ?? {});
};

const versionedStateAccount = ({ access, refresh, email, projectId, managedProjectId, expires } = {}) => ({
  access,
  refresh,
  ...(expires !== undefined ? { expires } : {}),
  commonAuthProviderState: {
    metadata: {
      ...(email !== undefined ? { email } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(managedProjectId !== undefined ? { managedProjectId } : {}),
    },
  },
});

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

describe('resolveAntigravityAuth — versioned store', () => {
  const configFor = ({ routing, cachedQuotaById = {} } = {}) => {
    const ids = Object.keys(cachedQuotaById);
    return {
      accounts: ids.map((id) => ({ id })),
      commonAuthPool: {
        rows: Object.fromEntries(
          ids.map((id) => [id, { quota: { cachedQuota: cachedQuotaById[id] } }])
        ),
      },
      antigravityRouting: routing ?? {},
    };
  };

  it('resolves the activeRowByFamily.gemini account (beating activeIndexByFamily.gemini) and its tokens/metadata', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: {
          'acct-primary': primaryQuota,
          'acct-gemini': geminiQuota,
        },
        routing: {
          activeIndex: 0,
          activeIndexByFamily: { gemini: 0 },
          activeRowByFamily: { gemini: { id: 'acct-gemini' } },
        },
      }),
      state: {
        accounts: {
          'acct-primary': versionedStateAccount({
            access: 'access-primary',
            refresh: 'refresh-primary|project-primary',
            email: 'primary@antigravity.test',
            projectId: 'project-primary',
            expires: FAR_FUTURE_EXPIRES,
          }),
          'acct-gemini': versionedStateAccount({
            access: 'access-gemini',
            refresh: 'refresh-gemini|project-gemini|managed-gemini',
            email: 'gemini@antigravity.test',
            projectId: 'gemini-explicit-project',
            managedProjectId: 'gemini-managed-project',
            expires: FAR_FUTURE_EXPIRES,
          }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth).not.toBeNull();
    expect(auth.sourceId).toBe('antigravity');
    expect(auth.sourceLabel).toBe('Antigravity');
    expect(auth.email).toBe('gemini@antigravity.test');
    expect(auth.refreshToken).toBe('refresh-gemini');
    expect(auth.accessToken).toBe('access-gemini');
    expect(auth.expires).toBe(FAR_FUTURE_EXPIRES);
    expect(auth.projectId).toBe('gemini-explicit-project');
    expect(auth.cachedQuota).toEqual(geminiQuota);
    expect(auth.cachedQuota).not.toEqual(primaryQuota);
  });

  it('falls back to activeIndexByFamily.gemini when activeRowByFamily is absent', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-primary': primaryQuota, 'acct-gemini': geminiQuota },
        routing: { activeIndex: 0, activeIndexByFamily: { gemini: 1 } },
      }),
      state: {
        accounts: {
          'acct-primary': versionedStateAccount({ refresh: 'rt-0|p-0', email: 'primary@antigravity.test' }),
          'acct-gemini': versionedStateAccount({ refresh: 'rt-1|p-1', email: 'gemini@antigravity.test' }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('gemini@antigravity.test');
    expect(auth.refreshToken).toBe('rt-1');
    expect(auth.cachedQuota).toEqual(geminiQuota);
  });

  it('falls back to activeIndex when no family routing exists', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-primary': primaryQuota, 'acct-gemini': geminiQuota },
        routing: { activeIndex: 1 },
      }),
      state: {
        accounts: {
          'acct-primary': versionedStateAccount({ refresh: 'rt-0|p-0', email: 'primary@antigravity.test' }),
          'acct-gemini': versionedStateAccount({ refresh: 'rt-1|p-1', email: 'gemini@antigravity.test' }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('gemini@antigravity.test');
    expect(auth.refreshToken).toBe('rt-1');
  });

  it('defaults to index 0 when the versioned store has no routing at all', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-primary': primaryQuota, 'acct-gemini': geminiQuota },
      }),
      state: {
        accounts: {
          'acct-primary': versionedStateAccount({ refresh: 'rt-0|p-0', email: 'primary@antigravity.test' }),
          'acct-gemini': versionedStateAccount({ refresh: 'rt-1|p-1', email: 'gemini@antigravity.test' }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('primary@antigravity.test');
    expect(auth.refreshToken).toBe('rt-0');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('derives projectId from managedProjectId, then the refresh-token segments', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-managed': primaryQuota },
        routing: { activeRowByFamily: { gemini: { id: 'acct-managed' } } },
      }),
      state: {
        accounts: {
          'acct-managed': versionedStateAccount({
            refresh: 'refresh-managed|refresh-project|refresh-managed-project',
            managedProjectId: 'metadata-managed-project',
            email: 'managed@antigravity.test',
          }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth().projectId).toBe('metadata-managed-project');
  });

  it('falls back to the first account carrying a refresh token when the versioned target has none', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-with-refresh': primaryQuota, 'acct-target': geminiQuota },
        routing: { activeRowByFamily: { gemini: { id: 'acct-target' } } },
      }),
      state: {
        accounts: {
          'acct-with-refresh': versionedStateAccount({ refresh: 'rt-0|p-0', email: 'with-refresh@antigravity.test' }),
          'acct-target': versionedStateAccount({ email: 'no-refresh@antigravity.test' }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('with-refresh@antigravity.test');
    expect(auth.refreshToken).toBe('rt-0');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('gives the legacy flat file precedence over the versioned store when both exist', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-versioned': geminiQuota },
        routing: { activeRowByFamily: { gemini: { id: 'acct-versioned' } } },
      }),
      state: {
        accounts: {
          'acct-versioned': versionedStateAccount({
            refresh: 'versioned-refresh|versioned-project',
            email: 'versioned@antigravity.test',
          }),
        },
      },
    });
    writeAccounts({
      activeIndex: 0,
      accounts: [
        {
          email: 'legacy@antigravity.test',
          refreshToken: 'legacy-refresh|legacy-project',
          cachedQuota: primaryQuota,
        },
      ],
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    const auth = resolveAntigravityAuth();

    expect(auth.email).toBe('legacy@antigravity.test');
    expect(auth.refreshToken).toBe('legacy-refresh');
    expect(auth.projectId).toBe('legacy-project');
    expect(auth.cachedQuota).toEqual(primaryQuota);
  });

  it('returns null when the pointer exists but the generation config.json is missing', async () => {
    writePointer({ schemaVersion: 3, id: 'gen-broken', directoryBasename: STORE_DIRECTORY_BASENAME });
    // Intentionally do NOT write generation/config.json.

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });

  it('returns null when the pointer has no directoryBasename', async () => {
    writePointer({ schemaVersion: 3, id: 'gen-broken' });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });

  it('returns null when the versioned store carries no refresh token anywhere', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-a': primaryQuota },
        routing: { activeRowByFamily: { gemini: { id: 'acct-a' } } },
      }),
      state: {
        accounts: {
          'acct-a': versionedStateAccount({ access: 'access-only', email: 'a@antigravity.test' }),
        },
      },
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });

  it('returns null when state.json carries no account entry for the config account', async () => {
    writeVersionedStore({
      config: configFor({
        cachedQuotaById: { 'acct-stated': geminiQuota },
        routing: { activeRowByFamily: { gemini: { id: 'acct-stated' } } },
      }),
      // state defaults to {} -> no account entries at all.
    });

    const resolveAntigravityAuth = await loadResolveAntigravityAuth();
    expect(resolveAntigravityAuth()).toBeNull();
  });
});

describe('versioned store helpers (utils/auth.js)', () => {
  it('resolveAntigravityStorePointer returns the pointer path and generation directory', () => {
    writeVersionedStore({ config: { accounts: [] }, state: {} });

    const pointer = resolveAntigravityStorePointer(accountsPath());
    expect(pointer).not.toBeNull();
    expect(pointer.pointerPath).toBe(pointerPath());
    expect(pointer.directory).toBe(generationDir());
  });

  it('resolveAntigravityStorePointer returns null without a pointer or directoryBasename', () => {
    expect(resolveAntigravityStorePointer(accountsPath())).toBeNull();

    writePointer({ schemaVersion: 3, id: 'gen-broken' });
    expect(resolveAntigravityStorePointer(accountsPath())).toBeNull();
  });

  it('readAntigravityAccountStore normalizes accounts, routing and cachedQuota', () => {
    writeVersionedStore({
      config: {
        accounts: [{ id: 'acct-primary' }, { id: 'acct-gemini' }],
        commonAuthPool: {
          rows: {
            'acct-primary': { quota: { cachedQuota: primaryQuota } },
            'acct-gemini': { quota: { cachedQuota: geminiQuota } },
          },
        },
        antigravityRouting: {
          activeIndex: 0,
          activeIndexByFamily: { gemini: 1 },
          activeRowByFamily: { gemini: { id: 'acct-gemini' } },
        },
      },
      state: {
        accounts: {
          'acct-gemini': versionedStateAccount({
            access: 'access-gemini',
            refresh: 'refresh-gemini|project-gemini',
            email: 'gemini@antigravity.test',
            projectId: 'explicit-project',
            managedProjectId: 'managed-project',
            expires: FAR_FUTURE_EXPIRES,
          }),
        },
      },
    });

    const store = readAntigravityAccountStore(accountsPath());
    expect(store).not.toBeNull();
    expect(store.accounts).toHaveLength(2);
    expect(store.activeIndex).toBe(0);
    expect(store.activeIndexByFamily).toEqual({ gemini: 1 });
    expect(store.activeRowByFamily).toEqual({ gemini: { id: 'acct-gemini' } });

    const gemini = store.accounts.find((account) => account.id === 'acct-gemini');
    expect(gemini.accessToken).toBe('access-gemini');
    // The store keeps the raw composite refresh token; segments are split later by
    // resolveAntigravityAuth via parseGoogleRefreshToken.
    expect(gemini.refreshToken).toBe('refresh-gemini|project-gemini');
    expect(gemini.email).toBe('gemini@antigravity.test');
    expect(gemini.projectId).toBe('explicit-project');
    expect(gemini.managedProjectId).toBe('managed-project');
    expect(gemini.expires).toBe(FAR_FUTURE_EXPIRES);
    expect(gemini.cachedQuota).toEqual(geminiQuota);

    const primary = store.accounts.find((account) => account.id === 'acct-primary');
    expect(primary.cachedQuota).toEqual(primaryQuota);
  });

  it('readAntigravityAccountStore drops config accounts without an id', () => {
    writeVersionedStore({
      config: { accounts: [{ id: 'acct-valid' }, { email: 'no-id@antigravity.test' }, {}, null] },
      state: { accounts: { 'acct-valid': versionedStateAccount({ refresh: 'rt|p' }) } },
    });

    const store = readAntigravityAccountStore(accountsPath());
    expect(store.accounts).toHaveLength(1);
    expect(store.accounts[0].id).toBe('acct-valid');
  });

  it('readAntigravityAccountStore returns null when the generation config.json is missing', () => {
    writePointer({ schemaVersion: 3, id: 'gen-broken', directoryBasename: STORE_DIRECTORY_BASENAME });
    expect(readAntigravityAccountStore(accountsPath())).toBeNull();
  });

  it('loadAntigravityAccounts returns the legacy shape and wins over the versioned store', () => {
    writeVersionedStore({
      config: {
        accounts: [{ id: 'acct-versioned' }],
        antigravityRouting: { activeRowByFamily: { gemini: { id: 'acct-versioned' } } },
      },
      state: { accounts: { 'acct-versioned': versionedStateAccount({ refresh: 'versioned|vp' }) } },
    });
    writeAccounts({
      activeIndex: 2,
      activeIndexByFamily: { gemini: 1 },
      accounts: [{ email: 'legacy@antigravity.test', refreshToken: 'legacy|legacy-project' }],
    });

    const loaded = loadAntigravityAccounts(accountsPath());
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0].email).toBe('legacy@antigravity.test');
    expect(loaded.activeIndex).toBe(2);
    expect(loaded.activeIndexByFamily).toEqual({ gemini: 1 });
  });

  it('loadAntigravityAccounts falls back to the versioned store when the legacy file has an empty accounts array', () => {
    writeVersionedStore({
      config: {
        accounts: [{ id: 'acct-versioned' }],
        antigravityRouting: { activeRowByFamily: { gemini: { id: 'acct-versioned' } } },
      },
      state: { accounts: { 'acct-versioned': versionedStateAccount({ refresh: 'versioned|vp', email: 'v@antigravity.test' }) } },
    });
    writeAccounts({ accounts: [] });

    const loaded = loadAntigravityAccounts(accountsPath());
    expect(loaded.accounts).toHaveLength(1);
    expect(loaded.accounts[0].email).toBe('v@antigravity.test');
  });

  it('resolveAntigravityTargetIndex follows rows -> family -> activeIndex -> 0 and ignores non-integer family indexes', () => {
    const accounts = [{ id: 'a' }, { id: 'b' }];

    expect(resolveAntigravityTargetIndex({ activeRowByFamily: { gemini: { id: 'b' } } }, accounts)).toBe(1);
    expect(resolveAntigravityTargetIndex(
      { activeRowByFamily: { gemini: { id: 'missing' } }, activeIndexByFamily: { gemini: 1 } },
      accounts
    )).toBe(1);
    expect(resolveAntigravityTargetIndex({ activeIndexByFamily: { gemini: 0 } }, accounts)).toBe(0);
    expect(resolveAntigravityTargetIndex({ activeIndex: 1 }, accounts)).toBe(1);
    expect(resolveAntigravityTargetIndex({}, accounts)).toBe(0);
    expect(resolveAntigravityTargetIndex({ activeIndexByFamily: { gemini: 1.5 } }, accounts)).toBe(0);
    expect(resolveAntigravityTargetIndex({ activeIndex: -1 }, accounts)).toBe(0);
    expect(resolveAntigravityTargetIndex(null)).toBe(0);
  });

  it('resolveAntigravityTargetIndex defaults the account list from the shared data object', () => {
    const data = {
      accounts: [{ id: 'a' }, { id: 'b' }],
      activeRowByFamily: { gemini: { id: 'b' } },
    };
    expect(resolveAntigravityTargetIndex(data)).toBe(1);
  });
});
