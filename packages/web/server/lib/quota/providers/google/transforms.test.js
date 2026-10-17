import { describe, expect, it } from 'vitest';
import {
  transformCachedQuotaWindows,
  transformCachedQuota,
  transformAntigravityProviderWindows,
  applyCachedQuotaToModels,
  parseGoogleRefreshToken,
  transformQuotaBucket,
  transformModelData,
  transformUserQuotaSummary,
  applyFamilyWindowsToModels
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

describe('Google — transformUserQuotaSummary (live retrieveUserQuotaSummary)', () => {
  const WEEKLY_RESET = '2026-10-15T15:31:37Z';
  const FIVE_HOUR_RESET = '2026-10-10T17:03:21Z';
  const THREE_P_WEEKLY_RESET = '2026-10-17T13:31:54Z';
  const THREE_P_FIVE_HOUR_RESET = '2026-10-10T18:31:54Z';

  const CANONICAL_PAYLOAD = {
    groups: [
      {
        displayName: 'gemini',
        buckets: [
          { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.73, resetTime: WEEKLY_RESET },
          { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.953209, resetTime: FIVE_HOUR_RESET }
        ]
      },
      {
        displayName: '3p',
        buckets: [
          { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5, resetTime: THREE_P_WEEKLY_RESET },
          { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: THREE_P_FIVE_HOUR_RESET }
        ]
      }
    ]
  };

  it('maps the four canonical buckets to usedPercent/windowSeconds/resetAt', () => {
    const { providerWindows, familyWindows } = transformUserQuotaSummary(CANONICAL_PAYLOAD);

    // The gemini family is the provider-level default.
    expect(providerWindows).toBe(familyWindows.gemini);

    expect(providerWindows.weekly.usedPercent).toBe(27);
    expect(providerWindows.weekly.remainingPercent).toBe(73);
    expect(providerWindows.weekly.windowSeconds).toBe(604800);
    expect(providerWindows.weekly.resetAt).toBe(Date.parse(WEEKLY_RESET));

    expect(providerWindows['5h'].usedPercent).toBe(5);
    expect(providerWindows['5h'].remainingPercent).toBe(95);
    expect(providerWindows['5h'].windowSeconds).toBe(18000);
    expect(providerWindows['5h'].resetAt).toBe(Date.parse(FIVE_HOUR_RESET));

    expect(familyWindows['non-gemini'].weekly.usedPercent).toBe(50);
    expect(familyWindows['non-gemini'].weekly.remainingPercent).toBe(50);
    expect(familyWindows['non-gemini'].weekly.windowSeconds).toBe(604800);
    expect(familyWindows['non-gemini'].weekly.resetAt).toBe(Date.parse(THREE_P_WEEKLY_RESET));

    expect(familyWindows['non-gemini']['5h'].usedPercent).toBe(0);
    expect(familyWindows['non-gemini']['5h'].remainingPercent).toBe(100);
    expect(familyWindows['non-gemini']['5h'].windowSeconds).toBe(18000);
    expect(familyWindows['non-gemini']['5h'].resetAt).toBe(Date.parse(THREE_P_FIVE_HOUR_RESET));
  });

  it('derives the window from the bucketId when no explicit window field is present', () => {
    const { providerWindows } = transformUserQuotaSummary({
      groups: [{
        buckets: [
          { bucketId: 'gemini-weekly', remainingFraction: 0.25 },
          { bucketId: 'gemini-five-hour', remainingFraction: 0.5 }
        ]
      }]
    });

    expect(providerWindows.weekly.usedPercent).toBe(75);
    expect(providerWindows.weekly.windowSeconds).toBe(604800);
    expect(providerWindows['5h'].usedPercent).toBe(50);
    expect(providerWindows['5h'].windowSeconds).toBe(18000);
  });

  it('gives a canonical bucket precedence over a model-scoped variant regardless of order', () => {
    const scopedFirst = transformUserQuotaSummary({
      groups: [{
        buckets: [
          { bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0.1 },
          { bucketId: 'gemini-weekly', remainingFraction: 0.73 }
        ]
      }]
    });
    expect(scopedFirst.providerWindows.weekly.usedPercent).toBe(27);

    const canonicalFirst = transformUserQuotaSummary({
      groups: [{
        buckets: [
          { bucketId: 'gemini-weekly', remainingFraction: 0.73 },
          { bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0.1 }
        ]
      }]
    });
    expect(canonicalFirst.providerWindows.weekly.usedPercent).toBe(27);
  });

  it('keeps the model-scoped variant only while no canonical bucket was seen', () => {
    const { providerWindows } = transformUserQuotaSummary({
      groups: [{
        buckets: [{ bucketId: 'gemini-argon-wtu-weekly', remainingFraction: 0.1 }]
      }]
    });

    expect(providerWindows.weekly.usedPercent).toBe(90);
  });

  it('sets usedPercent to null when remainingFraction is absent', () => {
    const { providerWindows } = transformUserQuotaSummary({
      groups: [{ buckets: [{ bucketId: 'gemini-weekly', window: 'weekly' }] }]
    });

    expect(providerWindows.weekly.usedPercent).toBeNull();
    expect(providerWindows.weekly.remainingPercent).toBeNull();
    expect(providerWindows.weekly.windowSeconds).toBe(604800);
    expect(providerWindows.weekly.resetAt).toBeNull();
  });

  it('ignores buckets with an unknown family prefix, unknown window or missing bucketId', () => {
    const { providerWindows, familyWindows } = transformUserQuotaSummary({
      groups: [{
        buckets: [
          { bucketId: 'unrelated-bucket', window: 'weekly', remainingFraction: 0.5 },
          { bucketId: 'gemini-monthly', window: 'monthly', remainingFraction: 0.5 },
          { window: 'weekly', remainingFraction: 0.5 }
        ]
      }]
    });

    expect(providerWindows).toEqual({});
    expect(familyWindows).toEqual({});
  });

  it('returns empty maps for an empty or malformed payload', () => {
    expect(transformUserQuotaSummary({})).toEqual({ providerWindows: {}, familyWindows: {} });
    expect(transformUserQuotaSummary(null)).toEqual({ providerWindows: {}, familyWindows: {} });
    expect(transformUserQuotaSummary({ groups: [{ buckets: [] }] })).toEqual({ providerWindows: {}, familyWindows: {} });
  });
});

describe('Google — applyFamilyWindowsToModels', () => {
  it('enriches gemini and non-gemini models with the live family windows (override)', () => {
    const { familyWindows } = transformUserQuotaSummary({
      groups: [
        {
          displayName: 'gemini',
          buckets: [
            { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.73 },
            { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.953209 }
          ]
        },
        {
          displayName: '3p',
          buckets: [
            { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 },
            { bucketId: '3p-5h', window: '5h', remainingFraction: 1 }
          ]
        }
      ]
    });

    const models = {
      'antigravity/gemini-3.8-flash': { windows: { '5h': { usedPercent: 99, windowSeconds: 18000 } } },
      'antigravity/claude-sonnet-5-5': { windows: {} }
    };

    const returned = applyFamilyWindowsToModels(models, familyWindows);

    expect(returned).toBe(models);
    // Live values override the pre-existing (stale) 5h window.
    expect(models['antigravity/gemini-3.8-flash'].windows.weekly.usedPercent).toBe(27);
    expect(models['antigravity/gemini-3.8-flash'].windows.weekly.windowSeconds).toBe(604800);
    expect(models['antigravity/gemini-3.8-flash'].windows['5h'].usedPercent).toBe(5);
    // Non-gemini models take the 3p family windows.
    expect(models['antigravity/claude-sonnet-5-5'].windows.weekly.usedPercent).toBe(50);
    expect(models['antigravity/claude-sonnet-5-5'].windows['5h'].usedPercent).toBe(0);
  });

  it('returns the models untouched when familyWindows or models is absent', () => {
    const models = { 'antigravity/gemini-3.8-flash': {} };
    expect(applyFamilyWindowsToModels(models, null)).toBe(models);
    expect(applyFamilyWindowsToModels(null, {})).toBeNull();
  });
});
