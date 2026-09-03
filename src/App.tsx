"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationStore } from "@/stores/conversation-store";
import { initMailboxEventListener } from "@/stores/mailbox-store";
import { ChatView } from "@/components/chat/ChatView";
import { NewChatView } from "@/components/chat/NewChatView";
import { WelcomeView } from "@/components/home/WelcomeView";
import { SkillsView } from "@/components/skills/SkillsView";
import { ChannelsView } from "@/components/bridge/ChannelsView";
import { AutomationView } from "@/components/automation/AutomationView";
import { ExtensionsPage } from "@/components/extensions/ExtensionsPage";
import { ConductorView } from "@duya/conductor/renderer/components/ConductorView";
import { SettingsView } from "@/components/settings/SettingsView";
import { AppShell } from "@/components/layout/app-shell";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { FontProvider } from "@/contexts/FontContext";
import { StartupLanding, type StartupLandingPhase } from "@/components/StartupLanding";
import { ensureSession, startStream, stopStream, subscribeSession, getSnapshot, setToolTimeoutCallback, canSend, enqueueMessage, clearQueuedMessages, hasQueuedMessages } from "@/lib/stream-session-manager";
import { useSettings } from "@/hooks/useSettings";
import { ConductorHostProvider } from "@/conductor-host-provider";
import type { Message, StreamPhase, FileAttachment } from "@/types/message";
import type { Message as IpcMessage } from "@/lib/ipc-client";
import { stripPastedContentMarkers } from "@/lib/message-content-parser";
import { interruptChat } from "@/lib/agent-sse-client";

/** Boot splash lifecycle. Re-exported from StartupLanding for convenience. */
type BootSplashPhase = StartupLandingPhase;

const ACTIVE_LIKE_PHASES: StreamPhase[] = ['starting', 'streaming', 'awaiting_permission', 'persisting'];
const isActiveLike = (phase: StreamPhase) => ACTIVE_LIKE_PHASES.includes(phase);

const DEFAULT_THREAD_TITLES = new Set(['New Thread', 'New Chat', '新对话', '开始新对话']);

function deriveProvisionalTitle(content: string): string | null {
  const normalized = content
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length < 4) return null;
  return normalized.slice(0, 48).trim();
}

interface PendingPersistedHandoff {
  sessionId: string;
  startedAt: number;
  sequence: number;
}

export function App({ onReady }: { onReady?: () => void } = {}) {
  // Plan 203 L1: a single QueryClient per app. The L1 hooks
  // (`useProvidersQuery`, mutation hooks, `useActiveProviderId`,
  // `useConfigUpdateSubscription`) all rely on this provider.
  // `useMemo` ensures the client is created once per mount (and
  // survives StrictMode double-invoke).
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Providers are config; not real-time. Aligns with
            // `useProvidersQuery` per-hook override.
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
    [],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <FontProvider>
          <ConductorHostProvider>
            <AppShellInner onReady={onReady} />
          </ConductorHostProvider>
        </FontProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function AppShellInner({ onReady }: { onReady?: () => void } = {}) {
  const {
    currentView,
    activeThreadId,
    messages,
    setActiveThread,
    setCurrentView,
    addMessage,
    loadThreadMessages,
    isHydrated,
    updateThreadTitle,
    isNewChatDrafting,
  } = useConversationStore();
  const { settings } = useSettings();

  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingPersistedHandoff, setPendingPersistedHandoff] = useState<PendingPersistedHandoff | null>(null);
  const lastCancelTimeRef = useRef(0);
  const prevPhaseRef = useRef<StreamPhase>('idle');
  const persistedHandoffSequenceRef = useRef(0);

  useEffect(() => initMailboxEventListener(), []);

  // -------------------------------------------------------------------
  // First-launch splash lifecycle.
  //
  // Show a branded overlay covering the window from "React mounted" to
  // "active session's messages are in the store". Once we transition to
  // 'fading' / 'hidden' the splash never returns within this run — session
  // switches do NOT re-trigger it (per product decision: "仅首次启动").
  //
  // "Ready" means BOTH:
  //   (a) `isHydrated` (zustand persist finished loading localStorage), and
  //   (b) either no `activeThreadId` is restored, OR `messages[activeThreadId]`
  //       has been set (even to an empty array — that's the post-load state).
  // -------------------------------------------------------------------
  const [bootPhase, setBootPhase] = useState<BootSplashPhase>("visible");
  const [bootStatus, setBootStatus] = useState("Loading workspace\u2026");
  const onReadyRef = useRef(onReady);
  useEffect(() => { onReadyRef.current = onReady; }, [onReady]);

  // Derived booleans keep the effect from re-firing on every messages-map mutation.
  const activeSessionLoaded =
    !activeThreadId || messages[activeThreadId] !== undefined;

  useEffect(() => {
    if (bootPhase !== "visible") return;
    if (!isHydrated) {
      setBootStatus("Loading workspace\u2026");
      return;
    }
    if (!activeSessionLoaded) {
      setBootStatus("Preparing session\u2026");
      return;
    }
    // Ready — start the 200ms fade-out, then unmount.
    onReadyRef.current?.();
    setBootPhase("fading");
    const t = window.setTimeout(() => setBootPhase("hidden"), 220);
    return () => window.clearTimeout(t);
  }, [isHydrated, activeSessionLoaded, bootPhase]);

  // Splash watchdog: if hydration never resolves (e.g. persisted state
  // references a thread whose messages never load, or the IPC call
  // hangs), the boot splash would block the entire UI forever. After
  // a generous timeout we force the splash to dismiss so the user can
  // still navigate. The app remains functional — the deferred work
  // (loading messages, fetching thread list) continues in the
  // background and is reflected as data arrives.
  useEffect(() => {
    if (bootPhase !== "visible") return;
    const FALLBACK_MS = 5_000;
    const t = window.setTimeout(() => {
      // eslint-disable-next-line no-console
      console.warn(
        "[boot] splash watchdog: force-dismissing after",
        FALLBACK_MS,
        "ms (isHydrated=",
        isHydrated,
        ", activeSessionLoaded=",
        activeSessionLoaded,
        ")",
      );
      onReadyRef.current?.();
      setBootPhase("fading");
      window.setTimeout(() => setBootPhase("hidden"), 220);
    }, FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [bootPhase, isHydrated, activeSessionLoaded]);

  // The terminal handoff has one owner. A successful worker persist is followed
  // by `done`; only then reload the durable rows, while keeping the existing
  // stream view visible until that reload has reached the conversation store.
  useEffect(() => {
    if (!activeThreadId) return;

    ensureSession(activeThreadId);
    const initialSnapshot = getSnapshot(activeThreadId);
    if (initialSnapshot) {
      setIsStreaming(isActiveLike(initialSnapshot.phase));
      prevPhaseRef.current = initialSnapshot.phase;
    }

    const unsubscribe = subscribeSession(activeThreadId, (snapshot) => {
      const wasActive = isActiveLike(prevPhaseRef.current);
      const isActive = isActiveLike(snapshot.phase);

      // Phase transition: active → non-active (stream ended).
      if (wasActive && !isActive) {
        if (snapshot.dbPersisted?.success) {
          const sequence = ++persistedHandoffSequenceRef.current;
          setPendingPersistedHandoff({
            sessionId: activeThreadId,
            startedAt: snapshot.startedAt,
            sequence,
          });
          void loadThreadMessages(activeThreadId, { force: true }).finally(() => {
            setPendingPersistedHandoff((current) => (
              current?.sequence === sequence ? null : current
            ));
          });
        }
        // For interrupted / errored streams (dbPersisted !== success),
        // do NOT inject optimistic messages into the store. The transient
        // StreamingMessage keeps showing the snapshot (thinking collapsed,
        // tools in order, last text fully rendered) until the user sends
        // the next message. This avoids the "two copies of the same reply"
        // artefact caused by the previous optimistic write, and means
        // interruption and error render the same way as a normal completion
        // would have, just without a durable DB row.
      }

      prevPhaseRef.current = snapshot.phase;
      setIsStreaming(isActive);
    });

    return unsubscribe;
  }, [activeThreadId, loadThreadMessages]);

  // A background sub-agent finishing after its parent turn completes is now
  // handled in the mailbox event listener (mailbox-store.ts): a
  // background_notification mail:created resumes the owning session.

  // Handle notification click to navigate to session
  useEffect(() => {
    if (window.electronAPI?.onNotificationClicked) {
      const unsubscribe = window.electronAPI.onNotificationClicked((data) => {
        if (data.sessionId) {
          setActiveThread(data.sessionId);
        }
      });
      return unsubscribe;
    }
  }, [setActiveThread]);

  // Handle new messages from bots (Plan 483 P2: send_to_ui tool)
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onMessageNew) return;
    const unsubscribe = api.onMessageNew((data) => {
      const { sessionId, messages: ipcMessages } = data;
      if (!ipcMessages || ipcMessages.length === 0) return;

      // Only add messages if this session is the active thread
      const activeThreadId = useConversationStore.getState().activeThreadId;
      if (sessionId !== activeThreadId) return;

      // Convert IPC messages to store Message format (same as mapIpcMessagesToStore)
      const storeMessages: Message[] = (ipcMessages as IpcMessage[]).map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        displayContent: m.displayContent ?? undefined,
        name: m.name ?? undefined,
        tool_call_id: m.toolCallId ?? undefined,
        timestamp: m.createdAt,
        tokenUsage: m.tokenUsage
          ? (typeof m.tokenUsage === 'string'
              ? JSON.parse(m.tokenUsage)
              : m.tokenUsage)
          : undefined,
        msgType: (m.msgType || undefined) as Message['msgType'],
        thinking: m.thinking ?? undefined,
        toolName: m.toolName ?? undefined,
        toolInput: m.toolInput ?? undefined,
        parentToolCallId: m.parentToolCallId ?? undefined,
        vizSpec: m.vizSpec ?? undefined,
        status: m.status ?? undefined,
        seqIndex: m.seqIndex ?? undefined,
        durationMs: m.durationMs ?? undefined,
        subAgentId: m.subAgentId ?? undefined,
        attachments: m.attachments ?? undefined,
      }));

      // Add each message to the store
      for (const msg of storeMessages) {
        useConversationStore.getState().addMessage(sessionId, msg);
      }
    });
    return unsubscribe;
  }, []);

  // Handle OS notification action buttons (Open / Reply for completed
  // messages; Allow / Deny for permission requests). The hook in
  // `usePermissions` already routes `type === 'permission'` actions to
  // the in-app permission flow; here we only act on message-type
  // notifications so we can navigate the user to the right thread.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onNotificationAction) return;
    const unsubscribe = api.onNotificationAction((data) => {
      if (data.type !== 'message') return;
      if (data.actionId === 'open' || data.actionId === '__reply') {
        if (data.sessionId) {
          setActiveThread(data.sessionId);
        }
        // A typed reply is currently not auto-injected into the chat
        // input — surfacing the session is enough for the user to type
        // or paste their response. The reply text is dropped with a
        // debug log so the wiring stays observable.
        if (data.actionId === '__reply' && data.reply) {
          console.log('[App] Notification reply received for session', data.sessionId, '— length:', data.reply.length);
        }
      }
    });
    return unsubscribe;
  }, [setActiveThread]);

  const handleSendMessage = useCallback(
    // The user-chosen permission mode (Ask/Auto/Bypass) rides along as a
    // per-turn override. The session row remains the durable default; we
    // still pass an explicit override so the worker never reverts to a
    // stale stored mode mid-turn.
    (
      content: string,
      model?: string,
      files?: FileAttachment[],
      agentProfileId?: string | null,
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
      mode?: string,
      effort?: string,
      displayContent?: string,
      conductorMode?: boolean,
      queuedMailboxId?: string,
      permissionMode?: 'ask' | 'auto' | 'bypass',
    ) => {
      if (!activeThreadId) return;

      // Plan 220 Phase 5: markers are gone from the write path, so
      // `content` is already plain. The legacy `stripPastedContentMarkers`
      // helper would no-op on the new format; we keep the call as a
      // defensive layer for any inline `content` that might still slip
      // a marker through (e.g. a unit test that constructs one).
      const plainContent = stripPastedContentMarkers(content);

      // Resolve the thread's providerId so the worker uses the right
      // API key/baseURL. Without this, picking a model from a
      // non-default provider still uses the active provider's config
      // and the user sees the active provider's rate-limit error.
      const activeThread = useConversationStore.getState().threads.find((t) => t.id === activeThreadId);
      const provisionalTitle = deriveProvisionalTitle(plainContent);
      if (activeThread && DEFAULT_THREAD_TITLES.has(activeThread.title) && provisionalTitle) {
        updateThreadTitle(activeThreadId, provisionalTitle);
      }
      const sessionProviderId = activeThread?.providerId;
      // Conductor canvas binding lives on the session row; read it here so
      // both enqueueMessage and startStream carry the durable canvasId.
      const conductorCanvasId = activeThread?.conductorCanvasId ?? undefined;
      const permissionModeOverride = permissionMode === 'bypass' ? 'bypassPermissions'
        : permissionMode === 'ask' ? 'default'
        : 'auto';

      if (!canSend(activeThreadId)) {
        enqueueMessage(activeThreadId, {
          sessionId: activeThreadId,
          content: plainContent,
          displayContent,
          permissionModeOverride,
          // Keep the durable profile in the session row; this is only a per-turn override.
          model,
          files,
          agentProfileId,
          outputStyleConfig: outputStyleConfig ?? undefined,
          mode,
          titleGenerationModel: settings.titleGenerationModel,
          providerId: sessionProviderId,
          effort,
          conductorMode,
          conductorCanvasId,
          queuedMailboxId,
        });
        return;
      }

      const now = Date.now();

      // Store message — attachments now carry full parsed data (images + documents)
      const userMsgId = crypto.randomUUID();
      const userMsg: Message = {
        id: userMsgId,
        role: "user",
        content,
        displayContent,
        timestamp: now,
        attachments: files,
        // Renderer-only flag (never persisted). conversation-store dedupes
        // optimistic user messages against DB rows by (role, content,
        // timestamp-window); without this flag, a forced reload during a
        // streaming turn would render the user message twice because the
        // optimistic UUID never matches the DB-assigned one.
        metadata: { optimistic: true },
      };
      console.log('[App] handleSendMessage:', {
        contentLength: content.length,
        filesCount: files?.length,
        filesWithText: files?.filter(f => f.text)?.map(f => ({ name: f.name, textLength: f.text?.length })),
        filesWithImageChunks: files?.filter(f => f.imageChunks)?.map(f => ({ name: f.name, chunks: f.imageChunks?.length })),
      });

      addMessage(activeThreadId, userMsg, { persist: false });

      setIsStreaming(true);

      void startStream({
        sessionId: activeThreadId,
        content: plainContent,
        displayContent,
        language: settings.agentLanguage,
        permissionModeOverride,
        // Keep the durable profile in the session row; this is only a per-turn override.
        model,
        files,
        agentProfileId,
        outputStyleConfig: outputStyleConfig ?? undefined,
        mode,
        titleGenerationModel: settings.titleGenerationModel,
        defaultWorkspaceDirectory: settings.workspaceDir,
        providerId: sessionProviderId,
        effort,
        conductorMode,
        conductorCanvasId,
      });

      setToolTimeoutCallback(activeThreadId, (retryContent: string) => {
        if (!activeThreadId || !canSend(activeThreadId)) return;

        const retryMsg: Message = {
          id: crypto.randomUUID(),
          role: "user",
          content: retryContent,
          timestamp: Date.now(),
        };

        addMessage(activeThreadId, retryMsg, { persist: false });
        // Strip markers before sending to API
        const plainRetryContent = stripPastedContentMarkers(retryContent);
        void startStream({
          sessionId: activeThreadId,
          content: plainRetryContent,
          language: settings.agentLanguage,
          permissionModeOverride,
          model,
          agentProfileId,
          titleGenerationModel: settings.titleGenerationModel,
          defaultWorkspaceDirectory: settings.workspaceDir,
        });
      });
    },
    [activeThreadId, addMessage, settings.titleGenerationModel, updateThreadTitle],
  );

  const handleInterrupt = useCallback(() => {
    if (!activeThreadId) return;
    const now = Date.now();

    if (isStreaming) {
      // The partial assistant view lives in StreamingMessage (driven by
      // stream-session-manager). Stopping the stream flips the session
      // phase to 'aborted'; StreamingMessage detects the terminal phase
      // and renders a "Stopped" banner above the partial content.
      stopStream(activeThreadId, 'Interrupted by user');
      void interruptChat(activeThreadId);
      lastCancelTimeRef.current = now;
      return;
    }

    // Second press within 3s: clear queued messages
    if (hasQueuedMessages(activeThreadId) && now - lastCancelTimeRef.current < 3000) {
      clearQueuedMessages(activeThreadId);
      lastCancelTimeRef.current = 0;
      return;
    }

    // First press while idle: no-op
    lastCancelTimeRef.current = now;
  }, [activeThreadId, isStreaming]);

  const threadMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const isPendingHandoffForActiveThread = pendingPersistedHandoff?.sessionId === activeThreadId;
  const hasDurableHandoffMessage = isPendingHandoffForActiveThread
    && threadMessages.some((message) => (
      message.role === 'assistant' && message.timestamp >= (pendingPersistedHandoff?.startedAt ?? Infinity)
    ));
  // This derived guard makes the store update and transient-view removal one
  // render decision, even if Zustand publishes before the reload promise settles.
  const isFinalizing = isPendingHandoffForActiveThread && !hasDurableHandoffMessage;
  const chatEverMountedRef = useRef(false);
  if (activeThreadId) {
    chatEverMountedRef.current = true;
  }
  const shouldRenderChat = chatEverMountedRef.current && !!activeThreadId;

  const renderView = () => {
    // Lazy new-chat composer: no backing thread yet. Shown before the user
    // sends anything, so an unsent draft never appears in the sidebar.
    if (isNewChatDrafting) {
      return <NewChatView onSendMessage={handleSendMessage} />;
    }

    if (shouldRenderChat) {
      return (
        <>
          {currentView === 'home' && (
            <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />
          )}
          {currentView === 'chat' && (
            <ChatView
              key={activeThreadId}
              sessionId={activeThreadId}
              messages={threadMessages}
              onSendMessage={handleSendMessage}
              onInterrupt={handleInterrupt}
              isStreaming={isStreaming || isFinalizing}
              isFinalizing={isFinalizing}
              hasQueuedMessages={hasQueuedMessages(activeThreadId)}
              onLivePermissionChange={(mode) => {
                const agentMode = mode === 'bypass' ? 'bypassPermissions' : mode === 'ask' ? 'default' : 'auto';
                void window.electronAPI?.agent?.setAgentPermissionMode(activeThreadId, agentMode);
              }}
            />
          )}
          {currentView === 'skills' && <SkillsView />}
          {currentView === 'bridge' && <ChannelsView />}
          {currentView === 'automation' && <AutomationView />}
          {currentView === 'conductor' && <ConductorView />}
          {currentView === 'settings' && <SettingsView />}
          {currentView === 'extensions' && <ExtensionsPage />}
        </>
      );
    }

    switch (currentView) {
      case 'chat':
      case 'home':
        return <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />;
      case 'skills':
        return <SkillsView />;
      case 'bridge':
        return <ChannelsView />;
      case 'automation':
        return <AutomationView />;
      case 'conductor':
        return <ConductorView />;
      case 'settings':
        return <SettingsView />;
      case 'extensions':
        return <ExtensionsPage />;
      default:
        return <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />;
    }
  };

  return (
    <I18nProvider>
      <FontProvider>
        <AppShell>{renderView()}</AppShell>
        {bootPhase !== "hidden" && (
          <StartupLanding phase={bootPhase} status={bootStatus} />
        )}
      </FontProvider>
    </I18nProvider>
  );
}
