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
import { useGuestsStore } from '@/lib/guests/store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const GUEST_ID = 'counter';
const ENTRY = 'panel/index.html';

const MemoryPressureProbe: React.FC = () => {
  useMemoryPressureGuard();
  return null;
};

const makeGuest = () => ({
  id: GUEST_ID,
  name: 'Counter',
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
  render: (active: boolean) => Promise<void>;
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
  useGuestsStore.getState().replaceCatalog([makeGuest()], runtimeKey);

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const theme = themeContext();

  const render = async (active: boolean): Promise<void> => {
    await act(async () => root.render(
      <React.StrictMode>
        <I18nProvider>
          <ThemeSystemContext.Provider value={theme}>
            <SyncProvider sdk={sdk} directory="/visible">
              <MemoryPressureProbe />
              <PluginPane mode={`plugin:${GUEST_ID}`} active={active} />
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

const waitForFrame = async (container: HTMLElement): Promise<HTMLIFrameElement> => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const frame = container.querySelector<HTMLIFrameElement>('iframe');
    if (frame) return frame;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error('Plugin iframe did not mount');
};

const dispatchPressure = async (detail: Record<string, unknown>): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('openchamber:memory-pressure', { detail }));
  });
};

test('memory pressure detaches a hidden plugin frame and reloads it when shown', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(false);
    const frame = await waitForFrame(harness.container);
    expect(frame.getAttribute('src') ?? frame.src).toContain(`/${ENTRY}`);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');

    await dispatchPressure({ level: 'critical', rssBytes: 2_100_000, limitBytes: 1_939_865, source: 'webkitgtk-monitor' });

    expect(harness.container.querySelector('iframe')).toBeNull();
    const report = getLastMemoryPurgeReport();
    expect(report?.level).toBe('critical');
    expect(report?.droppedSurfaces).toContain(`plugin:${GUEST_ID}`);

    // Showing the tab again rebuilds the frame instead of leaving a blank one.
    await harness.render(true);
    const reloaded = await waitForFrame(harness.container);
    expect(reloaded.getAttribute('src') ?? reloaded.src).toContain(`/${ENTRY}`);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('memory pressure never detaches the pane the user is looking at', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(true);
    const frame = await waitForFrame(harness.container);

    await dispatchPressure({ level: 'warning', rssBytes: 1_500_000 });

    expect(harness.container.querySelector('iframe')).toBe(frame);
    expect(getLastMemoryPurgeReport()?.droppedSurfaces).not.toContain(`plugin:${GUEST_ID}`);
    expect(getLastMemoryPurgeReport()?.level).toBe('warning');
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('unmount blanks the frame document before React removes the node', async () => {
  resetMemoryPressureForTests();
  const harness = await createHarness();
  try {
    await harness.render(true);
    const frame = await waitForFrame(harness.container);
    expect(frame.getAttribute('src') ?? frame.src).toContain(`/${ENTRY}`);

    await harness.unmount();

    expect(frame.getAttribute('src')).toBe('about:blank');
    expect(frame.getAttribute('srcdoc')).toBeNull();
  } finally {
    await harness.cleanup();
  }
});
