import React from 'react';
import { AppStartupOverlay } from '@/components/ui/AppStartupOverlay';
import { MainLayout } from '@/components/layout/MainLayout';
import { ChatView } from '@/components/views/ChatView';
import { AppLinkConfirmDialog } from '@/components/chat/AppLinkConfirmDialog';
import { SharedTrustConfirmDialog } from '@/components/projects/SharedTrustConfirmDialog';
import { FireworksProvider } from '@/contexts/FireworksContext';
import { Toaster } from '@/components/ui/sonner';
import { Button } from '@/components/ui/button';
import { MemoryDebugPanel } from '@/components/ui/MemoryDebugPanel';
import { setStreamPerfMemoryDebugEnabled } from '@/stores/utils/streamDebug';
import { setRequestsInFlightTrackingEnabled } from '@/stores/utils/requestsInFlight';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
// useEventStream removed — replaced by SyncProvider + SyncBridge
import { useMenuActions } from '@/hooks/useMenuActions';
import { useSessionStatusBootstrap } from '@/hooks/useSessionStatusBootstrap';
import { useTraySync } from '@/hooks/useTraySync';
import { useGlobalSessionsPolling } from '@/hooks/useGlobalSessionsPolling';
import { useRouter } from '@/hooks/useRouter';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWebNotificationStream } from '@/hooks/useWebNotificationStream';
import { useAgentMemorySync } from '@/hooks/useAgentMemorySync';
import { useRoutingSync } from '@/hooks/useRoutingSync';
import { usePwaInstallPrompt } from '@/hooks/usePwaInstallPrompt';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useRootScrollLock } from '@/hooks/useRootScrollLock';
import { useConfigStore } from '@/stores/useConfigStore';
import { isDesktopLocalOriginActive, isDesktopShell, restartDesktopApp, invokeDesktop } from '@/lib/desktop';
import {
  getInjectedBootOutcome,
  getBootInjectionStatus,
  resolveDesktopBootView,
  canDismissInitialLoading,
  shouldRestartDesktopBootFlow,
  type BootInjectionStatus,
  type DesktopBootView,
} from '@/lib/desktopBoot';
import type { RecoveryVariant } from '@/components/onboarding/DesktopConnectionRecovery';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { markSessionViewed } from '@/sync/notification-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { resumeAutoReviewRun } from '@/lib/reviewFlow';
import { SyncProvider } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { ConfigUpdateOverlay } from '@/components/ui/ConfigUpdateOverlay';
import { AboutDialog } from '@/components/ui/AboutDialog';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import type { RuntimeAPIs } from '@/lib/api/types';
import { TooltipProvider } from '@/components/ui/tooltip';
import { McpOAuthCallbackPage } from '@/components/sections/mcp/McpOAuthCallbackPage';
import { MCP_OAUTH_CALLBACK_PATH } from '@/components/sections/mcp/mcpOAuth';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { useI18n } from '@/lib/i18n';
import { applyMobileKeyboardMode } from '@/lib/mobileKeyboardMode';
import {
  EMBEDDED_VISIBILITY_UPDATE,
  getEmbeddedSessionChatURLIdentity,
  isEmbeddedSessionChat,
  requestEmbeddedSessionVisibility,
  startEmbeddedSessionVisibilityRetry,
} from '@/components/layout/contextPanelEmbeddedChat';
import { normalizePath } from '@/lib/pathNormalization';
import { Skeleton } from '@/components/ui/skeleton';
import { SyncAppEffects } from '@/apps/AppEffects';
import { resetAppForRuntimeEndpointChange } from '@/apps/runtimeEndpointReset';
import { useAppFontEffects } from '@/apps/useAppFontEffects';
import { OpenCodeUpdateToast } from '@/components/update/OpenCodeUpdateToast';
import { markStartupTrace, startupTraceEnabled } from '@/lib/startupTrace';

// Lazy-loaded heavy views — loaded on demand to reduce initial bundle size.
const OnboardingScreen = lazyWithChunkRecovery(() =>
  import('@/components/onboarding/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);

const AboutDialogWrapper: React.FC = () => {
  const isAboutDialogOpen = useUIStore((s) => s.isAboutDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  return (
    <AboutDialog
      open={isAboutDialogOpen}
      onOpenChange={setAboutDialogOpen}
    />
  );
};

const StartupInitializationRecovery: React.FC<{
  onRetry: () => void;
  isRetrying: boolean;
}> = ({ onRetry, isRetrying }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex flex-col gap-2">
          <h1 className="typography-title text-foreground">{t('startup.initRecovery.title')}</h1>
          <p className="typography-body text-muted-foreground">{t('startup.initRecovery.description')}</p>
        </div>
        <Button type="button" onClick={onRetry} disabled={isRetrying}>
          {isRetrying ? t('startup.initRecovery.retrying') : t('startup.initRecovery.retry')}
        </Button>
      </div>
    </div>
  );
};

type AppProps = {
  apis: RuntimeAPIs;
};

type EmbeddedSessionChatConfig = {
  sessionId: string;
  directory: string | null;
  readOnly: boolean;
  allowPromptingSubagentSessions?: boolean;
};

type EmbeddedVisibilityPayload = {
  visible?: unknown;
};

const normalizeEmbeddedDirectory = (value: string | null | undefined): string => {
  if (!value) return '';
  // Same normalization the directory store applies inside setDirectory, so the
  // URL directory and the store directory can actually converge (backslashes,
  // trailing slashes, Windows drive-letter case). Comparing across the two
  // spellings is what used to leave the embedded panel permanently blank.
  return normalizePath(value) ?? '';
};

const readEmbeddedSessionChatConfig = (): EmbeddedSessionChatConfig | null => {
  if (typeof window === 'undefined' || !isEmbeddedSessionChat()) {
    return null;
  }

  // The URL is the iframe's own identity: sessionId + directory are what the
  // direct-API path needs to fetch the transcript when the parent handshake
  // never answers, so they are read through the shared helper instead of a
  // second, divergent parse.
  const identity = getEmbeddedSessionChatURLIdentity();
  if (!identity) {
    return null;
  }

  const params = new URLSearchParams(window.location.search);

  return {
    sessionId: identity.sessionId,
    directory: identity.directory,
    readOnly: identity.readOnly,
    allowPromptingSubagentSessions: params.has('allowPromptingSubagentSessions')
      ? params.get('allowPromptingSubagentSessions') === '1'
      : undefined,
  };
};

const isMcpOAuthCallbackPath = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.location.pathname === MCP_OAUTH_CALLBACK_PATH;
};

/**
 * How long the embedded panel keeps showing the directory-sync skeleton before
 * it stops waiting for the store to converge. The panel was opened for one
 * specific directory, so the URL wins — but if the store never gets there
 * (worktree churn, a slow runtime switch) the frame degrades to rendering the
 * session anyway instead of staying blank forever.
 */
const EMBEDDED_DIRECTORY_SYNC_TIMEOUT_MS = 3_500;
const EMBEDDED_DIRECTORY_SYNC_RETRY_MS = 400;
const EMBEDDED_DIRECTORY_SYNC_MAX_ATTEMPTS = 6;

/**
 * Shown while the URL directory is being forced into the directory store.
 * A skeleton is deliberately used instead of `null`: an embedded frame that
 * renders nothing looks broken to the subagent's operator and gives no signal
 * that anything is happening.
 */
const EmbeddedDirectorySyncSkeleton: React.FC<{ directory: string }> = ({ directory }) => {
  const { t } = useI18n();

  return (
    <div
      className="flex h-full w-full flex-col gap-4 bg-background p-4"
      role="status"
      aria-busy="true"
      aria-live="polite"
      data-embedded-directory-sync="pending"
      data-embedded-directory={directory}
    >
      <span className="sr-only">{t('common.loading')}</span>
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-full" />
        <Skeleton className="h-4 w-36" />
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16 w-2/3 rounded-2xl" />
        <Skeleton className="h-20 w-3/4 self-end rounded-2xl" />
        <Skeleton className="h-12 w-1/2 rounded-2xl" />
      </div>
      <div className="mt-auto flex items-center gap-2">
        <Skeleton className="h-9 flex-1 rounded-lg" />
        <Skeleton className="h-9 w-9 rounded-lg" />
      </div>
    </div>
  );
};

const EmbeddedSessionChatContent: React.FC<{
  embeddedSessionChat: EmbeddedSessionChatConfig;
  isVSCodeRuntime: boolean;
  embeddedBackgroundWorkEnabled: boolean;
}> = ({ embeddedSessionChat, isVSCodeRuntime, embeddedBackgroundWorkEnabled }) => {
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const sync = useSync();
  const bootstrapKeyRef = React.useRef<string | null>(null);

  const expectedDirectory = normalizeEmbeddedDirectory(embeddedSessionChat.directory);
  const activeDirectory = normalizeEmbeddedDirectory(currentDirectory);
  // In embedded mode the URL directory is sovereign: the panel was opened for
  // exactly one directory (a worktree, a project), so a store that still
  // points elsewhere must be corrected — never blank the screen over it.
  const isDirectoryOutOfSync = expectedDirectory.length > 0 && activeDirectory !== expectedDirectory;
  const [directorySyncTimedOut, setDirectorySyncTimedOut] = React.useState(false);
  const isWaitingForDirectorySync = isDirectoryOutOfSync && !directorySyncTimedOut;

  // Force the store to the URL directory, retrying a bounded number of times
  // so a transient race (store still bootstrapping, worktree path swapping)
  // cannot strand the panel in the skeleton.
  React.useEffect(() => {
    if (isVSCodeRuntime) return;
    if (!expectedDirectory || activeDirectory === expectedDirectory) return;

    let attempts = 0;
    const syncDirectory = (): boolean => {
      const store = useDirectoryStore.getState();
      if (normalizeEmbeddedDirectory(store.currentDirectory) === expectedDirectory) {
        return true;
      }
      attempts += 1;
      store.setDirectory(expectedDirectory);
      return false;
    };

    if (syncDirectory()) return;

    const interval = window.setInterval(() => {
      if (syncDirectory() || attempts >= EMBEDDED_DIRECTORY_SYNC_MAX_ATTEMPTS) {
        window.clearInterval(interval);
      }
    }, EMBEDDED_DIRECTORY_SYNC_RETRY_MS);

    return () => window.clearInterval(interval);
  }, [activeDirectory, expectedDirectory, isVSCodeRuntime]);

  // Never wait forever: after the timeout the chat renders with whatever
  // directory the store settled on (the bootstrap below then proceeds too).
  React.useEffect(() => {
    if (!isDirectoryOutOfSync || directorySyncTimedOut || isVSCodeRuntime) return;

    const timer = window.setTimeout(() => setDirectorySyncTimedOut(true), EMBEDDED_DIRECTORY_SYNC_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [directorySyncTimedOut, isDirectoryOutOfSync, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isVSCodeRuntime) return;
    if (isDirectoryOutOfSync && !directorySyncTimedOut) return;

    const bootstrapKey = `${expectedDirectory}\n${embeddedSessionChat.sessionId}`;
    // Skip if this session was already bootstrapped and a session is still
    // active — allows in-place navigation (e.g. "Open subtask") to change
    // currentSessionId without this effect forcing it back. Only re-bootstrap
    // when currentSessionId was cleared (store init, draft, delete/archive,
    // runtime-switch remount).
    if (bootstrapKeyRef.current === bootstrapKey && currentSessionId) {
      return;
    }

    bootstrapKeyRef.current = bootstrapKey;
    setCurrentSession(embeddedSessionChat.sessionId, embeddedSessionChat.directory);
    void sync.ensureSessionRenderable(embeddedSessionChat.sessionId, true);
  }, [
    activeDirectory,
    currentSessionId,
    directorySyncTimedOut,
    embeddedSessionChat.directory,
    embeddedSessionChat.sessionId,
    expectedDirectory,
    isDirectoryOutOfSync,
    isVSCodeRuntime,
    setCurrentSession,
    sync,
  ]);

  if (isWaitingForDirectorySync) {
    return (
      <>
        <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
        <EmbeddedDirectorySyncSkeleton directory={expectedDirectory} />
      </>
    );
  }

  return (
    <>
      <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
      <OpenCodeUpdateToast />
      <ChatView
        active={embeddedBackgroundWorkEnabled}
        // Always subscribe to message history in the mounted session-chat
        // iframe. Visibility still gates composer focus and background work so
        // a boot-inactive / lost-handshake race cannot leave a busy subagent
        // showing only its status row (#2903 / #2892).
        messagesEnabled={true}
        readOnly={embeddedSessionChat.readOnly}
        initialAllowPromptingSubagentSessions={embeddedSessionChat.allowPromptingSubagentSessions}
      />
      <Toaster />
    </>
  );
};

function App({ apis }: AppProps) {
  React.useEffect(() => {
    markStartupTrace('App:mounted');
    if (startupTraceEnabled()) {
      console.info('[startup-trace] enabled. Run console.table(window.__OPENCHAMBER_STARTUP_TRACE__) after startup.');
    }
  }, []);

  const initializeApp = useConfigStore((s) => s.initializeApp);
  const isInitialized = useConfigStore((s) => s.isInitialized);
  const isConnected = useConfigStore((s) => s.isConnected);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const error = useSessionUIStore((s) => s.error);
  const clearError = useSessionUIStore((s) => s.clearError);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const isSwitchingDirectory = useDirectoryStore((state) => state.isSwitchingDirectory);
  const [showMemoryDebug, setShowMemoryDebug] = React.useState(false);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const refreshLinearAuthStatus = useLinearAuthStore((state) => state.refreshStatus);
  const [isVSCodeRuntime, setIsVSCodeRuntime] = React.useState<boolean>(() => apis.runtime.isVSCode);
  // Embedded chats start inactive until the parent panel identifies the active
  // tab. Otherwise a newly loaded background tab can focus its composer first
  // and steal keyboard input from the main chat.
  const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);
  const [initRetryExhausted, setInitRetryExhausted] = React.useState(false);
  const [initRetryEpoch, setInitRetryEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [manualInitRetrying, setManualInitRetrying] = React.useState(false);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const mobileKeyboardMode = useUIStore((state) => state.mobileKeyboardMode);
  const isDesktopRuntime = React.useMemo(() => isDesktopShell(), []);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const [bootInjectionStatus, setBootInjectionStatus] = React.useState<BootInjectionStatus>(() => {
    return getBootInjectionStatus();
  });
  const [bootView, setBootView] = React.useState<DesktopBootView | null>(() => {
    const outcome = getInjectedBootOutcome();
    return outcome !== null
      ? resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome })
      : null;
  });
  const appReadyDispatchedRef = React.useRef(false);
  const embeddedSessionChat = React.useMemo<EmbeddedSessionChatConfig | null>(() => readEmbeddedSessionChatConfig(), []);
  const embeddedBackgroundWorkEnabled = !embeddedSessionChat || isEmbeddedVisible;
  const isMcpOAuthCallback = React.useMemo(() => isMcpOAuthCallbackPath(), []);

  React.useEffect(() => {
    setStreamPerfMemoryDebugEnabled(showMemoryDebug);
    setRequestsInFlightTrackingEnabled(showMemoryDebug);
    return () => {
      setStreamPerfMemoryDebugEnabled(false);
      setRequestsInFlightTrackingEnabled(false);
    };
  }, [showMemoryDebug]);

  React.useEffect(() => {
    applyMobileKeyboardMode(mobileKeyboardMode);
  }, [mobileKeyboardMode]);

  React.useEffect(() => {
    setIsVSCodeRuntime(apis.runtime.isVSCode);
  }, [apis.runtime.isVSCode]);

  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setInitRetryExhausted(false);
      setInitRetryEpoch((epoch) => epoch + 1);
    });
  }, []);

  const autoReviewResumeSignature = useAutoReviewStore((state) => {
    const runtimeKey = getRuntimeKey();
    return Object.values(state.runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey)
      .map((run) => `${run.originalSessionID}:${run.phase}:${run.lastForwardedMessageID ?? ''}:${run.expectedAssistantParentID ?? ''}`)
      .sort()
      .join('|');
  });

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    const runtimeKey = getRuntimeKey();
    const runs = Object.values(useAutoReviewStore.getState().runsByOriginalSessionID)
      .filter((run) => run.status === 'running' && run.runtimeKey === runtimeKey);
    for (const run of runs) {
      resumeAutoReviewRun(run.originalSessionID);
    }
  }, [autoReviewResumeSignature, embeddedSessionChat, runtimeEndpointEpoch]);

  React.useEffect(() => {
    document.documentElement.classList.toggle('wide-chat-layout', wideChatLayoutEnabled);
    return () => {
      document.documentElement.classList.remove('wide-chat-layout');
    };
  }, [wideChatLayoutEnabled]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    void refreshGitHubAuthStatus(apis.github, { force: true });
    void refreshLinearAuthStatus(apis.linear, { force: true });
    // `apis` is the same object across an instance switch, so without the epoch
    // this ran once for the whole app session and both statuses kept describing
    // whichever instance happened to be connected at startup. `isConnected` is
    // here to re-ask, not to gate: both integrations answer independently of
    // OpenCode, but a switch can race the transport and the retry is deduped.
  }, [apis.github, apis.linear, embeddedSessionChat, isConnected, refreshGitHubAuthStatus, refreshLinearAuthStatus, runtimeEndpointEpoch]);

  useAppFontEffects();

  const bootOutcomeKnown = bootInjectionStatus === 'valid';
  const bootViewIsMain = bootView?.screen === 'main';

  // Splash dismissal: use the authoritative loading gate from desktopBoot.
  // Desktop shells strictly require a valid boot outcome before dismissing.
  // Non-main outcomes (chooser/recovery) can dismiss without waiting for init.
  React.useEffect(() => {
    if (!canDismissInitialLoading({
      isDesktopShell: isDesktopRuntime,
      isInitialized,
      bootOutcomeKnown,
      bootViewIsMain,
    })) {
      return;
    }

    const timer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 150);

    return () => clearTimeout(timer);
  }, [isDesktopRuntime, isInitialized, bootOutcomeKnown, bootViewIsMain]);

  // Deterministic malformed handling: update splash text so the user
  // sees a specific error instead of a generic spinner, but do NOT
  // dismiss the splash (that only happens on a valid outcome).
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'malformed') {
      return;
    }

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.textContent = 'Desktop startup failed — please restart the app.';
    }
  }, [isDesktopRuntime, bootInjectionStatus]);

  // Non-desktop fallback: remove splash after 5 seconds even if init stalls.
  React.useEffect(() => {
    if (isDesktopRuntime) {
      return;
    }

    const fallbackTimer = setTimeout(() => {
      const loadingElement = document.getElementById('initial-loading');
      if (loadingElement && !isInitialized) {
        loadingElement.classList.add('fade-out');
        setTimeout(() => {
          loadingElement.remove();
        }, 300);
      }
    }, 5000);

    return () => clearTimeout(fallbackTimer);
  }, [isDesktopRuntime, isInitialized]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | {
        planModeExperimentalEnabled?: unknown;
      };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      const enabled = raw === true || raw === 1 || raw === '1' || raw === 'true';
      setPlanModeEnabled(enabled);
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    // VS Code runtime bootstraps config + sessions after the managed OpenCode instance reports "connected".
    // Doing the default initialization here can race with startup and lead to one-shot failures.
    if (isVSCodeRuntime) {
      return;
    }
    void initializeApp();
  }, [initializeApp, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isVSCodeRuntime || isInitialized) return;

    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryCount = 0;
    const MAX_RETRIES = 10;
    const BASE_DELAY_MS = 1000;

    const retryInitialization = async () => {
      if (!active) return;
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const state = useConfigStore.getState();
      if (state.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      retryCount += 1;
      await state.initializeApp();

      const next = useConfigStore.getState();
      if (!active) return;
      if (next.isInitialized) {
        setInitRetryExhausted(false);
        return;
      }
      if (retryCount >= MAX_RETRIES) {
        setInitRetryExhausted(true);
        return;
      }
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, retryCount - 1), 16000);
      retryTimer = setTimeout(retryInitialization, delay);
    };

    retryTimer = setTimeout(retryInitialization, BASE_DELAY_MS);

    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [initRetryEpoch, isInitialized, isVSCodeRuntime]);

  React.useEffect(() => {
    if (isInitialized) {
      setInitRetryExhausted(false);
    }
  }, [isInitialized]);

  React.useEffect(() => {
    if (!initRetryExhausted) return;

    const loadingElement = document.getElementById('initial-loading');
    if (loadingElement) {
      loadingElement.classList.add('fade-out');
      setTimeout(() => {
        loadingElement.remove();
      }, 300);
    }
  }, [initRetryExhausted]);

  // Startup recovery: poll until providers AND agents are loaded.
  // loadProviders/loadAgents resolve normally even on failure (errors swallowed),
  // so a reactive effect can't detect failure — we need an interval.
  React.useEffect(() => {
    if (isVSCodeRuntime || !isConnected) return;
    if (providersCount > 0 && agentsCount > 0) return;

    let active = true;
    let retries = 0;
    const MAX_RETRIES = 15;
    const attempt = async () => {
      const state = useConfigStore.getState();
      if (state.providers.length > 0 && state.agents.length > 0) return;
      try {
        if (state.providers.length === 0) await loadProviders({ source: 'startupRecovery' });
        if (useConfigStore.getState().agents.length === 0) await loadAgents({ source: 'startupRecovery' });
      } catch { /* retry next interval */ }
    };

    void attempt();
    const id = setInterval(() => {
      if (!active) return;
      if (++retries >= MAX_RETRIES) { clearInterval(id); return; }
      void attempt();
    }, 2000);
    return () => { active = false; clearInterval(id); };
  }, [isConnected, isVSCodeRuntime, loadAgents, loadProviders, providersCount, agentsCount]);

  React.useEffect(() => {
    if (isSwitchingDirectory) {
      return;
    }

    // VS Code runtime loads sessions via VSCodeLayout bootstrap to avoid startup races.
    if (isVSCodeRuntime) {
      return;
    }

    if (!isConnected) {
      return;
    }
    opencodeClient.setDirectory(currentDirectory);

    // Session loading is handled by the sync system's bootstrap — no manual loadSessions needed.
  }, [currentDirectory, isSwitchingDirectory, isConnected, isVSCodeRuntime]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    let visibilityAcknowledged = false;

    const applyVisibility = (payload?: EmbeddedVisibilityPayload) => {
      visibilityAcknowledged = true;
      setIsEmbeddedVisible(payload?.visible === true);
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) {
        return;
      }

      const data = event.data as { type?: unknown; payload?: EmbeddedVisibilityPayload };
      if (data?.type !== EMBEDDED_VISIBILITY_UPDATE) {
        return;
      }

      applyVisibility(data.payload);
    };

    const scopedWindow = window as unknown as {
      __openchamberSetEmbeddedVisibility?: (payload?: EmbeddedVisibilityPayload) => void;
    };

    scopedWindow.__openchamberSetEmbeddedVisibility = applyVisibility;
    window.addEventListener('message', handleMessage);
    requestEmbeddedSessionVisibility();
    // The parent installs its listener after this frame can already have
    // posted its first request, so keep asking until it answers. A parent that
    // never answers is a lost handshake, not a hidden panel: fall back to the
    // direct-API path (URL sessionId/directory) with background work enabled
    // instead of leaving the subagent frozen.
    const stopVisibilityRetry = startEmbeddedSessionVisibilityRetry({
      isAcknowledged: () => visibilityAcknowledged,
      onGiveUp: () => applyVisibility({ visible: true }),
    });

    return () => {
      stopVisibilityRetry();
      window.removeEventListener('message', handleMessage);
      if (scopedWindow.__openchamberSetEmbeddedVisibility === applyVisibility) {
        delete scopedWindow.__openchamberSetEmbeddedVisibility;
      }
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (!embeddedSessionChat?.directory || isVSCodeRuntime) {
      return;
    }

    // Compare normalized spellings: the store stores the resolved path, while
    // the URL keeps whatever it was built with (trailing slash, backslashes,
    // lower-case drive letter). A raw comparison would keep re-issuing the
    // same switch forever on those pairs.
    if (normalizeEmbeddedDirectory(currentDirectory) === normalizeEmbeddedDirectory(embeddedSessionChat.directory)) {
      return;
    }

    setDirectory(embeddedSessionChat.directory, { showOverlay: false });
  }, [currentDirectory, embeddedSessionChat, isVSCodeRuntime, setDirectory]);

  React.useEffect(() => {
    if (!embeddedSessionChat || typeof window === 'undefined') {
      return;
    }

    const handleStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage) {
        return;
      }

      if (event.key !== 'ui-store') {
        return;
      }

      void useUIStore.persist.rehydrate();
    };

    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener('storage', handleStorage);
    };
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      void useSessionUIStore.getState().setCurrentSession(sessionId, directory);
    };

    window.addEventListener('openchamber:open-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-session', handler as EventListener);
  }, []);

  // Open a draft Mini Chat window from the native File menu / tray. Uses a
  // dedicated single-fire event (not the menu-action channel) because draft
  // mini-chat windows are NOT deduplicated — a double dispatch would open two.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenMiniChat = () => {
      void invokeDesktop('desktop_open_draft_mini_chat_window', {
        directory: '',
        projectId: null,
      });
    };
    window.addEventListener('openchamber:open-mini-chat', onOpenMiniChat);
    return () => window.removeEventListener('openchamber:open-mini-chat', onOpenMiniChat);
  }, []);

  // When the window regains focus, mark the currently-selected session as seen.
  // Turn-completes that arrive while the app is backgrounded are intentionally
  // left unseen (see isViewedInCurrentSession); coming back to the window is the
  // signal that the user has now looked at it, so the marker clears.
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocus = () => {
      const sessionId = useSessionUIStore.getState().currentSessionId;
      if (sessionId) markSessionViewed(sessionId);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ directory?: string; projectId?: string }>).detail;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : null;
      const projectId = typeof detail?.projectId === 'string' && detail.projectId.trim().length > 0
        ? detail.projectId.trim()
        : null;
      const hasProjectTarget = Boolean(directory || projectId);
      useUIStore.getState().setSessionSwitcherOpen(false);
      useSessionUIStore.getState().openNewSessionDraft({
        target: hasProjectTarget ? 'project' : 'chat',
        selectedProjectId: hasProjectTarget ? projectId : null,
        directoryOverride: hasProjectTarget ? directory : null,
        preserveDirectoryOverride: Boolean(directory),
      });
    };

    window.addEventListener('openchamber:open-draft-session', handler as EventListener);
    return () => window.removeEventListener('openchamber:open-draft-session', handler as EventListener);
  }, []);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!isInitialized || isSwitchingDirectory) return;
    if (appReadyDispatchedRef.current) return;
    appReadyDispatchedRef.current = true;
    (window as unknown as { __openchamberAppReady?: boolean }).__openchamberAppReady = true;
    window.dispatchEvent(new Event('openchamber:app-ready'));
  }, [isInitialized, isSwitchingDirectory]);

  // useEventStream replaced by SyncProvider + SyncBridge

  // Session attention now handled by notification-store via SSE events (session.idle/session.error)

  usePushVisibilityBeacon({ enabled: embeddedBackgroundWorkEnabled });
  useWebNotificationStream({ enabled: embeddedBackgroundWorkEnabled });
  // Loaded here rather than by the Memory tab: the session index is built from
  // this snapshot, so leaving it to the panel meant a user who never opened
  // Project notes sent every message with no memory index at all.
  useAgentMemorySync(currentDirectory || null);
  useRoutingSync();
  usePwaInstallPrompt();

  useWindowTitle();

  useRootScrollLock();

  useRouter();

  const handleToggleMemoryDebug = React.useCallback(() => {
    setShowMemoryDebug(prev => !prev);
  }, []);

  useMenuActions(handleToggleMemoryDebug);

  useTraySync();
  useGlobalSessionsPolling(!embeddedSessionChat);

  useSessionStatusBootstrap({ enabled: embeddedBackgroundWorkEnabled });

  // Palette-only action: the memory debug panel has no keyboard shortcut.
  React.useEffect(() => {
    if (embeddedSessionChat) return;
    const handleToggle = () => setShowMemoryDebug((previous) => !previous);
    window.addEventListener('openchamber:memory-debug-toggle', handleToggle);
    return () => window.removeEventListener('openchamber:memory-debug-toggle', handleToggle);
  }, [embeddedSessionChat]);

  React.useEffect(() => {
    if (embeddedSessionChat) {
      return;
    }

    if (error) {

      setTimeout(() => clearError(), 5000);
    }
  }, [clearError, embeddedSessionChat, error]);

  // Poll for the injected boot outcome until it becomes available (desktop only).
  // The Rust backend sets window.__OPENCHAMBER_DESKTOP_BOOT_OUTCOME__ once the
  // sidecar reaches a stable state. We poll with exponential backoff to handle
  // potential race conditions during startup and config writes.
  React.useEffect(() => {
    if (!isDesktopRuntime || bootInjectionStatus !== 'not-injected') {
      return;
    }

    let cancelled = false;
    let attempts = 0;
    const BASE_INTERVAL = 200;
    const MAX_INTERVAL = 2000;
    const MAX_ATTEMPTS = 50; // 10 seconds total (200ms * 50 with exponential backoff cap)

    const pollWithBackoff = () => {
      if (cancelled) return;

      attempts++;
      const status = getBootInjectionStatus();

      if (status !== 'not-injected') {
        cancelled = true;
        setBootInjectionStatus(status);

        if (status === 'valid') {
          const outcome = getInjectedBootOutcome();
          if (outcome) {
            setBootView(resolveDesktopBootView({ isDesktopShell: true, bootOutcome: outcome }));
          }
        }
        // If status is 'malformed', we keep the splash visible with error text
        // handled by the separate useEffect below
        return;
      }

      // Exponential backoff with cap
      const nextInterval = Math.min(BASE_INTERVAL * Math.pow(1.1, attempts), MAX_INTERVAL);

      if (attempts >= MAX_ATTEMPTS) {
        // Max attempts reached - keep polling but show error
        const loadingElement = document.getElementById('initial-loading');
        if (loadingElement && !loadingElement.textContent?.includes('taking longer')) {
          loadingElement.textContent = 'Desktop startup is taking longer than expected...';
        }
      }

      window.setTimeout(pollWithBackoff, nextInterval);
    };

    // Start polling
    window.setTimeout(pollWithBackoff, BASE_INTERVAL);

    return () => {
      cancelled = true;
    };
  }, [isDesktopRuntime, bootInjectionStatus]);

  const handleDesktopBootDismiss = React.useCallback(async () => {
    if (shouldRestartDesktopBootFlow({
      isDesktopShell: isDesktopShell(),
      isDesktopLocalOriginActive: isDesktopLocalOriginActive(),
    })) {
      await restartDesktopApp();
      return;
    }

    window.location.reload();
  }, []);

  const handleManualInitRetry = React.useCallback(async () => {
    if (manualInitRetrying) return;

    setInitRetryExhausted(false);
    setManualInitRetrying(true);
    try {
      await useConfigStore.getState().initializeApp();
    } finally {
      setManualInitRetrying(false);
    }

    if (!useConfigStore.getState().isInitialized) {
      setInitRetryEpoch((value) => value + 1);
    }
  }, [manualInitRetrying]);

  // Map boot outcome kind to recovery variant
  const mapBootViewToRecoveryVariant = (view: DesktopBootView): RecoveryVariant | undefined => {
    if (view.screen === 'recovery') {
      return view.variant;
    }
    return undefined;
  };

  // Desktop boot view routing.
  // When the boot outcome resolves to a non-main screen (chooser, recovery),
  // render OnboardingScreen with appropriate mode/variant.
  if (isDesktopRuntime && bootView && bootView.screen !== 'main') {
    // First-launch chooser
    if (bootView.screen === 'chooser') {
      return (
        <ErrorBoundary>
          <div className="h-full text-foreground bg-background">
            <React.Suspense fallback={<div className="h-full" />}>
              <OnboardingScreen
                mode="first-launch"
                localAvailable={bootView.localAvailable !== false}
                onCliAvailable={handleDesktopBootDismiss}
                onChooseRemote={() => {
                  // Switch to remote tab - handled internally by OnboardingScreen
                }}
              />
            </React.Suspense>
          </div>
        </ErrorBoundary>
      );
    }

    // Recovery screens
    const recoveryVariant = mapBootViewToRecoveryVariant(bootView);
    const hostUrl = bootView.screen === 'recovery' && 'url' in bootView ? bootView.url : undefined;

    return (
      <ErrorBoundary>
        <div className="h-full text-foreground bg-background">
          <React.Suspense fallback={<div className="h-full" />}>
            <OnboardingScreen
              mode="recovery"
              recoveryVariant={recoveryVariant}
              recoveryHostUrl={hostUrl}
              recoveryHostLabel={undefined}
              localAvailable={bootView.localAvailable !== false}
              onCliAvailable={handleDesktopBootDismiss}
            />
          </React.Suspense>
        </div>
      </ErrorBoundary>
    );
  }

  if (embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
          <RuntimeAPIProvider apis={apis}>
            <TooltipProvider delayDuration={300} skipDelayDuration={150}>
              <div className="h-full text-foreground bg-background">
                <EmbeddedSessionChatContent
                  embeddedSessionChat={embeddedSessionChat}
                  isVSCodeRuntime={isVSCodeRuntime}
                  embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled}
                />
                <AppLinkConfirmDialog />
                <SharedTrustConfirmDialog />
              </div>
            </TooltipProvider>
          </RuntimeAPIProvider>
        </SyncProvider>
      </ErrorBoundary>
    );
  }

  if (isMcpOAuthCallback) {
    return (
      <ErrorBoundary>
        <McpOAuthCallbackPage />
      </ErrorBoundary>
    );
  }

  if (initRetryExhausted && !isInitialized && !isVSCodeRuntime && !embeddedSessionChat) {
    return (
      <ErrorBoundary>
        <StartupInitializationRecovery
          onRetry={() => { void handleManualInitRetry(); }}
          isRetrying={manualInitRetrying}
        />
      </ErrorBoundary>
    );
  }

  // Always mount the full provider tree to avoid remounts when isInitialized
  // flips from false → true. FireworksProvider is a lightweight shell; its
  // heavy children are only activated when actually needed.
  const isBootShell = !isInitialized && !isDesktopRuntime;

  return (
    <ErrorBoundary>
      <SyncProvider key={runtimeEndpointEpoch} sdk={opencodeClient.getSdkClient()} directory={currentDirectory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <FireworksProvider>
              <TooltipProvider delayDuration={300} skipDelayDuration={150}>
                <div className={isDesktopRuntime ? 'h-full text-foreground bg-transparent' : 'h-full text-foreground bg-background'}>
                  <SyncAppEffects embeddedBackgroundWorkEnabled={embeddedBackgroundWorkEnabled} />
                  <OpenCodeUpdateToast />
                  <MainLayout />
                  <AppStartupOverlay ready={isInitialized && (!isDesktopRuntime || (bootOutcomeKnown && bootViewIsMain))} />
                  <Toaster />
                  <AppLinkConfirmDialog />
                  <SharedTrustConfirmDialog />
                  {!isBootShell && (
                    <>
                      <ConfigUpdateOverlay />
                      <AboutDialogWrapper />
                      {showMemoryDebug && (
                        <MemoryDebugPanel onClose={() => setShowMemoryDebug(false)} />
                      )}
                    </>
                  )}
                </div>
              </TooltipProvider>
          </FireworksProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

export default App;
