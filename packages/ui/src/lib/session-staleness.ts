/**
 * Single source of truth for "is the trailing assistant turn still alive?".
 *
 * Both the queue gate (`useQueuedMessageAutoSend`) and the working indicator
 * (`useSessionActivity`) derive the fallback from this predicate. The streaming
 * flag is deliberately NOT part of the decision: it is weak evidence that can
 * be orphaned when the SSE connection dies, and an orphaned flag used to pin
 * the session busy forever (stuck queue + frozen "working" spinner).
 *
 * The only durable evidence is the message timestamp the backend refreshes on
 * every real update (`time.updated`, falling back to `time.created`): fresh
 * within the timeout means the turn is genuinely running, past it means the
 * evidence expired and the session must be treated as idle.
 */
export const STALE_PENDING_ASSISTANT_TIMEOUT_MS = 10_000;

export interface SessionTimingMessage {
  role?: string;
  id?: string;
  finish?: unknown;
  time?: {
    created?: number;
    updated?: number;
    completed?: number;
  };
}

export type PendingAssistantEvidence =
  /** No trailing assistant turn waiting for completion. */
  | { kind: 'none' }
  /** The turn is still inside the freshness window; `expiresAt` is when it stops being evidence. */
  | { kind: 'pending'; lastUpdateAt: number; expiresAt: number }
  /** The turn's evidence expired; the session must be treated as idle. */
  | { kind: 'stale'; lastUpdateAt: number };

/**
 * Session timestamps arrive either in seconds or in milliseconds; anything
 * below 1e10 seconds is a seconds-precision value.
 */
export const normalizeSessionTimestampMs = (rawTimestamp: number): number => (
  rawTimestamp < 1e10 ? rawTimestamp * 1000 : rawTimestamp
);

/**
 * Resolve the pending-assistant evidence for a session's message list.
 *
 * `now` is injected so callers (and tests) control the clock instead of
 * depending on wall time. A message whose completion marker (`time.completed`)
 * or `finish` has landed is never pending, and a pending message without any
 * usable timestamp cannot prove liveness — both resolve to `none`, because
 * treating them as busy would recreate the hang this predicate fixes.
 */
export const resolvePendingAssistantEvidence = (
  messages: readonly SessionTimingMessage[] | undefined,
  now: number = Date.now(),
): PendingAssistantEvidence => {
  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
  if (!lastMessage || lastMessage.role !== 'assistant') return { kind: 'none' };
  if (typeof lastMessage.time?.completed === 'number') return { kind: 'none' };
  if (lastMessage.finish) return { kind: 'none' };

  const rawTimestamp = lastMessage.time?.updated ?? lastMessage.time?.created;
  if (typeof rawTimestamp !== 'number' || !Number.isFinite(rawTimestamp)) {
    return { kind: 'none' };
  }

  const lastUpdateAt = normalizeSessionTimestampMs(rawTimestamp);
  const expiresAt = lastUpdateAt + STALE_PENDING_ASSISTANT_TIMEOUT_MS;
  return now < expiresAt
    ? { kind: 'pending', lastUpdateAt, expiresAt }
    : { kind: 'stale', lastUpdateAt };
};
