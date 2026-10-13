import type { UsageProviderGroup, UsageLimitRow } from '@/components/usage/usageGroups';
import { useConfigStore } from '@/stores/useConfigStore';

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

/**
 * Estimates window duration in seconds for sorting purposes when windowSeconds is missing or non-finite.
 */
export const estimateWindowSeconds = (row: UsageLimitRow): number => {
  const seconds = row.window?.windowSeconds;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return seconds;
  }
  const key = (row.key ?? '').toLowerCase();
  const label = (row.label ?? '').toLowerCase();

  if (key.includes('5h') || label.includes('5-hour') || label.includes('5h')) {
    return 5 * 3600;
  }
  if (key.includes('daily') || label.includes('daily') || label.includes('diária') || label.includes('diaria')) {
    return 24 * 3600;
  }
  if (isWeeklyWindowRow(row)) {
    return 7 * 24 * 3600;
  }
  if (key.includes('monthly') || label.includes('monthly') || label.includes('mensal')) {
    return 30 * 24 * 3600;
  }
  return Number.POSITIVE_INFINITY;
};

/**
 * Checks whether a usage limit row matches an active model identifier.
 * Prevents non-gemini model quotas (e.g. Claude Opus/Sonnet 98% used) from leaking into Gemini sessions.
 */
export const rowMatchesModel = (row: UsageLimitRow, modelId: string | null | undefined): boolean => {
  if (!modelId) return true;
  const rawModel = modelId.trim().toLowerCase();
  if (!rawModel) return true;

  // Strip provider prefixes (e.g. 'google/gemini-2.5-flash' -> 'gemini-2.5-flash')
  const modelName = rawModel.includes('/') ? rawModel.split('/')[1] : rawModel;

  const rowSubtitle = (row.subtitle ?? '').trim().toLowerCase();
  const rowKey = (row.key ?? '').trim().toLowerCase();

  const isTargetGemini = modelName.includes('gemini');
  const isTargetClaude = modelName.includes('claude');

  // If user is on Gemini, exclude Claude / Opus / Sonnet / GPT rows strictly
  if (isTargetGemini) {
    if (
      rowSubtitle.includes('claude') ||
      rowSubtitle.includes('opus') ||
      rowSubtitle.includes('sonnet') ||
      rowSubtitle.includes('gpt') ||
      rowKey.includes('claude') ||
      rowKey.includes('opus') ||
      rowKey.includes('sonnet') ||
      rowKey.includes('gpt')
    ) {
      return false;
    }
    return rowSubtitle.includes('gemini') || rowKey.includes('gemini');
  }

  // If user is on Claude, exclude Gemini / GPT rows strictly
  if (isTargetClaude) {
    if (
      rowSubtitle.includes('gemini') ||
      rowSubtitle.includes('gpt') ||
      rowKey.includes('gemini') ||
      rowKey.includes('gpt')
    ) {
      return false;
    }

    if (modelName.includes('opus')) {
      return rowSubtitle.includes('opus') || rowKey.includes('opus');
    }
    if (modelName.includes('sonnet')) {
      return rowSubtitle.includes('sonnet') || rowKey.includes('sonnet');
    }
    if (modelName.includes('haiku')) {
      return rowSubtitle.includes('haiku') || rowKey.includes('haiku');
    }
    return rowSubtitle.includes('claude') || rowKey.includes('claude');
  }

  // General model matching (e.g. 'glm-5', 'gpt-4o')
  if (rowSubtitle) {
    if (rowSubtitle === modelName || modelName.includes(rowSubtitle) || rowSubtitle.includes(modelName)) {
      return true;
    }
  }
  if (rowKey.includes(modelName)) {
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
  activeModelId?: string | null | undefined,
): UsageHeadlinesResult | null => {
  const quotaProviderId = resolveQuotaProviderId(modelProviderId);
  if (!quotaProviderId) return null;

  const group = groups.find((candidate) => normalize(candidate.providerId) === quotaProviderId);
  if (!group || group.rows.length === 0) return null;

  const currentModel = activeModelId !== undefined
    ? activeModelId
    : (typeof useConfigStore !== 'undefined' ? useConfigStore.getState?.()?.currentModelId : undefined);

  const providerRows = group.rows.filter((row) => !row.subtitle && !row.key.startsWith('model-'));
  const modelRows = group.rows.filter((row) => Boolean(row.subtitle || row.key.startsWith('model-')));

  let candidateRows: UsageLimitRow[] = [];

  if (currentModel && currentModel.trim() && modelRows.length > 0) {
    const matchedModelRows = modelRows.filter((row) => rowMatchesModel(row, currentModel));
    if (matchedModelRows.length > 0) {
      candidateRows = matchedModelRows;
    } else if (providerRows.length > 0) {
      // Model rows exist but none matched active model (e.g. non-gemini Claude Opus while active is Gemini).
      // Fall back to clean provider-level rows (e.g. general Google/Gemini quota).
      candidateRows = providerRows;
    } else {
      // Only foreign model rows exist -> strictly do not leak
      return null;
    }
  } else if (providerRows.length > 0) {
    candidateRows = providerRows;
  } else {
    candidateRows = group.rows;
  }

  if (candidateRows.length === 0) return null;

  let best: UsageLimitRow | null = null;
  let bestSeconds = Number.POSITIVE_INFINITY;
  for (const row of candidateRows) {
    const seconds = estimateWindowSeconds(row);
    if (seconds < bestSeconds) {
      best = row;
      bestSeconds = seconds;
    }
  }

  const primary = best ?? candidateRows[0];

  // If the primary row itself is already a weekly window, there is no distinct
  // shorter cycle to pair it with.
  let secondary: UsageLimitRow | null = null;
  if (!isWeeklyWindowRow(primary)) {
    const candidates = candidateRows.filter((row) => {
      if (row === primary || row.key === primary.key) return false;
      if (primary.subtitle && row.subtitle !== primary.subtitle) return false;
      if (!primary.subtitle && row.subtitle) return false;
      return isWeeklyWindowRow(row);
    });

    if (candidates.length > 0) {
      secondary = candidates.find((r) => estimateWindowSeconds(r) < Number.POSITIVE_INFINITY) ?? candidates[0];
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
  activeModelId?: string | null | undefined,
): UsageHeadlineResult | null => {
  const result = pickUsageHeadlines(groups, modelProviderId, activeModelId);
  if (!result) return null;
  return {
    group: result.group,
    row: result.primary,
    secondaryRow: result.secondary,
  };
};
