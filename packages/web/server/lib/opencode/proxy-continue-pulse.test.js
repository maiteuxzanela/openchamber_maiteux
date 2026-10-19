import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SYNTHETIC_PULSE_BODY_BYTES,
  createSyntheticPulseGuard,
  createSyntheticPulseSseFilter,
  isSyntheticContinuationEvent,
  isSyntheticContinuationPart,
  isSyntheticContinuationPayload,
  registerOpenCodeProxy,
  sanitizeSessionMessagesPayload,
} from './proxy.js';

/**
 * TICKET-HARNESS-54 — transport-layer sanitizer.
 *
 * Real Express app + real HTTP server + real fetch: no mocks.
 */

const startServer = async ({ withJsonParser = false } = {}) => {
  const app = express();
  if (withJsonParser) {
    app.use(express.json());
  }
  app.use('/api', createSyntheticPulseGuard());
  const seen = [];
  app.use('/api', (req, res) => {
    seen.push({ path: req.path, body: req.body });
    res.json({ ok: true, inspected: true });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

let harness = null;
afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = null;
  }
});

const postJson = (baseUrl, path, body, headers = {}) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

describe('isSyntheticContinuationPayload (pure classifier)', () => {
  it('flags a bare [Continue] text part in parts[]', () => {
    expect(isSyntheticContinuationPayload({ parts: [{ type: 'text', text: '[Continue]' }] })).toBe(true);
  });

  it('flags the bare pulse inside message.parts[]', () => {
    expect(isSyntheticContinuationPayload({ message: { parts: [{ type: 'text', text: ' [Continue] ' }] } })).toBe(true);
  });

  it('does not flag a real prompt that merely contains the token', () => {
    expect(isSyntheticContinuationPayload({ parts: [{ type: 'text', text: 'why did [Continue] appear?' }] })).toBe(false);
  });

  it('does not flag mixed parts (tool + pulse text)', () => {
    expect(isSyntheticContinuationPayload({
      parts: [{ type: 'tool', tool: 'read' }, { type: 'text', text: '[Continue]' }],
    })).toBe(false);
  });

  it('does not flag multiple non-pulse text parts', () => {
    expect(isSyntheticContinuationPayload({
      parts: [{ type: 'text', text: '[Continue]' }, { type: 'text', text: 'real instruction' }],
    })).toBe(false);
  });

  it('does not flag an empty/absent payload', () => {
    expect(isSyntheticContinuationPayload(null)).toBe(false);
    expect(isSyntheticContinuationPayload({})).toBe(false);
    expect(isSyntheticContinuationPayload({ parts: [] })).toBe(false);
  });

  it('flags the legacy bare text/prompt shape', () => {
    expect(isSyntheticContinuationPayload({ text: '[Continue]' })).toBe(true);
    expect(isSyntheticContinuationPayload({ prompt: '[Continue]' })).toBe(true);
    expect(isSyntheticContinuationPayload({ prompt: 'continue the work' })).toBe(false);
  });
});

describe('createSyntheticPulseGuard over a real HTTP server', () => {
  it('rejects an anonymous POST prompt_async whose only text is [Continue]', async () => {
    harness = await startServer();
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/prompt_async', {
      parts: [{ type: 'text', text: '[Continue]' }],
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: 'synthetic_continue_blocked', code: 'TICKET-HARNESS-54' });
    expect(harness.seen).toHaveLength(0);
  });

  it('rejects the same pulse on POST /message (message.parts shape)', async () => {
    harness = await startServer();
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/message', {
      message: { parts: [{ type: 'text', text: '[Continue]' }] },
    });

    expect(response.status).toBe(400);
    expect(harness.seen).toHaveLength(0);
  });

  it('rejects the pulse after a real JSON body parser has consumed the stream', async () => {
    harness = await startServer({ withJsonParser: true });
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/prompt_async', {
      parts: [{ type: 'text', text: '[Continue]' }],
    });

    expect(response.status).toBe(400);
    expect(harness.seen).toHaveLength(0);
  });

  it('forwards legitimate prompts untouched (raw stream)', async () => {
    harness = await startServer();
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/prompt_async', {
      parts: [{ type: 'text', text: 'implement the failover fix' }],
    });

    expect(response.status).toBe(200);
    expect(harness.seen).toHaveLength(1);
  });

  it('forwards a prompt that includes the pulse together with a real instruction', async () => {
    harness = await startServer();
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/prompt_async', {
      parts: [{ type: 'text', text: '[Continue]' }, { type: 'text', text: 'and then run the tests' }],
    });

    expect(response.status).toBe(200);
    expect(harness.seen).toHaveLength(1);
  });

  it('ignores non-dispatch routes and other methods', async () => {
    harness = await startServer();
    const abort = await postJson(harness.baseUrl, '/api/session/ses_1/abort', {
      parts: [{ type: 'text', text: '[Continue]' }],
    });
    expect(abort.status).toBe(200);
    expect(harness.seen).toHaveLength(1);
  });

  it('honours the intentional opt-out header', async () => {
    harness = await startServer();
    const response = await postJson(
      harness.baseUrl,
      '/api/session/ses_1/prompt_async',
      { parts: [{ type: 'text', text: '[Continue]' }] },
      { 'x-openchamber-intentional-prompt': '1' },
    );

    expect(response.status).toBe(200);
    expect(harness.seen).toHaveLength(1);
  });

  it('forwards an over-limit body intact without classifying it', async () => {
    harness = await startServer();
    const huge = 'x'.repeat(MAX_SYNTHETIC_PULSE_BODY_BYTES + 1024);
    const response = await postJson(harness.baseUrl, '/api/session/ses_1/prompt_async', {
      parts: [{ type: 'text', text: huge }],
    });

    expect(response.status).toBe(200);
    expect(harness.seen).toHaveLength(1);
    expect(harness.seen[0].body.toString('utf8').includes(huge)).toBe(true);
  });
});

const pulsePart = { id: 'part_pulse', messageID: 'msg_pulse', type: 'text', text: '[Continue]' };
const legitPart = { id: 'part_real', messageID: 'msg_real', type: 'text', text: 'implement the fix' };

const pulseEvent = { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: pulsePart } };
const legitEvent = { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: legitPart } };

const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

describe('outbound classifiers', () => {
  it('classifies only a complete bare-pulse text part', () => {
    expect(isSyntheticContinuationPart(pulsePart)).toBe(true);
    expect(isSyntheticContinuationPart({ ...pulsePart, text: ' [Continue] ' })).toBe(true);
    expect(isSyntheticContinuationPart({ ...pulsePart, text: 'why [Continue]?' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...pulsePart, type: 'tool' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...pulsePart, type: undefined })).toBe(false);
    expect(isSyntheticContinuationPart(null)).toBe(false);
  });

  it('classifies the wrapped envelope and the bare { part } shape', () => {
    expect(isSyntheticContinuationEvent(pulseEvent)).toBe(true);
    expect(isSyntheticContinuationEvent({ part: pulsePart })).toBe(true);
    expect(isSyntheticContinuationEvent(legitEvent)).toBe(false);
    expect(isSyntheticContinuationEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } })).toBe(false);
  });

  it('never classifies a streamed delta fragment', () => {
    expect(isSyntheticContinuationEvent({
      type: 'message.part.delta',
      properties: { partID: 'part_real', field: 'text', delta: '[Continue]' },
    })).toBe(false);
  });
});

describe('createSyntheticPulseSseFilter', () => {
  it('drops the pulse frame and forwards every other frame verbatim', () => {
    const filter = createSyntheticPulseSseFilter();
    const output = filter.push(`${frame(pulseEvent)}${frame(legitEvent)}:heartbeat\n\n`);
    expect(output).toBe(`${frame(legitEvent)}:heartbeat\n\n`);
  });

  it('buffers a frame split across arbitrary TCP chunks', () => {
    const filter = createSyntheticPulseSseFilter();
    const raw = frame(pulseEvent);
    let output = '';
    for (const chunk of [raw.slice(0, 7), raw.slice(7, 31), raw.slice(31)]) {
      output += filter.push(chunk);
    }
    expect(output).toBe('');
    expect(filter.flush()).toBe('');
  });

  it('keeps framing of legitimate frames split across chunks', () => {
    const filter = createSyntheticPulseSseFilter();
    const raw = frame(legitEvent);
    const split = Math.floor(raw.length / 2);
    expect(filter.push(raw.slice(0, split))).toBe('');
    expect(filter.push(raw.slice(split))).toBe(raw);
  });

  it('normalizes CRLF and still suppresses the pulse', () => {
    const filter = createSyntheticPulseSseFilter();
    const crlfPulse = `data: ${JSON.stringify(pulseEvent)}\r\n\r\n`;
    const crlfLegit = `data: ${JSON.stringify(legitEvent)}\r\n\r\n`;
    expect(filter.push(`${crlfPulse}${crlfLegit}`)).toBe(`${frame(legitEvent)}`);
  });

  it('never touches comments, heartbeats, [DONE] or real text', () => {
    const filter = createSyntheticPulseSseFilter();
    const passthrough = [
      ':heartbeat\n\n',
      'data: [DONE]\n\n',
      'event: ping\ndata: {"ok":true}\n\n',
      frame({ type: 'message.part.updated', properties: { part: { type: 'text', text: 'why did [Continue] appear?' } } }),
    ].join('');
    expect(filter.push(passthrough)).toBe(passthrough);
  });

  it('flushes a trailing frame at EOF', () => {
    const filter = createSyntheticPulseSseFilter();
    const trailing = `data: ${JSON.stringify(legitEvent)}`;
    expect(filter.push(trailing)).toBe('');
    expect(filter.flush()).toBe(`${trailing}\n\n`);
  });

  it('flushes an unterminated pulse frame as suppressed', () => {
    const filter = createSyntheticPulseSseFilter();
    expect(filter.push(`data: ${JSON.stringify(pulseEvent)}`)).toBe('');
    expect(filter.flush()).toBe('');
  });
});

describe('sanitizeSessionMessagesPayload', () => {
  it('drops a user turn whose only part is the bare pulse', () => {
    const payload = [
      { info: { id: 'msg_pulse', role: 'user' }, parts: [pulsePart] },
      { info: { id: 'msg_real', role: 'user' }, parts: [legitPart] },
    ];
    expect(sanitizeSessionMessagesPayload(payload)).toEqual([payload[1]]);
  });

  it('strips the pulse from a mixed user turn and keeps the real parts', () => {
    const payload = [{ info: { id: 'msg_mixed', role: 'user' }, parts: [pulsePart, legitPart] }];
    expect(sanitizeSessionMessagesPayload(payload)).toEqual([
      { info: { id: 'msg_mixed', role: 'user' }, parts: [legitPart] },
    ]);
  });

  it('never hides assistant output', () => {
    const payload = [{ info: { id: 'msg_assistant', role: 'assistant' }, parts: [pulsePart] }];
    expect(sanitizeSessionMessagesPayload(payload)).toEqual(payload);
  });

  it('preserves records without parts and non-array payloads', () => {
    const payload = [{ info: { id: 'msg_no_parts', role: 'user' } }];
    expect(sanitizeSessionMessagesPayload(payload)).toEqual(payload);
    expect(sanitizeSessionMessagesPayload({ not: 'an array' })).toEqual({ not: 'an array' });
  });
});

const listen = (app) => new Promise((resolve, reject) => {
  const server = http.createServer(app);
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

const closeServer = (server) => new Promise((resolve) => {
  if (!server) {
    resolve();
    return;
  }
  server.close(() => resolve());
});

describe('registered proxy end-to-end (real HTTP, no mocks)', () => {
  let upstreamServer;
  let proxyServer;

  afterEach(async () => {
    await closeServer(proxyServer);
    await closeServer(upstreamServer);
    proxyServer = undefined;
    upstreamServer = undefined;
  });

  it('suppresses the pulse on the SSE channel and in the history page', async () => {
    let seenLimit = null;

    const upstream = express();
    upstream.get('/event', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(frame(pulseEvent));
      res.write(frame(legitEvent));
      res.write(':heartbeat\n\n');
      res.end();
    });
    upstream.get('/session/ses_1/message', (req, res) => {
      seenLimit = req.query.limit ?? null;
      res.json([
        { info: { id: 'msg_pulse', role: 'user', time: { created: 1 } }, parts: [pulsePart] },
        { info: { id: 'msg_real', role: 'user', time: { created: 2 } }, parts: [legitPart] },
      ]);
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({
        openCodePort: upstreamPort,
        isOpenCodeReady: true,
        openCodeNotReadySince: 0,
        isRestartingOpenCode: false,
      }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
    });
    proxyServer = await listen(app);
    const proxyPort = proxyServer.address().port;

    const streamed = await fetch(`http://127.0.0.1:${proxyPort}/api/event`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(streamed.status).toBe(200);
    const streamedBody = await streamed.text();
    expect(streamedBody).not.toContain('[Continue]');
    expect(streamedBody).toContain(JSON.stringify(legitPart));
    expect(streamedBody).toContain(':heartbeat\n\n');

    const history = await fetch(`http://127.0.0.1:${proxyPort}/api/session/ses_1/message?limit=10`);
    expect(history.status).toBe(200);
    const records = await history.json();
    expect(records.map((record) => record.info.id)).toEqual(['msg_real']);
    expect(seenLimit).toBe('10');
  });
});
