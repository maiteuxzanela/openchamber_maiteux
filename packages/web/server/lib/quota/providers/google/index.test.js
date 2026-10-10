import { describe, expect, it } from 'vitest';
import {
  fetchGoogleQuota,
  isConfigured,
  providerId,
  providerName,
  resolveGoogleAuthSources
} from './index.js';
import { resolveAntigravityAuth } from './auth.js';

describe('Google quota provider', () => {
  it('exposes provider metadata', () => {
    expect(providerId).toBe('google');
    expect(providerName).toBe('Google');
    expect(typeof isConfigured).toBe('function');
  });

  it('resolves antigravity auth with cachedQuota when configured', () => {
    const auth = resolveAntigravityAuth();
    if (auth) {
      expect(auth.sourceId).toBe('antigravity');
      expect(auth.refreshToken).toBeDefined();
      if (auth.cachedQuota) {
        expect(auth.cachedQuota.gemini).toBeDefined();
      }
    }
  });

  it('resolves google auth sources', () => {
    const sources = resolveGoogleAuthSources();
    expect(Array.isArray(sources)).toBe(true);
  });

  it('surfaces 5h and weekly quota windows in usage.windows', async () => {
    const sources = resolveGoogleAuthSources();
    if (sources.length === 0) return;

    const result = await fetchGoogleQuota();
    expect(result.providerId).toBe('google');
    expect(result.providerName).toBe('Google');
    expect(result.ok).toBe(true);
    expect(result.configured).toBe(true);

    expect(result.usage).toBeDefined();
    expect(result.usage.windows).toBeDefined();

    // Verify 5h window
    if (result.usage.windows['5h']) {
      expect(typeof result.usage.windows['5h'].usedPercent).toBe('number');
      expect(typeof result.usage.windows['5h'].remainingPercent).toBe('number');
      expect(result.usage.windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    }

    // Verify weekly window
    if (result.usage.windows.weekly) {
      expect(typeof result.usage.windows.weekly.usedPercent).toBe('number');
      expect(typeof result.usage.windows.weekly.remainingPercent).toBe('number');
      expect(result.usage.windows.weekly.windowSeconds).toBe(7 * 24 * 60 * 60);
    }
  });
});
