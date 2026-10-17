import { describe, expect, test } from 'bun:test';

import { OPENCHAMBER_SDK_API_VERSION, OPENCHAMBER_SDK_CHANNEL } from './api-version.ts';
import { connectHost, HostRequestError, type HostFrame } from './host.ts';
import {
  GUEST_REQUEST_BODY_MAX,
  type GuestMessage,
  type GuestRequestResult,
} from './contract.ts';
import { parseGuestMessage } from './protocol.ts';

type Listener = (event: Event) => void;

// The same seam host.test.ts uses: a real frame-shaped object whose
// postMessage records what actually crosses the wire, plus a dispatch that
// replays real MessageEvents back at the host listener. No mocks anywhere:
// every assertion inspects the concrete message the SDK posted.
const createFrame = (): HostFrame & { dispatch: (event: Event) => void; posted: GuestMessage[] } => {
  const listeners = new Set<Listener>();
  const posted: GuestMessage[] = [];
  const postMessage = (message: GuestMessage) => {
    posted.push(message);
  };
  return {
    parent: { postMessage },
    postMessage,
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.delete(listener);
    },
    dispatch: (event: Event) => {
      for (const listener of listeners) listener(event);
    },
    posted,
  };
};

const OK_RESULT: GuestRequestResult = { status: 200, body: '{"ok":true}' };

const connect = (requestTimeoutMs?: number) => {
  const frame = createFrame();
  const host = connectHost(requestTimeoutMs === undefined
    ? { target: frame, acceptSource: () => true }
    : { target: frame, acceptSource: () => true, requestTimeoutMs });
  return { frame, host };
};

/** Answer a posted call with a real host `result` MessageEvent. */
const answer = (frame: ReturnType<typeof createFrame>, message: GuestMessage, payload: object): void => {
  if (!('id' in message)) throw new Error('expected a call with an id');
  frame.dispatch(new MessageEvent('message', {
    data: {
      channel: OPENCHAMBER_SDK_CHANNEL,
      v: OPENCHAMBER_SDK_API_VERSION,
      type: 'result',
      id: message.id,
      ok: true,
      payload,
    },
  }));
};

const lastCall = (frame: ReturnType<typeof createFrame>, type: GuestMessage['type']): GuestMessage => {
  const posted = frame.posted.at(-1);
  if (!posted || posted.type !== type) {
    throw new Error(`expected a ${type} call, got ${posted ? posted.type : 'nothing'}`);
  }
  return posted;
};

describe('host request body normalization (TICKET-HARNESS-29)', () => {
  test('serviceRequest posts an object literal body as a JSON string and resolves', async () => {
    const { frame, host } = connect();
    const pending = host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: { foo: 'bar' } });
    const posted = lastCall(frame, 'service-request');
    if (posted.type !== 'service-request') throw new Error('unreachable');
    expect(typeof posted.payload.body).toBe('string');
    expect(posted.payload.body).toBe('{"foo":"bar"}');
    expect(posted.payload).toMatchObject({ method: 'POST', path: '/api/service/echo' });
    answer(frame, posted, OK_RESULT);
    await expect(pending).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('request posts an object literal body as a JSON string and resolves', async () => {
    const { frame, host } = connect();
    const pending = host.request({ method: 'POST', path: '/api/v2/notes', body: { foo: 'bar' } });
    const posted = lastCall(frame, 'request');
    if (posted.type !== 'request') throw new Error('unreachable');
    expect(posted.payload.body).toBe('{"foo":"bar"}');
    answer(frame, posted, OK_RESULT);
    await expect(pending).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('a plain string body crosses the wire untouched, never double-encoded', async () => {
    const { frame, host } = connect();
    const plain = host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: 'abc' });
    const first = lastCall(frame, 'service-request');
    if (first.type !== 'service-request') throw new Error('unreachable');
    expect(first.payload.body).toBe('abc');
    answer(frame, first, OK_RESULT);
    await expect(plain).resolves.toEqual(OK_RESULT);

    // A string that already looks like JSON must not gain quotes or escapes.
    const jsonShaped = '{"nested":true}';
    const reserialized = host.request({ method: 'PUT', path: '/api/v2/notes/1', body: jsonShaped });
    const second = lastCall(frame, 'request');
    if (second.type !== 'request') throw new Error('unreachable');
    expect(second.payload.body).toBe(jsonShaped);
    expect(second.payload.body).not.toBe(JSON.stringify(jsonShaped));
    answer(frame, second, OK_RESULT);
    await expect(reserialized).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('an array body is posted as its JSON string', async () => {
    const { frame, host } = connect();
    const pending = host.serviceRequest({ method: 'POST', path: '/api/service/bulk', body: [1, 2, 3] });
    const posted = lastCall(frame, 'service-request');
    if (posted.type !== 'service-request') throw new Error('unreachable');
    expect(posted.payload.body).toBe('[1,2,3]');
    expect(JSON.parse(posted.payload.body as string)).toEqual([1, 2, 3]);
    answer(frame, posted, OK_RESULT);
    await expect(pending).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('a null or undefined body never crosses the wire as the string "null"', async () => {
    const { frame, host } = connect();

    // `body: null` must not be serialized into the literal string "null".
    const withNull = host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: null });
    const first = lastCall(frame, 'service-request');
    if (first.type !== 'service-request') throw new Error('unreachable');
    expect(first.payload.body).not.toBe('null');
    expect(first.payload.body).toBeUndefined();
    expect('body' in first.payload).toBe(false);
    answer(frame, first, OK_RESULT);
    await expect(withNull).resolves.toEqual(OK_RESULT);

    // `body: undefined` (and an omitted body) stay absent, not "undefined".
    const withUndefined = host.request({ method: 'POST', path: '/api/v2/notes', body: undefined });
    const second = lastCall(frame, 'request');
    if (second.type !== 'request') throw new Error('unreachable');
    expect(second.payload.body).toBeUndefined();
    expect('body' in second.payload).toBe(false);
    answer(frame, second, OK_RESULT);
    await expect(withUndefined).resolves.toEqual(OK_RESULT);

    const omitted = host.request({ method: 'GET', path: '/api/v2/user' });
    const third = lastCall(frame, 'request');
    if (third.type !== 'request') throw new Error('unreachable');
    expect('body' in third.payload).toBe(false);
    answer(frame, third, OK_RESULT);
    await expect(omitted).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('a circular body rejects with HOST_REJECTED before anything is posted', async () => {
    // The 5 ms timeout proves the rejection is immediate: a message that had
    // actually crossed the wire would come back as HOST_TIMEOUT instead.
    const { frame, host } = connect(5);
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;

    await expect(host.request({ method: 'POST', path: '/api/v2/notes', body: circular }))
      .rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: circular }))
      .rejects.toMatchObject({ code: 'HOST_REJECTED' });

    try {
      await host.request({ method: 'POST', path: '/api/v2/notes', body: circular });
      throw new Error('should have rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(HostRequestError);
      if (error instanceof HostRequestError) {
        expect(error.code).toBe('HOST_REJECTED');
        expect(error.message).toContain('not JSON-serializable');
      }
    }

    // Fail-fast means no wire traffic at all: only the handshake went out.
    expect(frame.posted.map((message) => message.type)).toEqual(['hello']);
    host.dispose();
  });

  test('a top-level non-JSON value rejects instead of posting an empty body', async () => {
    const { frame, host } = connect(5);
    // JSON.stringify returns undefined for a function or a symbol, so the
    // guard after serialization must reject rather than send `body: undefined`.
    await expect(host.request({ method: 'POST', path: '/api/v2/notes', body: () => 'x' }))
      .rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: Symbol('id') }))
      .rejects.toMatchObject({ code: 'HOST_REJECTED' });
    expect(frame.posted.map((message) => message.type)).toEqual(['hello']);
    host.dispose();
  });

  test('an oversized body is rejected fail-fast while the exact cap still goes out', async () => {
    const { frame, host } = connect(5);

    await expect(host.serviceRequest({
      method: 'POST',
      path: '/api/service/echo',
      body: 'x'.repeat(GUEST_REQUEST_BODY_MAX + 1),
    })).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    await expect(host.request({
      method: 'POST',
      path: '/api/v2/notes',
      body: { blob: 'x'.repeat(GUEST_REQUEST_BODY_MAX + 1) },
    })).rejects.toMatchObject({ code: 'HOST_REJECTED' });
    expect(frame.posted.map((message) => message.type)).toEqual(['hello']);

    // The cap itself is inclusive: exactly GUEST_REQUEST_BODY_MAX characters
    // still crosses, which is what the host's z.string().max() accepts.
    const atCap = host.request({ method: 'POST', path: '/api/v2/notes', body: 'x'.repeat(GUEST_REQUEST_BODY_MAX) });
    const posted = lastCall(frame, 'request');
    if (posted.type !== 'request') throw new Error('unreachable');
    expect(posted.payload.body).toHaveLength(GUEST_REQUEST_BODY_MAX);
    answer(frame, posted, OK_RESULT);
    await expect(atCap).resolves.toEqual(OK_RESULT);
    host.dispose();
  });

  test('every posted request message satisfies the host wire schema, and an object body would not', async () => {
    const { frame, host } = connect();
    const withObject = host.serviceRequest({ method: 'POST', path: '/api/service/echo', body: { foo: 'bar' } });
    const service = lastCall(frame, 'service-request');
    expect(parseGuestMessage(service)).not.toBeNull();

    const withString = host.request({ method: 'POST', path: '/api/v2/notes', body: 'abc' });
    const request = lastCall(frame, 'request');
    expect(parseGuestMessage(request)).not.toBeNull();

    // Negative control: the host's Zod schema takes `body` as a string only,
    // which is exactly why normalization exists. If the SDK ever posts the
    // object again the host drops it and the caller waits out HOST_TIMEOUT.
    if (service.type !== 'service-request' || request.type !== 'request') throw new Error('unreachable');
    expect(parseGuestMessage({
      ...service,
      payload: { ...service.payload, body: { foo: 'bar' } as unknown as string },
    })).toBeNull();

    answer(frame, service, OK_RESULT);
    await expect(withObject).resolves.toEqual(OK_RESULT);
    answer(frame, request, OK_RESULT);
    await expect(withString).resolves.toEqual(OK_RESULT);
    host.dispose();
  });
});
