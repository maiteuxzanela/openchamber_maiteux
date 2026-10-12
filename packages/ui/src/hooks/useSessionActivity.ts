import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionStatus, useSessionMessages, useSessionPermissions, useSessionQuestions } from '@/sync/sync-context';
import { useStreamingStore } from '@/sync/streaming';

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

export const STALE_PENDING_ASSISTANT_TIMEOUT_MS = 10_000;

export interface DetermineSessionActivityParams {
  sessionId?: string | null;
  status?: { type?: string };
  messages?: Array<{ role?: string; id?: string; finish?: unknown; time?: { created?: number; updated?: number; completed?: number } }>;
  permissions?: unknown[];
  questions?: unknown[];
  isStreaming?: boolean;
  now?: number;
}

export function determineSessionActivity({
  sessionId,
  status,
  messages = [],
  permissions = [],
  questions = [],
  isStreaming = false,
  now = Date.now(),
}: DetermineSessionActivityParams): SessionActivityResult {
  if (!sessionId) return IDLE_RESULT;

  // Permissions or questions pending → idle (the blocking indicator takes
  // priority and the send button must remain a send, not a stop).
  if (permissions.length > 0 || questions.length > 0) return IDLE_RESULT;

  const phase: SessionActivityPhase = (status?.type ?? 'idle') as SessionActivityPhase;

  // Only trust the trailing assistant message as a transient fallback while
  // waiting for session.status/message.updated to settle.
  const lastMsg = messages[messages.length - 1];
  let hasPendingAssistant = false;
  if (
    lastMsg
    && lastMsg.role === 'assistant'
    && typeof lastMsg.time?.completed !== 'number'
    && !lastMsg.finish
  ) {
    if (isStreaming) {
      hasPendingAssistant = true;
    } else {
      const rawTs = lastMsg.time?.updated ?? lastMsg.time?.created;
      if (typeof rawTs === 'number' && Number.isFinite(rawTs)) {
        const ms = rawTs < 1e10 ? rawTs * 1000 : rawTs;
        if (now - ms <= STALE_PENDING_ASSISTANT_TIMEOUT_MS) {
          hasPendingAssistant = true;
        }
      }
    }
  }

  const hasAuthoritativeStatus = status !== undefined;
  const statusWorking = hasAuthoritativeStatus && phase !== 'idle';
  const isWorking = statusWorking || hasPendingAssistant;

  if (hasAuthoritativeStatus && !statusWorking) return IDLE_RESULT;

  if (!isWorking) return IDLE_RESULT;

  return {
    phase: statusWorking ? phase : 'busy',
    isWorking: true,
    isBusy: phase === 'busy' || (!statusWorking && hasPendingAssistant),
    isCooldown: false,
  };
}

/**
 * Determines if a session is actively working.
 * Checks session_status and, only when status is missing, falls back to the
 * trailing assistant message when its completion update has not landed yet.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const [stalenessTick, setStalenessTick] = React.useState(0);

  const lastMessage = messages[messages.length - 1];
  const lastTime = (lastMessage as { time?: { updated?: number; created?: number } } | undefined)?.time;
  const rawTimestamp = lastTime?.updated ?? lastTime?.created;
  const timestampMs = typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
    ? (rawTimestamp < 1e10 ? rawTimestamp * 1000 : rawTimestamp)
    : undefined;
  const ageMs = timestampMs !== undefined ? Math.max(0, Date.now() - timestampMs) : undefined;

  const isStreaming = Boolean(
    sessionId
    && lastMessage?.id
    && useStreamingStore.getState().streamingMessageIds.get(sessionId) === lastMessage.id
  );

  React.useEffect(() => {
    if (!sessionId || !lastMessage || lastMessage.role !== 'assistant') return;
    if (typeof (lastMessage as { time?: { completed?: number } }).time?.completed === 'number') return;
    if ((lastMessage as { finish?: unknown }).finish) return;
    if (isStreaming) return;
    if (ageMs === undefined || ageMs >= STALE_PENDING_ASSISTANT_TIMEOUT_MS) return;

    const remainingMs = Math.max(100, STALE_PENDING_ASSISTANT_TIMEOUT_MS - ageMs + 50);
    const timer = setTimeout(() => {
      setStalenessTick((prev) => prev + 1);
    }, remainingMs);
    return () => clearTimeout(timer);
  }, [sessionId, lastMessage, isStreaming, ageMs]);

  return React.useMemo<SessionActivityResult>(() => {
    return determineSessionActivity({
      sessionId,
      status,
      messages: messages as DetermineSessionActivityParams['messages'],
      permissions,
      questions,
      isStreaming,
    });
  }, [sessionId, status, messages, permissions, questions, isStreaming, stalenessTick]);
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
