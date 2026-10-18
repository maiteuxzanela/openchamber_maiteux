/**
 * Google Provider - Transforms
 *
 * Data transformation functions for Google quota responses.
 * @module quota/providers/google/transforms
 */

import {
  asObject,
  asNonEmptyString,
  toNumber,
  toTimestamp,
  toUsageWindow
} from '../../utils/index.js';

const GOOGLE_FIVE_HOUR_WINDOW_SECONDS = 5 * 60 * 60;
const GOOGLE_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const GOOGLE_WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;

export const parseGoogleRefreshToken = (rawRefreshToken) => {
  const refreshToken = asNonEmptyString(rawRefreshToken);
  if (!refreshToken) {
    return { refreshToken: null, projectId: null, managedProjectId: null };
  }

  const [rawToken = '', rawProject = '', rawManagedProject = ''] = refreshToken.split('|');
  return {
    refreshToken: asNonEmptyString(rawToken),
    projectId: asNonEmptyString(rawProject),
    managedProjectId: asNonEmptyString(rawManagedProject)
  };
};

/**
 * A window carries usable numbers only when it has a finite `usedPercent`;
 * everything else (null/NaN from a model that reported no quotaInfo) is
 * "no data" and must never block an aggregate from filling it.
 *
 * @param {unknown} usageWindow
 * @returns {boolean}
 */
const hasFiniteUsedPercent = (usageWindow) => Boolean(
  usageWindow
  && typeof usageWindow === 'object'
  && typeof usageWindow.usedPercent === 'number'
  && Number.isFinite(usageWindow.usedPercent)
);

/**
 * Wraps a `toUsageWindow` payload marking the result as a DYNAMIC per-model
 * reading (fetchAvailableModels / retrieveUserQuota) — but ONLY when the
 * reading actually carries a finite percentage. A model that reported no
 * usable quotaInfo stays an ordinary window, so family/cached windows may still
 * fill it without ever leaking the `dynamic` flag onto an aggregate value.
 *
 * Grouped windows from `retrieveUserQuotaSummary` and the on-disk
 * `cachedQuota` are family-level aggregates and never carry this flag, so
 * downstream merges can tell a live per-model value apart from an aggregate
 * stub (e.g. a generic `gemini-5h` bucket pinned at remainingFraction 1.0 →
 * 0% used forever).
 *
 * @param {{ usedPercent?: number|null, windowSeconds?: number|null, resetAt?: number|null }} payload
 * @returns {Record<string, unknown>}
 */
const toDynamicUsageWindow = (payload) => {
  const usageWindow = toUsageWindow(payload);
  return hasFiniteUsedPercent(usageWindow) ? { ...usageWindow, dynamic: true } : usageWindow;
};

/**
 * A window counts as a live per-model reading only when it is flagged
 * `dynamic` AND carries a finite percentage. The finite check is defensive: a
 * flagged window without usable numbers (legacy/foreign data) must never block
 * the family value from filling it.
 *
 * @param {unknown} usageWindow
 * @returns {boolean}
 */
const hasDynamicReading = (usageWindow) => Boolean(
  usageWindow
  && typeof usageWindow === 'object'
  && usageWindow.dynamic === true
  && hasFiniteUsedPercent(usageWindow)
);

/**
 * Claude/GPT/chat models belong to the non-gemini (3p) family; every other
 * model maps to the gemini family. Shared by the family merge and the
 * provider-level 5h derivation so both classify models identically.
 *
 * @param {string} modelName
 * @returns {boolean}
 */
const isNonGeminiModelName = (modelName) => (
  modelName.includes('claude') || modelName.includes('gpt') || modelName.includes('chat_')
);

const resolveGoogleWindow = (sourceId, resetAt) => {
  if (sourceId === 'gemini') {
    return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
  }

  if (sourceId === 'antigravity') {
    const remainingSeconds = typeof resetAt === 'number'
      ? Math.max(0, Math.round((resetAt - Date.now()) / 1000))
      : null;

    if (remainingSeconds !== null && remainingSeconds > 10 * 60 * 60) {
      return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
    }

    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS };
  }

  return { label: 'daily', seconds: GOOGLE_DAILY_WINDOW_SECONDS };
};

export const transformQuotaBucket = (bucket, sourceId) => {
  const modelId = asNonEmptyString(bucket?.modelId);
  if (!modelId) {
    return null;
  }

  const scopedName = modelId.startsWith(`${sourceId}/`)
    ? modelId
    : `${sourceId}/${modelId}`;

  const remainingFraction = toNumber(bucket?.remainingFraction);
  const remainingPercent = remainingFraction !== null
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = toTimestamp(bucket?.resetTime);
  const window = resolveGoogleWindow(sourceId, resetAt);

  return {
    [scopedName]: {
      windows: {
        [window.label]: toDynamicUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  };
};

export const transformModelData = (modelName, modelData, sourceId) => {
  const scopedName = modelName.startsWith(`${sourceId}/`)
    ? modelName
    : `${sourceId}/${modelName}`;

  const remainingFraction = modelData?.quotaInfo?.remainingFraction;
  const remainingPercent = typeof remainingFraction === 'number'
    ? Math.round(remainingFraction * 100)
    : null;
  const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
  const resetAt = modelData?.quotaInfo?.resetTime
    ? new Date(modelData.quotaInfo.resetTime).getTime()
    : null;
  const window = resolveGoogleWindow(sourceId, resetAt);

  return {
    [scopedName]: {
      windows: {
        [window.label]: toDynamicUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        })
      }
    }
  };
};

/**
 * Transforms cachedQuota entries for a model family (e.g. 'gemini' or 'non-gemini')
 * into standard toUsageWindow objects.
 *
 * @param {unknown} familyQuota
 * @returns {Record<string, object>}
 */
export const transformCachedQuotaWindows = (familyQuota) => {
  const quota = asObject(familyQuota);
  if (!quota) return {};

  const windows = {};
  const entries = Array.isArray(quota.windows) ? quota.windows : [];

  for (const item of entries) {
    const rawKey = asNonEmptyString(item?.window);
    if (!rawKey) continue;

    const remainingFraction = toNumber(item?.remainingFraction);
    const remainingPercent = remainingFraction !== null
      ? Math.round(remainingFraction * 100)
      : null;
    const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
    const resetAt = toTimestamp(item?.resetTime);

    let windowSeconds = null;
    let windowKey = rawKey;
    if (rawKey === '7d' || rawKey === 'week' || rawKey === 'weekly') {
      windowKey = 'weekly';
      windowSeconds = GOOGLE_WEEKLY_WINDOW_SECONDS;
    } else if (rawKey === '5h' || rawKey === '5-hour') {
      windowKey = '5h';
      windowSeconds = GOOGLE_FIVE_HOUR_WINDOW_SECONDS;
    } else if (rawKey === 'daily' || rawKey === '1d' || rawKey === '24h') {
      windowKey = 'daily';
      windowSeconds = GOOGLE_DAILY_WINDOW_SECONDS;
    }

    windows[windowKey] = toUsageWindow({
      usedPercent,
      windowSeconds,
      resetAt
    });
  }

  // Fallback if weekly window is absent in array but top-level remainingFraction exists
  if (!windows.weekly && quota.remainingFraction !== undefined) {
    const remainingFraction = toNumber(quota.remainingFraction);
    const remainingPercent = remainingFraction !== null
      ? Math.round(remainingFraction * 100)
      : null;
    const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
    const resetAt = toTimestamp(quota.resetTime);
    windows.weekly = toUsageWindow({
      usedPercent,
      windowSeconds: GOOGLE_WEEKLY_WINDOW_SECONDS,
      resetAt
    });
  }

  return windows;
};

/**
 * Transforms full cachedQuota root object (containing families like 'gemini' and 'non-gemini')
 * into a map of family -> windows.
 *
 * @param {unknown} cachedQuota
 * @returns {Record<string, Record<string, object>>}
 */
export const transformCachedQuota = (cachedQuota) => {
  const root = asObject(cachedQuota);
  if (!root) return {};
  const quota = asObject(root.cachedQuota) ?? root;

  const result = {};
  for (const [familyKey, familyData] of Object.entries(quota)) {
    const familyObj = asObject(familyData);
    if (!familyObj) continue;
    const windows = transformCachedQuotaWindows(familyObj);
    if (Object.keys(windows).length > 0) {
      result[familyKey] = windows;
    }
  }
  return result;
};

/**
 * Extracts provider-level windows ('5h' and 'weekly') from Antigravity cachedQuota.
 * Specifically looks for cachedQuota.gemini (or root if formatted directly).
 *
 * @param {unknown} cachedQuota
 * @returns {Record<string, object>}
 */
export const transformAntigravityProviderWindows = (cachedQuota) => {
  const root = asObject(cachedQuota);
  if (!root) return {};
  const quota = asObject(root.cachedQuota) ?? root;
  const geminiQuota = asObject(quota.gemini) ?? quota;
  return transformCachedQuotaWindows(geminiQuota);
};

const GOOGLE_QUOTA_SUMMARY_FAMILIES = [
  { prefix: 'gemini-', family: 'gemini' },
  { prefix: '3p-', family: 'non-gemini' }
];

const GOOGLE_QUOTA_CANONICAL_BUCKET_IDS = new Set([
  'gemini-weekly',
  'gemini-5h',
  '3p-weekly',
  '3p-5h'
]);

const resolveQuotaSummaryFamily = (bucketId) => {
  for (const { prefix, family } of GOOGLE_QUOTA_SUMMARY_FAMILIES) {
    if (bucketId.startsWith(prefix)) {
      return family;
    }
  }
  return null;
};

const resolveQuotaSummaryWindow = (bucket) => {
  const bucketId = (asNonEmptyString(bucket?.bucketId) ?? '').toLowerCase();
  const rawWindow = (asNonEmptyString(bucket?.window) ?? '').toLowerCase();

  if (rawWindow === 'weekly' || bucketId.includes('weekly') || bucketId.includes('7d')) {
    return { label: 'weekly', seconds: GOOGLE_WEEKLY_WINDOW_SECONDS };
  }
  if (
    rawWindow === '5h'
    || bucketId.includes('5h')
    || bucketId.includes('fivehour')
    || bucketId.includes('five-hour')
  ) {
    return { label: '5h', seconds: GOOGLE_FIVE_HOUR_WINDOW_SECONDS };
  }
  return null;
};

/**
 * Transforms a `retrieveUserQuotaSummary` payload into live usage windows.
 *
 * Expected shape:
 *   { groups: [{ displayName, buckets: [{ bucketId, window, remainingFraction, resetTime }] }] }
 *
 * Buckets are grouped into the `gemini` family (`bucketId` prefix `gemini-`,
 * e.g. `gemini-weekly` / `gemini-5h`) and the `non-gemini` family (prefix `3p-`,
 * e.g. `3p-weekly` / `3p-5h`). For each family the `weekly` and `5h` windows are
 * produced as standard `toUsageWindow` objects.
 *
 * @param {unknown} payload
 * @returns {{
 *   providerWindows: Record<string, object>,
 *   familyWindows: Record<string, Record<string, object>>
 * }}
 */
export const transformUserQuotaSummary = (payload) => {
  const root = asObject(payload);
  const groups = Array.isArray(root?.groups) ? root.groups : [];

  const familyWindows = {};
  // Tracks whether the window currently stored was taken from a canonical
  // bucket id, so a canonical bucket (e.g. `gemini-weekly`) always wins over a
  // model-scoped variant (e.g. `gemini-argon-wtu-weekly`) regardless of order.
  const canonicalChosen = new Set();

  for (const group of groups) {
    const buckets = Array.isArray(group?.buckets) ? group.buckets : [];

    for (const bucket of buckets) {
      const bucketId = asNonEmptyString(bucket?.bucketId);
      if (!bucketId) {
        continue;
      }

      const family = resolveQuotaSummaryFamily(bucketId);
      const window = resolveQuotaSummaryWindow(bucket);
      if (!family || !window) {
        continue;
      }

      const remainingFraction = toNumber(bucket?.remainingFraction);
      const remainingPercent = remainingFraction !== null
        ? Math.round(remainingFraction * 100)
        : null;
      const usedPercent = remainingPercent !== null ? Math.max(0, 100 - remainingPercent) : null;
      const resetAt = toTimestamp(bucket?.resetTime);

      const familyEntry = familyWindows[family] ?? (familyWindows[family] = {});
      const cacheKey = `${family}:${window.label}`;
      const isCanonical = GOOGLE_QUOTA_CANONICAL_BUCKET_IDS.has(bucketId.toLowerCase());
      const alreadyCanonical = canonicalChosen.has(cacheKey);

      if (!familyEntry[window.label] || (isCanonical && !alreadyCanonical)) {
        familyEntry[window.label] = toUsageWindow({
          usedPercent,
          windowSeconds: window.seconds,
          resetAt
        });
        if (isCanonical) {
          canonicalChosen.add(cacheKey);
        } else {
          canonicalChosen.delete(cacheKey);
        }
      }
    }
  }

  return {
    // The gemini family is the provider-level default (the Antigravity weekly
    // limit marker that drives the sidebar gauge).
    providerWindows: familyWindows.gemini ?? {},
    familyWindows
  };
};

/**
 * Enriches model records with live weekly and 5h windows from a
 * `transformUserQuotaSummary` result. Gemini models map to the gemini family;
 * Claude/GPT/chat models map to the non-gemini (3p) family.
 *
 * Live family windows are authoritative and override stale/cached values while
 * preserving any extra fields the model window already carried — EXCEPT for a
 * DYNAMIC per-model reading (`dynamic: true`, produced by
 * `transformModelData`/`transformQuotaBucket`): a grouped family bucket (e.g.
 * `gemini-5h` = 1.0 → 0% used) is an aggregate stub and must never clobber the
 * real rolling quota the model itself is reporting, otherwise the gauge freezes
 * at 0% while consumption keeps rising.
 *
 * @param {Record<string, object>} models
 * @param {Record<string, Record<string, object>>} familyWindows
 * @returns {Record<string, object>}
 */
export const applyFamilyWindowsToModels = (models, familyWindows) => {
  if (!models || typeof models !== 'object') {
    return models;
  }

  const families = asObject(familyWindows);
  if (!families) {
    return models;
  }

  const geminiWindows = asObject(families.gemini) ?? {};
  const nonGeminiWindows = asObject(families['non-gemini']) ?? {};

  for (const [modelName, modelEntry] of Object.entries(models)) {
    if (!modelEntry || typeof modelEntry !== 'object') continue;
    if (!modelEntry.windows) modelEntry.windows = {};

    const sourceWindows = isNonGeminiModelName(modelName) ? nonGeminiWindows : geminiWindows;

    for (const label of ['weekly', '5h']) {
      const existing = modelEntry.windows[label];
      if (hasDynamicReading(existing)) {
        // The model already reports its own live value for this window: the
        // family aggregate must not overwrite it (weekly still lands on models
        // that carry no dynamic weekly reading of their own).
        continue;
      }

      const liveWindow = sourceWindows[label];
      if (liveWindow) {
        modelEntry.windows[label] = {
          ...(existing ?? {}),
          ...liveWindow
        };
      }
    }
  }

  return models;
};

/**
 * Derives the provider-level `5h` window from the LIVE per-model readings of
 * the Gemini family (Claude/GPT/chat models belong to the 3p family and are
 * always excluded), returning the most-consumed Gemini model's window — the
 * most conservative reading drives the sidebar gauge.
 *
 * This exists because the grouped `gemini-5h` bucket of
 * `retrieveUserQuotaSummary` (and the on-disk cachedQuota) can stay pinned at
 * remainingFraction 1.0 → 0% used while real Gemini models are already
 * consuming their rolling quota.
 *
 * @param {Record<string, object>} models
 * @returns {Record<string, unknown> | null} the winning 5h window, or null when
 *   no Gemini model carries a usable dynamic 5h reading.
 */
export const deriveGeminiFiveHourWindow = (models) => {
  if (!models || typeof models !== 'object') {
    return null;
  }

  let mostConsumed = null;
  for (const [modelName, modelEntry] of Object.entries(models)) {
    if (isNonGeminiModelName(modelName)) continue;
    if (!modelEntry || typeof modelEntry !== 'object') continue;

    const window = modelEntry.windows?.['5h'];
    if (!hasDynamicReading(window)) continue;

    if (!mostConsumed || window.usedPercent > mostConsumed.usedPercent) {
      mostConsumed = window;
    }
  }

  // Clone so the provider-level window never aliases a model record.
  return mostConsumed ? { ...mostConsumed } : null;
};

/**
 * Augments model records with weekly (and missing 5h) windows from cachedQuota.
 * Gemini models map to cachedQuota.gemini; Claude/GPT/other non-gemini models map to cachedQuota['non-gemini'].
 *
 * A model window that carries usable numbers keeps winning the merge (its
 * values — a live `dynamic` reading included — are fresher than the on-disk
 * snapshot); a model window without usable numbers is REPLACED by the cached
 * value instead of blocking it with nulls.
 *
 * @param {Record<string, object>} models
 * @param {unknown} cachedQuota
 * @returns {Record<string, object>}
 */
export const applyCachedQuotaToModels = (models, cachedQuota) => {
  const root = asObject(cachedQuota);
  if (!models || typeof models !== 'object' || !root) {
    return models;
  }

  const quotaObj = asObject(root.cachedQuota) ?? root;
  const geminiWindows = transformCachedQuotaWindows(quotaObj.gemini ?? quotaObj);
  const nonGeminiWindows = transformCachedQuotaWindows(quotaObj['non-gemini']);

  const mergeCachedWindow = (existing, cachedWindow) => (
    hasFiniteUsedPercent(existing)
      ? { ...cachedWindow, ...existing }
      : cachedWindow
  );

  for (const [modelName, modelEntry] of Object.entries(models)) {
    if (!modelEntry || typeof modelEntry !== 'object') continue;
    if (!modelEntry.windows) modelEntry.windows = {};

    const sourceWindows = isNonGeminiModelName(modelName) ? nonGeminiWindows : geminiWindows;

    if (sourceWindows?.weekly) {
      modelEntry.windows.weekly = mergeCachedWindow(modelEntry.windows.weekly, sourceWindows.weekly);
    }
    if (sourceWindows?.['5h']) {
      modelEntry.windows['5h'] = mergeCachedWindow(modelEntry.windows['5h'], sourceWindows['5h']);
    }
  }

  return models;
};
