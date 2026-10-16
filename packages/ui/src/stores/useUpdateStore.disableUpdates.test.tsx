import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { UPDATE_CHECKS_DISABLED, useUpdateStore } from './useUpdateStore';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';

const here = path.dirname(fileURLToPath(import.meta.url));
const sidebarSource = readFileSync(
  path.resolve(here, '../components/session/SessionSidebar.tsx'),
  'utf8',
);

describe('update checks are disabled by the product kill-switch', () => {
  test('UPDATE_CHECKS_DISABLED is the absolute default', () => {
    expect(UPDATE_CHECKS_DISABLED).toBe(true);
  });

  test('checkForUpdates resolves null and clears any surfaced update without touching the network', async () => {
    // Make the runtime look like a live web client, so an unguarded store would
    // reach for `/api/openchamber/update-check` instead of returning early.
    registerRuntimeAPIs({ runtime: { platform: 'web', isVSCode: false } } as never);
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error('update check must never reach the network while disabled');
    }) as typeof fetch;

    try {
      useUpdateStore.setState({
        checking: true,
        available: true,
        info: { available: true, currentVersion: '1.0.0', version: '1.0.1' } as never,
        error: 'stale-error',
        lastChecked: null,
      });

      const result = await useUpdateStore.getState().checkForUpdates();

      expect(result).toBeNull();
      const state = useUpdateStore.getState();
      expect(state.available).toBe(false);
      expect(state.info).toBeNull();
      expect(state.error).toBeNull();
      expect(state.checking).toBe(false);
      // The enabled path stamps `lastChecked`; the disabled short-circuit must not.
      expect(state.lastChecked).toBeNull();
      expect(fetchCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
      registerRuntimeAPIs(null);
    }
  });

  test('the sidebar update button is hard-wired off at the component', () => {
    expect(sidebarSource).toContain('const showSidebarUpdateButton = false;');
    // The old availability-driven wiring must be gone so no code path can
    // re-enable the button by flipping store state.
    expect(sidebarSource).not.toContain('updateStore.available &&');
    expect(sidebarSource).toContain('showUpdateButton={showSidebarUpdateButton}');
  });
});

describe('useUpdatePolling schedules no timer while updates are disabled', () => {
  let dom: Window;
  let root: Root;
  let scheduledDelays: number[];
  let restoredSetTimeout: typeof dom.setTimeout;

  const Harness = () => {
    useUpdatePolling();
    return null;
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: dom,
      document: dom.document,
      navigator: dom.navigator,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    scheduledDelays = [];
    restoredSetTimeout = dom.setTimeout;
    dom.setTimeout = ((_handler: unknown, delay?: number) => {
      scheduledDelays.push(Number(delay));
      return 0 as never;
    }) as typeof dom.setTimeout;
    useUpdateStore.setState(useUpdateStore.getInitialState());
    root = createRoot(dom.document.createElement('div') as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    dom.setTimeout = restoredSetTimeout;
  });

  test('mounting the hook never schedules the 3000ms background check', async () => {
    await act(async () => {
      root.render(<Harness />);
    });

    // The poller's initial delay is exactly 3000ms; a live poller would schedule it.
    expect(scheduledDelays).not.toContain(3000);
  });
});
