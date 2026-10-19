import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSyntheticPulseSseFilter,
  isSyntheticContinuationEvent,
  isSyntheticContinuationPart,
  isSyntheticContinuationPayload,
  registerOpenCodeProxy,
  sanitizeSessionMessagesPayload,
} from './opencode/proxy.js';

/**
 * TICKET-HARNESS-54 — independent SDET suite for the outbound transport
 * sanitizer (packages/web/server).
 *
 * Every assertion below runs against the real modules: the real SSE filter,
 * the real history sanitizer, and a real Express app + real HTTP server +
 * real `fetch` for the end-to-end paths. There are no mocks here; the only
 * non-production object is the upstream HTTP server the test itself owns.
 */

const PART_PULSE = { id: 'prt_pulse', messageID: 'msg_pulse', type: 'text', text: '[Continue]' };
const PART_REAL = { id: 'prt_real', messageID: 'msg_real', type: 'text', text: 'implement the failover fix' };

const eventOf = (part) => ({
  type: 'message.part.updated',
  properties: { sessionID: 'ses_1', part },
});

const frameOf = (payload) => `data: ${JSON.stringify(payload)}\n\n`;

const sseStream = () => [
  ':heartbeat\n\n',
  frameOf(eventOf(PART_PULSE)),
  'event: message\n',
  frameOf(eventOf(PART_REAL)),
  'data: [DONE]\n\n',
  `data: ${JSON.stringify(eventOf({ ...PART_REAL, text: 'olá 🚀 fim' }))}\n\n`,
].join('');

const runSplit = (filter, stream, splitAt, asBytes = false) => {
  if (!asBytes) {
    return filter.push(stream.slice(0, splitAt)) + filter.push(stream.slice(splitAt)) + filter.flush();
  }
  const bytes = new TextEncoder().encode(stream);
  return filter.push(bytes.slice(0, splitAt)) + filter.push(bytes.slice(splitAt)) + filter.flush();
};

describe('classifier exactness (no over-suppression)', () => {
  it('accepts only the bare, case-sensitive pulse', () => {
    expect(isSyntheticContinuationPart(PART_PULSE)).toBe(true);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: '  [Continue]\n' })).toBe(true);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: '[continue]' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: '[CONTINUE]' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: 'Continue' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: '[Continue] please' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: 'why did [Continue] appear?' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: '' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, type: 'tool' })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, type: undefined })).toBe(false);
    expect(isSyntheticContinuationPart({ ...PART_PULSE, text: 42 })).toBe(false);
    expect(isSyntheticContinuationPart(null)).toBe(false);
    expect(isSyntheticContinuationPart([])).toBe(false);
    expect(isSyntheticContinuationPart('[Continue]')).toBe(false);
  });

  it('classifies full part snapshots but never streamed deltas', () => {
    expect(isSyntheticContinuationEvent(eventOf(PART_PULSE))).toBe(true);
    expect(isSyntheticContinuationEvent({ part: PART_PULSE })).toBe(true);
    expect(isSyntheticContinuationEvent({
      type: 'message.part.delta',
      properties: { partID: 'prt_real', field: 'text', delta: '[Continue]' },
    })).toBe(false);
    expect(isSyntheticContinuationEvent({ type: 'session.idle', properties: { sessionID: 'ses_1' } })).toBe(false);
    expect(isSyntheticContinuationEvent({ properties: [] })).toBe(false);
    expect(isSyntheticContinuationEvent(null)).toBe(false);
    expect(isSyntheticContinuationEvent(['part'])).toBe(false);
  });

  it('keeps the inbound dispatch classifier strict about mixed content', () => {
    expect(isSyntheticContinuationPayload({ parts: [{ type: 'text', text: '[Continue]' }] })).toBe(true);
    expect(isSyntheticContinuationPayload({
      parts: [{ type: 'text', text: '[Continue]' }, { type: 'text', text: 'run the suite' }],
    })).toBe(false);
    expect(isSyntheticContinuationPayload({
      parts: [{ type: 'tool', tool: 'bash' }, { type: 'text', text: '[Continue]' }],
    })).toBe(false);
    expect(isSyntheticContinuationPayload({ prompt: 'continue the work' })).toBe(false);
    expect(isSyntheticContinuationPayload({ parts: [] })).toBe(false);
    expect(isSyntheticContinuationPayload(null)).toBe(false);
  });
});

describe('SSE filter — byte-exact framing under arbitrary TCP splits', () => {
  it('forwards a legitimate mixed stream byte-identically at every string split point', () => {
    const stream = sseStream();
    // The pulse frame is the only thing the filter may remove; everything else
    // (heartbeat, `event:` line, legit frame, `[DONE]`) must survive untouched.
    const expected = [
      ':heartbeat\n\n',
      'event: message\n',
      frameOf(eventOf(PART_REAL)),
      'data: [DONE]\n\n',
      `data: ${JSON.stringify(eventOf({ ...PART_REAL, text: 'olá 🚀 fim' }))}\n\n`,
    ].join('');

    for (let splitAt = 1; splitAt < stream.length; splitAt += 1) {
      const output = runSplit(createSyntheticPulseSseFilter(), stream, splitAt);
      expect(output.includes('[Continue]'), `split at ${splitAt}`).toBe(false);
      expect(output.includes(':heartbeat\n\n'), `heartbeat lost at ${splitAt}`).toBe(true);
      expect(output.includes('event: message\n'), `event line lost at ${splitAt}`).toBe(true);
      expect(output.includes('data: [DONE]\n\n'), `[DONE] lost at ${splitAt}`).toBe(true);
      expect(output.includes('implement the failover fix'), `legit frame lost at ${splitAt}`).toBe(true);
      expect(output, `framing changed at ${splitAt}`).toBe(expected);
    }
  });

  it('suppresses the pulse at every string split point', () => {
    const stream = frameOf(eventOf(PART_PULSE));
    for (let splitAt = 1; splitAt < stream.length; splitAt += 1) {
      const output = runSplit(createSyntheticPulseSseFilter(), stream, splitAt);
      expect(output, `leaked at split ${splitAt}`).toBe('');
    }
  });

  it('suppresses the pulse at every BYTE split point (split inside multibyte codepoints)', () => {
    const stream = `${frameOf(eventOf(PART_PULSE))}${frameOf(eventOf({ ...PART_REAL, text: 'ação 🚀 ok' }))}`;
    const expected = frameOf(eventOf({ ...PART_REAL, text: 'ação 🚀 ok' }));

    for (let splitAt = 1; splitAt < new TextEncoder().encode(stream).length; splitAt += 1) {
      const output = runSplit(createSyntheticPulseSseFilter(), stream, splitAt, true);
      expect(output, `byte split ${splitAt}`).toBe(expected);
    }
  });

  it('normalizes CRLF and bare CR without altering the payload', () => {
    const filter = createSyntheticPulseSseFilter();
    const input = `${frameOf(eventOf(PART_PULSE)).replace(/\n/g, '\r\n')}:heartbeat\r\n\r\ndata: [DONE]\r\n\r\n`;
    expect(filter.push(input)).toBe(':heartbeat\n\ndata: [DONE]\n\n');
  });

  it('suppresses data lines without the optional space and with extra padding', () => {
    const compact = `data:${JSON.stringify(eventOf(PART_PULSE))}\n\n`;
    const padded = `data:   ${JSON.stringify(eventOf(PART_PULSE))}\n\n`;
    expect(createSyntheticPulseSseFilter().push(compact)).toBe('');
    expect(createSyntheticPulseSseFilter().push(padded)).toBe('');
  });

  it('flushes a residual legitimate frame at EOF and drops a residual pulse', () => {
    const legit = `data: ${JSON.stringify(eventOf(PART_REAL))}`;
    const filter = createSyntheticPulseSseFilter();
    expect(filter.push(legit)).toBe('');
    expect(filter.flush()).toBe(`${legit}\n\n`);

    const pulse = `data: ${JSON.stringify(eventOf(PART_PULSE))}`;
    const pulseFilter = createSyntheticPulseSseFilter();
    expect(pulseFilter.push(pulse)).toBe('');
    expect(pulseFilter.flush()).toBe('');
  });
});

describe('history sanitizer', () => {
  it('drops bare user pulses, strips mixed turns, and never hides assistant output', () => {
    const payload = [
      { info: { id: 'msg_pulse', role: 'user' }, parts: [PART_PULSE] },
      { info: { id: 'msg_mixed', role: 'user' }, parts: [PART_PULSE, PART_REAL] },
      { info: { id: 'msg_assistant', role: 'assistant' }, parts: [PART_PULSE] },
      { info: { id: 'msg_legit', role: 'user' }, parts: [PART_REAL] },
      { info: { id: 'msg_no_parts', role: 'user' } },
    ];

    const sanitized = sanitizeSessionMessagesPayload(payload);

    expect(sanitized.map((record) => record.info.id)).toEqual([
      'msg_mixed',
      'msg_assistant',
      'msg_legit',
      'msg_no_parts',
    ]);
    expect(sanitized[0].parts).toEqual([PART_REAL]);
    expect(payload).toHaveLength(5); // input must not be mutated in place
  });

  it('drops a user turn with no explicit role when it only carries the pulse', () => {
    const payload = [{ info: { id: 'msg_anonymous_user' }, parts: [PART_PULSE] }];
    expect(sanitizeSessionMessagesPayload(payload)).toEqual([]);
  });

  it('passes through non-array payloads and non-record entries untouched', () => {
    expect(sanitizeSessionMessagesPayload({ not: 'an array' })).toEqual({ not: 'an array' });
    expect(sanitizeSessionMessagesPayload(null)).toBe(null);
    const sentinel = ['raw', 7, null];
    expect(sanitizeSessionMessagesPayload(sentinel)).toEqual(sentinel);
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

const startProxy = async (upstreamApp) => {
  const upstreamServer = await listen(upstreamApp);
  const upstreamPort = upstreamServer.address().port;

  const proxyApp = express();
  registerOpenCodeProxy(proxyApp, {
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
  const proxyServer = await listen(proxyApp);
  return {
    upstreamServer,
    proxyServer,
    proxyOrigin: `http://127.0.0.1:${proxyServer.address().port}`,
  };
};

describe('registered proxy — real HTTP end-to-end', () => {
  let harness;

  afterEach(async () => {
    if (!harness) return;
    await closeServer(harness.proxyServer);
    await closeServer(harness.upstreamServer);
    harness = undefined;
  });

  it('filters SSE frames that the upstream emits split across many TCP chunks, preserving heartbeats and EOF tail', async () => {
    const upstream = express();
    upstream.get('/event', async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const tail = `data: ${JSON.stringify(eventOf({ ...PART_REAL, text: 'tail-real' }))}`;
      const stream = `${frameOf(eventOf(PART_PULSE))}:heartbeat\n\n${frameOf(eventOf(PART_REAL))}${tail}`;
      for (let index = 0; index < stream.length; index += 5) {
        res.write(stream.slice(index, index + 5));
      }
      res.end();
    });
    harness = await startProxy(upstream);

    const response = await fetch(`${harness.proxyOrigin}/api/event`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    const body = await response.text();

    expect(body).not.toContain('[Continue]');
    expect(body).toContain(':heartbeat\n\n');
    expect(body).toContain('implement the failover fix');
    expect(body).toContain('tail-real');
    expect(body.endsWith('\n\n')).toBe(true);
  });

  it('drops an unterminated pulse frame at EOF without emitting a partial frame', async () => {
    const upstream = express();
    upstream.get('/event', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(`data: ${JSON.stringify(eventOf(PART_PULSE))}`); // no blank line, then EOF
      res.end();
    });
    harness = await startProxy(upstream);

    const response = await fetch(`${harness.proxyOrigin}/api/event`, {
      headers: { Accept: 'text/event-stream' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  it('sanitizes the history route in place and forwards query parameters upstream', async () => {
    let seenLimit = null;
    const upstream = express();
    upstream.get('/session/ses_1/message', (req, res) => {
      seenLimit = req.query.limit ?? null;
      res.json([
        { info: { id: 'msg_pulse', role: 'user' }, parts: [PART_PULSE] },
        { info: { id: 'msg_assistant', role: 'assistant' }, parts: [PART_PULSE] },
        { info: { id: 'msg_real', role: 'user' }, parts: [PART_PULSE, PART_REAL] },
      ]);
    });
    harness = await startProxy(upstream);

    const response = await fetch(`${harness.proxyOrigin}/api/session/ses_1/message?limit=10`);
    expect(response.status).toBe(200);
    expect(seenLimit).toBe('10');

    const records = await response.json();
    expect(records.map((record) => record.info.id)).toEqual(['msg_assistant', 'msg_real']);
    expect(records[1].parts).toEqual([PART_REAL]);
  });

  it('passes an upstream error body through untouched instead of corrupting it', async () => {
    const upstream = express();
    upstream.get('/session/ses_1/message', (_req, res) => {
      res.status(502).type('text/html').send('<html><body>upstream down</body></html>');
    });
    harness = await startProxy(upstream);

    const response = await fetch(`${harness.proxyOrigin}/api/session/ses_1/message`);
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('upstream down');
  });
});
