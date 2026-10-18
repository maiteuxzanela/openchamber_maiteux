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
  applyCachedQuotaToModels,
  transformUserQuotaSummary,
  applyFamilyWindowsToModels,
  deriveGeminiFiveHourWindow
} from './transforms.js';
import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels,
  fetchGoogleQuotaSummary
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
  // Becomes true as soon as a live retrieveUserQuotaSummary payload is applied
  // for any source. When live data is available it is authoritative and the
  // stale cachedQuota fallback must not be re-injected.
  let liveSummaryApplied = false;

  for (const source of authSources) {
    try {
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

      // Live grouped quota summary (weekly + 5h long/rolling windows). This is
      // the only endpoint that carries the Antigravity weekly limit; it is
      // authoritative when reachable.
      let liveSummary = null;
      if (source.sourceId === 'antigravity' || source.sourceId === 'gemini') {
        const summaryPayload = await fetchGoogleQuotaSummary(accessToken, projectId);
        if (Array.isArray(summaryPayload?.groups) && summaryPayload.groups.length > 0) {
          liveSummary = transformUserQuotaSummary(summaryPayload);
        }
      }

      // Fall back to the on-disk cachedQuota ONLY while the live summary is
      // unavailable (e.g. offline / endpoint failure).
      const liveProviderWindows = liveSummary?.providerWindows ?? null;
      const hasLiveProviderWindows = Boolean(liveProviderWindows && Object.keys(liveProviderWindows).length);
      if (!hasLiveProviderWindows && source.cachedQuota) {
        const extracted = transformAntigravityProviderWindows(source.cachedQuota);
        if (Object.keys(extracted).length > 0) {
          providerWindows = { ...providerWindows, ...extracted };
        }
      }

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

      // Merge the live windows last so they override anything derived from the
      // cached fallback, then enrich the models with the matching family windows
      // (gemini for Gemini models, non-gemini/3p for Claude/GPT models).
      if (hasLiveProviderWindows) {
        providerWindows = { ...providerWindows, ...liveProviderWindows };
      }

      if (liveSummary) {
        // Enrich every model with the live family windows (weekly for all, 5h
        // only where the model has no dynamic per-model reading of its own —
        // see applyFamilyWindowsToModels, which shields live model quotas from
        // the generic grouped buckets such as `gemini-5h` = 1.0).
        applyFamilyWindowsToModels(models, liveSummary.familyWindows);
        liveSummaryApplied = true;
      } else if (source.cachedQuota) {
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

  // Ensure providerWindows has both 5h and weekly from Antigravity cachedQuota.
  // Skipped entirely once a live summary was applied: stale on-disk values must
  // never overwrite or fill gaps left by authoritative live data.
  if (!liveSummaryApplied) {
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

  // Provider-level 5h comes from the live Gemini model readings themselves
  // (most-consumed model wins), not from the grouped `gemini-5h` bucket of
  // retrieveUserQuotaSummary or the on-disk cachedQuota: that aggregate can sit
  // at remainingFraction 1.0 (0% used) while the real models already report
  // consumption, freezing the gauge at 0%. Weekly has no per-model source, so
  // it keeps coming from the live summary (or the cached fallback).
  const liveGeminiFiveHour = deriveGeminiFiveHourWindow(models);
  if (liveGeminiFiveHour) {
    providerWindows = { ...providerWindows, '5h': liveGeminiFiveHour };
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
