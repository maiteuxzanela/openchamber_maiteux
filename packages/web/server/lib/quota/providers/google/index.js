import { buildResult } from '../../utils/index.js';
import {
  resolveGoogleAuthSources,
  resolveGoogleOAuthClient,
  resolveAntigravityAuth,
  DEFAULT_PROJECT_ID
} from './auth.js';
import {
  transformQuotaBucket,
  transformModelData,
  transformAntigravityProviderWindows,
  applyCachedQuotaToModels
} from './transforms.js';
import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels
} from './api.js';

export { resolveGoogleAuthSources } from './auth.js';

export const providerId = 'google';
export const providerName = 'Google';
export const aliases = ['google', 'google.oauth'];

export const isConfigured = () => resolveGoogleAuthSources().length > 0;

export const fetchGoogleQuota = async () => {
  const authSources = resolveGoogleAuthSources();
  if (!authSources.length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const models = {};
  const sourceErrors = [];
  let providerWindows = {};

  for (const source of authSources) {
    try {
      if (source.cachedQuota) {
        const extracted = transformAntigravityProviderWindows(source.cachedQuota);
        if (Object.keys(extracted).length > 0) {
          providerWindows = { ...providerWindows, ...extracted };
        }
      }

      const now = Date.now();
      let accessToken = source.accessToken;

      if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
        if (!source.refreshToken) {
          sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
          continue;
        }
        const { clientId, clientSecret } = resolveGoogleOAuthClient(source.sourceId);
        accessToken = await refreshGoogleAccessToken(source.refreshToken, clientId, clientSecret);
      }

      if (!accessToken) {
        sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
        continue;
      }

      const projectId = source.projectId ?? DEFAULT_PROJECT_ID;
      let mergedAnyModel = false;

      if (source.sourceId === 'gemini') {
        const quotaPayload = await fetchGoogleQuotaBuckets(accessToken, projectId);
        const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

        for (const bucket of buckets) {
          const transformed = transformQuotaBucket(bucket, source.sourceId);
          if (transformed) {
            Object.assign(models, transformed);
            mergedAnyModel = true;
          }
        }
      }

      const payload = await fetchGoogleModels(accessToken, projectId);
      if (payload) {
        for (const [modelName, modelData] of Object.entries(payload.models ?? {})) {
          const transformed = transformModelData(modelName, modelData, source.sourceId);
          Object.assign(models, transformed);
          mergedAnyModel = true;
        }
      }

      if (source.cachedQuota) {
        applyCachedQuotaToModels(models, source.cachedQuota);
      }

      if (!mergedAnyModel) {
        sourceErrors.push(`${source.sourceLabel}: Failed to fetch models`);
      }
    } catch (error) {
      // A failure in one source (e.g. the Gemini CLI OAuth refresh) must never
      // abort nor mask the remaining sources (e.g. a healthy Antigravity pool).
      const detail = error instanceof Error ? error.message : 'Request failed';
      sourceErrors.push(`${source.sourceLabel}: ${detail}`);
    }
  }

  // Ensure providerWindows has both 5h and weekly from Antigravity cachedQuota
  if (!providerWindows['5h'] || !providerWindows.weekly) {
    const antigravityAuth = resolveAntigravityAuth();
    if (antigravityAuth?.cachedQuota) {
      const extracted = transformAntigravityProviderWindows(antigravityAuth.cachedQuota);
      providerWindows = { ...extracted, ...providerWindows };
    }
  }

  // Always ensure all discovered models are enriched with 5h and weekly windows
  const fallbackCachedQuota = authSources.find((s) => s.cachedQuota)?.cachedQuota
    ?? resolveAntigravityAuth()?.cachedQuota;
  if (fallbackCachedQuota) {
    applyCachedQuotaToModels(models, fallbackCachedQuota);
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: providerWindows,
      models: Object.keys(models).length ? models : undefined
    }
  });
};
