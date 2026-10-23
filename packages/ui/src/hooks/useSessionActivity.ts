import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import {
  resolvePendingAssistantEvidence,
  STALE_PENDING_ASSISTANT_TIMEOUT_MS,
  type SessionTimingMessage,
} from '@/lib/session-staleness';

// Re-exported for existing consumers (ChatInput) that read the timeout to
// mirror the same threshold. The value now lives in the shared module.
export { STALE_PENDING_ASSISTANT_TIMEOUT_MS };

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

export interface DetermineSessionActivityParams {
  sessionId?: string | null;
  status?: { type?: string };
  messages?: SessionTimingMessage[];
  permissions?: unknown[];
  questions?: unknown[];
  /**
   * Kept for API compatibility only. The activity decision no longer consults
   * the streaming flag: it can outlive a dead SSE connection and pin the
   * spinner busy forever. Staleness is derived from the message timestamps.
   */
  isStreaming?: boolean;
  now?: number;
}

export function determineSessionActivity({
  sessionId,
  status,
  messages = [],
  permissions = [],
  questions = [],
  now = Date.now(),
}: DetermineSessionActivityParams): SessionActivityResult {
  if (!sessionId) return IDLE_RESULT;

  // Permissions or questions pending → idle (the blocking indicator takes
  // priority and the send button must remain a send, not a stop).
  if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;

  const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;
  const hasAuthoritativeStatus = status !== undefined;

  // The backend status always wins when present.
  if (hasAuthoritativeStatus) {
    if (phase === 'idle') return IDLE_RESULT;
    return {
      phase,
      isWorking: true,
      isBusy: phase === 'busy',
      isCooldown: false,
    };
  }

  // Fallback only while the status event settles: shared staleness predicate.
  const evidence = resolvePendingAssistantEvidence(messages, now);
  if (evidence.kind !== 'pending') return IDLE_RESULT;

  return {
    phase: 'busy',
    isWorking: true,
    isBusy: true,
    isCooldown: false,
  };
}

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * shared pending-assistant evidence derived from (time.updated ?? time.created).
 * The streaming flag is not consulted: it can be orphaned and would freeze the
 * indicator. Returns idle when permissions or questions are pending (the
 * permission / question indicator takes priority, and the send button must stay
 * available so the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const [stalenessTick, setStalenessTick] = React.useState(0);

  // Recompute the evidence on every render so a real `time.updated` refresh
  // (or a completed message) wins over the fallback immediately.
  const evidence = resolvePendingAssistantEvidence(
    messages as SessionTimingMessage[],
    Date.now(),
  );
  // An authoritative status (busy or idle) never needs the fallback wake.
  const retryAt = status === undefined && evidence.kind === 'pending' ? evidence.expiresAt : null;

  // Wake once when the freshness window closes, regardless of the streaming
  // flag. Without this timer the memo would never re-evaluate and the spinner
  // would stay busy until an unrelated store update.
  React.useEffect(() => {
    if (retryAt === null) return;
    const remainingMs = Math.max(100, retryAt - Date.now() + 50);
    const timer = setTimeout(() => {
      setStalenessTick((prev) => prev + 1);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [retryAt, stalenessTick]);

  return React.useMemo<SessionActivityResult>(() => {
    return determineSessionActivity({
      sessionId,
      status,
      messages: messages as SessionTimingMessage[],
      permissions,
      questions,
    });
  }, [sessionId, status, messages, permissions, questions, stalenessTick]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
