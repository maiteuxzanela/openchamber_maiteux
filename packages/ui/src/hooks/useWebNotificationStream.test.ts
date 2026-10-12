import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { resetEmbeddedSessionChatCache } from '@/components/layout/contextPanelEmbeddedChat';

let eventSourceConstructorCalls: string[] = [];
class FakeEventSource {
  url: string;
  onmessage: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    eventSourceConstructorCalls.push(url);
  }
  close() {
    this.closed = true;
  }
}

const { useWebNotificationStream } = await import('./useWebNotificationStream');

const HookHarness: React.FC<{ enabled?: boolean }> = ({ enabled }) => {
  useWebNotificationStream({ enabled });
  return null;
};

describe('useWebNotificationStream', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetEmbeddedSessionChatCache();
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    eventSourceConstructorCalls = [];
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      EventSource: FakeEventSource,
    });
    host = windowInstance.document.createElement('div') as unknown as HTMLDivElement;
    (windowInstance.document.body as unknown as { appendChild: (node: unknown) => void }).appendChild(host);
    root = createRoot(host as unknown as HTMLElement);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    resetEmbeddedSessionChatCache();
  });

  test('does not open EventSource when window location has ocPanel=', () => {
    windowInstance.location.href = 'http://localhost/?ocPanel=session-chat';
    resetEmbeddedSessionChatCache();

    act(() => {
      root.render(React.createElement(HookHarness, { enabled: true }));
    });

    expect(eventSourceConstructorCalls.length).toBe(0);
  });

  test('opens EventSource when in normal top-level window and enabled', () => {
    windowInstance.location.href = 'http://localhost/';
    resetEmbeddedSessionChatCache();

    act(() => {
      root.render(React.createElement(HookHarness, { enabled: true }));
    });

    expect(eventSourceConstructorCalls.length).toBe(1);
    expect(eventSourceConstructorCalls[0]).toContain('/api/notifications/stream');
  });
});
