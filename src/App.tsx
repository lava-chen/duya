"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationStore } from "@/stores/conversation-store";
import { initMailboxEventListener } from "@/stores/mailbox-store";
import { ChatView } from "@/components/chat/ChatView";
import { WelcomeView } from "@/components/home/WelcomeView";
import { SkillsView } from "@/components/skills/SkillsView";
import { ChannelsView } from "@/components/bridge/ChannelsView";
import { AutomationView } from "@/components/automation/AutomationView";
import { ConductorView } from "@duya/conductor/renderer/components/ConductorView";
import { MemoryView } from "@/components/memory/MemoryView";
import { SettingsView } from "@/components/settings/SettingsView";
import { AppShell } from "@/components/layout/app-shell";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { FontProvider } from "@/contexts/FontContext";
import { StartupLanding, type StartupLandingPhase } from "@/components/StartupLanding";
import { ensureSession, startStream, stopStream, subscribeSession, getSnapshot, setToolTimeoutCallback, subscribeToDbPersisted, canSend, enqueueMessage, clearQueuedMessages, hasQueuedMessages, resumeBackgroundTask } from "@/lib/stream-session-manager";
import { useSettings } from "@/hooks/useSettings";
import { ConductorHostProvider } from "@/conductor-host-provider";
import type { Message, SessionStreamSnapshot, StreamPhase, FileAttachment } from "@/types/message";
import type { PermissionMode } from "@/components/chat/PermissionModeSelector";
import { uiPermissionModeToAgentModeOverride } from "@/lib/permission-mode";
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

function buildOptimisticMessages(snapshot: SessionStreamSnapshot): Message[] {
  const messages: Message[] = [];
  const now = Date.now();
  const interruptedMetadata = snapshot.phase === 'aborted'
    ? { interrupted: true }
    : undefined;

  if (snapshot.streamingThinkingContent) {
    messages.push({
      id: `optimistic-thinking-${snapshot.streamId || now}`,
      role: 'assistant',
      content: snapshot.streamingThinkingContent,
      timestamp: now - 2,
      msgType: 'thinking',
      thinking: snapshot.streamingThinkingContent,
      metadata: interruptedMetadata,
    });
  }

  for (const toolUse of snapshot.toolUses) {
    messages.push({
      id: `optimistic-tool-${toolUse.id}`,
      role: 'assistant',
      content: toolUse.input ? JSON.stringify(toolUse.input) : '',
      timestamp: now - 1,
      msgType: 'tool_use',
      toolName: toolUse.name,
      toolInput: toolUse.input ? JSON.stringify(toolUse.input) : null,
      tool_call_id: toolUse.id,
      name: toolUse.name,
      metadata: interruptedMetadata,
    });
  }

  for (const result of snapshot.toolResults) {
    messages.push({
      id: `optimistic-result-${result.tool_use_id}`,
      role: 'tool',
      content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
      timestamp: now - 1,
      msgType: 'tool_result',
      parentToolCallId: result.tool_use_id,
      tool_call_id: result.tool_use_id,
      status: result.is_error ? 'error' : 'done',
      metadata: interruptedMetadata,
    });
  }

  const textContent = snapshot.finalMessageContent || snapshot.streamingContent;
  if (textContent) {
    messages.push({
      id: `optimistic-text-${snapshot.streamId || now}`,
      role: 'assistant',
      content: textContent,
      timestamp: now,
      metadata: interruptedMetadata,
    });
  }

  return messages;
}

function mergeOptimisticMessagesForCompletedStream(
  currentMessages: Message[],
  optimisticMessages: Message[],
  snapshot: SessionStreamSnapshot,
): Message[] {
  if (optimisticMessages.length === 0) return currentMessages;

  const streamStartedAt = snapshot.startedAt;
  if (!streamStartedAt) {
    return [...currentMessages, ...optimisticMessages];
  }

  const nextUserIndex = currentMessages.findIndex(
    (message) => message.role === 'user' && message.timestamp > streamStartedAt,
  );

  if (nextUserIndex === -1) {
    return [...currentMessages, ...optimisticMessages];
  }

  return [
    ...currentMessages.slice(0, nextUserIndex),
    ...optimisticMessages,
    ...currentMessages.slice(nextUserIndex),
  ];
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
    markMessageInterrupted,
    updateThreadTitle,
  } = useConversationStore();
  const { settings } = useSettings();
  const wikiAgentEnabled = settings?.wikiAgentEnabled === true;

  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingSnapshot, setStreamingSnapshot] = useState<SessionStreamSnapshot | null>(null);
  const lastCancelTimeRef = useRef(0);
  const prevPhaseRef = useRef<StreamPhase>('idle');

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

  useEffect(() => {
    if (!wikiAgentEnabled && currentView === 'memory') {
      setCurrentView('home');
    }
  }, [wikiAgentEnabled, currentView, setCurrentView]);

  // Subscribe to stream snapshot updates with optimistic message injection
  useEffect(() => {
    if (!activeThreadId) return;

    ensureSession(activeThreadId);
    const initialSnapshot = getSnapshot(activeThreadId);
    if (initialSnapshot) {
      setIsStreaming(isActiveLike(initialSnapshot.phase));
      setStreamingSnapshot(initialSnapshot);
      prevPhaseRef.current = initialSnapshot.phase;
    }

    const unsubscribe = subscribeSession(activeThreadId, (snapshot) => {
      const wasActive = isActiveLike(prevPhaseRef.current);
      const isActive = isActiveLike(snapshot.phase);

      // Phase transition: active → non-active (stream ended)
      // Inject optimistic messages to avoid blank gap before DB load completes.
      // Do NOT call loadThreadMessages here — db_persisted event is the authoritative
      // signal that messages have been persisted and will trigger the DB reload.
      if (wasActive && !isActive) {
        // An interrupt can race a successful persistence acknowledgement that
        // only contains completed tool history, not the last streamed text.
        if (snapshot.phase === 'aborted' || !snapshot.dbPersisted?.success) {
          const optimistic = buildOptimisticMessages(snapshot);
          if (optimistic.length > 0) {
            const store = useConversationStore.getState();
            const current = store.messages[activeThreadId] ?? [];
            useConversationStore.setState({
              messages: {
                ...store.messages,
                [activeThreadId]: mergeOptimisticMessagesForCompletedStream(
                  current,
                  optimistic,
                  snapshot,
                ),
              },
            });
          }
        }
        // DB reload is triggered by db_persisted event below — do not call loadThreadMessages here
      }

      prevPhaseRef.current = snapshot.phase;
      setIsStreaming(isActive);
      setStreamingSnapshot(snapshot);
    });

    return unsubscribe;
  }, [activeThreadId, loadThreadMessages]);

  // Subscribe to db_persisted events: reload messages from DB
  useEffect(() => {
    if (!activeThreadId) return;

    ensureSession(activeThreadId);
    const unsubscribe = subscribeToDbPersisted(activeThreadId, (event) => {
      const startTime = performance.now();
      console.log(`[App] db_persisted received: ${activeThreadId.slice(0, 8)}, success=${event.success}, elapsedSinceEvent=${event.timestamp ? (Date.now() - event.timestamp) : 'unknown'}ms`);
      if (event.success) {
        console.log(`[App] calling loadThreadMessages: ${activeThreadId.slice(0, 8)}`);
        loadThreadMessages(activeThreadId, { force: true });
      }
    });

    return unsubscribe;
  }, [activeThreadId, loadThreadMessages]);

  // A background sub-agent can finish after its parent turn has already
  // completed. Resume the parent session through the normal HTTP+SSE path so
  // the queued task-notification becomes a real model follow-up, not merely
  // a message waiting for the user's next input.
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onBackgroundTaskReady) return;
    return api.onBackgroundTaskReady(({ sessionId }) => {
      void resumeBackgroundTask(sessionId);
    });
  }, []);

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
    // The session row remains the durable default, but this current turn also
    // carries the UI mode as a trusted override to avoid DB write/read races.
    (
      content: string,
      uiPermissionMode?: PermissionMode,
      model?: string,
      files?: FileAttachment[],
      agentProfileId?: string | null,
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
      mode?: string,
      effort?: string,
      displayContent?: string,
      conductorMode?: boolean,
      queuedMailboxId?: string,
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
      const permissionModeOverride = uiPermissionModeToAgentModeOverride(uiPermissionMode);

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
          wikiAgentEnabled,
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
        wikiAgentEnabled,
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
          wikiAgentEnabled,
          defaultWorkspaceDirectory: settings.workspaceDir,
        });
      });
    },
    [activeThreadId, addMessage, settings.titleGenerationModel, updateThreadTitle, wikiAgentEnabled],
  );

  const handleInterrupt = useCallback(() => {
    if (!activeThreadId) return;
    const now = Date.now();

    if (isStreaming) {
      // P2-β: flag the partial assistant message as interrupted so the
      // chrome shows a "Stopped" badge. Find the most recent assistant
      // message in this thread and write metadata.interrupted = true
      // (local-only — does not persist to DB).
      const threadMessages = messages[activeThreadId];
      if (threadMessages && threadMessages.length > 0) {
        for (let i = threadMessages.length - 1; i >= 0; i--) {
          const m = threadMessages[i];
          if (m.role === 'assistant'
            && (!streamingSnapshot?.startedAt || m.timestamp >= streamingSnapshot.startedAt)) {
            markMessageInterrupted(activeThreadId, m.id);
            break;
          }
        }
      }
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
  }, [activeThreadId, isStreaming, messages, markMessageInterrupted, streamingSnapshot]);

  const threadMessages = activeThreadId ? (messages[activeThreadId] ?? []) : [];
  const chatEverMountedRef = useRef(false);
  if (activeThreadId) {
    chatEverMountedRef.current = true;
  }
  const shouldRenderChat = chatEverMountedRef.current && !!activeThreadId;

  const renderView = () => {
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
              isStreaming={isStreaming}
              hasQueuedMessages={hasQueuedMessages(activeThreadId)}
            />
          )}
          {currentView === 'skills' && <SkillsView />}
          {currentView === 'bridge' && <ChannelsView />}
          {currentView === 'automation' && <AutomationView />}
          {currentView === 'conductor' && <ConductorView />}
          {currentView === 'settings' && <SettingsView />}
          {currentView === 'memory' && wikiAgentEnabled && <MemoryView />}
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
      case 'memory':
        return wikiAgentEnabled
          ? <MemoryView />
          : <WelcomeView onSelectThread={setActiveThread} onSendMessage={handleSendMessage} />;
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
