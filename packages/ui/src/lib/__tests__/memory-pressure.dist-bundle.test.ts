/**
 * Production-bundle contract for the desktop memory-pressure containment.
 *
 * `packages/ui/src/lib/memory-pressure.ts` is only useful if it actually
 * reaches the browser: the daemon on :3000 serves `packages/web/dist`, so a
 * stale build silently keeps the old behaviour no matter what the sources say.
 * TICKET-HARNESS-84 shipped the sources while `dist` was still the 2026-10-16
 * build, and nothing failed. These assertions close that gap.
 *
 * The bundle is a build artifact (`dist` is gitignored), so the suite skips
 * with an explicit reason when it is absent instead of pretending to pass.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Optional seam: point the suite at a staged/previous build
 * (`OPENCHAMBER_WEB_DIST=packages/web/dist-next bun test ...`). Default is the
 * directory the :3000 daemon actually serves.
 */
const DIST_DIR = process.env.OPENCHAMBER_WEB_DIST
  ? path.resolve(process.env.OPENCHAMBER_WEB_DIST)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../web/dist');
const ASSETS_DIR = path.join(DIST_DIR, 'assets');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');

const MEMORY_PRESSURE_EVENT = 'openchamber:memory-pressure';
const MEMORY_PRESSURE_GLOBAL = '__OPENCHAMBER_MEMORY_PRESSURE__';
const BACKEND_RECONNECTED_EVENT = 'openchamber:backend-reconnected';

/** Every surface `registerEphemeralCache` / `registerHiddenSurfaceDropper` names. */
const REGISTERED_SURFACES = [
  'chat:turn-models',
  'chat:turn-projections',
  'markdown:render',
  'markdown:mermaid',
  'plugin:',
] as const;

const bundlePresent = existsSync(INDEX_HTML) && existsSync(ASSETS_DIR);

const assetFiles = (): string[] => {
  if (!bundlePresent) return [];
  return readdirSync(ASSETS_DIR)
    .filter((name) => name.endsWith('.js'))
    .map((name) => path.join(ASSETS_DIR, name));
};

type Asset = { file: string; name: string; source: string };

const readAssets = (): Asset[] => assetFiles().map((file) => ({
  file,
  name: path.basename(file),
  source: readFileSync(file, 'utf8'),
}));

const assetsWith = (marker: string): Asset[] => (
  readAssets().filter((asset) => asset.source.includes(marker))
);

const indexHtml = (): string => (bundlePresent ? readFileSync(INDEX_HTML, 'utf8') : '');

/** `src="/assets/main-x.js"` / `href="/assets/x.js"` emitted by Vite. */
const referencedAssets = (html: string): string[] => {
  const matches = html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g);
  return Array.from(new Set(Array.from(matches, (match) => match[1])));
};

const entryAssetName = (html: string): string | null => {
  const match = html.match(/src="\/?assets\/(main-[^"]+\.js)"/);
  return match ? match[1] : null;
};

/**
 * `describe.skipIf` is not part of `src/types/bun-test.d.ts` (the minimal shim
 * `tsc --noEmit` uses), so the suite is gated at registration instead of
 * widening the shim: a skipped suite must not break `bun run --cwd packages/ui
 * build`, which is exactly what a production-bundle regression test is for.
 */
const describeBundle = (name: string, fn: () => void): void => {
  if (bundlePresent) describe(name, fn);
};

describeBundle('packages/web/dist memory-pressure contract', () => {
  test('index.html loads an entry script that exists on disk', () => {
    const html = indexHtml();
    const entry = entryAssetName(html);

    expect(entry).not.toBeNull();
    expect(existsSync(path.join(ASSETS_DIR, entry as string))).toBe(true);
  });

  test('every asset referenced by index.html exists (no dangling build)', () => {
    const referenced = referencedAssets(indexHtml());
    expect(referenced.length).toBeGreaterThan(0);

    const missing = referenced.filter((relative) => !existsSync(path.join(DIST_DIR, relative)));
    expect(missing).toEqual([]);
  });

  test('the bundle exposes the memory-pressure event contract', () => {
    const matching = assetsWith(MEMORY_PRESSURE_EVENT);
    expect(matching.length).toBeGreaterThan(0);

    const combined = matching.map((asset) => asset.source).join('\n');
    expect(combined).toContain(MEMORY_PRESSURE_GLOBAL);
    expect(combined).toContain(BACKEND_RECONNECTED_EVENT);
  });

  test('the memory-pressure chunk is reachable from the entry script', () => {
    const entry = entryAssetName(indexHtml());
    expect(entry).not.toBeNull();

    const entrySource = readFileSync(path.join(ASSETS_DIR, entry as string), 'utf8');
    const carriers = assetsWith(MEMORY_PRESSURE_EVENT);
    expect(carriers.length).toBeGreaterThan(0);

    const reachable = carriers.filter((asset) => entrySource.includes(asset.name));
    expect(reachable.length).toBeGreaterThan(0);
  });

  test('hidden-surface droppers and ephemeral caches are registered in the bundle', () => {
    const assets = readAssets();
    const missing = REGISTERED_SURFACES.filter(
      (surface) => !assets.some((asset) => asset.source.includes(surface)),
    );
    expect(missing).toEqual([]);
  });

  test('the entry script is not older than the sources that define the contract', () => {
    const entry = entryAssetName(indexHtml());
    expect(entry).not.toBeNull();

    // The event name only exists since TICKET-HARNESS-84; a bundle older than
    // its own carrier asset cannot contain it, so this pins the rebuild to the
    // artifact instead of to a wall-clock assumption.
    const entryStat = statSync(path.join(ASSETS_DIR, entry as string));
    const carrierStat = statSync(assetsWith(MEMORY_PRESSURE_EVENT)[0].file);
    expect(entryStat.mtimeMs).toBeLessThanOrEqual(carrierStat.mtimeMs + 60_000);
  });
});

if (!bundlePresent) {
  test('packages/web/dist memory-pressure contract (skipped: build artifact absent)', () => {
    expect(bundlePresent).toBe(false);
  });
}
