import { describe, expect, it } from 'vitest';
import {
  transformCachedQuotaWindows,
  transformCachedQuota,
  transformAntigravityProviderWindows,
  applyCachedQuotaToModels,
  parseGoogleRefreshToken,
  transformQuotaBucket,
  transformModelData
} from './transforms.js';

describe('Google / Antigravity transforms', () => {
  const SAMPLE_CACHED_QUOTA = {
    gemini: {
      remainingFraction: 0.4099272,
      resetTime: '2026-10-15T15:31:37Z',
      modelCount: 2,
      windows: [
        {
          window: '5h',
          remainingFraction: 0.953209,
          resetTime: '2026-10-10T17:03:21Z'
        },
        {
          window: 'weekly',
          remainingFraction: 0.4099272,
          resetTime: '2026-10-15T15:31:37Z'
        }
      ]
    },
    'non-gemini': {
      remainingFraction: 1,
      resetTime: '2026-10-10T18:31:54Z',
      modelCount: 3,
      windows: [
        {
          window: '5h',
          remainingFraction: 1,
          resetTime: '2026-10-10T18:31:54Z'
        },
        {
          window: 'weekly',
          remainingFraction: 1,
          resetTime: '2026-10-17T13:31:54Z'
        }
      ]
    }
  };

  it('transforms family cachedQuota windows to 5h and weekly usage windows', () => {
    const windows = transformCachedQuotaWindows(SAMPLE_CACHED_QUOTA.gemini);

    expect(windows['5h']).toBeDefined();
    expect(windows['5h'].usedPercent).toBe(5);
    expect(windows['5h'].remainingPercent).toBe(95);
    expect(windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    expect(windows['5h'].resetAt).toBe(Date.parse('2026-10-10T17:03:21Z'));

    expect(windows.weekly).toBeDefined();
    expect(windows.weekly.usedPercent).toBe(59);
    expect(windows.weekly.remainingPercent).toBe(41);
    expect(windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-10-15T15:31:37Z'));
  });

  it('transforms entire cachedQuota with all model families', () => {
    const allFamilies = transformCachedQuota(SAMPLE_CACHED_QUOTA);

    expect(allFamilies.gemini).toBeDefined();
    expect(allFamilies.gemini['5h'].usedPercent).toBe(5);
    expect(allFamilies.gemini.weekly.usedPercent).toBe(59);

    expect(allFamilies['non-gemini']).toBeDefined();
    expect(allFamilies['non-gemini']['5h'].usedPercent).toBe(0);
    expect(allFamilies['non-gemini'].weekly.usedPercent).toBe(0);
  });

  it('extracts provider-level windows from Antigravity cachedQuota', () => {
    const providerWindows = transformAntigravityProviderWindows(SAMPLE_CACHED_QUOTA);

    expect(providerWindows['5h'].usedPercent).toBe(5);
    expect(providerWindows['5h'].windowSeconds).toBe(18000);
    expect(providerWindows.weekly.usedPercent).toBe(59);
    expect(providerWindows.weekly.windowSeconds).toBe(604800);
  });

  it('falls back to top-level remainingFraction if windows array is missing', () => {
    const legacyQuota = {
      remainingFraction: 0.25,
      resetTime: '2026-10-16T12:00:00Z'
    };
    const windows = transformCachedQuotaWindows(legacyQuota);

    expect(windows.weekly).toBeDefined();
    expect(windows.weekly.usedPercent).toBe(75);
    expect(windows.weekly.remainingPercent).toBe(25);
    expect(windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    expect(windows.weekly.resetAt).toBe(Date.parse('2026-10-16T12:00:00Z'));
  });

  it('augments models with weekly windows from cachedQuota', () => {
    const models = {
      'antigravity/gemini-3.8-flash': {
        windows: {
          '5h': { usedPercent: 10, windowSeconds: 18000 }
        }
      },
      'antigravity/claude-sonnet-5-5': {
        windows: {
          '5h': { usedPercent: 0, windowSeconds: 18000 }
        }
      }
    };

    applyCachedQuotaToModels(models, SAMPLE_CACHED_QUOTA);

    expect(models['antigravity/gemini-3.8-flash'].windows.weekly).toBeDefined();
    expect(models['antigravity/gemini-3.8-flash'].windows.weekly.usedPercent).toBe(59);

    expect(models['antigravity/claude-sonnet-5-5'].windows.weekly).toBeDefined();
    expect(models['antigravity/claude-sonnet-5-5'].windows.weekly.usedPercent).toBe(0);
  });

  it('extracts provider windows when passing full account object with cachedQuota', () => {
    const account = {
      email: 'test@example.com',
      cachedQuota: SAMPLE_CACHED_QUOTA
    };
    const providerWindows = transformAntigravityProviderWindows(account);

    expect(providerWindows['5h']).toBeDefined();
    expect(providerWindows['5h'].usedPercent).toBe(5);
    expect(providerWindows.weekly).toBeDefined();
    expect(providerWindows.weekly.usedPercent).toBe(59);
  });

  it('enriches models when passing account object with cachedQuota to applyCachedQuotaToModels', () => {
    const account = {
      email: 'test@example.com',
      cachedQuota: SAMPLE_CACHED_QUOTA
    };
    const models = {
      'antigravity/gemini-2.5-pro': {}
    };

    applyCachedQuotaToModels(models, account);

    expect(models['antigravity/gemini-2.5-pro'].windows['5h']).toBeDefined();
    expect(models['antigravity/gemini-2.5-pro'].windows['5h'].usedPercent).toBe(5);
    expect(models['antigravity/gemini-2.5-pro'].windows.weekly).toBeDefined();
    expect(models['antigravity/gemini-2.5-pro'].windows.weekly.usedPercent).toBe(59);
  });

  it('derives weekly window from top-level remainingFraction when windows array only contains 5h', () => {
    const quotaOnly5h = {
      remainingFraction: 0.35,
      resetTime: '2026-10-18T10:00:00Z',
      windows: [
        {
          window: '5h',
          remainingFraction: 0.8,
          resetTime: '2026-10-12T15:00:00Z'
        }
      ]
    };
    const windows = transformCachedQuotaWindows(quotaOnly5h);

    expect(windows['5h']).toBeDefined();
    expect(windows['5h'].usedPercent).toBe(20);
    expect(windows.weekly).toBeDefined();
    expect(windows.weekly.usedPercent).toBe(65);
    expect(windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
  });
});
