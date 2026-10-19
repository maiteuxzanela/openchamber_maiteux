/**
 * TICKET-HARNESS-54 — synthetic `[Continue]` pulse classifiers.
 *
 * The Antigravity/Gemini recovery transformer emits a bare `[Continue]` turn
 * on the wire (protocol requirement after a signed functionResponse) and, on
 * some error paths, also dispatches one as a real session prompt. Neither may
 * leak into the UI as a visible user message or trigger a follow-on reaction.
 *
 * This module is deliberately dependency-free so every transport (HTTP proxy,
 * SSE, WebSocket hubs) can share the exact same classification without pulling
 * the whole proxy stack into the event-stream layer.
 */

// Exact literal produced by the recovery transformer: `[Continue]` (brackets,
// capital C, no prefix/suffix). Case-sensitive on purpose, so a legitimate
// "[continue]" / "continue the work" is never swallowed.
const SYNTHETIC_PULSE_TEXT_PATTERN = /^\s*\[Continue\]\s*$/;

export const MAX_SYNTHETIC_PULSE_BODY_BYTES = 2 * 1024 * 1024;

export const isBareContinuationText = (value) => (
  typeof value === 'string' && SYNTHETIC_PULSE_TEXT_PATTERN.test(value)
);

const collectCandidateParts = (payload) => {
  const parts = [];
  if (Array.isArray(payload?.parts)) parts.push(...payload.parts);
  if (Array.isArray(payload?.message?.parts)) parts.push(...payload.message.parts);
  return parts;
};

/**
 * True only when an inbound dispatch payload is exclusively one or more bare
 * continuation pulses and nothing else (no tool parts, no real text).
 */
export const isSyntheticContinuationPayload = (payload) => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }

  const parts = collectCandidateParts(payload);
  if (parts.length === 0) {
    const text = typeof payload.text === 'string'
      ? payload.text
      : (typeof payload.prompt === 'string' ? payload.prompt : null);
    return text !== null && isBareContinuationText(text);
  }

  const texts = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return false;
    if (part.type !== undefined && part.type !== 'text') return false;
    if (typeof part.text !== 'string') return false;
    texts.push(part.text);
  }
  return texts.length > 0 && texts.every(isBareContinuationText);
};

/**
 * Part-level classifier for anything streaming toward the UI.
 *
 * Only a complete text part whose whole content is the bare pulse is
 * synthetic. Real prose that merely mentions the token (e.g. "why did
 * [Continue] appear?") never matches, and neither do tool/file/step parts.
 */
export const isSyntheticContinuationPart = (part) => {
  if (!part || typeof part !== 'object' || Array.isArray(part)) {
    return false;
  }
  if (part.type !== 'text') {
    return false;
  }
  return isBareContinuationText(part.text);
};

/**
 * Event-level classifier for the OpenCode event channel (SSE and WebSocket).
 *
 * Accepts both the wrapped envelope (`{ type, properties: { part } }`) and a
 * bare `{ part }` shape. `message.part.delta` fragments are deliberately NOT
 * classified: a delta can be exactly "[Continue]" while belonging to a longer
 * legitimate message, so only full part snapshots are eligible.
 */
export const isSyntheticContinuationEvent = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return false;
  }
  const properties = event.properties && typeof event.properties === 'object' && !Array.isArray(event.properties)
    ? event.properties
    : event;
  return isSyntheticContinuationPart(properties.part);
};

/**
 * Stateful SSE transformer that drops only the frames carrying a synthetic
 * continuation pulse.
 *
 * The filter is transport-safe by construction:
 * - it buffers incomplete frames across TCP chunks (a `data:` line may be
 *   split anywhere), so no frame is ever forwarded half-parsed;
 * - it never touches comments/heartbeats, `event:` lines, or non-JSON data;
 * - it normalizes CRLF/CR to LF (SSE semantics) but otherwise forwards frames
 *   verbatim, so ordering and framing stay identical;
 * - `flush()` emits any residual trailing frame at upstream EOF.
 */
export const createSyntheticPulseSseFilter = () => {
  const decoder = new TextDecoder();
  let buffered = '';

  const normalize = (value) => value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const filterFrame = (frame) => {
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) {
      return `${frame}\n\n`;
    }

    const data = dataLines.join('\n');
    // Cheap guard before JSON.parse on every streaming token chunk.
    if (data.includes('Continue')) {
      try {
        if (isSyntheticContinuationEvent(JSON.parse(data))) {
          return '';
        }
      } catch {
        // Not JSON (heartbeat, `[DONE]`, vendor comment) — forward untouched.
      }
    }
    return `${frame}\n\n`;
  };

  return {
    push(chunk) {
      const text = typeof chunk === 'string'
        ? chunk
        : decoder.decode(chunk, { stream: true });
      if (!text) {
        return '';
      }

      buffered = normalize(`${buffered}${text}`);
      let output = '';
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        output += filterFrame(buffered.slice(0, boundary));
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf('\n\n');
      }
      return output;
    },
    flush() {
      const trailing = decoder.decode();
      if (trailing) {
        buffered = normalize(`${buffered}${trailing}`);
      }
      if (!buffered) {
        return '';
      }
      const frame = buffered;
      buffered = '';
      return filterFrame(frame);
    },
  };
};

/**
 * History sanitizer for `GET /session/:id/message`.
 *
 * The live stream alone is not enough: when a `message.part.updated` arrives
 * without its owning message the UI schedules an incomplete-session snapshot,
 * so a persisted pulse would reappear on the refetch. A user record whose every
 * part is the bare pulse is therefore removed from the page; mixed records keep
 * their real parts. Assistant records are never dropped, so model output can
 * never be silently hidden.
 */
export const sanitizeSessionMessagesPayload = (payload) => {
  if (!Array.isArray(payload)) {
    return payload;
  }

  const sanitized = [];
  for (const record of payload) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      sanitized.push(record);
      continue;
    }

    const parts = Array.isArray(record.parts) ? record.parts : null;
    if (!parts || parts.length === 0) {
      sanitized.push(record);
      continue;
    }

    const keptParts = parts.filter((part) => !isSyntheticContinuationPart(part));
    if (keptParts.length === parts.length) {
      sanitized.push(record);
      continue;
    }

    if (keptParts.length === 0) {
      const role = record.info?.role;
      if (role === undefined || role === 'user') {
        continue;
      }
      sanitized.push(record);
      continue;
    }

    sanitized.push({ ...record, parts: keptParts });
  }
  return sanitized;
};
