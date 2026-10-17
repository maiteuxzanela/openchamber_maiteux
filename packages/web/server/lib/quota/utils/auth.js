import fs from 'fs';
import path from 'path';
import os from 'os';
import { OPENCODE_CONFIG_DIR } from '../../opencode/shared.js';
import { asObject, asNonEmptyString, toTimestamp } from './transformers.js';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');

export const ANTIGRAVITY_ACCOUNTS_PATHS = [
  path.join(OPENCODE_CONFIG_DIR, 'antigravity-accounts.json'),
  path.join(OPENCODE_DATA_DIR, 'antigravity-accounts.json')
];

/**
 * The @cortexkit/opencode-antigravity-auth plugin (v3+) migrated the legacy
 * `antigravity-accounts.json` pool into a versioned account store:
 *
 *   antigravity-accounts.json.store.pointer.json
 *     -> { schemaVersion, id, directoryBasename }
 *   <directoryBasename>/
 *     -> config.json  (accounts[], commonAuthPool.rows[].quota.cachedQuota,
 *                      antigravityRouting.activeIndexByFamily / activeRowByFamily)
 *     -> state.json   (accounts[].access/refresh/expires + metadata)
 */
export const ANTIGRAVITY_STORE_POINTER_SUFFIX = '.store.pointer.json';

export const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch (error) {
    console.warn(`Failed to read JSON file: ${filePath}`, error);
    return null;
  }
};

export const getAuthEntry = (auth, aliases) => {
  for (const alias of aliases) {
    if (auth[alias]) {
      return auth[alias];
    }
  }
  return null;
};

export const normalizeAuthEntry = (entry) => {
  if (!entry) return null;
  if (typeof entry === 'string') {
    return { token: entry };
  }
  if (typeof entry === 'object') {
    return entry;
  }
  return null;
};

/**
 * Resolves the versioned account-store generation directory for a legacy
 * `antigravity-accounts.json` path by reading its `.store.pointer.json` sibling.
 *
 * @param {string} storePath Legacy accounts file path.
 * @returns {{ pointerPath: string, directory: string } | null}
 */
export const resolveAntigravityStorePointer = (storePath) => {
  const pointerPath = `${storePath}${ANTIGRAVITY_STORE_POINTER_SUFFIX}`;
  const pointer = readJsonFile(pointerPath);
  const directoryBasename = asNonEmptyString(pointer?.directoryBasename);
  if (!directoryBasename) {
    return null;
  }

  return {
    pointerPath,
    directory: path.join(path.dirname(storePath), directoryBasename)
  };
};

/**
 * Reads the versioned Antigravity account store (pointer + generation dir) and
 * normalizes it into the same shape consumed by the legacy resolver.
 *
 * @param {string} storePath Legacy accounts file path used to locate the pointer.
 * @returns {{
 *   accounts: Array<object>,
 *   activeIndex?: number,
 *   activeIndexByFamily?: object,
 *   activeRowByFamily?: object
 * } | null}
 */
export const readAntigravityAccountStore = (storePath) => {
  const pointer = resolveAntigravityStorePointer(storePath);
  if (!pointer) {
    return null;
  }

  const config = readJsonFile(path.join(pointer.directory, 'config.json'));
  if (!config) {
    return null;
  }
  const state = readJsonFile(path.join(pointer.directory, 'state.json'));

  const configAccounts = Array.isArray(config.accounts) ? config.accounts : [];
  const stateAccounts = asObject(state?.accounts) ?? {};
  const rows = asObject(asObject(config.commonAuthPool)?.rows) ?? {};
  const routing = asObject(config.antigravityRouting) ?? {};

  const accounts = configAccounts
    .map((entry) => {
      const id = asNonEmptyString(asObject(entry)?.id);
      if (!id) return null;

      const stateEntry = asObject(stateAccounts[id]) ?? {};
      const metadata = asObject(asObject(stateEntry.commonAuthProviderState)?.metadata) ?? {};
      const row = asObject(rows[id]) ?? {};

      return {
        id,
        accessToken: asNonEmptyString(stateEntry.access),
        refreshToken: asNonEmptyString(stateEntry.refresh),
        expires: toTimestamp(stateEntry.expires),
        email: asNonEmptyString(metadata.email),
        projectId: asNonEmptyString(metadata.projectId),
        managedProjectId: asNonEmptyString(metadata.managedProjectId),
        cachedQuota: asObject(asObject(row.quota)?.cachedQuota)
      };
    })
    .filter((account) => account !== null);

  return {
    accounts,
    activeIndex: typeof routing.activeIndex === 'number' ? routing.activeIndex : undefined,
    activeIndexByFamily: asObject(routing.activeIndexByFamily),
    activeRowByFamily: asObject(routing.activeRowByFamily)
  };
};

/**
 * Loads Antigravity accounts from either the legacy flat file or the versioned
 * store, preserving legacy precedence when both are present.
 *
 * @param {string} storePath
 * @returns {object | null}
 */
export const loadAntigravityAccounts = (storePath) => {
  const legacy = readJsonFile(storePath);
  if (legacy && Array.isArray(legacy.accounts) && legacy.accounts.length > 0) {
    return {
      accounts: legacy.accounts,
      activeIndex: legacy.activeIndex,
      activeIndexByFamily: legacy.activeIndexByFamily,
      activeRowByFamily: legacy.activeRowByFamily
    };
  }

  return readAntigravityAccountStore(storePath);
};

/**
 * Resolves the target account index for the Gemini family, preferring the
 * versioned `activeRowByFamily.gemini.id`, then `activeIndexByFamily.gemini`,
 * then the legacy `activeIndex`, defaulting to 0.
 *
 * @param {object | null} data
 * @param {Array<object>} [accounts]
 * @returns {number}
 */
export const resolveAntigravityTargetIndex = (data, accounts = data?.accounts) => {
  const list = Array.isArray(accounts) ? accounts : [];

  const geminiRow = asObject(asObject(data?.activeRowByFamily)?.gemini);
  const rowId = asNonEmptyString(geminiRow?.id);
  if (rowId) {
    const rowIndex = list.findIndex((account) => asNonEmptyString(asObject(account)?.id) === rowId);
    if (rowIndex >= 0) {
      return rowIndex;
    }
  }

  const familyIndex = asObject(data?.activeIndexByFamily)?.gemini;
  if (typeof familyIndex === 'number' && Number.isInteger(familyIndex) && familyIndex >= 0) {
    return familyIndex;
  }

  if (typeof data?.activeIndex === 'number' && Number.isInteger(data.activeIndex) && data.activeIndex >= 0) {
    return data.activeIndex;
  }

  return 0;
};
