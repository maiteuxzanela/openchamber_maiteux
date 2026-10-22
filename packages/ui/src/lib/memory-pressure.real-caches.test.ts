/**
 * SDET integration: the *real* ephemeral caches must be released by the real
 * `openchamber:memory-pressure` event, synchronously before the first `await`.
 * The desktop shell recycles the WebKitWebProcess right after the dispatch
 * returns, so a purge that only clears a test counter would prove nothing.
 *
 * No business logic is replaced here: the caches are populated through their
 * public production APIs (markdown renderer, turn projection cache) and the
 * event is a real DOM CustomEvent on a real happy-dom window. The only seam is
 * the Shiki *worker* module, which Bun cannot load (`?worker&url`) and which a
 * browser-only bundler import requires; the plain-text block rendered below is
 * never highlighted, so the worker is not exercised at all.
 */
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';

mock.module('../components/chat/markdown/markdown-worker', () => ({
  highlightCodeInWorker: async () => null,
  highlightLinesInWorker: async () => null,
  highlightTokensInWorker: async () => null,
  getCachedHighlightedLines: () => null,
  resetMarkdownWorkerClientCacheForTests: () => undefined,
}));

const dom = new Window({ url: 'http://memory-pressure.test' });
const installGlobal = (name: string, value: unknown): void => {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
};
installGlobal('window', dom);
installGlobal('document', dom.document);
installGlobal('navigator', dom.navigator);
installGlobal('HTMLElement', dom.HTMLElement);
installGlobal('HTMLAnchorElement', dom.HTMLAnchorElement);
installGlobal('Node', dom.Node);
installGlobal('CustomEvent', dom.CustomEvent);
installGlobal('Event', dom.Event);
installGlobal('localStorage', dom.localStorage);

const pressure = await import('./memory-pressure');
const markdown = await import('../components/chat/markdown/markdownCore');
const turns = await import('../components/chat/lib/turns/turnProjectionCache');

type EventTargetLike = import('./memory-pressure').EventTargetLike;

const pressureEvent = (detail?: unknown): unknown => (
  detail === undefined
    ? new dom.Event(pressure.MEMORY_PRESSURE_EVENT)
    : new dom.CustomEvent(pressure.MEMORY_PRESSURE_EVENT, { detail })
);

const dispatch = (detail?: unknown): void => {
  dom.dispatchEvent(pressureEvent(detail) as never);
};

const withListener = (run: () => void): void => {
  const detach = pressure.attachMemoryPressureListeners(dom as unknown as EventTargetLike);
  try {
    run();
  } finally {
    detach();
  }
};

describe('real ephemeral caches react to the desktop event', () => {
  test('markdown block caches are emptied synchronously during the dispatch', async () => {
    markdown.resetMarkdownHtmlCacheForTests();
    await markdown.renderMarkdownBlocks('# memory pressure\n\nplain body text', false);
    const populated = markdown.__markdownBlockCacheSizesForTests();
    expect(populated.full).toBeGreaterThan(0);

    withListener(() => {
      dispatch({ level: 'critical', rssBytes: 2_100_000, source: 'webkitgtk-monitor' });
      // The shell recycles the process after dispatch returns: the release must
      // already have happened here, without awaiting the purge promise.
      expect(markdown.__markdownBlockCacheSizesForTests()).toEqual({ full: 0, live: 0 });
    });
  });

  test('turn projection cache is emptied synchronously during the dispatch', () => {
    const key = 'session:memory-pressure';
    turns.setCachedProjection(key, { turns: [] } as unknown as Parameters<typeof turns.setCachedProjection>[1]);
    expect(turns.getCachedProjection(key)).toBeDefined();

    withListener(() => {
      dispatch({ level: 'warning', rssBytes: 1_500_000 });
      expect(turns.getCachedProjection(key)).toBeUndefined();
    });
  });

  test('the purge report names the real caches it released', async () => {
    markdown.resetMarkdownHtmlCacheForTests();
    await markdown.renderMarkdownBlocks('report paragraph', false);
    turns.setCachedProjection('session:report', { turns: [] } as unknown as Parameters<typeof turns.setCachedProjection>[1]);

    const report = await pressure.purgeEphemeralMemory('memory-pressure', 'critical');

    expect(report.purgedCaches).toContain('markdown:render');
    expect(report.purgedCaches).toContain('chat:turn-projections');
    expect(report.failures).toEqual([]);
    expect(markdown.__markdownBlockCacheSizesForTests()).toEqual({ full: 0, live: 0 });
    expect(turns.getCachedProjection('session:report')).toBeUndefined();
  });

  test('a detached listener no longer touches the real caches', async () => {
    markdown.resetMarkdownHtmlCacheForTests();
    await markdown.renderMarkdownBlocks('survives detach', false);
    const detach = pressure.attachMemoryPressureListeners(dom as unknown as EventTargetLike);
    detach();
    detach();

    dispatch({ level: 'critical' });
    await Promise.resolve();

    expect(markdown.__markdownBlockCacheSizesForTests().full).toBeGreaterThan(0);
    markdown.resetMarkdownHtmlCacheForTests();
  });

  test('a second warning burst still coalesces onto one purge of real caches', async () => {
    markdown.resetMarkdownHtmlCacheForTests();
    await markdown.renderMarkdownBlocks('burst paragraph', false);
    const report = pressure.purgeEphemeralMemory('memory-pressure', 'critical');
    const coalesced = pressure.purgeEphemeralMemory('memory-pressure', 'warning');
    expect(coalesced).toBe(report);

    const settledReport = await report;
    expect(settledReport.level).toBe('critical');
    expect(markdown.__markdownBlockCacheSizesForTests()).toEqual({ full: 0, live: 0 });
  });
});
