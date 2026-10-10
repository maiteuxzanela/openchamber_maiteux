import type { Theme } from '@/types/theme';
import type { RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';

export type EmbeddedSessionChatThemeBootstrap = {
  mode: 'light' | 'dark' | 'system';
  lightThemeId: string;
  darkThemeId: string;
  currentTheme: Theme;
};

export type EmbeddedSessionChatSettingsBootstrap = {
  allowPromptingSubagentSessions: boolean;
};

export type EmbeddedSessionChatURLCacheEntry = {
  signature: string;
  src: string;
};

export type EmbeddedSessionRuntimeBootstrap = {
  apiBaseUrl: string;
  clientToken: string;
  localOrigin: string;
  runtimeHeaders?: Record<string, string>;
  relayHostId: string;
  relay?: Omit<RelayRuntimeDescriptor, 'grant'>;
};

export const EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST = 'openchamber:embedded-runtime-bootstrap-request';
export const EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE = 'openchamber:embedded-runtime-bootstrap-response';
export const EMBEDDED_VISIBILITY_REQUEST = 'openchamber:embedded-visibility-request';
export const EMBEDDED_VISIBILITY_UPDATE = 'openchamber:embedded-visibility';
const EMBEDDED_RUNTIME_BOOTSTRAP_TIMEOUT_MS = 5_000;
const EMBEDDED_RUNTIME_BOOTSTRAP_RETRY_MS = 100;
/**
 * The visibility handshake is a fire-and-forget postMessage, so a parent that
 * installs its listener a few milliseconds after the iframe has already asked
 * (or a browser that drops the first message) would otherwise leave the frame
 * invisible for its whole life. The child keeps asking on this cadence until
 * the parent answers, for at most {@link EMBEDDED_VISIBILITY_RETRY_WINDOW_MS}.
 */
export const EMBEDDED_VISIBILITY_RETRY_MS = 750;
export const EMBEDDED_VISIBILITY_RETRY_WINDOW_MS = 6_000;

const isStringRecord = (value: unknown): value is Record<string, string> => (
  value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.values(value).every((entry) => typeof entry === 'string')
);

const isRuntimeBootstrap = (value: unknown): value is EmbeddedSessionRuntimeBootstrap => {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Partial<EmbeddedSessionRuntimeBootstrap>;
  if (
    typeof candidate.apiBaseUrl !== 'string'
    || typeof candidate.clientToken !== 'string'
    || typeof candidate.localOrigin !== 'string'
    || typeof candidate.relayHostId !== 'string'
  ) {
    return false;
  }
  if (candidate.runtimeHeaders !== undefined && !isStringRecord(candidate.runtimeHeaders)) {
    return false;
  }

  const relay = candidate.relay;
  if (relay === undefined) return true;

  return relay !== null
    && typeof relay === 'object'
    && !('grant' in relay)
    && typeof relay.relayUrl === 'string'
    && typeof relay.serverId === 'string'
    && relay.hostEncPubJwk !== null
    && typeof relay.hostEncPubJwk === 'object'
    && !Array.isArray(relay.hostEncPubJwk);
};

export const requestEmbeddedSessionRuntimeBootstrap = (): Promise<EmbeddedSessionRuntimeBootstrap | null> => {
  if (!isEmbeddedSessionChat() || typeof window === 'undefined' || window.parent === window) {
    return Promise.resolve(null);
  }

  const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random()}`;

  return new Promise((resolve) => {
    let settled = false;
    let retry = 0;
    let timeout = 0;
    const finish = (value: EmbeddedSessionRuntimeBootstrap | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      window.clearInterval(retry);
      window.removeEventListener('message', handleMessage);
      resolve(value);
    };
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data as { type?: unknown; requestId?: unknown; payload?: unknown };
      if (data?.type !== EMBEDDED_RUNTIME_BOOTSTRAP_RESPONSE || data.requestId !== requestId) return;
      const payload = isRuntimeBootstrap(data.payload) ? data.payload : null;
      if (!payload) {
        // A parent answering before its runtime config is ready must not
        // terminate the handshake: ask again and keep the retry loop alive
        // until it sends a payload this frame can actually use (or the
        // timeout falls back to the URL-derived direct-API context).
        sendRequest();
        return;
      }
      finish(payload);
    };
    timeout = window.setTimeout(() => finish(null), EMBEDDED_RUNTIME_BOOTSTRAP_TIMEOUT_MS);
    const sendRequest = () => {
      window.parent.postMessage({ type: EMBEDDED_RUNTIME_BOOTSTRAP_REQUEST, requestId }, window.location.origin);
    };
    retry = window.setInterval(sendRequest, EMBEDDED_RUNTIME_BOOTSTRAP_RETRY_MS);
    window.addEventListener('message', handleMessage);
    sendRequest();
  });
};

export const requestEmbeddedSessionVisibility = (): void => {
  if (!isEmbeddedSessionChat() || typeof window === 'undefined' || !window.parent || window.parent === window) {
    return;
  }
  window.parent.postMessage({ type: EMBEDDED_VISIBILITY_REQUEST }, window.location.origin);
};

export type EmbeddedSessionVisibilityRetryOptions = {
  /** Stops the retries as soon as the parent has answered at least once. */
  isAcknowledged: () => boolean;
  /** Called exactly once when the retry window closes with no answer at all. */
  onGiveUp?: () => void;
};

/**
 * Keeps re-asking the parent for the authoritative visibility signal until it
 * answers (or the retry window closes). The first request is sent by the
 * caller so the handshake starts in the same tick the listener is installed;
 * this helper only covers the "parent was not listening yet" race.
 *
 * Returns a disposer that must run on unmount so a hidden panel cannot keep
 * re-posting into a torn-down parent.
 */
export const startEmbeddedSessionVisibilityRetry = (
  options: EmbeddedSessionVisibilityRetryOptions,
): (() => void) => {
  if (
    typeof window === 'undefined'
    || typeof window.setInterval !== 'function'
    || typeof window.clearInterval !== 'function'
    || !isEmbeddedSessionChat()
  ) {
    return () => undefined;
  }

  const startedAt = Date.now();
  let stopped = false;
  let interval = 0;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(interval);
  };

  interval = window.setInterval(() => {
    if (stopped) return;
    if (options.isAcknowledged()) {
      stop();
      return;
    }
    if (Date.now() - startedAt >= EMBEDDED_VISIBILITY_RETRY_WINDOW_MS) {
      stop();
      options.onGiveUp?.();
      return;
    }
    requestEmbeddedSessionVisibility();
  }, EMBEDDED_VISIBILITY_RETRY_MS);

  return stop;
};

/**
 * Identity the embedded iframe carries in its own URL (`sessionId`,
 * `directory`, `readOnly`).
 *
 * This is the direct-API fallback for a lost handshake: the parent is the
 * normal source of truth for runtime bootstrap and visibility, but every
 * message the frame needs is reachable through the API with nothing more than
 * the identity above, so a parent that never answers cannot leave the panel
 * blank.
 */
export type EmbeddedSessionChatURLIdentity = {
  sessionId: string;
  directory: string | null;
  readOnly: boolean;
};

export const getEmbeddedSessionChatURLIdentity = (): EmbeddedSessionChatURLIdentity | null => {
  if (!isEmbeddedSessionChat() || typeof window === 'undefined') {
    return null;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    const sessionId = (params.get('sessionId') ?? '').trim();
    if (!sessionId) {
      return null;
    }

    const directoryRaw = params.get('directory');
    const directory = typeof directoryRaw === 'string' && directoryRaw.trim().length > 0
      ? directoryRaw.trim()
      : null;

    return {
      sessionId,
      directory,
      readOnly: params.get('readOnly') === '1' || params.get('readOnly') === 'true',
    };
  } catch {
    return null;
  }
};

const buildEmbeddedSessionChatURLSignature = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
): string => JSON.stringify({ sessionID, directory: directory || '', readOnly: readOnly === true });

export const buildEmbeddedSessionChatURL = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
  settings?: EmbeddedSessionChatSettingsBootstrap,
): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('ocPanel', 'session-chat');
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('sessionId', sessionID);
  if (readOnly) {
    url.searchParams.set('readOnly', '1');
  } else {
    url.searchParams.delete('readOnly');
  }
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory);
  } else {
    url.searchParams.delete('directory');
  }
  url.searchParams.set('themeMode', theme.mode);
  url.searchParams.set('lightThemeId', theme.lightThemeId);
  url.searchParams.set('darkThemeId', theme.darkThemeId);
  url.searchParams.set('themeVariant', theme.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light');
  if (settings) {
    url.searchParams.set('allowPromptingSubagentSessions', settings.allowPromptingSubagentSessions ? '1' : '0');
  }

  url.hash = '';
  return url.toString();
};

export const getOrCreateEmbeddedSessionChatURL = (
  cache: Map<string, EmbeddedSessionChatURLCacheEntry>,
  tabID: string,
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
  settings?: EmbeddedSessionChatSettingsBootstrap,
): string => {
  const signature = buildEmbeddedSessionChatURLSignature(sessionID, directory, readOnly);
  const existing = cache.get(tabID);
  if (existing?.signature === signature) {
    return existing.src;
  }

  const src = buildEmbeddedSessionChatURL(sessionID, directory, readOnly, theme, settings);
  cache.set(tabID, { signature, src });
  return src;
};

export const getActiveEmbeddedSessionChatTab = <T extends { id: string }>(
  tabs: T[],
  activeTabID: string | null,
): T | null => {
  if (!activeTabID) {
    return null;
  }

  return tabs.find((tab) => tab.id === activeTabID) ?? null;
};

/**
 * True when the current document is the embedded session-chat iframe
 * (`?ocPanel=session-chat`). Used to distinguish the embedded iframe from
 * the main app so callers can route behavior accordingly (e.g. in-place
 * subtask navigation instead of opening a new side-panel tab, or skipping
 * URL rewrites that would strip the iframe's identity params).
 *
 * Cached on first call (per JS realm): an iframe's embedded-ness is fixed
 * at mount by the parent and cannot change during its lifetime — a parent
 * src swap is a full browser reload, starting a fresh realm.
 */
let embeddedSessionChatCached: boolean | null = null;

export const isEmbeddedSessionChat = (): boolean => {
  if (embeddedSessionChatCached !== null) {
    return embeddedSessionChatCached;
  }
  if (typeof window === 'undefined') {
    embeddedSessionChatCached = false;
    return false;
  }
  try {
    embeddedSessionChatCached =
      new URLSearchParams(window.location.search).get('ocPanel') === 'session-chat';
    return embeddedSessionChatCached;
  } catch {
    embeddedSessionChatCached = false;
    return false;
  }
};

/**
 * Reset the module-level cache. Intended for tests that simulate different
 * JS realms by swapping `window.location` in the same process.
 */
export const resetEmbeddedSessionChatCache = (): void => {
  embeddedSessionChatCached = null;
};

/**
 * The session ID recorded in the embedded iframe's URL
 * (`?ocPanel=session-chat&sessionId=…`), i.e. the session the panel was
 * opened to show. Returns `null` outside the embedded iframe or when the
 * URL is malformed.
 */
export const getEmbeddedSessionChatOriginSessionId = (): string | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }
  try {
    const sid = new URLSearchParams(window.location.search).get('sessionId');
    return sid && sid.trim().length > 0 ? sid.trim() : null;
  } catch {
    return null;
  }
};
