/**
 * SDET guard for TICKET-HARNESS-75 — the guest-visible directory is the owning
 * project root, but HOST-SIDE operations must keep the physical worktree path.
 *
 * The regression this catches: wiring `guestDirectory` into `directoryRef` (or
 * replacing it) would silently point every guest file operation at the parent
 * checkout instead of the isolated worktree. The observation is the real
 * request the pane sends to the runtime: `POST /api/guests/<id>/files` with the
 * `x-opencode-directory` header set from the pane's directory ref.
 */
import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import type { GuestMessage } from '@openchamber/sdk';
import type { InstalledGuest } from '@/lib/guests/types';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const GUEST_ID = 'board';
const PROJECT = '/project-alpha';
const WORKTREE = '/worktrees/project-alpha/fix-login';

const makeGuest = (): InstalledGuest => ({
  id: GUEST_ID,
  name: 'Board',
  icon: 'window',
  entry: 'panel/index.html',
  capabilities: { requested: ['files'], granted: ['files'] },
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

type CapturedRequest = { url: string; headers: Record<string, string>; body: string | null };

const headerRecord = (headers: HeadersInit | undefined): Record<string, string> => {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
};

test('host file operations keep the physical worktree directory while the guest gets the project root', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    localStorage: dom.localStorage,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    Event: dom.Event,
    MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const captured: CapturedRequest[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    captured.push({
      url,
      headers: headerRecord(init?.headers as HeadersInit | undefined),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (url.includes('/auth/url-token')) {
      return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    }
    if (url.includes(`/api/guests/${GUEST_ID}/files`)) {
      return Response.json({ ok: true });
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
  useProjectsStore.setState({
    hasServerSnapshot: true,
    serverSnapshotFailed: false,
    projects: [{ id: 'p1', path: PROJECT, label: 'Alpha', addedAt: 1 }],
  });
  useSessionUIStore.setState({
    currentSessionId: null,
    availableWorktreesByProject: new Map([[PROJECT, [{
      path: WORKTREE,
      projectDirectory: PROJECT,
      branch: 'fix-login',
      name: 'fix-login',
      label: 'fix-login',
      worktreeStatus: 'ready',
    }]]]),
  });
  useDirectoryStore.setState({ currentDirectory: WORKTREE });

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const theme = themeContext();
  const guestWindow = new Window();

  try {
    await act(async () => root.render(
      <React.StrictMode>
        <I18nProvider>
          <ThemeSystemContext.Provider value={theme}>
            <SyncProvider sdk={sdk} directory={WORKTREE}>
              <PluginPane mode={`plugin:${GUEST_ID}`} />
            </SyncProvider>
          </ThemeSystemContext.Provider>
        </I18nProvider>
      </React.StrictMode>,
    ));

    let frame: HTMLIFrameElement | null = null;
    for (let attempt = 0; attempt < 200 && !frame; attempt++) {
      frame = container.querySelector<HTMLIFrameElement>('iframe');
      if (!frame) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    if (!frame) throw new Error('Plugin iframe did not mount');
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });

    const guestMessages: Array<Record<string, unknown>> = [];
    const post = spyOn(guestWindow, 'postMessage').mockImplementation((data) => {
      guestMessages.push(data as Record<string, unknown>);
    });

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: guestWindow as unknown as MessageEventSource,
        data: { channel: 'openchamber.sdk', v: 1, type: 'hello' } satisfies GuestMessage,
      }));
    });

    // Sanity: the handshake already handed the project root to the guest.
    const ready = guestMessages.find((message) => message['type'] === 'ready');
    expect((ready?.['payload'] as { directory?: string } | undefined)?.directory).toBe(PROJECT);

    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', {
        source: guestWindow as unknown as MessageEventSource,
        data: {
          channel: 'openchamber.sdk',
          v: 1,
          type: 'file-read',
          id: 'sdet-file-1',
          payload: { path: 'notes.txt' },
        } satisfies GuestMessage,
      }));
    });

    let fileRequest: CapturedRequest | undefined;
    for (let attempt = 0; attempt < 100 && !fileRequest; attempt++) {
      fileRequest = captured.find((entry) => entry.url.includes(`/api/guests/${GUEST_ID}/files`));
      if (!fileRequest) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    post.mockRestore();
    if (!fileRequest) throw new Error('host never issued the guest file request');

    // The host-side seam is the physical worktree, never the guest-visible root.
    expect(fileRequest.headers['x-opencode-directory']).toBe(WORKTREE);
    expect(fileRequest.headers['x-opencode-directory']).not.toBe(PROJECT);
    expect(JSON.parse(fileRequest.body ?? '{}')).toEqual({ op: 'read', path: 'notes.txt' });
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    useSessionUIStore.setState({ currentSessionId: null, availableWorktreesByProject: new Map() });
    useProjectsStore.setState({ projects: [], activeProjectId: null });
    await dom.happyDOM.close();
    await guestWindow.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
