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
        [window.label]: toUsageWindow({
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
        [window.label]: toUsageWindow({
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

/**
 * Augments model records with weekly (and missing 5h) windows from cachedQuota.
 * Gemini models map to cachedQuota.gemini; Claude/GPT/other non-gemini models map to cachedQuota['non-gemini'].
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

  for (const [modelName, modelEntry] of Object.entries(models)) {
    if (!modelEntry || typeof modelEntry !== 'object') continue;
    if (!modelEntry.windows) modelEntry.windows = {};

    const isNonGemini = modelName.includes('claude') || modelName.includes('gpt') || modelName.includes('chat_');
    const sourceWindows = isNonGemini ? nonGeminiWindows : geminiWindows;

    if (sourceWindows?.weekly) {
      if (!modelEntry.windows.weekly) {
        modelEntry.windows.weekly = sourceWindows.weekly;
      } else {
        modelEntry.windows.weekly = {
          ...sourceWindows.weekly,
          ...modelEntry.windows.weekly
        };
      }
    }
    if (sourceWindows?.['5h']) {
      if (!modelEntry.windows['5h']) {
        modelEntry.windows['5h'] = sourceWindows['5h'];
      } else {
        modelEntry.windows['5h'] = {
          ...sourceWindows['5h'],
          ...modelEntry.windows['5h']
        };
      }
    }
  }

  return models;
};
