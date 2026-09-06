"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useConversationStore } from "@/stores/conversation-store";
import { initMailboxEventListener } from "@/stores/mailbox-store";
import { ChatView } from "@/components/chat/ChatView";
import { BotDirectChatView } from "@/components/chat/BotDirectChatView";
import { AgentDmPairView } from "@/components/chat/bot/AgentDmPairView";
import { GroupRoomChatView } from "@/components/chat/GroupRoomChatView";
import { resolveChatMode, resolveBotAgentId } from "@/components/chat/bot/chat-mode";
import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";
import { botDirectSendComplete } from "@/components/chat/bot/send";
import {
  cancelPendingTurnsForSession,
  rememberPendingTurn,
  subscribeScheduledTurns,
  takePendingTurn,
} from "@/components/chat/bot/send/scheduled-turns";
import type { BotComposerSendPayload } from "@/components/chat/BotComposer";
import { composeReplyContent } from "@/components/chat/bot/reply";
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
import {
  dbMessageToMessage,
  isBotDirectVisibleSource,
  type DbMessage as DbMessageRow,
} from "@/lib/ipc-client";
import { stripPastedContentMarkers } from "@/lib/message-content-parser";
import { interruptChat } from "@/lib/agent-sse-client";
import { SearchCommandPalette } from "@/components/SearchCommandPalette";

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

      // Convert IPC messages to store Message format (same as mapIpcMessagesToStore).
      // The broadcast rows are snake_case MessageRow — convert them through
      // dbMessageToMessage first; reading camelCase fields off the raw row
      // yields undefined (timestamp, toolName, ...) and breaks rendering.
      const storeMessages: Message[] = (ipcMessages as DbMessageRow[])
        .map(dbMessageToMessage)
        // Plan 497 — ingestion-boundary source filter: the broadcast carries
        // every persisted row, including bot-internal ones (tool_use /
        // thinking / scratchpad / system — e.g. a wake run's prompt user
        // row). Without this guard they entered the visible conversation
        // store unfiltered and out of order, surfacing as stray bubbles in
        // the bot-direct chat behind the source-filtered projection. Same
        // allowlist the main-process projection enforces.
        .filter((m) => isBotDirectVisibleSource(m.source))
        .map((m) => ({
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
          source: m.source ?? undefined,
          sendMessageMeta: m.sendMessageMeta ?? undefined,
          agentDmMeta: m.agentDmMeta ?? undefined,
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

  // Plan 491 P1.1 / 477 P3.1: dedicated bot-direct send path. The workspace
  // handleSendMessage would work for message transport, but the bot session
  // needs (a) agentProfileId carried so the worker loads the bot identity +
  // toolset + prompt (the server force-overrides it for bot sessions anyway),
  // (b) the nonce-dedup + preemption pipeline from the 491 send module, and
  // (c) per-message delivery phases in the conversation store.
  const setMessageDelivery = useConversationStore((s) => s.setMessageDelivery);
  const handleBotDirectSend = useCallback(
    (payload: BotComposerSendPayload) => {
      if (!activeThreadId) return;
      const agentId = resolveBotAgentId(activeThreadId);
      if (!agentId) return;
      const { text, model, providerId, mode, files, replyTo } = payload;
      // Reply quote (bot/reply.ts): the sentinel block rides inside the
      // content the agent (and the persisted row) sees, while
      // `displayContent` keeps the plain user text for the bubble body.
      const content = composeReplyContent(text, replyTo);
      const displayContent = replyTo ? text : undefined;

      // Bot-direct is an 'auto' surface: the session row stores the durable
      // default and the server binds the profile from the bot id.
      const permissionModeOverride = 'auto' as const;
      const sessionProviderId = useConversationStore
        .getState()
        .threads.find((t) => t.id === activeThreadId)?.providerId;

      // Plan 500 P2: every bot DM send goes through the main-process gate.
      // Main decides: run now ('start', renderer keeps its streaming path)
      // or park on the wake queue's user lane ('queued', priority judgment
      // + preemption already applied main-side). The messageId is minted
      // here so the queued bubble and the later scheduled-turn push match.
      const messageId = crypto.randomUUID();
      addMessage(
        activeThreadId,
        {
          id: messageId,
          role: 'user',
          content,
          displayContent,
          timestamp: Date.now(),
          metadata: { optimistic: true },
        },
        { persist: false },
      );
      setMessageDelivery(activeThreadId, messageId, 'sending');

      const startTurn = (): void => {
        setIsStreaming(true);
        void startStream({
          sessionId: activeThreadId,
          content,
          displayContent,
          language: settings.agentLanguage,
          permissionModeOverride,
          agentProfileId: agentId,
          titleGenerationModel: settings.titleGenerationModel,
          defaultWorkspaceDirectory: settings.workspaceDir,
          providerId: providerId ?? sessionProviderId,
          model,
          mode,
          files,
        });
      };

      void (async () => {
        let action: 'start' | 'queued' = 'start';
        try {
          const gate = await window.electronAPI?.botTurn?.sendTurn({
            agentId,
            text: content,
            clientMsgId: messageId,
          });
          if (gate?.action) action = gate.action;
        } catch {
          // Gate unavailable (older preload / IPC failure) → direct send,
          // the pre-500 behavior.
          action = 'start';
        }
        if (action === 'start') {
          startTurn();
          return;
        }
        // Queued on the user lane. Keep the captured start params so the
        // scheduled-turn push can restart the turn with the same shape.
        setMessageDelivery(activeThreadId, messageId, 'queued');
        rememberPendingTurn(messageId, {
          sessionId: activeThreadId,
          content,
          displayContent,
          start: startTurn,
        });
      })();
    },
    [
      activeThreadId,
      addMessage,
      setMessageDelivery,
      settings.agentLanguage,
      settings.titleGenerationModel,
      settings.workspaceDir,
    ],
  );

  // Release the bot-direct send pipeline's busy lock when the stream
  // settles, so the next send is not misclassified as a duplicate turn.
  useEffect(() => {
    if (!activeThreadId || isStreaming) return;
    if (resolveChatMode(activeThreadId) === 'bot-direct') {
      botDirectSendComplete(activeThreadId);
    }
  }, [activeThreadId, isStreaming]);

  // Plan 500 P2.2 — main hands a queued user turn to the renderer when its
  // lane slot arrives. Exactly one window claims it (IPC CAS inside
  // subscribeScheduledTurns); the claiming window runs the turn through the
  // normal streaming path. The ref keeps the subscription stable while the
  // handler closure stays fresh.
  const scheduledTurnHandlerRef = useRef<(push: { sessionId: string; agentId: string; messageId: string; text: string }) => void>(() => {});
  scheduledTurnHandlerRef.current = (push) => {
    const pending = takePendingTurn(push.messageId);
    const content = pending?.content ?? push.text;
    const alreadyRendered = (messages[push.sessionId] ?? []).some(
      (m) => m.id === push.messageId,
    );
    if (!alreadyRendered) {
      addMessage(
        push.sessionId,
        {
          id: push.messageId,
          role: 'user',
          content,
          displayContent: pending?.displayContent,
          timestamp: Date.now(),
          metadata: { optimistic: true },
        },
        { persist: false },
      );
    }
    setMessageDelivery(push.sessionId, push.messageId, 'sending');
    setIsStreaming(true);
    if (pending?.start) {
      pending.start();
      return;
    }
    // Queued from another window (or before a reload): start with session
    // defaults — the server binds the profile from the bot session id.
    void startStream({
      sessionId: push.sessionId,
      content,
      language: settings.agentLanguage,
      permissionModeOverride: 'auto' as const,
      agentProfileId: push.agentId,
      titleGenerationModel: settings.titleGenerationModel,
      defaultWorkspaceDirectory: settings.workspaceDir,
    });
  };
  useEffect(() => {
    return subscribeScheduledTurns((push) => scheduledTurnHandlerRef.current(push));
  }, []);

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
      // Plan 500: queued bot turns also live on the main wake queue.
      if (resolveChatMode(activeThreadId) === 'bot-direct') {
        cancelPendingTurnsForSession(activeThreadId);
      }
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

  // Plan 497 — bot↔bot DM pair view (sibling of BotDirectChatView, same
  // app container; the chip hands over, the back arrow returns). Null = the
  // bot chat itself. Reset on thread switch so a peer never lingers.
  const [botDmPairPeer, setBotDmPairPeer] = useState<{ peerId: string; peerName: string } | null>(
    null,
  );
  useEffect(() => {
    setBotDmPairPeer(null);
  }, [activeThreadId]);
  const activeBotAgentId = activeThreadId ? resolveBotAgentId(activeThreadId) : null;
  // The pair view header needs the CURRENT bot's identity (name/avatar);
  // resolved from the same roster the bot chat header uses.
  const allContacts = useBotContacts().allContacts;
  const activeBotContact = activeBotAgentId
    ? allContacts.find((c) => c.agentId === activeBotAgentId) ?? null
    : null;
  const botDirectIdentity = {
    name: activeBotContact?.name ?? activeBotAgentId ?? '',
    avatarUrl: activeBotContact?.avatarUrl,
    avatarColor: activeBotContact?.avatarColor,
    avatarEmoji: activeBotContact?.avatarEmoji,
  };

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
          {currentView === 'chat' && resolveChatMode(activeThreadId) === 'bot-direct' && botDmPairPeer && activeBotAgentId && (
            <AgentDmPairView
              key={`${activeThreadId}:${botDmPairPeer.peerId}`}
              selfAgentId={activeBotAgentId}
              sessionId={activeThreadId}
              selfName={botDirectIdentity.name}
              selfAvatarUrl={botDirectIdentity.avatarUrl}
              selfAvatarColor={botDirectIdentity.avatarColor}
              peerId={botDmPairPeer.peerId}
              peerName={botDmPairPeer.peerName}
              onBack={() => setBotDmPairPeer(null)}
            />
          )}
          {currentView === 'chat' && resolveChatMode(activeThreadId) === 'bot-direct' && !botDmPairPeer && (
            <BotDirectChatView
              key={activeThreadId}
              sessionId={activeThreadId}
              messages={threadMessages}
              isStreaming={isStreaming}
              isFinalizing={isFinalizing}
              onSend={handleBotDirectSend}
              onStop={handleInterrupt}
              onOpenDmPair={(peerId, peerName) => setBotDmPairPeer({ peerId, peerName })}
            />
          )}
          {currentView === 'chat' && resolveChatMode(activeThreadId) === 'room' && (
            // Plan 478 P3.1: shared-room surface — self-contained (own
            // transcript hook + composer), the workspace pipeline and
            // ChatView never mount for `room:` sessions.
            <GroupRoomChatView key={activeThreadId} sessionId={activeThreadId} />
          )}
          {currentView === 'chat' && resolveChatMode(activeThreadId) === 'workspace' && (
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
        <SearchCommandPalette />
        {bootPhase !== "hidden" && (
          <StartupLanding phase={bootPhase} status={bootStatus} />
        )}
      </FontProvider>
    </I18nProvider>
  );
}
