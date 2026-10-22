import { describe, expect, test } from 'bun:test';

import { GUEST_REQUEST_RESPONSE_MAX, GUEST_REQUEST_RESPONSE_WARN } from '@openchamber/sdk';

import {
  RESPONSE_TOO_LARGE,
  RESPONSE_TOO_LARGE_STATUS,
  readWithinBudget,
  responseTooLargeResult,
} from './response-budget.js';

// Real `Response` objects and real streams: nothing is stubbed here.
const streamed = (chunks, onPull) => new Response(new ReadableStream({
  pull(controller) {
    onPull();
    const next = chunks.shift();
    if (next === undefined) {
      controller.close();
      return;
    }
    controller.enqueue(new TextEncoder().encode(next));
  },
}));

describe('response budget', () => {
  test('the shared ceiling is 2 MiB with a warning at 1.5 MiB', () => {
    expect(GUEST_REQUEST_RESPONSE_MAX).toBe(2_097_152);
    expect(GUEST_REQUEST_RESPONSE_WARN).toBe(1_572_864);
  });

  test('reads a body that fits the budget verbatim', async () => {
    const payload = '{"tickets":[1,2,3]}';
    const result = await readWithinBudget(new Response(payload));
    expect(result).toEqual({ ok: true, text: payload });
  });

  test('refuses a body above the budget instead of slicing it', async () => {
    const payload = JSON.stringify({ body: 'x'.repeat(2_000) });
    const limit = 1_000;
    const result = await readWithinBudget(new Response(payload), limit);
    expect(result.ok).toBe(false);
    expect(result.received).toBeGreaterThan(limit);
    // The old behaviour handed back `payload.slice(0, limit)`, which the panel
    // could not parse. This is the regression the ticket exists for.
    expect(() => JSON.parse(payload.slice(0, limit))).toThrow();
  });

  test('the rejection is valid JSON with a 413 status and an actionable code', () => {
    const result = responseTooLargeResult(2_500_000);
    expect(result.status).toBe(RESPONSE_TOO_LARGE_STATUS);
    expect(result.status).toBe(413);
    const parsed = JSON.parse(result.body);
    expect(parsed.error.code).toBe(RESPONSE_TOO_LARGE);
    expect(parsed.error.code).toBe('response-too-large');
    expect(parsed.error.limit).toBe(GUEST_REQUEST_RESPONSE_MAX);
    expect(parsed.error.received).toBe(2_500_000);
    expect(parsed.error.message).toContain('2097152');
  });

  test('a declared byte length above the ceiling is NOT enough to reject: characters decide', async () => {
    // 2_097_153 BYTES is above the 2 MiB budget, but the body is 11 CHARACTERS.
    // The protocol ceiling counts characters (TICKET-HARNESS-88 · F4), so a
    // false 413 here would break every heavily accented answer.
    const response = new Response('{"ok":true}', {
      headers: { 'content-length': String(GUEST_REQUEST_RESPONSE_MAX + 1) },
    });
    const result = await readWithinBudget(response);
    expect(result).toEqual({ ok: true, text: '{"ok":true}' });
  });

  test('a declared byte length beyond 3 bytes per character is rejected before reading', async () => {
    const limit = 1_000;
    const response = new Response('{"ok":true}', {
      headers: { 'content-length': String(limit * 3 + 1) },
    });
    const result = await readWithinBudget(response, limit);
    expect(result).toEqual({ ok: false, received: limit * 3 + 1, declared: true });
  });

  test('a body cut short after announcing more bytes than the ceiling is rejected, never prefixed', async () => {
    const limit = 1_000;
    const broken = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode('{"ok"'));
        controller.error(new Error('terminated'));
      },
    });
    const response = new Response(broken, {
      headers: { 'content-length': String(limit + 1) },
    });
    const result = await readWithinBudget(response, limit);
    expect(result).toEqual({ ok: false, received: limit + 1, declared: true, truncated: true });
  });

  test('rejections report the same unit they measured', () => {
    const declared = JSON.parse(responseTooLargeResult(5, 10, { declared: true }).body);
    expect(declared.error.unit).toBe('bytes');
    expect(declared.error.message).toContain('announces 5 bytes');
    expect(declared.error.message).not.toContain('characters read');
    const counted = JSON.parse(responseTooLargeResult(11, 10).body);
    expect(counted.error.unit).toBe('characters');
    expect(counted.error.message).toContain('11 characters read');
  });

  test('aborts a stream as soon as the budget is blown', async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 50 }, () => 'y'.repeat(400));
    const result = await readWithinBudget(streamed(chunks, () => { pulls += 1; }), 1_000);
    expect(result.ok).toBe(false);
    expect(result.received).toBeGreaterThan(1_000);
    // 3 pulls of 400 characters are enough to pass the 1 000 limit; the other
    // 47 chunks are never buffered.
    expect(pulls).toBeLessThanOrEqual(4);
  });

  test('counts multi-byte characters as the protocol schema does', async () => {
    const fits = await readWithinBudget(new Response('é'.repeat(10)), 10);
    expect(fits).toEqual({ ok: true, text: 'é'.repeat(10) });
    const overflow = await readWithinBudget(new Response('é'.repeat(11)), 10);
    expect(overflow.ok).toBe(false);
  });
});
