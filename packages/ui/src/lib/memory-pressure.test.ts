import { describe, expect, test } from 'bun:test';

import {
  attachMemoryPressureListeners,
  BACKEND_RECONNECTED_EVENT,
  getLastMemoryPurgeReport,
  MEMORY_PRESSURE_EVENT,
  parseMemoryPressureDetail,
  purgeEphemeralMemory,
  registerEphemeralCache,
  registerHiddenSurfaceDropper,
  resetMemoryPressureForTests,
  toFiniteByteCount,
  type MemoryPressureDetail,
} from './memory-pressure';

const pressureEvent = (detail?: unknown): Event => (
  detail === undefined
    ? new Event(MEMORY_PRESSURE_EVENT)
    : new CustomEvent(MEMORY_PRESSURE_EVENT, { detail })
);

/** Real timers: the purge promise chain settles after the dispatch returns. */
const settled = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe('parseMemoryPressureDetail', () => {
  test('keeps the desktop bridge contract', () => {
    const detail = parseMemoryPressureDetail({
      level: 'critical',
      rssBytes: 1_966_080,
      limitBytes: 1_939_865,
      source: 'webkitgtk-monitor',
      at: 1_700_000_000_000,
      totalRssMb: 1875,
      processCount: 3,
    });

    expect(detail).toEqual({
      level: 'critical',
      rssBytes: 1_966_080,
      limitBytes: 1_939_865,
      source: 'webkitgtk-monitor',
      at: 1_700_000_000_000,
    });
  });

  test('defaults to warning and tolerates a missing payload', () => {
    const detail = parseMemoryPressureDetail(undefined, 42);

    expect(detail.level).toBe('warning');
    expect(detail.rssBytes).toBeNull();
    expect(detail.limitBytes).toBeNull();
    expect(detail.source).toBeNull();
    expect(detail.at).toBe(42);
  });

  test('rejects garbage byte counts instead of propagating NaN', () => {
    expect(toFiniteByteCount('512000')).toBe(512_000);
    expect(toFiniteByteCount(-1)).toBeNull();
    expect(toFiniteByteCount(Number.NaN)).toBeNull();
    expect(toFiniteByteCount(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toFiniteByteCount('not-a-number')).toBeNull();
    expect(toFiniteByteCount(null)).toBeNull();

    const detail = parseMemoryPressureDetail({ rssBytes: 'nope', at: 'nope' }, 7);
    expect(detail.rssBytes).toBeNull();
    expect(detail.at).toBe(7);
  });
});

describe('purgeEphemeralMemory', () => {
  test('drops hidden surfaces synchronously and purges every cache', async () => {
    resetMemoryPressureForTests();
    const order: string[] = [];
    const unregisterDropper = registerHiddenSurfaceDropper('plugin:hidden', () => {
      order.push('drop');
      return true;
    });
    const unregisterVisible = registerHiddenSurfaceDropper('plugin:visible', () => {
      order.push('visible-refused');
      return false;
    });
    const unregisterCache = registerEphemeralCache('files:content', () => {
      order.push('cache-sync');
    });
    registerEphemeralCache('chat:turns', async () => {
      await Promise.resolve();
      order.push('cache-async');
    });

    const pending = purgeEphemeralMemory('memory-pressure', 'critical');
    // The dropper and the sync purge already ran before the first await: the
    // desktop shell recycles the process only after the dispatch returns.
    expect(order).toEqual(['drop', 'visible-refused', 'cache-sync']);
    expect(getLastMemoryPurgeReport()).toBeNull();

    const report = await pending;
    expect(order).toEqual(['drop', 'visible-refused', 'cache-sync', 'cache-async']);
    expect(report.droppedSurfaces).toEqual(['plugin:hidden']);
    expect(report.purgedCaches).toEqual(['files:content', 'chat:turns']);
    expect(report.failures).toEqual([]);
    expect(report.level).toBe('critical');
    expect(report.reason).toBe('memory-pressure');
    expect(getLastMemoryPurgeReport()).toBe(report);

    unregisterDropper();
    unregisterVisible();
    unregisterCache();
  });

  test('isolates a failing purge so the remaining caches still run', async () => {
    resetMemoryPressureForTests();
    registerEphemeralCache('broken', () => {
      throw new Error('cache exploded');
    });
    registerHiddenSurfaceDropper('bad-surface', () => {
      throw new Error('frame gone');
    });
    let purged = false;
    registerEphemeralCache('healthy', () => {
      purged = true;
    });

    const report = await purgeEphemeralMemory('manual');

    expect(purged).toBe(true);
    expect(report.purgedCaches).toEqual(['healthy']);
    expect(report.failures).toEqual([
      { name: 'bad-surface', error: 'frame gone' },
      { name: 'broken', error: 'cache exploded' },
    ]);
  });

  test('coalesces re-entrant purges instead of stacking work', async () => {
    resetMemoryPressureForTests();
    let runs = 0;
    registerEphemeralCache('counter', () => {
      runs += 1;
    });

    const first = purgeEphemeralMemory('memory-pressure', 'critical');
    const second = purgeEphemeralMemory('memory-pressure', 'critical');
    expect(second).toBe(first);

    await first;
    // The queued reason replays once the in-flight purge settles.
    expect(runs).toBe(2);
  });

  test('keeps working after the registry is emptied', async () => {
    resetMemoryPressureForTests();

    const report = await purgeEphemeralMemory('backend-reconnected');

    expect(report.droppedSurfaces).toEqual([]);
    expect(report.purgedCaches).toEqual([]);
    expect(report.level).toBeNull();
  });
});

describe('attachMemoryPressureListeners', () => {
  test('purges on openchamber:memory-pressure and reports the parsed detail', async () => {
    resetMemoryPressureForTests();
    const target = new EventTarget();
    let dropped = 0;
    registerHiddenSurfaceDropper('plugin:hidden', () => {
      dropped += 1;
      return true;
    });
    const seen: { rss: number | null; level: string | null }[] = [];
    const detach = attachMemoryPressureListeners(target, {
      onPurge: (_report, detail) => seen.push({ rss: detail.rssBytes, level: detail.level }),
    });

    target.dispatchEvent(pressureEvent({ level: 'critical', rssBytes: 2_100_000, source: 'webkitgtk-monitor' }));
    await settled();

    expect(dropped).toBe(1);
    expect(seen).toEqual([{ rss: 2_100_000, level: 'critical' }]);
    expect(getLastMemoryPurgeReport()?.reason).toBe('memory-pressure');

    detach();
  });

  test('purges on openchamber:backend-reconnected', async () => {
    resetMemoryPressureForTests();
    const target = new EventTarget();
    let purged = 0;
    registerEphemeralCache('stale-relay-cache', () => {
      purged += 1;
    });
    const detach = attachMemoryPressureListeners(target);

    target.dispatchEvent(new Event(BACKEND_RECONNECTED_EVENT));
    await settled();

    expect(purged).toBe(1);
    expect(getLastMemoryPurgeReport()?.reason).toBe('backend-reconnected');

    detach();
  });

  test('falls back to the global sample when the event carries no detail', async () => {
    resetMemoryPressureForTests();
    const target = new EventTarget() as EventTarget & { __OPENCHAMBER_MEMORY_PRESSURE__?: unknown };
    target.__OPENCHAMBER_MEMORY_PRESSURE__ = {
      level: 'critical',
      rssBytes: 2_097_152,
      limitBytes: 1_939_865,
      source: 'webkitgtk-monitor',
      at: 1_700_000_000_000,
    };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: target });
    const seen: MemoryPressureDetail[] = [];
    const detach = attachMemoryPressureListeners(target, {
      onPurge: (_report, detail) => seen.push(detail),
    });
    try {
      target.dispatchEvent(new Event(MEMORY_PRESSURE_EVENT));
      await settled();

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ level: 'critical', rssBytes: 2_097_152, source: 'webkitgtk-monitor' });
    } finally {
      detach();
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  test('detach stops purges and is idempotent', async () => {
    resetMemoryPressureForTests();
    const target = new EventTarget();
    let purged = 0;
    registerEphemeralCache('counter', () => {
      purged += 1;
    });
    const detach = attachMemoryPressureListeners(target);

    detach();
    detach();
    target.dispatchEvent(pressureEvent({ level: 'warning' }));
    await settled();

    expect(purged).toBe(0);
    expect(getLastMemoryPurgeReport()).toBeNull();
  });
});
