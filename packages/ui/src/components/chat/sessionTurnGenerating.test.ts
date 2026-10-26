import { beforeEach, describe, expect, test } from 'bun:test';
import { STALE_PENDING_ASSISTANT_TIMEOUT_MS } from '@/hooks/useSessionActivity';
import { resetStreamingState, useStreamingStore } from '@/sync/streaming';
import {
    isSessionTurnGenerating,
    type SessionTurnGeneratingEvidence,
    type TrailingTurnEvidence,
} from './sessionTurnGenerating';

/**
 * Deterministic suite for the ChatInput turn-occupancy predicate.
 *
 * The streaming-flag cross-check reads the REAL `useStreamingStore`, driven
 * via `setState` exactly like `useQueuedMessageAutoSend.test.ts` — no mocks,
 * no fake timers. Staleness is controlled through the injectable `now` seam
 * (production defaults to `Date.now()`).
 */

const SESSION = 'ses_1';
const MESSAGE = 'msg_stream_1';
/** Fixed clock (ms) safely above the seconds/milliseconds 1e10 boundary. */
const NOW = 1_700_000_000_000;

const evidence = (overrides: Partial<SessionTurnGeneratingEvidence> = {}): SessionTurnGeneratingEvidence => ({
    sessionId: SESSION,
    autoReviewRunning: false,
    sessionPhase: 'idle',
    sessionIsBusy: false,
    getTrailingMessage: () => undefined,
    now: NOW,
    ...overrides,
});

const trailing = (overrides: TrailingTurnEvidence = {}): TrailingTurnEvidence => ({
    role: 'assistant',
    ...overrides,
});

/** Seed the REAL streaming store the way a live turn (or a dead SSE) leaves it. */
const seedStreamingFlag = (
    state?: { phase: 'streaming' | 'cooldown' | 'completed'; lastUpdateAt: number; startedAt?: number },
) => {
    useStreamingStore.setState({
        streamingMessageIds: new Map([[SESSION, MESSAGE]]),
        messageStreamStates: new Map(state
            ? [[MESSAGE, { startedAt: NOW - 60_000, completedAt: state.phase === 'completed' ? NOW : undefined, ...state }]]
            : []),
    });
};

beforeEach(() => {
    resetStreamingState();
});

describe('streaming-flag heartbeat cross-check (orphaned flag fix)', () => {
    test('fresh streaming heartbeat keeps the session occupied', () => {
        seedStreamingFlag({ phase: 'streaming', lastUpdateAt: NOW - 1_000 });
        expect(isSessionTurnGenerating(evidence())).toBe(true);
    });

    test('heartbeat exactly at the freshness boundary is still occupied (<= window)', () => {
        seedStreamingFlag({ phase: 'streaming', lastUpdateAt: NOW - STALE_PENDING_ASSISTANT_TIMEOUT_MS });
        expect(isSessionTurnGenerating(evidence())).toBe(true);
    });

    test('orphaned flag (SSE died, end event lost) with a stale trailing message does NOT block the direct send', () => {
        // The flag survives forever in streamingMessageIds, but its stream
        // state never existed (or was wiped): the predicate must fall through
        // to the trailing-message evidence, whose staleness frees the send.
        seedStreamingFlag();
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 25_000, updated: NOW - 11_000 } }),
        }))).toBe(false);
    });

    test('orphaned flag with no trailing message at all does not block the direct send', () => {
        seedStreamingFlag();
        expect(isSessionTurnGenerating(evidence({ getTrailingMessage: () => undefined }))).toBe(false);
    });

    test('orphaned flag still defers to a FRESH unfinished trailing message', () => {
        seedStreamingFlag();
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 2_000, updated: NOW - 500 } }),
        }))).toBe(true);
    });

    test('completed stream state falls through to the trailing evidence', () => {
        seedStreamingFlag({ phase: 'completed', lastUpdateAt: NOW });
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 5_000, updated: NOW - 1_000 } }),
        }))).toBe(true);
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 25_000, updated: NOW - 11_000 } }),
        }))).toBe(false);
    });

    test('cooldown stream state falls through to the trailing evidence', () => {
        seedStreamingFlag({ phase: 'cooldown', lastUpdateAt: NOW });
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 25_000, updated: NOW - 11_000 } }),
        }))).toBe(false);
    });

    test('heartbeat older than the freshness window falls through even while still marked streaming', () => {
        seedStreamingFlag({
            phase: 'streaming',
            lastUpdateAt: NOW - STALE_PENDING_ASSISTANT_TIMEOUT_MS - 1,
        });
        expect(isSessionTurnGenerating(evidence({ getTrailingMessage: () => undefined }))).toBe(false);
    });

    test('a streaming flag whose message id is null is treated as absent', () => {
        useStreamingStore.setState({
            streamingMessageIds: new Map([[SESSION, null]]),
            messageStreamStates: new Map(),
        });
        expect(isSessionTurnGenerating(evidence({ getTrailingMessage: () => undefined }))).toBe(false);
    });
});

describe('trailing-message fallback', () => {
    test('unfinished fresh assistant message still counts as generating', () => {
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 3_000, updated: NOW - 200 } }),
        }))).toBe(true);
    });

    test('assistant message with a completed timestamp is idle', () => {
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 5_000, updated: NOW - 1_000, completed: NOW - 900 } }),
        }))).toBe(false);
    });

    test('assistant message carrying a finish marker is idle', () => {
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ finish: 'stop', time: { created: NOW - 2_000, updated: NOW - 1_000 } }),
        }))).toBe(false);
    });

    test('assistant message without any timestamp stays conservative (generating)', () => {
        expect(isSessionTurnGenerating(evidence({ getTrailingMessage: () => trailing({} ) }))).toBe(true);
    });

    test('stale unfinished assistant message (>10s) is idle', () => {
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: NOW - 40_000, updated: NOW - STALE_PENDING_ASSISTANT_TIMEOUT_MS - 1 } }),
        }))).toBe(false);
    });

    test('a trailing USER message is never treated as a pending turn', () => {
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => ({ role: 'user', time: { created: NOW - 100 } }),
        }))).toBe(false);
    });

    test('interprets second-unit timestamps as seconds (ts < 1e10 × 1000)', () => {
        const updatedSecondsFresh = (NOW - 5_000) / 1_000;
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: updatedSecondsFresh - 10, updated: updatedSecondsFresh } }),
        }))).toBe(true);

        const updatedSecondsStale = (NOW - 11_000) / 1_000;
        expect(isSessionTurnGenerating(evidence({
            getTrailingMessage: () => trailing({ time: { created: updatedSecondsStale - 10, updated: updatedSecondsStale } }),
        }))).toBe(false);
    });
});

describe('authoritative guards outrank the weak flags', () => {
    test('sessionIsBusy wins over an orphaned streaming flag and a stale trailing message', () => {
        seedStreamingFlag();
        expect(isSessionTurnGenerating(evidence({
            sessionIsBusy: true,
            getTrailingMessage: () => trailing({ time: { created: NOW - 40_000, updated: NOW - 11_000 } }),
        }))).toBe(true);
    });

    test('a non-idle session phase wins over an orphaned streaming flag', () => {
        seedStreamingFlag();
        expect(isSessionTurnGenerating(evidence({ sessionPhase: 'busy' }))).toBe(true);
        expect(isSessionTurnGenerating(evidence({ sessionPhase: 'retry' }))).toBe(true);
    });

    test('autoReviewRunning wins before any other evidence', () => {
        expect(isSessionTurnGenerating(evidence({ autoReviewRunning: true }))).toBe(true);
    });

    test('no session id is never generating', () => {
        expect(isSessionTurnGenerating(evidence({ sessionId: null }))).toBe(false);
        expect(isSessionTurnGenerating(evidence({ sessionId: undefined }))).toBe(false);
    });

    test('decides without touching the message store when an earlier guard or a fresh heartbeat settles it', () => {
        const explode = () => {
            throw new Error('getTrailingMessage must stay lazily unevaluated');
        };
        expect(isSessionTurnGenerating(evidence({ sessionIsBusy: true, getTrailingMessage: explode }))).toBe(true);
        expect(isSessionTurnGenerating(evidence({ autoReviewRunning: true, getTrailingMessage: explode }))).toBe(true);
        seedStreamingFlag({ phase: 'streaming', lastUpdateAt: NOW - 100 });
        expect(isSessionTurnGenerating(evidence({ getTrailingMessage: explode }))).toBe(true);
    });
});
