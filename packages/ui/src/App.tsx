import { lazy, Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
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
import type { BotDirectSendPayload } from "@/components/chat/BotDirectChatView";
import { composeReplyContent } from "@/components/chat/bot/reply";
import { WelcomeView } from "@/components/home/WelcomeView";
import { AppShell } from "@/components/layout/app-shell";
import { I18nProvider } from "@/components/layout/I18nProvider";
import { StartupLanding, type StartupLandingPhase } from "@/components/StartupLanding";
import { ensureSession, startStream, stopStream, subscribeSession, getSnapshot, setToolTimeoutCallback, canSend, enqueueMessage, clearQueuedMessages, hasQueuedMessages } from "@/lib/stream-session-manager";
import { useSettings } from "@/hooks/useSettings";
import type { Message, StreamPhase, FileAttachment } from "@/types/message";
import type { PermissionRequestEvent } from "@/types/stream";
import {
  dbMessageToMessage,
  isBotDirectVisibleSource,
  type DbMessage as DbMessageRow,
} from "@/lib/ipc-client";
import { stripPastedContentMarkers } from "@/lib/message-content-parser";
import { interruptChat } from "@/lib/agent-sse-client";
import { SearchCommandPalette } from "@/components/SearchCommandPalette";
import { UiServicesProvider } from "@/hooks/useUiServices";
import { getUiServices, type UiServices } from "@/services";
import { WorkspaceLifecycleProvider } from "@/hooks/useWorkspaceLifecycle";
import { peekWorkspaceLifecycle } from "@/services";
import type { UiRunSession } from "@/services/ui-services";
import type { RunSessionSnapshot } from "@duya/client-core";
import type { HostPermissionRequest } from "@duya/agent-protocol";
import { mergeRunSessionRows } from "@/lib/run-session-view";
import { RunAttachmentGate } from "@/lib/run-attachment-gate";

/**
 * Surfaces the user reaches through an explicit click are loaded on demand.
 *
 * They used to be static imports, so the whole settings, workflow,
 * projects, extensions, automation, skills and new-chat trees rode along in
 * the startup chunk: the renderer downloaded and evaluated all of them
 * before the composer was interactive, even though the first screen is the
 * home / chat surface. A lazy boundary stops the static module graph at the
 * view, so the startup chunk carries only what the first screen renders.
 *
 * The chat surfaces (`ChatView`, `BotDirectChatView`, `GroupRoomChatView`)
 * stay eager on purpose: `activeThreadId` and `currentView` are persisted,
 * so a returning user lands straight in a session and the chat IS the first
 * screen. Lazy-loading those would push the composer further away, not
 * closer.
 *
 * The `Suspense` fallback is null, matching the pattern already used for
 * the onboarding flow (`components/layout/app-shell.tsx`): the shell around
 * the surface stays mounted, only the surface that is still loading is
 * absent.
 */
const NewChatView = lazy(() => import("@/components/chat/NewChatView").then((m) => ({ default: m.NewChatView })));
const SkillsView = lazy(() => import("@/components/skills/SkillsView").then((m) => ({ default: m.SkillsView })));
const AutomationView = lazy(() => import("@/components/automation/AutomationView").then((m) => ({ default: m.AutomationView })));
const WorkflowPage = lazy(() => import("@/components/workflow/WorkflowPage").then((m) => ({ default: m.WorkflowPage })));
const ProjectsView = lazy(() => import("@/components/projects/ProjectsView").then((m) => ({ default: m.ProjectsView })));
const ExtensionsPage = lazy(() => import("@/components/extensions/ExtensionsPage").then((m) => ({ default: m.ExtensionsPage })));
const MiniAppsView = lazy(() => import("@/components/plugin-apps/MiniAppsView").then((m) => ({ default: m.MiniAppsView })));
const SettingsView = lazy(() => import("@/components/settings/SettingsView").then((m) => ({ default: m.SettingsView })));

/** Boot splash lifecycle. Re-exported from StartupLanding for convenience. */
type BootSplashPhase = StartupLandingPhase;

interface WorkflowRunNavigationRequest {
  runId: string;
  nodeId?: string;
}

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

function CapabilityUnavailable({ title }: { title: string }) {
  return (
    <section className="flex h-full min-h-0 items-center justify-center p-8" role="status">
      <div className="max-w-lg text-center">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          当前 Web Host 尚未提供此功能。请在桌面端继续使用。
        </p>
      </div>
    </section>
  );
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
  const uiServices = resolveUiServices();
  // The workspace-lifecycle port (plan 621). A surface that installed no
  // adapter has no checkout / pull-request questions to answer; the provider
  // carries `null` so the panel says "this surface cannot answer" instead of
  // pretending the session has no checkout.
  const workspaceLifecycle = peekWorkspaceLifecycle();
  const app = (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <WorkspaceLifecycleProvider port={workspaceLifecycle}>
          <AppShellInner onReady={onReady} uiServices={uiServices} />
        </WorkspaceLifecycleProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  return uiServices === null ? app : (
    <UiServicesProvider services={uiServices}>{app}</UiServicesProvider>
  );
}

function resolveUiServices(): UiServices | null {
  try {
    return getUiServices();
  } catch (error) {
    // The existing Desktop shell continues through its established preload
    // adapter until its Host migration is complete. Browser entry points must
    // configure an explicit Host adapter before mounting this shared App.
    if (typeof window !== "undefined" && window.electronAPI) return null;
    if (import.meta.env.MODE === "test") return null;
    throw error;
  }
}

function AppShellInner({ onReady, uiServices }: { onReady?: () => void; uiServices: UiServices | null } = { uiServices: null }) {
  // Actions: stable references via useShallow — avoids re-renders when
  // the store returns new references for other (unrelated) state fields.
  const {
    setActiveThread,
    setCurrentView,
    addMessage,
    loadThreadMessages,
    updateThreadTitle,
  } = useConversationStore(
    useShallow((s) => ({
      setActiveThread: s.setActiveThread,
      setCurrentView: s.setCurrentView,
      addMessage: s.addMessage,
      loadThreadMessages: s.loadThreadMessages,
      updateThreadTitle: s.updateThreadTitle,
    }))
  );

  // State: individual field subscriptions to avoid subscribing to the
  // entire store. threadMessages is derived here so only the active
  // thread's message-array changes trigger re-renders of child ChatViews.
  const { currentView, isHydrated, isNewChatDrafting, newChatSourceSessionId, activeThreadId, messages } =
    useConversationStore(
      useShallow((s) => ({
        currentView: s.currentView,
        isHydrated: s.isHydrated,
        isNewChatDrafting: s.isNewChatDrafting,
        newChatSourceSessionId: s.newChatSourceSessionId,
        activeThreadId: s.activeThreadId,
        messages: s.messages,
      }))
    );
  const selectedThreadRef = useRef(activeThreadId);
  const selectionLeaseRef = useRef(0);
  if (selectedThreadRef.current !== activeThreadId) {
    selectedThreadRef.current = activeThreadId;
    selectionLeaseRef.current += 1;
  }

  const [workflowRunRequest, setWorkflowRunRequest] = useState<WorkflowRunNavigationRequest | null>(null);
  const consumeWorkflowRunRequest = useCallback(() => setWorkflowRunRequest(null), []);

  useEffect(() => {
    const openWorkflowRun = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: unknown; nodeId?: unknown }>).detail;
      const runId = typeof detail?.runId === 'string' ? detail.runId.trim() : '';
      const nodeId = typeof detail?.nodeId === 'string' ? detail.nodeId.trim() : '';
      if (!runId) return;
      setWorkflowRunRequest({ runId, ...(nodeId ? { nodeId } : {}) });
      setCurrentView('workflow');
    };

    window.addEventListener('duya:open-workflow-run-panel', openWorkflowRun as EventListener);
    window.addEventListener('duya:open-workflow-node-panel', openWorkflowRun as EventListener);
    return () => {
      window.removeEventListener('duya:open-workflow-run-panel', openWorkflowRun as EventListener);
      window.removeEventListener('duya:open-workflow-node-panel', openWorkflowRun as EventListener);
    };
  }, [setCurrentView]);

  const [hostRunSnapshot, setHostRunSnapshot] = useState<RunSessionSnapshot | null>(null);
  const [hostLedgerPermission, setHostLedgerPermission] = useState<HostPermissionRequest | null>(null);
  const [hostSendError, setHostSendError] = useState<string | null>(null);
  const hostRunSessionRef = useRef<UiRunSession | null>(null);
  const hostRunIdRef = useRef<string | null>(null);
  const hostRunAbortRef = useRef<AbortController | null>(null);
  const runAttachmentGateRef = useRef(new RunAttachmentGate());
  const bindHostRun = useCallback((runId: string, sessionId: string, lease: number) => {
    const isCurrentSelection = () => selectedThreadRef.current === sessionId && selectionLeaseRef.current === lease;
    if (!isCurrentSelection() || !uiServices) return () => {};
    hostRunAbortRef.current?.abort();
    hostRunSessionRef.current?.stop();
    const abort = new AbortController();
    hostRunAbortRef.current = abort;
    hostRunIdRef.current = runId;
    const runSession = uiServices.runs.openSession(runId, sessionId, abort.signal);
    hostRunSessionRef.current = runSession;
    const initialSnapshot = runSession.getSnapshot();
    if (isCurrentSelection()) {
      setHostRunSnapshot(initialSnapshot);
      const durableStatus = runSession.getDurableStatus();
      setIsStreaming(durableStatus === null || durableStatus === 'running');
    }
    const unsubscribe = runSession.subscribe(() => {
      const snapshot = runSession.getSnapshot();
      if (!isCurrentSelection()) return;
      setHostRunSnapshot(snapshot);
      const durableStatus = runSession.getDurableStatus();
      setIsStreaming(durableStatus === null || durableStatus === 'running');
    });
    runSession.start();
    void runSession.settled().finally(() => {
      if (hostRunSessionRef.current !== runSession) return;
      const durableStatus = runSession.getDurableStatus();
      if (durableStatus === 'completed') {
        setHostSendError(null);
      } else if (durableStatus === 'cancelled') {
        setHostSendError('The Host confirmed that this run was cancelled.');
      } else if (durableStatus === 'failed') {
        setHostSendError('The Host recorded this run as failed.');
      } else if (durableStatus === 'budget_exhausted') {
        setHostSendError('The Host stopped this run after it exhausted its budget.');
      } else {
        // Stream completion alone is not proof of durable settlement.
        setHostSendError('The Host has not confirmed a terminal run status.');
      }
      void loadThreadMessages(sessionId, { force: true }).finally(() => {
        if (hostRunSessionRef.current !== runSession || !isCurrentSelection()) return;
        // Keep the authoritative terminal projection mounted so tool cards and
        // interleaved assistant rows remain visible after the live stream ends.
        setIsStreaming(false);
      });
    });
    return () => {
      unsubscribe();
      abort.abort();
      runSession.stop();
    };
  }, [loadThreadMessages, uiServices]);

  useEffect(() => {
    if (!uiServices || !activeThreadId) {
      setHostRunSnapshot(null);
      hostRunIdRef.current = null;
      return;
    }
    setIsStreaming(false);
    setHostSendError(null);
    setHostRunSnapshot(null);
    hostRunIdRef.current = null;
    const lease = selectionLeaseRef.current;
    const restoreGeneration = runAttachmentGateRef.current.beginRestore();
    const abort = new AbortController();
    let dispose: (() => void) | undefined;
    void uiServices.runs.listBySession(activeThreadId).then((runs) => {
      if (abort.signal.aborted || !runAttachmentGateRef.current.isCurrent(restoreGeneration) ||
          selectionLeaseRef.current !== lease || selectedThreadRef.current !== activeThreadId) return;
      const run = [...runs].sort((a, b) => a.createdAt - b.createdAt).at(-1);
      if (!run) {
        setHostRunSnapshot(null);
        return;
      }
      dispose = bindHostRun(run.runId, activeThreadId, lease);
    }).catch(() => {
      if (!abort.signal.aborted && runAttachmentGateRef.current.isCurrent(restoreGeneration) &&
          selectionLeaseRef.current === lease && selectedThreadRef.current === activeThreadId) {
        setHostRunSnapshot(null);
      }
    });
    return () => {
      abort.abort();
      dispose?.();
      if (hostRunSessionRef.current) {
        hostRunSessionRef.current.stop();
        hostRunSessionRef.current = null;
      }
    };
  }, [activeThreadId, bindHostRun, uiServices]);

  useEffect(() => {
    if (!uiServices || !activeThreadId) {
      setHostLedgerPermission(null);
      return;
    }
    const lease = selectionLeaseRef.current;
    const controller = new AbortController();
    const refresh = () => {
      void uiServices.approvals.listPending(activeThreadId).then((requests) => {
        if (controller.signal.aborted || selectionLeaseRef.current !== lease || selectedThreadRef.current !== activeThreadId) return;
        setHostLedgerPermission(requests.find((request) => request.sessionId === activeThreadId) ?? null);
      }).catch(() => {
        if (!controller.signal.aborted && selectionLeaseRef.current === lease && selectedThreadRef.current === activeThreadId) {
          setHostLedgerPermission(null);
        }
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 1_500);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeThreadId, uiServices]);

  const threadMessages = useMemo(() => {
    const durable = activeThreadId ? messages[activeThreadId] ?? [] : [];
    if (!uiServices || hostRunSnapshot?.sessionId !== activeThreadId) return durable;
    return mergeRunSessionRows(durable, hostRunSnapshot);
  }, [activeThreadId, hostRunSnapshot, messages, uiServices]);
  const hostPermission = useMemo(() => {
    const permission = hostRunSnapshot?.permissions.find((item) => item.awaitingAnswer);
    if (permission) {
      const mode: PermissionRequestEvent['mode'] = permission.mode === 'ask_user_question' || permission.toolName === 'AskUserQuestion'
      ? 'ask_user_question'
      : permission.mode === 'exit_plan_mode' || permission.toolName === 'ExitPlanMode'
        ? 'exit_plan_mode'
        : 'generic';
      return {
        id: permission.requestId,
        toolName: permission.toolName,
        toolInput: { ...permission.toolInput },
        mode,
        expiresAt: permission.expiresAt,
        ...(permission.reason ? { decisionReason: permission.reason } : {}),
      };
    }
    const ledgerPermission = hostLedgerPermission;
    if (!ledgerPermission || ledgerPermission.status !== 'pending') return null;
    // The record now carries the worker's own mode, reason and deadline.
    // The tool-name inference stays as the fallback for records written
    // before those columns existed — a name is a guess, and a guess is
    // only better than nothing.
    const mode: PermissionRequestEvent['mode'] = ledgerPermission.mode === 'ask_user_question' || ledgerPermission.toolName === 'AskUserQuestion'
      ? 'ask_user_question'
      : ledgerPermission.mode === 'exit_plan_mode' || ledgerPermission.toolName === 'ExitPlanMode'
        ? 'exit_plan_mode'
        : 'generic';
    const decisionReason = ledgerPermission.reason ?? ledgerPermission.message ?? undefined;
    return {
      id: ledgerPermission.id,
      toolName: ledgerPermission.toolName,
      toolInput: { ...(ledgerPermission.toolInput ?? {}) },
      mode,
      expiresAt: ledgerPermission.expiresAt ?? Number.MAX_SAFE_INTEGER,
      ...(decisionReason ? { decisionReason } : {}),
    };
  }, [hostLedgerPermission, hostRunSnapshot]);
  const respondToHostPermission = useCallback((decision: 'allow' | 'allow_session' | 'deny') => {
    if (!uiServices || !hostPermission) return;
    void uiServices.approvals.resolve(hostPermission.id, {
      status: decision === 'deny' ? 'deny' : 'allow',
      decision,
    }).catch((error: unknown) => {
      setHostSendError(error instanceof Error ? error.message : 'The Host could not resolve this approval.');
    });
  }, [hostPermission, uiServices]);
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
    if (uiServices || !activeThreadId) return;

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
  }, [activeThreadId, loadThreadMessages, uiServices]);

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
          isCompactSummary: m.isCompactSummary ?? undefined,
          compactBoundaryId: m.compactBoundaryId ?? undefined,
          compactedMessageCount: m.compactedMessageCount ?? undefined,
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

      if (uiServices) {
        if (files?.length) {
          setHostSendError('Attachments are not available for this Host connection yet. Remove the attachments and try again.');
          return;
        }
        setHostSendError(null);
        const thread = useConversationStore.getState().threads.find((item) => item.id === activeThreadId);
        const title = deriveProvisionalTitle(plainContent);
        if (thread && DEFAULT_THREAD_TITLES.has(thread.title) && title) {
          updateThreadTitle(activeThreadId, title, { sync: false });
          void uiServices.sessions.update(activeThreadId, thread.updatedAt, { title }).then((result) => {
            if (!result.updated) {
              setHostSendError('The Host session changed before its title could be saved.');
            }
          }).catch((error: unknown) => {
            setHostSendError(error instanceof Error ? error.message : 'The Host could not save the session title.');
          });
        }
        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content,
          displayContent,
          timestamp: Date.now(),
          metadata: { optimistic: true },
        };
        // The Host already owns this selected session. The store's legacy
        // first-message title sync would route it through createThreadIPC,
        // incorrectly requiring a source workspace binding and treating the
        // existing Host session as a new Web-created session.
        addMessage(activeThreadId, userMessage, { persist: false, syncTitle: false, updateTitle: false });
        // A delayed listBySession restore for this same selection must never
        // replace the run this send is about to start.
        runAttachmentGateRef.current.invalidateRestores();
        setIsStreaming(true);
        const sendLease = selectionLeaseRef.current;
        // The turn's CONFIGURATION travels with the request, not just its text.
        // The Host adjudicates the permission mode, the agent profile and the
        // declared modes the same way it does for the legacy path, so a turn
        // that names them runs under the rules the user picked. Leaving them
        // out would run the turn under the Host's defaults and say nothing.
        const hostPermissionMode = permissionMode === 'bypass' ? 'bypassPermissions'
          : permissionMode === 'ask' ? 'default'
            : 'acceptEdits';
        void uiServices.runs.start({
          sessionId: activeThreadId,
          prompt: plainContent,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(thread?.providerId ? { providerId: thread.providerId } : {}),
          ...(permissionMode ? { permissionMode: hostPermissionMode } : {}),
          ...(agentProfileId !== undefined ? { agentProfileId } : {}),
          ...(mode ? { modes: [mode] } : {}),
        }).then((result) => {
          if (selectionLeaseRef.current !== sendLease || selectedThreadRef.current !== activeThreadId) return;
          if (!result.accepted) {
            setIsStreaming(false);
            setHostSendError(`The Host could not start this run: ${result.reason}`);
            return;
          }
          bindHostRun(result.runId, activeThreadId, sendLease);
        }).catch((error: unknown) => {
          if (selectionLeaseRef.current !== sendLease || selectedThreadRef.current !== activeThreadId) return;
          setIsStreaming(false);
          setHostSendError(error instanceof Error ? error.message : 'The Host could not start this run.');
        });
        return;
      }

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
      const permissionModeOverride = permissionMode === 'bypass' ? 'bypassPermissions'
        : permissionMode === 'ask' ? 'default'
        : 'auto';

      if (queuedMailboxId || !canSend(activeThreadId)) {
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
        // Persisted user row reuses this id so the merge dedupes the
        // optimistic bubble by id even when the worker persists late.
        clientMsgId: userMsgId,
        titleGenerationModel: settings.titleGenerationModel,
        defaultWorkspaceDirectory: settings.workspaceDir,
        providerId: sessionProviderId,
        effort,
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
    [activeThreadId, addMessage, bindHostRun, settings.titleGenerationModel, uiServices, updateThreadTitle],
  );

  // Plan 491 P1.1 / 477 P3.1: dedicated bot-direct send path. The workspace
  // handleSendMessage would work for message transport, but the bot session
  // needs (a) agentProfileId carried so the worker loads the bot identity +
  // toolset + prompt (the server force-overrides it for bot sessions anyway),
  // (b) the nonce-dedup + preemption pipeline from the 491 send module, and
  // (c) per-message delivery phases in the conversation store.
  const setMessageDelivery = useConversationStore((s) => s.setMessageDelivery);
  const handleBotDirectSend = useCallback(
    (payload: BotDirectSendPayload) => {
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
          // Persisted user row reuses the optimistic id so the merge
          // dedupes by id, even for a turn queued on the wake lane.
          clientMsgId: messageId,
        });
      };

      void (async () => {
        let action: 'start' | 'queued' | 'accepted' = 'start';
        try {
          const gate = await window.electronAPI?.botTurn?.sendTurn({
            agentId,
            text: content,
            clientMsgId: messageId,
            attachments: files,
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
        if (action === 'accepted') {
          // The durable Host inbox owns this turn from acceptance onward.
          // Keep the optimistic bubble queued, without registering the legacy
          // renderer-claim callback that would start a second executor.
          setMessageDelivery(activeThreadId, messageId, 'queued');
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
      // Persisted user row reuses the optimistic id so the merge dedupes by id.
      clientMsgId: push.messageId,
    });
  };
  useEffect(() => {
    return subscribeScheduledTurns((push) => scheduledTurnHandlerRef.current(push));
  }, []);

  const handleInterrupt = useCallback(() => {
    if (!activeThreadId) return;
    if (uiServices && hostRunIdRef.current && hostRunSessionRef.current?.getSnapshot().sessionId === activeThreadId) {
      const runId = hostRunIdRef.current;
      const cancelLease = selectionLeaseRef.current;
      void uiServices.runs.cancel(runId).then((result) => {
        if (selectionLeaseRef.current !== cancelLease || selectedThreadRef.current !== activeThreadId) return;
        if (!result.requested) setHostSendError(`The Host could not cancel this run: ${result.reason}`);
      }).catch((error: unknown) => {
        if (selectionLeaseRef.current !== cancelLease || selectedThreadRef.current !== activeThreadId) return;
        setHostSendError(error instanceof Error ? error.message : 'The Host could not cancel this run.');
      });
      return;
    }
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
  }, [activeThreadId, isStreaming, uiServices]);

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
    avatarColor: activeBotContact?.avatarColor,
  };

  // Workflow library「通过对话创建」: prefill a new-chat draft with the creation
  // prompt (never auto-send, ZCode parity) and land in the new-chat composer,
  // optionally preset to the owning project so the session runs in its cwd.
  const { t } = useTranslation();
  const handleCreateWorkflowViaConversation = useCallback(
    (scope: 'global' | 'project', projectDir?: string) => {
      const store = useConversationStore.getState();
      store.updateNewChatDraft({
        text: t(scope === 'global' ? 'workflow.create.prompt.global' : 'workflow.create.prompt.project'),
        attachments: [],
        hasContent: true,
      });
      store.startNewChat(
        projectDir
          ? {
              workingDirectory: projectDir,
              projectName: projectDir.split(/[\\/]/).pop() || projectDir,
            }
          : undefined,
      );
    },
    [t],
  );

  const renderView = () => {
    if (uiServices) {
      const capabilityByView: Partial<Record<string, keyof UiServices['capabilities']>> = {
        apps: 'extensions',
        skills: 'extensions',
        automation: 'automation',
        workflow: 'workflows',
        projects: 'localFileAccess',
        settings: 'settings',
        extensions: 'extensions',
      };
      const requiredCapability = capabilityByView[currentView];
      if (requiredCapability && !uiServices.capabilities[requiredCapability]) {
        return <CapabilityUnavailable title="此功能暂不可用" />;
      }
      // A surface that can register a directory may always start a
      // conversation. One that cannot needs a session whose workspace the Host
      // has already bound — the worker still needs somewhere to run.
      const canStartConversation = uiServices.registerWorkspace !== undefined;
      if (!canStartConversation && !activeThreadId && !newChatSourceSessionId &&
          (currentView === 'chat' || currentView === 'home' || isNewChatDrafting)) {
        return <CapabilityUnavailable title="尚无已授权的工作区会话" />;
      }
      if (currentView === 'chat' && !uiServices.capabilities.bots && resolveChatMode(activeThreadId) !== 'workspace') {
        return <CapabilityUnavailable title="机器人和共享房间暂不可用" />;
      }
    }

    // Lazy new-chat composer: no backing thread yet. Shown before the user
    // sends anything, so an unsent draft never appears in the sidebar.
    if (isNewChatDrafting) {
      // The folder picker needs a surface that can turn a directory into a
      // workspace binding. A Host-backed surface that can register one may
      // offer it; one that cannot would collect a path it could not use.
      const canPickWorkspace = uiServices === null || uiServices.registerWorkspace !== undefined;
      return <NewChatView onSendMessage={handleSendMessage} workspaceSelectionEnabled={canPickWorkspace} />;
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
              hostRunActive={uiServices !== null && (hostRunSnapshot?.run.status === 'pending' || hostRunSnapshot?.run.status === 'running')}
              hostSendError={hostSendError}
              hostPermission={hostPermission}
              onHostPermissionResponse={respondToHostPermission}
              allowPermissionModeChange={uiServices?.capabilities.turnConfiguration !== false}
              hasQueuedMessages={hasQueuedMessages(activeThreadId)}
              onLivePermissionChange={uiServices === null ? (mode) => {
                // The legacy path persists the mode on the session row through
                // the Electron channel. A Host-backed surface carries the mode
                // with the TURN instead, so there is nothing to persist here.
                const agentMode = mode === 'bypass' ? 'bypassPermissions' : mode === 'ask' ? 'default' : 'auto';
                void window.electronAPI?.agent?.setAgentPermissionMode(activeThreadId, agentMode);
              } : undefined}
            />
          )}
          {currentView === 'skills' && <SkillsView />}
          {currentView === 'automation' && <AutomationView />}
          {currentView === 'workflow' && (
            <WorkflowPage
              onCreateViaConversation={handleCreateWorkflowViaConversation}
              runRequest={workflowRunRequest}
              onRunRequestConsumed={consumeWorkflowRunRequest}
            />
          )}
          {currentView === 'projects' && <ProjectsView />}
          {currentView === 'apps' && <MiniAppsView />}
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
      case 'automation':
        return <AutomationView />;
      case 'workflow':
        return (
          <WorkflowPage
            onCreateViaConversation={handleCreateWorkflowViaConversation}
            runRequest={workflowRunRequest}
            onRunRequestConsumed={consumeWorkflowRunRequest}
          />
        );
      case 'projects':
        // Plan 525 Phase 2: Projects page must be reachable even when no
        // session has ever been mounted (chatEverMountedRef stays false on
        // a brand-new install). The `shouldRenderChat` branch above also
        // routes `projects`, so this only fires on first-launch paths.
        return <ProjectsView />;
      case 'apps':
        return <MiniAppsView />;
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
      {/* The lazily loaded surfaces suspend here. Only one view is rendered
          at a time, so the boundary never takes the eager content down
          with it. */}
      <AppShell capabilities={uiServices?.capabilities}>
        <Suspense fallback={null}>{renderView()}</Suspense>
      </AppShell>
      <SearchCommandPalette />
      {bootPhase !== "hidden" && (
        <StartupLanding phase={bootPhase} status={bootStatus} />
      )}
    </I18nProvider>
  );
}
