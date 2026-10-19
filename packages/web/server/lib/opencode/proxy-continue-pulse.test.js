import express from 'express';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_SYNTHETIC_PULSE_BODY_BYTES,
  createSyntheticPulseGuard,
  isSyntheticContinuationPayload,
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
