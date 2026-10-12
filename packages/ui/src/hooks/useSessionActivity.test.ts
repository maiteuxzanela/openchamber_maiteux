import { describe, expect, test } from 'bun:test';
import { determineSessionActivity, STALE_PENDING_ASSISTANT_TIMEOUT_MS } from './useSessionActivity';

describe('determineSessionActivity', () => {
  test('returns idle when sessionId is null or undefined', () => {
    expect(determineSessionActivity({ sessionId: null })).toEqual({
      phase: 'idle',
      isWorking: false,
      isBusy: false,
      isCooldown: false,
    });
    expect(determineSessionActivity({ sessionId: undefined })).toEqual({
      phase: 'idle',
      isWorking: false,
      isBusy: false,
      isCooldown: false,
    });
  });

  test('returns idle when permissions or questions are pending', () => {
    const active = determineSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      permissions: [{ id: 'perm_1' }],
    });
    expect(active.isWorking).toBe(false);
    expect(active.phase).toBe('idle');

    const activeQuestion = determineSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      questions: [{ id: 'q_1' }],
    });
    expect(activeQuestion.isWorking).toBe(false);
    expect(activeQuestion.phase).toBe('idle');
  });

  test('returns idle when authoritative status is idle regardless of pending assistant message', () => {
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'idle' },
      messages: [{ role: 'assistant', id: 'msg_1', time: { created: Date.now() } }],
    });
    expect(result.phase).toBe('idle');
    expect(result.isWorking).toBe(false);
    expect(result.isBusy).toBe(false);
  });

  test('treats recent trailing assistant message without completed as busy fallback when status is missing', () => {
    const now = 100_000_000_000;
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: undefined,
      messages: [{ role: 'assistant', id: 'msg_1', time: { created: now - 2_000 } }],
      now,
    });
    expect(result.phase).toBe('busy');
    expect(result.isWorking).toBe(true);
    expect(result.isBusy).toBe(true);
  });

  test('treats stale trailing assistant message (>10s old) as idle when status is missing and not streaming', () => {
    const now = 100_000_000_000;
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: undefined,
      messages: [{ role: 'assistant', id: 'msg_1', time: { created: now - (STALE_PENDING_ASSISTANT_TIMEOUT_MS + 1_000) } }],
      now,
      isStreaming: false,
    });
    expect(result.phase).toBe('idle');
    expect(result.isWorking).toBe(false);
    expect(result.isBusy).toBe(false);
  });

  test('treats stale trailing assistant message as busy if actively streaming deltas', () => {
    const now = 100_000_000_000;
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: undefined,
      messages: [{ role: 'assistant', id: 'msg_1', time: { created: now - 30_000 } }],
      now,
      isStreaming: true,
    });
    expect(result.phase).toBe('busy');
    expect(result.isWorking).toBe(true);
    expect(result.isBusy).toBe(true);
  });

  test('treats trailing assistant message with finish property as idle even without completed timestamp', () => {
    const now = 100_000_000_000;
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: undefined,
      messages: [{ role: 'assistant', id: 'msg_1', finish: 'stop', time: { created: now - 1_000 } }],
      now,
    });
    expect(result.phase).toBe('idle');
    expect(result.isWorking).toBe(false);
    expect(result.isBusy).toBe(false);
  });

  test('treats trailing assistant message with completed timestamp as idle', () => {
    const now = 100_000_000_000;
    const result = determineSessionActivity({
      sessionId: 'ses_1',
      status: undefined,
      messages: [{ role: 'assistant', id: 'msg_1', time: { created: now - 1_000, completed: now - 500 } }],
      now,
    });
    expect(result.phase).toBe('idle');
    expect(result.isWorking).toBe(false);
    expect(result.isBusy).toBe(false);
  });
});
