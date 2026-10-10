import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';

/**
 * Picking the quota headlines worth showing while the Usage section is collapsed.
 *
 * The primary limit is the one that runs out first, which is the shortest
 * window a provider reports — a 5-hour bucket says more about whether the next
 * turn will land than a monthly one. Rows without a window duration (credit
 * balances, tool counters) are kept only as a last resort, since they never
 * answer "can I keep working right now".
 *
 * When available, a secondary longer-cycle weekly window (weekly / 7d) from the
 * same provider or model is also extracted to give the user a clear high-level
 * picture of both their short-term turn headroom and longer-cycle quota.
 */

/**
 * Quota provider ids mostly match OpenCode provider ids; these are the ones
 * that do not. Unmatched providers simply produce no headline.
 *
 * `claude-code` is the provider the opencode-claude integration registers, and
 * it bills against the same Claude subscription the `claude` quota reports.
 */
const QUOTA_PROVIDER_ALIASES = new Map<string, string>([
  ['openai', 'codex'],
  ['chatgpt', 'codex'],
  ['anthropic', 'claude'],
  ['claude-code', 'claude'],
  ['gemini', 'google'],
]);

const normalize = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase();

export const resolveQuotaProviderId = (modelProviderId: string | null | undefined): string | null => {
  const normalized = normalize(modelProviderId);
  if (!normalized) return null;
  return QUOTA_PROVIDER_ALIASES.get(normalized) ?? normalized;
};

/**
 * Checks whether a usage limit row represents a weekly / 7-day quota window.
 */
export const isWeeklyWindowRow = (row: UsageLimitRow): boolean => {
  const seconds = row.window?.windowSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 6 * 24 * 3600 && seconds <= 8 * 24 * 3600) {
    return true;
  }
  const key = (row.key ?? '').toLowerCase();
  if (key.includes('weekly') || key.includes('7d')) {
    return true;
  }
  const label = (row.label ?? '').toLowerCase();
  if (
    label.includes('weekly') ||
    label.includes('semanal') ||
    label.includes('7-day') ||
    label.includes('7d') ||
    label.includes('7 dias') ||
    label.includes('7-dias')
  ) {
    return true;
  }
  return false;
};

export type UsageHeadlinesResult = {
  group: UsageProviderGroup;
  primary: UsageLimitRow;
  secondary: UsageLimitRow | null;
};

export type UsageHeadlineResult = {
  group: UsageProviderGroup;
  row: UsageLimitRow;
  secondaryRow: UsageLimitRow | null;
};

/**
 * Extracts both primary (shortest reported window) and secondary (weekly/7d window)
 * for the provider or model the composer is pointed at.
 */
export const pickUsageHeadlines = (
  groups: readonly UsageProviderGroup[],
  modelProviderId: string | null | undefined,
): UsageHeadlinesResult | null => {
  const quotaProviderId = resolveQuotaProviderId(modelProviderId);
  if (!quotaProviderId) return null;

  const group = groups.find((candidate) => normalize(candidate.providerId) === quotaProviderId);
  if (!group || group.rows.length === 0) return null;

  // Provider-level rows only: a model-scoped row describes one model, not the
  // provider the composer is pointed at.
  const providerRows = group.rows.filter((row) => !row.subtitle);
  const rows = providerRows.length > 0 ? providerRows : group.rows;

  let best: UsageLimitRow | null = null;
  let bestSeconds = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const seconds = row.window?.windowSeconds;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) continue;
    if (seconds < bestSeconds) {
      best = row;
      bestSeconds = seconds;
    }
  }

  const primary = best ?? rows[0];

  // If the primary row itself is already a weekly window, there is no distinct
  // shorter cycle to pair it with.
  let secondary: UsageLimitRow | null = null;
  if (!isWeeklyWindowRow(primary)) {
    const candidates = rows.filter((row) => {
      if (row === primary || row.key === primary.key) return false;
      if (primary.subtitle && row.subtitle !== primary.subtitle) return false;
      if (!primary.subtitle && row.subtitle) return false;
      return isWeeklyWindowRow(row);
    });

    if (candidates.length > 0) {
      secondary = candidates.find((r) => typeof r.window?.windowSeconds === 'number' && r.window.windowSeconds > 0) ?? candidates[0];
    }
  }

  return {
    group,
    primary,
    secondary,
  };
};

/**
 * Shortest reported window for the provider the composer is pointed at,
 * along with an optional secondary weekly window if available.
 *
 * Returns null when nothing matches — the section then falls back to its
 * display-mode label rather than showing a quota belonging to some other
 * provider, which would read as the active one.
 */
export const pickUsageHeadline = (
  groups: readonly UsageProviderGroup[],
  modelProviderId: string | null | undefined,
): UsageHeadlineResult | null => {
  const result = pickUsageHeadlines(groups, modelProviderId);
  if (!result) return null;
  return {
    group: result.group,
    row: result.primary,
    secondaryRow: result.secondary,
  };
};
