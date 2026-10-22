/**
 * SDET amplification for the PluginPane containment contract:
 *  - the hidden tab loses its document and comes back on a NEW frame element;
 *  - an active tab and a pane running a background action are never dropped;
 *  - a headless frame is owned by a command in flight and registers no dropper.
 *
 * Real happy-dom window, real React root, real guest store; no module mocks.
 */
import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { useMemoryPressureGuard } from '@/hooks/useMemoryPressureGuard';
import { getLastMemoryPurgeReport, resetMemoryPressureForTests } from '@/lib/memory-pressure';
import type { GuestBackgroundAction } from '@/lib/guests/run-action';
import { useGuestsStore } from '@/lib/guests/store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const GUEST_ID = 'counter';
const SECOND_GUEST_ID = 'clock';
const ENTRY = 'panel/index.html';

const MemoryPressureProbe: React.FC = () => {
  useMemoryPressureGuard();
  return null;
};

const makeGuest = (id: string) => ({
  id,
  name: id === GUEST_ID ? 'Counter' : 'Clock',
  icon: 'window',
  entry: ENTRY,
  capabilities: { requested: [], granted: [] },
});

const themeContext = (): ThemeContextValue => {
  const theme = getDefaultTheme(false);
  return {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
};

type Harness = {
  container: HTMLElement;
  render: (tree: React.ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
  cleanup: () => Promise<void>;
};

const createHarness = async (): Promise<Harness> => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('/auth/url-token')) {
      return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    }
    return Response.json({});
  });

  const sdk = createOpencodeClient({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (url.pathname.endsWith('/global/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json(url.pathname.endsWith('/session/status') ? {} : []);
  } });

  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([makeGuest(GUEST_ID), makeGuest(SECOND_GUEST_ID)], runtimeKey);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const theme = themeContext();

  const render = async (tree: React.ReactNode): Promise<void> => {
    await act(async () => root.render(
      <React.StrictMode>
        <I18nProvider>
          <ThemeSystemContext.Provider value={theme}>
            <SyncProvider sdk={sdk} directory="/visible">
              <MemoryPressureProbe />
              {tree}
            </SyncProvider>
          </ThemeSystemContext.Provider>
        </I18nProvider>
      </React.StrictMode>,
    ));
  };

  return {
    container,
    render,
    unmount: async () => { await act(async () => root.unmount()); },
    cleanup: async () => {
      fetch.mockRestore();
      useSessionUIStore.setState({ currentSessionId: null });
      await dom.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const waitForFrames = async (container: HTMLElement, count: number): Promise<HTMLIFrameElement[]> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frames = Array.from(container.querySelectorAll<HTMLIFrameElement>('iframe'));
    if (frames.length >= count) return frames;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error(`Expected ${count} plugin iframe(s) to mount`);
};

const dispatchPressure = async (detail: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('openchamber:memory-pressure', { detail }));
  });
};

const activeBackgroundAction = (): GuestBackgroundAction => ({
  id: 'action-1',
  guestId: GUEST_ID,
  item: {} as GuestBackgroundAction['item'],
  isActive: () => true,
  takeMessage: () => null,
  complete: () => undefined,
});

test('a dropped hidden tab returns on a new frame element', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(<PluginPane mode={`plugin:${GUEST_ID}`} active={false} />);
    const [original] = await waitForFrames(harness.container, 1);

    await dispatchPressure({ level: 'critical', rssBytes: 2_100_000 });
    expect(harness.container.querySelector('iframe')).toBeNull();

    await harness.render(<PluginPane mode={`plugin:${GUEST_ID}`} active />);
    const [restored] = await waitForFrames(harness.container, 1);

    expect(restored).not.toBe(original);
    expect(restored.getAttribute('src') ?? restored.src).toContain(`/${ENTRY}`);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).toContain(`plugin:${GUEST_ID}`);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('a hidden pane running a background action keeps its document', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(
      <PluginPane mode={`plugin:${GUEST_ID}`} active={false} backgroundAction={activeBackgroundAction()} />,
    );
    const [frame] = await waitForFrames(harness.container, 1);

    await dispatchPressure({ level: 'critical', rssBytes: 2_100_000 });

    expect(harness.container.querySelector('iframe')).toBe(frame);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).not.toContain(`plugin:${GUEST_ID}`);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('a headless frame never registers a hidden-surface dropper', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(<PluginPane mode={`plugin:${GUEST_ID}`} active={false} headless />);
    const [frame] = await waitForFrames(harness.container, 1);

    await dispatchPressure({ level: 'critical', rssBytes: 2_100_000 });

    expect(harness.container.querySelector('iframe')).toBe(frame);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).not.toContain(`plugin:${GUEST_ID}`);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('one purge drops the hidden tab only, preserving the tab on screen', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(
      <>
        <PluginPane mode={`plugin:${GUEST_ID}`} active />
        <PluginPane mode={`plugin:${SECOND_GUEST_ID}`} active={false} />
      </>,
    );
    const frames = await waitForFrames(harness.container, 2);
    const activeFrame = frames.find((frame) => frame.getAttribute('title') === 'Counter');
    expect(activeFrame).toBeDefined();

    await dispatchPressure({ level: 'critical', rssBytes: 2_100_000 });

    const remaining = Array.from(harness.container.querySelectorAll<HTMLIFrameElement>('iframe'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(activeFrame);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).toContain(`plugin:${SECOND_GUEST_ID}`);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).not.toContain(`plugin:${GUEST_ID}`);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});
