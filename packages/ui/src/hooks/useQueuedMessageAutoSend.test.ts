import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Agent, Message } from '@opencode-ai/sdk/v2';
import type { QueuedMessage } from '../stores/messageQueueStore';
import { ChildStoreManager } from '@/sync/child-store';
import { setSyncRefs } from '@/sync/sync-refs';
import { useStreamingStore } from '@/sync/streaming';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];

const getVisibleAgentsMock = mock(() => visibleAgents);

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: getVisibleAgentsMock,
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      sessionAbortFlags: new Map(),
    }),
  },
}));

import {
  buildQueuedAutoSendPayload,
  createQueuedAutoSendRetryScheduler,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  resolveQueuedSessionStatus,
  resolveQueuedSessionStatusType,
  scheduleQueuedStalenessWake,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
} from './useQueuedMessageAutoSend';
import { STALE_PENDING_ASSISTANT_TIMEOUT_MS } from '@/lib/session-staleness';

describe('queued auto-send retry scheduler', () => {
  test('wakes the queue when backoff expires', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    let wakeups = 0;
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => { wakeups += 1; },
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        expect(delay).toBe(500);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(1_500);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(wakeups).toBe(1);
  });

  test('keeps the earliest retry and cancels it on dispose', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const delays: number[] = [];
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        delays.push(delay);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(3_000);
    scheduler.schedule(4_000);
    scheduler.schedule(2_000);

    expect(delays).toEqual([2_000, 1_000]);
    expect(callbacks.size).toBe(1);
    scheduler.dispose();
    expect(callbacks.size).toBe(0);
  });
});

describe('shouldDispatchQueuedAutoSend', () => {
  test('dispatches only after an active session becomes idle', () => {
    expect(shouldDispatchQueuedAutoSend('busy', 'idle', false)).toBe(true);
    expect(shouldDispatchQueuedAutoSend('retry', 'idle', false)).toBe(true);
  });

  test('does not dispatch when idle is only first seen or status is missing', () => {
    expect(shouldDispatchQueuedAutoSend(undefined, 'idle', false)).toBe(false);
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', false)).toBe(false);
  });

  test('dispatches when idle→idle and queue has items', () => {
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', true)).toBe(true);
  });
});

describe('queued auto-send retry backoff', () => {
  test('delay grows exponentially and is capped', () => {
    expect(getQueuedAutoSendRetryDelayMs(1)).toBe(2000);
    expect(getQueuedAutoSendRetryDelayMs(2)).toBe(4000);
    expect(getQueuedAutoSendRetryDelayMs(3)).toBe(8000);
    expect(getQueuedAutoSendRetryDelayMs(10)).toBe(60000);
    expect(getQueuedAutoSendRetryDelayMs(100)).toBe(60000);
  });

  test('backs off only the failed message within its window', () => {
    const failure = { messageId: 'queued-1', failures: 1, nextAttemptAt: 10_000 };

    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 9_999)).toBe(true);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 10_000)).toBe(false);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-2', 9_999)).toBe(false);
    expect(isQueuedAutoSendBackedOff(undefined, 'queued-1', 0)).toBe(false);
  });
});

describe('resolveQueuedSessionStatusType', () => {
  const DIRECTORY = '/repo';

  const assistantMessage = (id: string, completed?: number, created: number = Date.now() - 1_000): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created, ...(completed !== undefined ? { completed } : {}) },
  } as Message);

  let childStores: ChildStoreManager;

  beforeEach(() => {
    childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ status: 'complete', session_status: {}, message: {} });
    setSyncRefs({} as never, childStores, DIRECTORY);
  });

  test('treats a session with an in-flight assistant turn as busy even when the status entry is missing', () => {
    // The server status map only lists busy/retry sessions, so a missed busy
    // event leaves NO status entry while the turn is still streaming. The
    // queue gate must not read that absence as idle: queued prompts would be
    // dispatched into the running turn and merged into one model response.
    childStores.ensureChild(DIRECTORY, { bootstrap: false }).setState({
      message: { ses_1: [assistantMessage('msg_streaming')] },
    });

    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
  });

  test('resolves an explicit busy or retry status entry', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'busy' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
    store.setState({ session_status: { ses_1: { type: 'retry', attempt: 2, message: 'boom', next: 30 } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('retry');
  });

  test('resolves idle when the trailing assistant message has completed', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ message: { ses_1: [assistantMessage('msg_done', 5)] } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });

  test('resolves an explicit idle entry and unknown sessions as idle', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'idle' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
    expect(resolveQueuedSessionStatusType('ses_unknown', DIRECTORY)).toBe('idle');
  });

  test('honors an explicit idle status immediately even with a residual in-flight assistant message', () => {
    // Regression: a backend `idle` is authoritative. A residual trailing
    // assistant message with no completion timestamp must NOT hold the queue
    // busy for up to STALE_PENDING_ASSISTANT_TIMEOUT_MS (10s) — the first
    // queued prompt has to drain on the very next evaluation instead.
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      session_status: { ses_1: { type: 'idle' } },
      message: { ses_1: [assistantMessage('msg_residual')] },
    });

    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });

  test('resolves idle when trailing assistant message is stale (>10s old)', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const staleMsg: Message = {
      id: 'msg_stale',
      role: 'assistant',
      sessionID: 'ses_1',
      time: { created: Date.now() - 25_000 },
    } as Message;
    store.setState({ message: { ses_1: [staleMsg] } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });

  test('drains the queue on an orphaned streaming flag without touching the current directory', () => {
    // Scenario: the SSE connection died mid-turn, so `streamingMessageIds`
    // never cleared while the message timestamp stopped moving. The flag is
    // orphaned; the queue must drain at the freshness deadline and the
    // directory that owns the queue must stay exactly where it was.
    const now = 100_000_000_000;
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      message: {
        ses_1: [{
          id: 'msg_stream_orphan',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: now - (STALE_PENDING_ASSISTANT_TIMEOUT_MS + 5_000) },
        } as unknown as Message],
      },
    });
    useStreamingStore.setState({
      streamingMessageIds: new Map([['ses_1', 'msg_stream_orphan']]),
      messageStreamStates: new Map(),
    });
    const previousDirectory = useDirectoryStore.getState().currentDirectory;
    useDirectoryStore.setState({ currentDirectory: DIRECTORY });

    try {
      const resolved = resolveQueuedSessionStatus('ses_1', DIRECTORY, now);
      expect(resolved).toEqual({ type: 'idle', source: 'pending-assistant', retryAt: null });
      expect(resolved.type).toBe(resolveQueuedSessionStatusType('ses_1', DIRECTORY, now));
      // Busy → idle with queued items is the dispatch trigger.
      expect(shouldDispatchQueuedAutoSend('busy', resolved.type, true)).toBe(true);
      // A stale session needs no wake: the queue drains now, not later.
      const scheduled: number[] = [];
      const scheduler = createQueuedAutoSendRetryScheduler(
        () => { throw new Error('stale evidence must not arm a wake'); },
        () => now,
        (_callback, delay) => {
          scheduled.push(delay);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        () => undefined,
      );
      scheduleQueuedStalenessWake(scheduler, resolved);
      expect(scheduled).toEqual([]);
      // Draining never mutates the session's directory.
      expect(useDirectoryStore.getState().currentDirectory).toBe(DIRECTORY);
    } finally {
      useDirectoryStore.setState({ currentDirectory: previousDirectory });
      useStreamingStore.setState({
        streamingMessageIds: new Map(),
        messageStreamStates: new Map(),
      });
    }
  });

  test('arms exactly one wake for a fallback busy, at lastUpdate + timeout', () => {
    const now = 100_000_000_000;
    const lastUpdate = now - 4_000;
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      message: {
        ses_1: [{
          id: 'msg_fresh',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: now - 60_000, updated: lastUpdate },
        } as unknown as Message],
      },
    });

    const resolved = resolveQueuedSessionStatus('ses_1', DIRECTORY, now);
    expect(resolved).toEqual({
      type: 'busy',
      source: 'pending-assistant',
      retryAt: lastUpdate + STALE_PENDING_ASSISTANT_TIMEOUT_MS,
    });

    const delays: number[] = [];
    let timers = 0;
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => now,
      (_callback, delay) => {
        timers += 1;
        delays.push(delay);
        return timers as unknown as ReturnType<typeof setTimeout>;
      },
      () => undefined,
    );
    // Repeated effect passes must not spawn a polling loop.
    scheduleQueuedStalenessWake(scheduler, resolved);
    scheduleQueuedStalenessWake(scheduler, resolved);
    scheduleQueuedStalenessWake(scheduler, resolved);
    expect(delays).toEqual([STALE_PENDING_ASSISTANT_TIMEOUT_MS - 4_000]);
    expect(timers).toBe(1);
  });

  test('never arms a wake for an authoritative busy or retry status', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    const scheduled: number[] = [];
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => 0,
      (_callback, delay) => {
        scheduled.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      () => undefined,
    );

    store.setState({ session_status: { ses_1: { type: 'busy' } } });
    const busy = resolveQueuedSessionStatus('ses_1', DIRECTORY);
    expect(busy).toEqual({ type: 'busy', source: 'authoritative', retryAt: null });
    scheduleQueuedStalenessWake(scheduler, busy);

    store.setState({ session_status: { ses_1: { type: 'retry', attempt: 1, message: 'boom', next: 30 } } });
    const retry = resolveQueuedSessionStatus('ses_1', DIRECTORY);
    expect(retry).toEqual({ type: 'retry', source: 'authoritative', retryAt: null });
    scheduleQueuedStalenessWake(scheduler, retry);

    expect(scheduled).toEqual([]);
  });

  test('keeps a long legitimate turn busy while real updates keep landing', () => {
    const now = 100_000_000_000;
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      message: {
        ses_1: [{
          id: 'msg_long_turn',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: now - 90_000, updated: now - 2_000 },
        } as unknown as Message],
      },
    });

    const resolved = resolveQueuedSessionStatus('ses_1', DIRECTORY, now);
    expect(resolved.type).toBe('busy');
    expect(resolved.source).toBe('pending-assistant');
    expect(resolved.retryAt).toBe(now - 2_000 + STALE_PENDING_ASSISTANT_TIMEOUT_MS);
  });

  test('drains immediately when the trailing assistant message completes', () => {
    const now = 100_000_000_000;
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({
      message: {
        ses_1: [{
          id: 'msg_completed',
          role: 'assistant',
          sessionID: 'ses_1',
          time: { created: now - 2_000, updated: now - 1_000, completed: now - 500 },
        } as unknown as Message],
      },
    });

    const resolved = resolveQueuedSessionStatus('ses_1', DIRECTORY, now);
    expect(resolved).toEqual({ type: 'idle', source: 'none', retryAt: null });
    expect(shouldDispatchQueuedAutoSend('busy', resolved.type, true)).toBe(true);
  });
});

describe('buildQueuedAutoSendPayload', () => {
  beforeEach(() => {
    visibleAgents = [];
    sendMessageCalls.length = 0;
  });

  test('returns only the first queued message for auto-send', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-1',
        content: 'first queued message',
        text: 'first queued message',
        createdAt: 1,
      },
      {
        id: 'queued-2',
        content: 'second queued message',
        text: 'second queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('first queued message');
    expect(payload?.primaryAttachments).toEqual([]);
  });

  test('delivers the captured mention and context instead of re-parsing the content', () => {
    const metadata = { openchamberContext: { kind: 'github-issue' as const, number: 3, title: 'Bug', url: 'https://x/issues/3' } };
    const queue: QueuedMessage[] = [
      {
        id: 'queued-mention',
        content: '@Builder please take this',
        text: 'please take this',
        agentMention: 'Builder',
        context: [
          { kind: 'context', text: 'issue body', metadata },
          { kind: 'instruction', text: 'use the skill' },
        ],
        createdAt: 1,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.agentMentionName).toBe('Builder');
    expect(payload?.primaryText).toBe('please take this');
    expect(payload?.additionalParts).toEqual([
      { text: 'issue body', synthetic: true, metadata },
      { text: 'use the skill', synthetic: true },
    ]);
  });

  test('preserves attachment-only queued messages as sendable payloads', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-attachments',
        content: '',
        text: '',
        createdAt: 1,
        attachments: [
          {
            id: 'file-1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
            source: 'local',
            file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
            dataUrl: 'data:text/plain;base64,aGVsbG8=',
          },
        ],
      },
      {
        id: 'queued-2',
        content: 'later queued message',
        text: 'later queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-attachments');
    expect(payload?.primaryText).toBe('');
    expect(payload?.primaryAttachments).toHaveLength(1);
    expect(payload?.primaryAttachments[0]?.filename).toBe('notes.txt');
  });

  test('retains raw queued content and attachments for history submissions', async () => {
    const attachment = {
      id: 'file-1',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      source: 'local' as const,
      file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
      dataUrl: 'data:text/plain;base64,aGVsbG8=',
    };

    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-raw',
        text: '/plan feature from raw queue',
        content: '/plan feature from raw queue',
        createdAt: 1,
        attachments: [attachment],
      },
    ]);

    expect(payload).not.toBeNull();
    expect(payload?.historySubmissions).toEqual([
      {
        text: '/plan feature from raw queue',
        attachmentKeys: ['local|notes.txt|text/plain|5|data'],
        restorableAttachments: [],
      },
    ]);

    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-original',
      sessionId: 'session-original',
      directory: '/repo',
    }, {
      ...payload!,
      primaryText: 'sanitized transport text',
    }, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    });

    expect(sendMessageCalls[0]?.[0]).toBe('sanitized transport text');
    expect(sendMessageCalls[0]?.[9]).toEqual({
      target: {
        runtimeKey: 'runtime-original',
        sessionId: 'session-original',
        directory: '/repo',
      },
        historySubmissions: [
          {
            text: '/plan feature from raw queue',
            attachmentKeys: ['local|notes.txt|text/plain|5|data'],
            restorableAttachments: [],
          },
        ],
    });
  });

  test('auto-send targets the queued session explicitly', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-1',
        content: 'queued message',
        text: 'queued message',
        createdAt: 1,
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-original',
      sessionId: 'session-original',
      directory: '/repo',
    }, payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    });

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toEqual([
      'queued message',
      'provider-1',
      'model-1',
      'agent-1',
      [],
      undefined,
      undefined,
      'variant-1',
      'normal',
      {
        target: {
          runtimeKey: 'runtime-original',
          sessionId: 'session-original',
          directory: '/repo',
        },
        historySubmissions: [
          {
            text: 'queued message',
            attachmentKeys: [],
            restorableAttachments: [],
          },
        ],
      },
    ]);
  });
});
