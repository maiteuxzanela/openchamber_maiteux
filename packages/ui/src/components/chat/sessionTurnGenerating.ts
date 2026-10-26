/**
 * Pure session-turn generating predicate, extracted verbatim from the
 * `isCurrentSessionActivelyGenerating` closure in ChatInput.tsx.
 *
 * Keeping the body in a standalone module lets the deterministic test suite
 * exercise the REAL production logic (including the orphaned-streaming-flag
 * staleness check) without having to render the 4000-line composer component.
 * ChatInput resolves the trailing message via `getSyncMessages` (as it already
 * did) and injects it lazily, so the streaming-store short-circuit still avoids
 * touching the message store when it decides the outcome.
 *
 * The streaming-flag check reads the REAL `useStreamingStore` (not an injected
 * stub): tests drive it via `useStreamingStore.setState(...)`, exactly like
 * `useQueuedMessageAutoSend.test.ts` does, so no mock crosses the seam.
 */

import { useStreamingStore } from '@/sync/streaming';
import { STALE_PENDING_ASSISTANT_TIMEOUT_MS } from '@/hooks/useSessionActivity';

/**
 * Structural shape of the trailing message the fallback inspects. Deliberately
 * minimal so tests can build fixtures without importing the full SDK Message
 * type; ChatInput passes the real sync message (structurally compatible).
 */
export interface TrailingTurnEvidence {
    role?: string;
    finish?: unknown;
    time?: {
        created?: number;
        updated?: number;
        completed?: number;
    };
}

export interface SessionTurnGeneratingEvidence {
    /** Current session id; `null`/`undefined` means nothing can be generating. */
    sessionId: string | null | undefined;
    /** Auto-review flow is mid-flight (authoritative, like backend busy). */
    autoReviewRunning: boolean;
    /** Backend session phase; anything but `'idle'` is authoritative busy. */
    sessionPhase: string;
    /** Backend busy flag; authoritative occupancy. */
    sessionIsBusy: boolean;
    /**
     * Lazily resolved trailing assistant message (last of the session list).
     * Only invoked when the earlier guards and the streaming-flag check did
     * not already decide — preserving the original lazy evaluation order.
     */
    getTrailingMessage: () => TrailingTurnEvidence | undefined;
    /** Injectable clock (ms) so tests control staleness deterministically. */
    now?: number;
}

/**
 * Decide whether the given session is actively generating a turn.
 *
 * Order (identical to the original ChatInput closure):
 *  1. No session → false.
 *  2. Auto-review running → true.
 *  3. Authoritative backend busy (phase !== 'idle' or isBusy) → true.
 *  4. Streaming flag, cross-checked against its per-message heartbeat: only a
 *     `phase === 'streaming'` state whose `lastUpdateAt` is fresh (within
 *     `STALE_PENDING_ASSISTANT_TIMEOUT_MS`) keeps the session occupied. An
 *     orphaned flag (SSE died mid-turn, end event never arrived) or a
 *     completed/cooldown state falls through instead of blocking the send.
 *  5. Trailing assistant message fallback: no completion marker, no finish,
 *     and a fresh timestamp → still generating; stale or finished → idle.
 */
export const isSessionTurnGenerating = (evidence: SessionTurnGeneratingEvidence): boolean => {
    const {
        sessionId,
        autoReviewRunning,
        sessionPhase,
        sessionIsBusy,
        getTrailingMessage,
        now = Date.now(),
    } = evidence;

    if (!sessionId) return false;
    if (autoReviewRunning) return true;

    // Authoritative backend status wins: when the server still reports the
    // session as busy/retry (phase !== 'idle' or isBusy), the session MUST
    // be treated as occupied. Long tool runs and thinking stretches emit
    // no deltas and let the trailing assistant message go stale, so a
    // premature "not generating" return below would flip the Stop/Queue
    // affordance back to Send and collide a second prompt into the
    // running turn.
    if (sessionPhase !== 'idle' || sessionIsBusy) return true;

    // If streaming deltas actively, it is generating tokens. The flag is
    // weak evidence on its own: when the SSE connection dies mid-turn the
    // message-end event never arrives and `streamingMessageIds` keeps the
    // id forever, which used to pin this predicate to true and divert
    // every new prompt into the queue. Cross-check the per-message stream
    // state heartbeat (`lastUpdateAt`, refreshed by touchStreamingSession
    // on every part event): a fresh heartbeat means deltas are really
    // flowing; a missing state or one stale past the shared freshness
    // window means the flag is orphaned, so fall through to the trailing
    // assistant message below instead of blocking the direct send.
    const streamingId = useStreamingStore.getState().streamingMessageIds.get(sessionId);
    if (streamingId) {
        const streamState = useStreamingStore.getState().messageStreamStates.get(streamingId);
        if (
            streamState?.phase === 'streaming'
            && now - streamState.lastUpdateAt <= STALE_PENDING_ASSISTANT_TIMEOUT_MS
        ) {
            return true;
        }
        // Orphaned or completed stream flag: the trailing-message evidence
        // below decides whether the turn is still generating.
    }

    // Fallback while status events settle: the trailing assistant message.
    const lastMsg = getTrailingMessage();

    if (lastMsg?.role === 'assistant') {
        if (typeof lastMsg.time?.completed === 'number') {
            return false;
        }
        if (lastMsg.finish) {
            return false;
        }
        const timeInfo = lastMsg.time;
        const ts = timeInfo?.updated ?? timeInfo?.created;
        if (typeof ts === 'number' && Number.isFinite(ts)) {
            const tsMs = ts < 1e10 ? ts * 1000 : ts;
            // A stale trailing message only counts as idle when there is
            // no authoritative busy status and no active delta streaming
            // — both were already ruled in as busy above.
            if (now - tsMs > STALE_PENDING_ASSISTANT_TIMEOUT_MS) {
                return false;
            }
        }
        // Trailing assistant message with no completion marker, no finish
        // and a fresh timestamp: the turn is still generating.
        return true;
    }

    // Default: anything that is not a pending trailing assistant message
    // (empty session, last message from the user, …) is NOT generating.
    // Returning true here would queue the first prompt of a brand new
    // session instead of dispatching it.
    return false;
};
