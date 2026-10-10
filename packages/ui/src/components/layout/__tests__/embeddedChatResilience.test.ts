/**
 * Resilience coverage for the embedded subagent chat (side panel iframe).
 *
 * Three failure modes used to blank or freeze the subagent panel:
 *
 * 1. The URL directory and the directory store disagreed (worktree, pending
 *    store sync) and `EmbeddedSessionChatContent` answered with `return null`.
 * 2. The parent missed the one-shot visibility handshake, so the frame stayed
 *    invisible forever and background work never started.
 * 3. The iframe emitted its visibility request before the child listener
 *    existed, so the answer landed in a window that was not listening.
 *
 * These tests pin the source-level guards (the same pattern used by
 * issue-2815) plus the real behaviour of the retry helper.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMBEDDED_VISIBILITY_RETRY_MS,
  getEmbeddedSessionChatURLIdentity,
  resetEmbeddedSessionChatCache,
  startEmbeddedSessionVisibilityRetry,
} from '../contextPanelEmbeddedChat';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf-8');
const contextPanelSource = readFileSync(join(__dirname, '..', 'ContextPanel.tsx'), 'utf-8');

const originalWindow = globalThis.window;
const originalDateNow = Date.now;

type TestWindow = {
  location: { href: string; origin: string; pathname: string; search: string };
  parent: { postMessage: (message: unknown, origin: string) => void };
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

const posted: Array<{ message: unknown; origin: string }> = [];

const installEmbeddedWindow = (href = 'http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=ses_1&directory=%2Frepo') => {
  const url = new URL(href);
  const value: TestWindow = {
    location: {
      href: url.toString(),
      origin: url.origin,
      pathname: url.pathname,
      search: url.search,
    },
    parent: {
      postMessage: (message, origin) => posted.push({ message, origin }),
    },
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value,
  });
  resetEmbeddedSessionChatCache();
  return value;
};

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

beforeEach(() => {
  posted.length = 0;
  installEmbeddedWindow();
});

afterAll(() => {
  Date.now = originalDateNow;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

describe('embedded directory sync (App.tsx)', () => {
  const contentStart = appSource.indexOf('const EmbeddedSessionChatContent');
  const contentEnd = appSource.indexOf('function App(', contentStart);
  const contentSource = appSource.slice(contentStart, contentEnd > 0 ? contentEnd : undefined);

  test('never returns null while the URL directory is still syncing', () => {
    expect(contentStart).toBeGreaterThan(-1);
    expect(contentEnd).toBeGreaterThan(contentStart);
    expect(contentSource).not.toContain('return null;');
  });

  test('forces the directory store to the URL directory instead of blanking', () => {
    expect(contentSource).toContain('store.setDirectory(expectedDirectory);');
    expect(appSource).toContain('data-embedded-directory-sync="pending"');
    expect(contentSource).toContain('<EmbeddedDirectorySyncSkeleton directory={expectedDirectory} />');
  });

  test('degrades to the chat after the sync timeout instead of waiting forever', () => {
    expect(contentSource).toContain('const [directorySyncTimedOut, setDirectorySyncTimedOut] = React.useState(false);');
    expect(contentSource).toContain('setDirectorySyncTimedOut(true)');
    expect(contentSource).toContain('if (isWaitingForDirectorySync) {');
  });

  test('normalizes the URL directory exactly like the directory store', () => {
    expect(appSource).toContain("return normalizePath(value) ?? '';");
  });

  test('keeps the visibility handshake retry with a give-up fallback', () => {
    expect(appSource).toContain('window.addEventListener(\'message\', handleMessage);');
    expect(appSource).toContain('requestEmbeddedSessionVisibility();');
    expect(appSource).toContain('startEmbeddedSessionVisibilityRetry({');
    expect(appSource).toContain('onGiveUp: () => applyVisibility({ visible: true }),');
  });
});

describe('iframe visibility push (ContextPanel.tsx)', () => {
  test('pushes visibility as soon as the frame registers', () => {
    expect(contextPanelSource).toContain(
      'postEmbeddedVisibilityToChat(activeChatTab.id, node, window.location.origin);',
    );
  });

  test('re-pushes visibility after mount while the child listener comes up', () => {
    expect(contextPanelSource).toContain('const timers = [300, 1_200, 3_000].map(');
    expect(contextPanelSource).toContain(
      'postEmbeddedVisibilityToChat(activeChatTabID, frame, window.location.origin);',
    );
  });

  test('keeps the chat container responsive inside the panel', () => {
    expect(contextPanelSource).toContain("'relative min-h-0 min-w-0 w-full flex-1 overflow-hidden'");
    expect(contextPanelSource).toContain('className="absolute inset-0 block h-full w-full border-0 bg-background"');
  });
});

describe('getEmbeddedSessionChatURLIdentity', () => {
  test('reads sessionId, directory and readOnly straight from the URL', () => {
    installEmbeddedWindow('http://127.0.0.1:5173/app?ocPanel=session-chat&sessionId=%20ses_child%20&directory=%2Frepo%2Fworktree&readOnly=1');

    expect(getEmbeddedSessionChatURLIdentity()).toEqual({
      sessionId: 'ses_child',
      directory: '/repo/worktree',
      readOnly: true,
    });
  });

  test('returns null without an embedded panel or a sessionId', () => {
    installEmbeddedWindow('http://127.0.0.1:5173/app?sessionId=ses_main');
    expect(getEmbeddedSessionChatURLIdentity()).toBeNull();

    installEmbeddedWindow('http://127.0.0.1:5173/app?ocPanel=session-chat&directory=%2Frepo');
    expect(getEmbeddedSessionChatURLIdentity()).toBeNull();
  });
});

describe('startEmbeddedSessionVisibilityRetry', () => {
  test('keeps re-asking an unresponsive parent', async () => {
    installEmbeddedWindow();

    const stop = startEmbeddedSessionVisibilityRetry({ isAcknowledged: () => false });
    try {
      await sleep(EMBEDDED_VISIBILITY_RETRY_MS + 150);
      expect(posted.length).toBeGreaterThanOrEqual(1);
      expect(posted[0]).toEqual({
        message: { type: 'openchamber:embedded-visibility-request' },
        origin: 'http://127.0.0.1:5173',
      });
    } finally {
      stop();
    }
  });

  test('stops asking once the parent has acknowledged', async () => {
    installEmbeddedWindow();

    const stop = startEmbeddedSessionVisibilityRetry({ isAcknowledged: () => true });
    try {
      await sleep(EMBEDDED_VISIBILITY_RETRY_MS + 150);
      expect(posted).toHaveLength(0);
    } finally {
      stop();
    }
  });

  test('invokes onGiveUp exactly once when the retry window closes', async () => {
    installEmbeddedWindow();

    const start = Date.now();
    let offset = 0;
    Date.now = () => start + offset;

    let giveUps = 0;
    const stop = startEmbeddedSessionVisibilityRetry({
      isAcknowledged: () => false,
      onGiveUp: () => { giveUps += 1; },
    });

    try {
      offset = 60_000;
      await sleep(EMBEDDED_VISIBILITY_RETRY_MS + 150);
      expect(giveUps).toBe(1);
      stop();
      await sleep(EMBEDDED_VISIBILITY_RETRY_MS + 150);
      expect(giveUps).toBe(1);
    } finally {
      stop();
      Date.now = originalDateNow;
    }
  });

  test('is a no-op outside the embedded iframe', async () => {
    installEmbeddedWindow('http://127.0.0.1:5173/app?sessionId=ses_main');

    const stop = startEmbeddedSessionVisibilityRetry({ isAcknowledged: () => false });
    try {
      await sleep(EMBEDDED_VISIBILITY_RETRY_MS + 150);
      expect(posted).toHaveLength(0);
    } finally {
      stop();
    }
  });
});
