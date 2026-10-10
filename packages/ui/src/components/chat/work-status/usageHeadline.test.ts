import { describe, expect, test } from 'bun:test';
import { isWeeklyWindowRow, pickUsageHeadline, pickUsageHeadlines, resolveQuotaProviderId } from './usageHeadline';
import type { UsageProviderGroup } from '@/components/usage/usageGroups';

const HOUR = 3600;

const window = (windowSeconds: number | null, usedPercent = 10) => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowSeconds,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const group = (providerId: string, rows: Array<{ key: string; label: string; subtitle?: string; seconds: number | null; used?: number }>): UsageProviderGroup => ({
  providerId: providerId as UsageProviderGroup['providerId'],
  providerName: providerId,
  status: null,
  rows: rows.map((row) => ({
    key: row.key,
    label: row.label,
    subtitle: row.subtitle,
    window: window(row.seconds, row.used ?? 10),
  })),
});

describe('resolveQuotaProviderId', () => {
  test('passes through ids that already match a quota provider', () => {
    expect(resolveQuotaProviderId('opencode-go')).toBe('opencode-go');
  });

  test('maps the known divergences', () => {
    expect(resolveQuotaProviderId('openai')).toBe('codex');
    expect(resolveQuotaProviderId('anthropic')).toBe('claude');
  });

  test('maps the opencode-claude integration provider onto Claude quota', () => {
    expect(resolveQuotaProviderId('claude-code')).toBe('claude');
  });

  test('is case and whitespace tolerant, and rejects empties', () => {
    expect(resolveQuotaProviderId('  OpenAI ')).toBe('codex');
    expect(resolveQuotaProviderId('')).toBeNull();
    expect(resolveQuotaProviderId(null)).toBeNull();
  });
});

describe('isWeeklyWindowRow', () => {
  test('recognizes 7-day duration in seconds', () => {
    expect(isWeeklyWindowRow({ key: 'custom', label: 'Custom', window: window(7 * 24 * HOUR) })).toBe(true);
  });

  test('recognizes weekly and 7d in keys', () => {
    expect(isWeeklyWindowRow({ key: 'window-weekly', label: 'Quota', window: window(null) })).toBe(true);
    expect(isWeeklyWindowRow({ key: 'model-gemini-7d', label: 'Quota', window: window(null) })).toBe(true);
  });

  test('recognizes weekly labels in various locales (Weekly, Semanal, 7-Day Limit)', () => {
    expect(isWeeklyWindowRow({ key: 'k1', label: 'Weekly', window: window(null) })).toBe(true);
    expect(isWeeklyWindowRow({ key: 'k2', label: 'Semanal', window: window(null) })).toBe(true);
    expect(isWeeklyWindowRow({ key: 'k3', label: '7-Day Limit', window: window(null) })).toBe(true);
    expect(isWeeklyWindowRow({ key: 'k4', label: '7 dias', window: window(null) })).toBe(true);
  });

  test('rejects non-weekly windows (daily, 5h, monthly, credits)', () => {
    expect(isWeeklyWindowRow({ key: 'window-5h', label: '5-Hour', window: window(5 * HOUR) })).toBe(false);
    expect(isWeeklyWindowRow({ key: 'window-daily', label: 'Diária', window: window(24 * HOUR) })).toBe(false);
    expect(isWeeklyWindowRow({ key: 'window-monthly', label: 'Mensal', window: window(30 * 24 * HOUR) })).toBe(false);
    expect(isWeeklyWindowRow({ key: 'credits', label: 'Credits', window: window(null) })).toBe(false);
  });
});

describe('pickUsageHeadline and pickUsageHeadlines', () => {
  const groups = [
    group('codex', [{ key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR }]),
    group('opencode-go', [
      { key: 'm', label: 'Monthly Limit', seconds: 30 * 24 * HOUR },
      { key: 'h', label: '5-Hour', seconds: 5 * HOUR, used: 3 },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR, used: 59 },
    ]),
    group('google', [
      { key: 'window-5h', label: '5-Hour', seconds: 5 * HOUR, used: 3 },
      { key: 'window-weekly', label: 'Semanal', seconds: 7 * 24 * HOUR, used: 59 },
    ]),
  ];

  test('picks the shortest window of the matching provider', () => {
    // The tightest bucket is the one that decides whether the next turn lands.
    expect(pickUsageHeadline(groups, 'opencode-go')?.row.label).toBe('5-Hour');
  });

  test('picks both 5-hour primary and weekly secondary when both are present', () => {
    const headline = pickUsageHeadline(groups, 'opencode-go');
    expect(headline?.row.label).toBe('5-Hour');
    expect(headline?.secondaryRow?.label).toBe('Weekly Limit');

    const dual = pickUsageHeadlines(groups, 'opencode-go');
    expect(dual?.primary.label).toBe('5-Hour');
    expect(dual?.secondary?.label).toBe('Weekly Limit');
  });

  test('extracts 5-Hour and Semanal for google/gemini alias', () => {
    const headline = pickUsageHeadline(groups, 'gemini');
    expect(headline?.group.providerId).toBe('google');
    expect(headline?.row.label).toBe('5-Hour');
    expect(headline?.row.window.usedPercent).toBe(3);
    expect(headline?.secondaryRow?.label).toBe('Semanal');
    expect(headline?.secondaryRow?.window.usedPercent).toBe(59);
  });

  test('leaves secondaryRow as null when only a weekly window exists', () => {
    const headline = pickUsageHeadline(groups, 'codex');
    expect(headline?.row.label).toBe('Weekly Limit');
    expect(headline?.secondaryRow).toBeNull();
  });

  test('leaves secondaryRow as null when only 5-hour and daily exist without weekly', () => {
    const onlyDaily = [
      group('custom-provider', [
        { key: 'h', label: '5-Hour', seconds: 5 * HOUR },
        { key: 'd', label: 'Daily', seconds: 24 * HOUR },
      ]),
    ];
    const headline = pickUsageHeadline(onlyDaily, 'custom-provider');
    expect(headline?.row.label).toBe('5-Hour');
    expect(headline?.secondaryRow).toBeNull();
  });

  test('resolves the provider through the alias table', () => {
    expect(pickUsageHeadline(groups, 'openai')?.group.providerId).toBe('codex');
  });

  test('returns null when no group matches the composer provider', () => {
    // Showing another provider's quota would read as the active one.
    expect(pickUsageHeadline(groups, 'mistral')).toBeNull();
    expect(pickUsageHeadline(groups, null)).toBeNull();
  });

  test('ignores model-scoped rows while any provider-level row exists', () => {
    const scoped = [group('zai-coding-plan', [
      { key: 'model', label: '5-Hour', subtitle: 'GLM-5', seconds: 5 * HOUR },
      { key: 'provider', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(scoped, 'zai-coding-plan')?.row.label).toBe('Weekly Limit');
  });

  test('pairs model-scoped 5-hour and weekly windows belonging to the same model', () => {
    const scopedModels = [
      group('claude', [
        { key: 'm1-5h', label: '5-Hour', subtitle: 'Claude Sonnet', seconds: 5 * HOUR },
        { key: 'm1-w', label: 'Weekly Limit', subtitle: 'Claude Sonnet', seconds: 7 * 24 * HOUR },
        { key: 'm2-w', label: 'Weekly Limit', subtitle: 'Claude Opus', seconds: 7 * 24 * HOUR },
      ]),
    ];
    const headline = pickUsageHeadline(scopedModels, 'anthropic');
    expect(headline?.row.label).toBe('5-Hour');
    expect(headline?.row.subtitle).toBe('Claude Sonnet');
    expect(headline?.secondaryRow?.label).toBe('Weekly Limit');
    expect(headline?.secondaryRow?.subtitle).toBe('Claude Sonnet');
  });

  test('falls back to a durationless row when nothing reports a window', () => {
    const balances = [group('codex', [{ key: 'credits', label: 'Credits Balance', seconds: null }])];
    expect(pickUsageHeadline(balances, 'codex')?.row.label).toBe('Credits Balance');
    expect(pickUsageHeadline(balances, 'codex')?.secondaryRow).toBeNull();
  });

  test('prefers any real window over a durationless row', () => {
    const mixed = [group('codex', [
      { key: 'credits', label: 'Credits Balance', seconds: null },
      { key: 'w', label: 'Weekly Limit', seconds: 7 * 24 * HOUR },
    ])];
    expect(pickUsageHeadline(mixed, 'codex')?.row.label).toBe('Weekly Limit');
    expect(pickUsageHeadline(mixed, 'codex')?.secondaryRow).toBeNull();
  });

  test('returns null for a matched provider that reported no rows', () => {
    expect(pickUsageHeadline([group('codex', [])], 'codex')).toBeNull();
  });
});
