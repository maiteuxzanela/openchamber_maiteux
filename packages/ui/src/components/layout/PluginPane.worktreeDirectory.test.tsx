import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useGuestsStore } from '@/lib/guests/store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveConfigDirectory } from '@/stores/useConfigStore';
import { SyncProvider } from '@/sync/sync-context';
import { PluginPane } from './PluginPane';

const GUEST_ID = 'board';
const ENTRY = 'panel/index.html';
const PROJECT = '/project-alpha';
const WORKTREE = '/worktrees/project-alpha/fix-login';

const makeGuest = () => ({
  id: GUEST_ID,
  name: 'Board',
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
  /** Sends `hello` from the guest and returns every host message captured. */
  handshake: (guestWindow: Window, directoryOverride?: string) => Promise<HostMessage[]>;
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

  const render = async (directory: string): Promise<void> => {
    useDirectoryStore.setState({ currentDirectory: directory });
    await act(async () => root.render(
      <React.StrictMode>
        <I18nProvider>
          <ThemeSystemContext.Provider value={theme}>
            <SyncProvider sdk={sdk} directory={directory}>
              <PluginPane mode={`plugin:${GUEST_ID}`} />
            </SyncProvider>
          </ThemeSystemContext.Provider>
        </I18nProvider>
      </React.StrictMode>,
    ));
  };

  const waitForFrame = async (): Promise<HTMLIFrameElement> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const frame = container.querySelector<HTMLIFrameElement>('iframe');
      if (frame) return frame;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error('Plugin iframe did not mount');
  };

  return {
    container,
    handshake: async (guestWindow, directoryOverride) => {
      await render(directoryOverride ?? PROJECT);
      const frame = await waitForFrame();
      // Frame navigation is disabled in this DOM; supply a real guest window so
      // the host's source check and postMessage path run unchanged.
      Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
      const messages: HostMessage[] = [];
      const post = spyOn(guestWindow, 'postMessage').mockImplementation((data) => {
        messages.push(hostMessageSchema.parse(data));
      });
      try {
        await act(async () => {
          window.dispatchEvent(new MessageEvent('message', {
            source: guestWindow as unknown as MessageEventSource,
            data: { channel: 'openchamber.sdk', v: 1, type: 'hello' } satisfies GuestMessage,
          }));
        });
      } finally {
        post.mockRestore();
      }
      return messages;
    },
    unmount: async () => { await act(async () => root.unmount()); },
    cleanup: async () => {
      fetch.mockRestore();
      useSessionUIStore.setState({ currentSessionId: null, availableWorktreesByProject: new Map() });
      useProjectsStore.setState({ projects: [], activeProjectId: null });
      await dom.happyDOM.close();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

const directoryMessage = (messages: HostMessage[]) => {
  const message = messages.find((entry) => entry.type === 'directory');
  if (!message || message.type !== 'directory') throw new Error('No directory message dispatched');
  return message.payload.directory;
};

const readyMessage = (messages: HostMessage[]) => {
  const message = messages.find((entry) => entry.type === 'ready');
  if (!message || message.type !== 'ready') throw new Error('No ready message dispatched');
  return message.payload;
};

test('a worktree session hands the guest the owning project root, not the worktree path', async () => {
  const harness = await createHarness();
  const guestWindow = new Window();
  try {
    useProjectsStore.setState({
      hasServerSnapshot: true,
      serverSnapshotFailed: false,
      projects: [{ id: 'p1', path: PROJECT, label: 'Alpha', addedAt: 1 }],
    });
    useSessionUIStore.setState({
      availableWorktreesByProject: new Map([[PROJECT, [{
        path: WORKTREE,
        projectDirectory: PROJECT,
        branch: 'fix-login',
        name: 'fix-login',
        label: 'fix-login',
        worktreeStatus: 'ready',
      }]]]),
    });

    const messages = await harness.handshake(guestWindow, WORKTREE);

    expect(directoryMessage(messages)).toBe(PROJECT);
    expect(readyMessage(messages).directory).toBe(PROJECT);
    expect(directoryMessage(messages)).not.toBe(WORKTREE);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('a worktree topology discovered after mount re-resolves to the project root', async () => {
  const harness = await createHarness();
  const guestWindow = new Window();
  // Distinct paths: the persisted worktree->project cache survives between
  // tests in this file, and this case must start unresolved.
  const lateProject = '/project-beta';
  const lateWorktree = '/worktrees/project-beta/late';
  try {
    useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });

    const beforeDiscovery = await harness.handshake(guestWindow, lateWorktree);
    expect(directoryMessage(beforeDiscovery)).toBe(lateWorktree);

    // Async git discovery lands after the pane is already mounted.
    await act(async () => {
      useProjectsStore.setState({
        hasServerSnapshot: true,
        serverSnapshotFailed: false,
        projects: [{ id: 'p9', path: lateProject, label: 'Beta', addedAt: 1 }],
      });
      useSessionUIStore.setState({
        availableWorktreesByProject: new Map([[lateProject, [{
          path: lateWorktree,
          projectDirectory: lateProject,
          branch: 'late',
          name: 'late',
          label: 'late',
          worktreeStatus: 'ready',
        }]]]),
      });
    });

    const afterDiscovery = await harness.handshake(guestWindow, lateWorktree);
    expect(directoryMessage(afterDiscovery)).toBe(lateProject);
    expect(readyMessage(afterDiscovery).directory).toBe(lateProject);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('a plain project directory is forwarded unchanged', async () => {
  const harness = await createHarness();
  const guestWindow = new Window();
  try {
    useProjectsStore.setState({
      hasServerSnapshot: true,
      serverSnapshotFailed: false,
      projects: [{ id: 'p1', path: PROJECT, label: 'Alpha', addedAt: 1 }],
    });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });

    const messages = await harness.handshake(guestWindow);

    expect(directoryMessage(messages)).toBe(PROJECT);
    expect(readyMessage(messages).directory).toBe(PROJECT);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('an unknown directory is forwarded unchanged instead of being dropped', async () => {
  const harness = await createHarness();
  const guestWindow = new Window();
  try {
    useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [] });
    useSessionUIStore.setState({ availableWorktreesByProject: new Map() });

    const messages = await harness.handshake(guestWindow);
    expect(directoryMessage(messages)).toBe(PROJECT);
    expect(readyMessage(messages).directory).toBe(PROJECT);
  } finally {
    await harness.unmount();
    await harness.cleanup();
  }
});

test('the config-directory resolver is null/undefined safe', () => {
  useProjectsStore.setState({ hasServerSnapshot: true, serverSnapshotFailed: false, projects: [] });
  useSessionUIStore.setState({ availableWorktreesByProject: new Map() });
  expect(resolveConfigDirectory(null)).toBeNull();
  expect(resolveConfigDirectory(undefined)).toBeNull();
  expect(resolveConfigDirectory('')).toBeNull();
});
