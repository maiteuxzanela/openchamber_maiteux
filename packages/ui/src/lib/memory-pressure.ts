/**
 * Frontend containment for desktop memory pressure.
 *
 * The Linux/GTK shell watches the WebKitWebProcess RSS and dispatches
 * `openchamber:memory-pressure` on `window` when it crosses a threshold. It
 * also assigns `window.__OPENCHAMBER_MEMORY_PRESSURE__` right before the
 * dispatch, so a page that lost the event (reload, suspended timer) can still
 * read the last sample. The shell only recycles the web process after the
 * dispatch returns, which makes this handler the last chance to hand heap back
 * to the system: dropping documents and clearing caches must happen
 * synchronously, before the first `await`.
 *
 * Nothing here owns UI state. Ephemeral caches register a purge, mounted plugin
 * frames register a dropper, and this module only decides when to run them.
 * The active session, drafts and the visible pane are never touched: a dropper
 * is expected to refuse when its surface is on screen.
 */

export const MEMORY_PRESSURE_EVENT = 'openchamber:memory-pressure';
export const BACKEND_RECONNECTED_EVENT = 'openchamber:backend-reconnected';

export type MemoryPressureLevel = 'warning' | 'critical';
export type MemoryPurgeReason = 'memory-pressure' | 'backend-reconnected' | 'manual';

export type MemoryPressureDetail = {
  level: MemoryPressureLevel;
  rssBytes: number | null;
  limitBytes: number | null;
  source: string | null;
  at: number;
};

/** Clearing an ephemeral cache. Async purges are started synchronously. */
export type EphemeralCachePurge = () => void | Promise<void>;
/** Returns `true` only when it actually detached a document. */
export type HiddenSurfaceDropper = () => boolean;

export type MemoryPurgeFailure = { name: string; error: string };

export type MemoryPurgeReport = {
  reason: MemoryPurgeReason;
  at: number;
  level: MemoryPressureLevel | null;
  /** Names of the surfaces that detached their document during this purge. */
  droppedSurfaces: string[];
  /** Names of the caches whose purge completed (synchronously or awaited). */
  purgedCaches: string[];
  failures: MemoryPurgeFailure[];
  durationMs: number;
};

type Registration<T> = { name: string; handle: T };

const cacheRegistrations = new Map<symbol, Registration<EphemeralCachePurge>>();
const dropperRegistrations = new Map<symbol, Registration<HiddenSurfaceDropper>>();

let lastReport: MemoryPurgeReport | null = null;
let inFlight: Promise<MemoryPurgeReport> | null = null;
let queuedPurge: { reason: MemoryPurgeReason; level: MemoryPressureLevel | null } | null = null;

const describeError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return 'unknown error';
  }
};

/** Accepts `123`, `'123'`, `1200.4`; rejects garbage, negatives and Infinity. */
export const toFiniteByteCount = (value: unknown): number | null => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }
  return null;
};

const readString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const readTimestamp = (value: unknown, fallback: number): number => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
};

/**
 * Normalizes whatever the desktop bridge sent. Unknown or missing fields are
 * tolerated: an event with no detail still means "free memory now".
 */
export const parseMemoryPressureDetail = (raw: unknown, now: number = Date.now()): MemoryPressureDetail => {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    level: record.level === 'critical' ? 'critical' : 'warning',
    rssBytes: toFiniteByteCount(record.rssBytes),
    limitBytes: toFiniteByteCount(record.limitBytes),
    source: readString(record.source),
    at: readTimestamp(record.at, now),
  };
};

/** Last sample the shell published; survives an event the page missed. */
export const readMemoryPressureGlobal = (): unknown => {
  if (typeof window === 'undefined') return undefined;
  return window.__OPENCHAMBER_MEMORY_PRESSURE__;
};

const readRawDetail = (event: Event): unknown => {
  const detail = (event as CustomEvent<unknown>).detail;
  if (detail !== undefined && detail !== null) return detail;
  return readMemoryPressureGlobal();
};

export const registerEphemeralCache = (name: string, purge: EphemeralCachePurge): (() => void) => {
  const token = Symbol(name);
  cacheRegistrations.set(token, { name, handle: purge });
  return () => {
    cacheRegistrations.delete(token);
  };
};

export const registerHiddenSurfaceDropper = (name: string, drop: HiddenSurfaceDropper): (() => void) => {
  const token = Symbol(name);
  dropperRegistrations.set(token, { name, handle: drop });
  return () => {
    dropperRegistrations.delete(token);
  };
};

const runDroppers = (report: MemoryPurgeReport): void => {
  // Snapshot so a dropper that unregisters itself does not skip the next one.
  for (const registration of Array.from(dropperRegistrations.values())) {
    try {
      if (registration.handle()) report.droppedSurfaces.push(registration.name);
    } catch (error) {
      report.failures.push({ name: registration.name, error: describeError(error) });
    }
  }
};

const startCachePurges = (report: MemoryPurgeReport): Promise<void>[] => {
  const pending: Promise<void>[] = [];
  // Snapshot: starting every purge synchronously is what matters for a
  // `critical` dispatch, and starting them all before awaiting keeps a slow
  // async purge from delaying the others.
  for (const registration of Array.from(cacheRegistrations.values())) {
    try {
      const result = registration.handle();
      report.purgedCaches.push(registration.name);
      if (result && typeof (result as Promise<void>).then === 'function') {
        pending.push(Promise.resolve(result).catch((error: unknown) => {
          report.failures.push({ name: registration.name, error: describeError(error) });
        }));
      }
    } catch (error) {
      report.failures.push({ name: registration.name, error: describeError(error) });
    }
  }
  return pending;
};

/**
 * Frees what can be freed now: hidden plugin documents first (the largest
 * retained heap), then registered ephemeral caches. Re-entrant calls coalesce
 * onto the purge already running instead of stacking work on a starved process.
 */
export const purgeEphemeralMemory = (
  reason: MemoryPurgeReason = 'manual',
  level: MemoryPressureLevel | null = null,
): Promise<MemoryPurgeReport> => {
  if (inFlight) {
    queuedPurge = { reason, level };
    return inFlight;
  }

  const startedAt = Date.now();
  const report: MemoryPurgeReport = {
    reason,
    at: startedAt,
    level,
    droppedSurfaces: [],
    purgedCaches: [],
    failures: [],
    durationMs: 0,
  };

  runDroppers(report);
  const pending = startCachePurges(report);
  report.durationMs = Date.now() - startedAt;

  inFlight = Promise.all(pending).then(() => {
    report.durationMs = Date.now() - startedAt;
    lastReport = report;
    return report;
  }).finally(() => {
    inFlight = null;
    const queued = queuedPurge;
    queuedPurge = null;
    if (queued) void purgeEphemeralMemory(queued.reason, queued.level);
  });

  return inFlight;
};

export const getLastMemoryPurgeReport = (): MemoryPurgeReport | null => lastReport;

/** Test seam: forget registrations and the last report. */
export const resetMemoryPressureForTests = (): void => {
  cacheRegistrations.clear();
  dropperRegistrations.clear();
  lastReport = null;
  inFlight = null;
  queuedPurge = null;
};

export type EventTargetLike = {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
};

export type MemoryPressureListenerOptions = {
  onPurge?: (report: MemoryPurgeReport, detail: MemoryPressureDetail) => void;
};

/**
 * Wires the two desktop events onto the purge. Returns an idempotent detach so
 * a React effect can own it; a detached listener never purges again.
 */
export const attachMemoryPressureListeners = (
  target: EventTargetLike | null | undefined,
  options: MemoryPressureListenerOptions = {},
): (() => void) => {
  if (!target) return () => undefined;
  let detached = false;

  const onPressure = (event: Event): void => {
    if (detached) return;
    const detail = parseMemoryPressureDetail(readRawDetail(event));
    void purgeEphemeralMemory('memory-pressure', detail.level).then((report) => {
      if (detached) return;
      options.onPurge?.(report, detail);
    });
  };

  const onReconnected = (): void => {
    if (detached) return;
    // A reconnect re-hydrates streams and stores; the caches loaded from the
    // previous socket are stale and only cost heap. Unlike a pressure event
    // there is no RSS sample to report.
    void purgeEphemeralMemory('backend-reconnected', null);
  };

  target.addEventListener(MEMORY_PRESSURE_EVENT, onPressure);
  target.addEventListener(BACKEND_RECONNECTED_EVENT, onReconnected);
  return () => {
    if (detached) return;
    detached = true;
    target.removeEventListener(MEMORY_PRESSURE_EVENT, onPressure);
    target.removeEventListener(BACKEND_RECONNECTED_EVENT, onReconnected);
  };
};
