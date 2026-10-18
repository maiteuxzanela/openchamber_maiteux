/**
 * Google Provider - Auth
 *
 * Authentication resolution logic for Google quota providers.
 * @module quota/providers/google/auth
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ANTIGRAVITY_ACCOUNTS_PATHS,
  getAuthEntry,
  normalizeAuthEntry,
  asObject,
  asNonEmptyString,
  toTimestamp,
  loadAntigravityAccounts,
  resolveAntigravityTargetIndex
} from '../../utils/index.js';
import { readAuthFile } from '../../../opencode/auth.js';
import { parseGoogleRefreshToken } from './transforms.js';

export const getAntigravityCandidatePaths = () => {
  const home = process.env.HOME || os.homedir();
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return [
    path.join(configHome, 'opencode', 'antigravity-accounts.json'),
    path.join(home, '.local', 'share', 'opencode', 'antigravity-accounts.json')
  ];
};

const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const resolveAntigravityVersionedStore = (storePath) => {
  const pointerPath = `${storePath}.store.pointer.json`;
  const pointer = readJsonFile(pointerPath);
  const directoryBasename = asNonEmptyString(pointer?.directoryBasename);
  if (!directoryBasename) {
    return null;
  }

  const genDir = path.join(path.dirname(storePath), directoryBasename);
  const config = readJsonFile(path.join(genDir, 'config.json'));
  if (!config) {
    return null;
  }
  const state = readJsonFile(path.join(genDir, 'state.json'));

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

const ANTIGRAVITY_GOOGLE_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const ANTIGRAVITY_GOOGLE_CLIENT_SECRET = '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';
const GEMINI_GOOGLE_CLIENT_ID =
  '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const GEMINI_GOOGLE_CLIENT_SECRET = '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';
export const DEFAULT_PROJECT_ID = 'rising-fact-p41fc';

export const resolveGoogleOAuthClient = (sourceId) => {
  if (sourceId === 'gemini') {
    return {
      clientId: GEMINI_GOOGLE_CLIENT_ID,
      clientSecret: GEMINI_GOOGLE_CLIENT_SECRET
    };
  }

  return {
    clientId: ANTIGRAVITY_GOOGLE_CLIENT_ID,
    clientSecret: ANTIGRAVITY_GOOGLE_CLIENT_SECRET
  };
};

const resolveGeminiCliAuth = (auth) => {
  const entry = normalizeAuthEntry(getAuthEntry(auth, ['google', 'google.oauth']));
  const entryObject = asObject(entry);
  if (!entryObject) {
    return null;
  }

  const oauthObject = asObject(entryObject.oauth) ?? entryObject;
  const accessToken = asNonEmptyString(oauthObject.access) ?? asNonEmptyString(oauthObject.token);
  const refreshParts = parseGoogleRefreshToken(oauthObject.refresh);

  if (!accessToken && !refreshParts.refreshToken) {
    return null;
  }

  return {
    sourceId: 'gemini',
    sourceLabel: 'Gemini',
    accessToken,
    refreshToken: refreshParts.refreshToken,
    projectId: refreshParts.projectId ?? refreshParts.managedProjectId,
    expires: toTimestamp(oauthObject.expires)
  };
};

export const resolveAntigravityAuth = () => {
  const candidatePaths = [
    ...getAntigravityCandidatePaths(),
    ...ANTIGRAVITY_ACCOUNTS_PATHS
  ];
  const seenPaths = new Set();

  for (const filePath of candidatePaths) {
    if (seenPaths.has(filePath)) continue;
    seenPaths.add(filePath);

    // Prioridade: formato legado se existir com contas, senão o versionado 3.0.5 via pointer
    let data = loadAntigravityAccounts(filePath);
    if (!data) {
      data = resolveAntigravityVersionedStore(filePath);
    }
    if (!data) continue;

    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (accounts.length === 0) continue;

    const targetIndex = resolveAntigravityTargetIndex(data, accounts);
    const primaryAccount = accounts[targetIndex] ?? accounts[0];
    // Fall back to the first account that actually carries a refresh token
    // when the Gemini-family target account has none.
    const account = primaryAccount?.refreshToken
      ? primaryAccount
      : (accounts.find((a) => a?.refreshToken) ?? primaryAccount);
    if (!account?.refreshToken) continue;

    const refreshParts = parseGoogleRefreshToken(account.refreshToken);
    const cachedQuota = asObject(account.cachedQuota)
      ?? accounts.find((a) => a?.cachedQuota)?.cachedQuota
      ?? null;

    return {
      sourceId: 'antigravity',
      sourceLabel: 'Antigravity',
      accessToken: asNonEmptyString(account.accessToken) ?? undefined,
      refreshToken: refreshParts.refreshToken,
      expires: typeof account.expires === 'number' ? account.expires : undefined,
      projectId: asNonEmptyString(account.projectId)
        ?? asNonEmptyString(account.managedProjectId)
        ?? refreshParts.projectId
        ?? refreshParts.managedProjectId,
      email: account.email,
      cachedQuota: asObject(cachedQuota) ?? null
    };
  }

  return null;
};

export const resolveGoogleAuthSources = () => {
  const auth = readAuthFile();
  const sources = [];

  const geminiAuth = resolveGeminiCliAuth(auth);
  if (geminiAuth) {
    sources.push(geminiAuth);
  }

  const antigravityAuth = resolveAntigravityAuth();
  if (antigravityAuth) {
    sources.push(antigravityAuth);
  }

  return sources;
};
