// Response budget for guest transports (TICKET-HARNESS-88).
//
// Both guest transports (host -> external API in `request.js`, host -> guest
// service in `service.js`) used to slice an oversized body at
// GUEST_REQUEST_RESPONSE_MAX and hand the prefix back as if it were a whole
// answer. The panel then failed on `JSON.parse` with "Resposta inválida do
// serviço". Silent truncation is gone: an oversized answer becomes a
// structured `413 response-too-large` result whose body is valid JSON, so a
// consumer can explain the failure instead of trusting a partial payload.

import { GUEST_REQUEST_RESPONSE_MAX } from '@openchamber/sdk';

export const RESPONSE_TOO_LARGE = 'response-too-large';

/** Synthetic status carried by a budget rejection. */
export const RESPONSE_TOO_LARGE_STATUS = 413;

/**
 * A body that announces more bytes than the ceiling allows but stops sending
 * them leaves some runtimes (Bun) waiting for the rest forever instead of
 * erroring like Node's undici does. The guard only engages in that suspicious
 * band, and it measures the gap between chunks — never the total duration.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 2_000;
const STALLED = Symbol('stalled');

const budgetError = (received, limit, { declared = false } = {}) => ({
  error: {
    code: RESPONSE_TOO_LARGE,
    // The ceiling is measured in CHARACTERS (protocol.ts validates
    // `z.string().max(GUEST_REQUEST_RESPONSE_MAX)`), so the unit must match the
    // number reported: a declared `Content-Length` is UTF-8 BYTES.
    message: declared
      ? `Guest response announces ${received} bytes, more than the ${limit}-character budget can hold (UTF-8 needs at most 3 bytes per character). Ask the service for a smaller page or a field subset.`
      : `Guest response is above the ${limit}-character budget (${received} characters read). Ask the service for a smaller page or a field subset.`,
    limit,
    received,
    unit: declared ? 'bytes' : 'characters',
  },
});

/**
 * Builds the `{ status, body }` result a guest transport returns when the
 * answer exceeded the budget. The body is valid JSON on purpose.
 */
export const responseTooLargeResult = (received, limit = GUEST_REQUEST_RESPONSE_MAX, options) => ({
  status: RESPONSE_TOO_LARGE_STATUS,
  body: JSON.stringify(budgetError(received, limit, options)),
});

/**
 * Rejection built from a `readWithinBudget` failure, preserving whether the
 * number came from a declared byte length or from an exact character count.
 */
export const budgetRejection = (budget, limit = GUEST_REQUEST_RESPONSE_MAX) =>
  responseTooLargeResult(budget.received, limit, { declared: budget.declared === true });

/**
 * Reads one chunk, giving up when the upstream stays silent for `timeoutMs`.
 * Returns `STALLED` instead of throwing so the caller can decide whether the
 * announced size already condemns the answer.
 */
const readChunk = async (reader, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(STALLED), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Reads a fetch `Response` without materializing more than roughly `limit`
 * characters.
 *
 * Returns `{ ok: true, text }` when the body fits, or `{ ok: false, received }`
 * when it does not. `received` counts CHARACTERS (the protocol unit) unless the
 * rejection came from the declared byte length or from a body cut short after
 * announcing one, in which case it is BYTES and `declared` is `true`.
 */
export const readWithinBudget = async (
  response,
  limit = GUEST_REQUEST_RESPONSE_MAX,
  { stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS } = {},
) => {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  // `Content-Length` counts UTF-8 BYTES while the ceiling counts CHARACTERS
  // (`z.string().max(...)` in protocol.ts). A JS string needs at most 3 bytes
  // per code unit, so only `bytes > 3 * limit` proves the body is over budget;
  // anything below that must be counted by characters, otherwise a 1.2 MiB
  // accented answer (2.4 MiB on the wire) would be refused with a false 413.
  if (Number.isFinite(declared) && declared > limit * 3) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, received: declared, declared: true };
  }
  if (response.body === null || response.body === undefined) {
    const text = await response.text();
    return text.length <= limit ? { ok: true, text } : { ok: false, received: text.length };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let length = 0;
  // Only an announced size above the ceiling can be a lying upstream; every
  // other read keeps the previous unbounded wait, so a slow-but-honest body is
  // never cut by the stall guard.
  const guardStalls = Number.isFinite(declared) && declared > limit;
  try {
    for (;;) {
      const next = guardStalls ? await readChunk(reader, stallTimeoutMs) : await reader.read();
      if (next === STALLED) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, received: declared, declared: true, truncated: true };
      }
      const { done, value } = next;
      if (done) break;
      const part = decoder.decode(value, { stream: true });
      parts.push(part);
      length += part.length;
      // Stop as soon as the budget is blown: the rest of the body is never
      // buffered, so an unbounded upstream cannot grow this process.
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, received: length };
      }
    }
    parts.push(decoder.decode());
  } catch (error) {
    // A body that is cut short after announcing more bytes than the ceiling can
    // hold is not trustworthy: reject with the announced size instead of
    // handing back what was read (never a prefix that looks like a whole answer).
    if (Number.isFinite(declared) && declared > limit) {
      return { ok: false, received: declared, declared: true, truncated: true };
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const text = parts.join('');
  return text.length <= limit ? { ok: true, text } : { ok: false, received: text.length };
};
