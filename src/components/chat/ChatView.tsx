// ChatView.tsx - Main chat container component (CodePilot style)

'use client';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '@/hooks/useTranslation';
import type { Message } from '@/types';
import { MessageList, type MessageListRef } from './MessageList';
import { MessageInput } from './MessageInput';
import { GoalStatusChip } from './GoalStatusChip';
import { PermissionPrompt } from './PermissionPrompt';
import { ConnectorAuthRequiredCard } from './ConnectorAuthRequiredCard';
import { getAppConnectionAPI } from '@/lib/app-connection-ipc';
import { usePermissions } from '@/hooks/usePermissions';
import { useNextStepSuggestions } from '@/hooks/useNextStepSuggestions';
import { dispatchPrefillChatInput } from '@/lib/prefill-chat-input-event';
import { subscribeToPermissions, subscribeToPhase, subscribeToModeChanged, subscribeToConnectorAuthRequired, clearConnectorAuthRequired, attachToExistingStream, getSnapshot, type ConnectorAuthRequiredData } from '@/lib/stream-session-manager';
import { getAgentServerClient } from '@/lib/agent-http-client';
import { InfoIcon, CaretDownIcon } from '@/components/icons';
import { ChatHeader } from './ChatHeader';
import { DB_DEFAULT_MODEL } from '@/lib/constants';
import { getThreadIPC, updateThreadIPC, getProviderIPC, getModelCapabilityIPC } from '@/lib/ipc-client';
import type { ModelPricing } from '@/lib/context-usage-utils';
import { useSettings } from '@/hooks/useSettings';
import { usePolling } from '@/hooks/usePolling';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingError } from '@/hooks/useStreamingError';
import { useConversationStore } from '@/stores/conversation-store';
import { useContextUsageStore } from '@/stores/context-usage-store';
import { useCompactionStore } from '@/stores/compaction-store';
import { useMailboxStore } from '@/stores/mailbox-store';
import { useBusyMessageModeValue } from '@/stores/busy-message-mode-store';
import { useShallow } from 'zustand/react/shallow';
import type { MailboxRow } from '@/stores/mailbox-store';
import type { FileAttachment } from '@/types/message';
import { MailboxPanel } from './MailboxPanel';
import { compactContext } from '@/lib/agent-sse-client';
import { projectMessageTranscript } from '@/lib/project-message-transcript';
import { getProfileIdForMode } from './AgentModeSelector';
import { AgentProfileBadge } from './AgentProfileBadge';
import { ContextUsageRing } from './ContextUsageRing';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionSelector } from '@/components/home/SessionSelector';
import { InputDialog } from '@/components/ui/InputDialog';
import { Button } from '@/components/ui/Button';
import { TaskDrawer } from '@/components/layout/TaskDrawer';
import { useTaskDrawerOpen } from '@/components/layout/task-drawer-store';
import { useTaskList } from '@/hooks/useTaskList';
import { useGitStatus } from '@/hooks/useGitStatus';
import { getGitStatus, getGitLatestTurnReview } from '@/lib/git-ipc';
import type { GitTurnReview } from '@/lib/git-ipc';
import type { UseGitStatusResult } from '@/hooks/useGitStatus';
import { useOptionalPanel } from '@/hooks/usePanel';
import { useConductorStore } from '@duya/conductor/renderer/stores/conductor-store';
import type { ConductorCanvas } from '@duya/conductor/renderer/types/conductor';

export type PermissionModeUi = 'ask' | 'auto' | 'bypass';

/** Session-row `permission_profile` → composer selector mode. Unknown values fall back to Auto. */
function permissionProfileToUi(profile: string | null | undefined): PermissionModeUi {
  if (profile === 'default') return 'ask';
  if (profile === 'full_access') return 'bypass';
  return 'auto';
}

/** Composer selector mode → session-row `permission_profile`. */
function permissionModeUiToProfile(mode: PermissionModeUi): string {
  return mode === 'bypass' ? 'full_access' : mode === 'ask' ? 'default' : 'auto';
}

interface ChatViewProps {
  sessionId: string;
  messages: Message[];
  /**
   * The user-chosen permission mode (Ask/Auto/Bypass) rides along on each send
   * as a per-turn override; a live change mid-work is applied to the running
   * agent through `onLivePermissionChange`.
   */
  onSendMessage: (content: string, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string, conductorMode?: boolean, queuedMailboxId?: string, permissionMode?: 'ask' | 'auto' | 'bypass') => void;
  /** Live mid-run permission switch, forwarded to the running agent. */
  onLivePermissionChange?: (mode: 'ask' | 'auto' | 'bypass') => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
  /** The final persisted reply is loading; keep the existing stream view until it arrives. */
  isFinalizing?: boolean;
  hasQueuedMessages?: boolean;
}

const NOOP_OPEN_PANEL = () => '';
const NOOP_CLOSE_PANEL = () => {};

// Hoisted (plan 236 Phase 5) so the sub-agent / background-stream poll timers
// don't allocate a fresh Set on every interval tick.
const ACTIVE_STREAM_PHASES = new Set<string>([
  'starting',
  'streaming',
  'tool_use',
  'awaiting_permission',
  'persisting',
]);

function WorkspaceComposerLayer({
  expanded,
  children,
}: {
  expanded: boolean;
  children: React.ReactNode;
}) {
  const [host, setHost] = useState<Element | null>(null);

  useEffect(() => {
    setHost(expanded ? document.querySelector('.app-workspace-row') : null);
  }, [expanded]);

  return expanded && host ? createPortal(children, host) : children;
}

/**
 * Context compression notification toast
 */
function ContextCompressionToast({ message }: { message: string }) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300">
      <div className="flex items-center gap-2 px-4 py-2 bg-blue-500/90 text-white text-sm rounded-lg shadow-lg backdrop-blur-sm">
        <InfoIcon size={16} />
        <span>{message}</span>
      </div>
    </div>
  );
}

export function ChatView({
  sessionId,
  messages,
  onSendMessage,
  onLivePermissionChange,
  onInterrupt,
  isStreaming = false,
  isFinalizing = false,
  hasQueuedMessages = false,
}: ChatViewProps) {
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const [compressionNotification, setCompressionNotification] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [sessionProviderId, setSessionProviderId] = useState<string>('');
  // Per-model `contextWindow` resolved from the
  // `provider_model_capabilities` table. The user toggles this via the
  // 200K/1M buttons on the provider edit page; without this hook the
  // ContextUsageRing falls back to a hardcoded 200K for any minimax-*
  // model id, which silently hides 1M sessions.
  const [capabilityContextWindow, setCapabilityContextWindow] = useState<number | undefined>(undefined);
  const [capabilityPricing, setCapabilityPricing] = useState<ModelPricing | undefined>(undefined);
  const [agentProfileId, setAgentProfileId] = useState<string | null>(getProfileIdForMode('main'));
  const [effort, setEffortState] = useState<string | undefined>(settings.defaultThinkingEffort ?? undefined);
  // Permission mode restored as a composer selector (Ask / Auto / Bypass).
  // Defaults to Auto (workspace-trust) to preserve the previous behavior.
  // The choice is persisted to the session row (permission_profile) so it
  // survives session switches and is the worker's durable default.
  const [permissionMode, setPermissionMode] = useState<'ask' | 'auto' | 'bypass'>('auto');
  const handlePermissionModeChange = useCallback((mode: 'ask' | 'auto' | 'bypass') => {
    setPermissionMode(mode);
    onLivePermissionChange?.(mode);
    updateThreadIPC(sessionId, { permissionProfile: permissionModeUiToProfile(mode) }).catch(console.error);
  }, [onLivePermissionChange, sessionId]);

  // Sync effort from settings when settings load for the first time.
  useEffect(() => {
    setEffortState(settings.defaultThinkingEffort ?? undefined);
  }, [settings.defaultThinkingEffort]);

  const setEffort = useCallback((newEffort: string | undefined) => {
    setEffortState(newEffort);
    if (newEffort !== settings.defaultThinkingEffort) {
      saveSettings({ defaultThinkingEffort: newEffort ?? null }).catch(console.error);
    }
  }, [saveSettings, settings.defaultThinkingEffort]);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
  const [gitBaseline, setGitBaseline] = useState<UseGitStatusResult | null>(null);
  // Tracks whether a baseline has been captured for the current round.
  // Reset when a new user message is sent or the session changes, so the
  // effect below captures a fresh snapshot when streaming begins.
  const baselineCapturedRef = useRef(false);
  const messageListRef = useRef<MessageListRef>(null);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { tasks: floatingTasks, setTasks: setFloatingTasks, fetchTasks: fetchFloatingTasks } = useTaskList(sessionId);
  const panel = useOptionalPanel();
  const workspaceExpanded = panel?.workspaceExpanded ?? false;

  // Poll tasks for the floating task panel above the composer. The task
  // list hook already fetches once on mount, so suppress the poll's own
  // immediate first tick (plan 426 Phase 4.2).
  usePolling(
    () => {
      void fetchFloatingTasks();
    },
    1500,
    { activeWhen: () => Boolean(sessionId), noImmediate: true },
  );

  const handleToggleFloatingTask = useCallback(
    async (task: typeof floatingTasks[number]) => {
      const next = task.status === 'completed' ? 'pending' : 'completed';
      setFloatingTasks((prev) =>
        prev.map((item) => (item.id === task.id ? { ...item, status: next } : item))
      );
      try {
        await window.electronAPI?.thread?.updateTask?.(task.id, { status: next });
        void fetchFloatingTasks();
      } catch (err) {
        console.error('[ChatView] updateTask failed:', err);
        setFloatingTasks((prev) =>
          prev.map((item) => (item.id === task.id ? { ...item, status: task.status } : item))
        );
      }
    },
    [fetchFloatingTasks, setFloatingTasks]
  );

  const openOrActivatePage = panel?.openOrActivatePage ?? NOOP_OPEN_PANEL;
  const panelTabs = panel?.tabs ?? [];
  const closePanel = panel?.closePanel ?? NOOP_CLOSE_PANEL;
  // Keep a ref to the latest panel tabs so cleanup code can close conductor
  // tabs without adding `tabs` to the dependency list of callbacks/effects
  // that must stay stable (e.g. handleConductorChange, session loader).
  const panelTabsRef = useRef(panelTabs);
  useEffect(() => {
    panelTabsRef.current = panelTabs;
  }, [panelTabs]);
  const activeTabId = panel?.activeTabId ?? null;
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);

  // Conductor mode is independent of plan/research modes — separate state.
  // conductorCanvasId is the durable binding to the sidebar canvas; when
  // conductor is enabled and no canvas exists yet, one is created lazily.
  const [conductorEnabled, setConductorEnabledState] = useState(false);
  const [conductorCanvasId, setConductorCanvasIdState] = useState<string | null>(null);
  // Ref mirrors kept in sync with state via wrapper setters below, so
  // `handleConductorChange` and the panel-open subscription read the latest
  // value synchronously instead of waiting for a separate ref-mirror effect
  // to flush. This avoids render-frame races where the auto-enable effect
  // would observe a stale `conductorEnabledRef` (e.g. session restore sets
  // conductorEnabled=true and then opens the panel; without synchronous
  // updates the panel-open effect could fire before the ref caught up and
  // double-fire handleConductorChange).
  const conductorCanvasIdRef = useRef<string | null>(null);
  const conductorEnabledRef = useRef<boolean>(false);
  const setConductorEnabled = useCallback((next: boolean) => {
    conductorEnabledRef.current = next;
    setConductorEnabledState(next);
  }, []);
  const setConductorCanvasId = useCallback((next: string | null) => {
    conductorCanvasIdRef.current = next;
    setConductorCanvasIdState(next);
  }, []);

  // Plan 413e: plan-task is a session-level toggle persisted to
  // `sessions.extensions.plan_mode_enabled`. Mirrors conductor's ref pattern
  // so `handlePlanModeChange` reads the latest value synchronously and the
  // DB write is skipped when the requested state already matches.
  const [planModeEnabled, setPlanModeEnabledState] = useState(false);
  const planModeEnabledRef = useRef<boolean>(false);
  const setPlanModeEnabled = useCallback((next: boolean) => {
    planModeEnabledRef.current = next;
    setPlanModeEnabledState(next);
  }, []);

  // Plan 420: goal mode is a session-level toggle persisted to
  // `sessions.extensions.goal_mode_enabled`. Mirrors plan-task's ref pattern
  // so `handleGoalModeChange` reads the latest value synchronously and the
  // DB write is skipped when the requested state already matches.
  const [goalModeEnabled, setGoalModeEnabledState] = useState(false);
  const goalModeEnabledRef = useRef<boolean>(false);
  const setGoalModeEnabled = useCallback((next: boolean) => {
    goalModeEnabledRef.current = next;
    setGoalModeEnabledState(next);
  }, []);

  // Plan 224 follow-up: agent-initiated runtime mode (e.g. via
  // EnterPlanMode / ExitPlanMode / SwitchMode tool). When the agent
  // switches to 'plan' we surface it as a virtual plan-task mode on
  // the input box so the user sees the same chip + glow they'd get
  // from manually toggling Plan Mode in the popover. Switching back
  // to 'general' (or any non-plan mode) clears it. Other runtime
  // modes (explore / verify / code-review) currently do not have
  // a popover equivalent, so they only clear the plan chip.
  const [agentPlanMode, setAgentPlanMode] = useState(false);

  // Agent-side canvas_manage operations are durable in SQLite, but the
  // renderer also needs to follow them immediately. Listen on the conductor
  // channel so a switch updates the conversation binding and replaces the
  // frozen sidebar canvas tab with the new target.
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    const subscribe = () => {
      unsubscribe?.();
      const port = window.electronAPI?.getConductorPort?.();
      if (!port?.onCanvasChanged) return;

      unsubscribe = port.onCanvasChanged((event) => {
        const canvas = event.canvas as unknown as ConductorCanvas;
        const conductorStore = useConductorStore.getState();
        if (conductorStore.canvases.some((item) => item.id === canvas.id)) {
          conductorStore.updateCanvas(canvas);
        } else {
          conductorStore.addCanvas(canvas);
        }

        if (!event.currentCanvasId || event.sessionId !== sessionId) return;

        setConductorEnabled(true);
        setConductorCanvasId(event.currentCanvasId);
        useConversationStore.getState().setThreadConductorBinding(sessionId, true, event.currentCanvasId);

        // If the requested canvas is already the active conductor tab, keep it
        // as-is instead of closing and reopening tabs.
        const activeTab = panelTabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
        if (
          activeTab?.pageId === 'conductor' &&
          activeTab.params?.canvasId === event.currentCanvasId
        ) {
          return;
        }

        for (const tab of panelTabsRef.current.filter(
          (item) => item.pageId === 'conductor' && item.params?.canvasId !== event.currentCanvasId,
        )) {
          closePanel(tab.id);
        }
        openOrActivatePage('conductor', {
          canvasId: event.currentCanvasId,
          title: canvas.name || t('panel.conductor'),
        });
      });
    };

    subscribe();
    window.addEventListener('conductor-port-ready', subscribe);
    return () => {
      window.removeEventListener('conductor-port-ready', subscribe);
      unsubscribe?.();
    };
  }, [closePanel, openOrActivatePage, sessionId, setConductorCanvasId, setConductorEnabled]);

  // Project state derived from store threads
  const storeThreads = useConversationStore(s => s.threads);
  const setThreadWorkingDirectory = useConversationStore(s => s.setThreadWorkingDirectory);
  const setThreadModel = useConversationStore(s => s.setThreadModel);
  const addProjectFolder = useConversationStore(s => s.addProjectFolder);
  const setActiveThread = useConversationStore(s => s.setActiveThread);
  const deleteMessageAndAfter = useConversationStore(s => s.deleteMessageAndAfter);
  const sendMailbox = useMailboxStore(s => s.send);
  const busyMessageMode = useBusyMessageModeValue();
  const mailboxRows = useMailboxStore(
    useShallow(state => state.getBySession(sessionId)),
  );

  // Mailbox rows are deliberately not persisted in the normal transcript
  // until their checkpoint permits it. Render them as transient user bubbles
  // meanwhile, so a queued or guided instruction is visible immediately.
  const mailboxMessages = useMemo(() => {
    const persistedMessageIds = new Set(messages.map(message => message.id));
    const isVisible = (row: MailboxRow) => {
      if (row.status === 'pending' || row.status === 'observed') return true;
      return row.status === 'applied'
        && isStreaming
        && (!row.resultingUserMsgId || !persistedMessageIds.has(row.resultingUserMsgId));
    };

    return mailboxRows
      .filter(isVisible)
      .map((row): Message => ({
        id: `mailbox-${row.id}`,
        role: 'user',
        content: row.content,
        timestamp: row.createdAt,
      }));
  }, [isStreaming, mailboxRows, messages]);

  /**
   * Filter persisted messages through the agent-side visibility field.
   * Hidden runtime_context rows (attachment context, mailbox instructions,
   * background notifications, etc.) are removed before rendering. Tool
   * results remain in the returned array so MessageList can group them as usual.
   */
  const visibleMessages = useMemo(
    () => projectMessageTranscript(messages).messages,
    [messages],
  );

  const renderedMessages = useMemo(
    () => [...visibleMessages, ...mailboxMessages],
    [visibleMessages, mailboxMessages],
  );

  const selectedProject = useMemo(() => {
    const thread = storeThreads.find(t => t.id === sessionId);
    if (thread?.workingDirectory) {
      return { workingDirectory: thread.workingDirectory, projectName: thread.projectName || thread.workingDirectory };
    }
    return null;
  }, [storeThreads, sessionId]);

  const activeThread = useMemo(
    () => storeThreads.find((t) => t.id === sessionId) || null,
    [storeThreads, sessionId]
  );
  const gitStatus = useGitStatus(activeThread?.workingDirectory ?? null, true);

  // Capture a git baseline when the agent starts working so the floating
  // file-change pill only shows changes produced by the current turn.
  // The baseline persists after streaming ends so the user can still
  // inspect the round's changes. It is cleared when a new user message
  // is sent (next round) or the session changes.
  useEffect(() => {
    if (!isStreaming || !activeThread?.workingDirectory) {
      return;
    }
    if (baselineCapturedRef.current) return;

    let cancelled = false;
    void getGitStatus(activeThread.workingDirectory).then((status) => {
      if (cancelled) return;
      baselineCapturedRef.current = true;
      setGitBaseline({
        isGitRepo: status.isGitRepo,
        fileChanges: status.fileChanges ?? [],
        totals: status.totals ?? { additions: 0, removals: 0, fileCount: 0 },
      });
    }).catch(() => {
      if (!cancelled) {
        baselineCapturedRef.current = false;
        setGitBaseline(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isStreaming, activeThread?.workingDirectory]);

  // Plan 308 Phase 2: once a turn completes, pull the agent-persisted
  // per-turn review so the pill shows turn-scoped numbers instead of
  // repo-wide uncommitted totals (which mix in other sessions' changes).
  const [lastTurnReview, setLastTurnReview] = useState<GitTurnReview | null>(null);
  const prevStreamingRef = useRef(isStreaming);
  useEffect(() => {
    const wasStreaming = prevStreamingRef.current;
    prevStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) return;
    const cwd = activeThread?.workingDirectory;
    if (!sessionId || !cwd) return;
    let cancelled = false;
    const fetchTurnReview = (allowRetry: boolean) => {
      void getGitLatestTurnReview(sessionId, cwd).then((result) => {
        if (cancelled) return;
        if (result.review) {
          setLastTurnReview(result.review);
        } else if (allowRetry) {
          // persistTurnReview lands before chat:done, but retry once in
          // case the renderer's streaming flag flipped a beat earlier.
          window.setTimeout(() => { if (!cancelled) fetchTurnReview(false); }, 1500);
        }
      }).catch(() => {
        // Ignore — live gitStatus stays the fallback source.
      });
    };
    fetchTurnReview(true);
    return () => { cancelled = true; };
  }, [isStreaming, sessionId, activeThread?.workingDirectory]);

  // Clear baseline when the session changes so the pill from a previous
  // session does not bleed into the new one.
  useEffect(() => {
    setGitBaseline(null);
    baselineCapturedRef.current = false;
    setLastTurnReview(null);
  }, [sessionId]);

  // Derive a stable fingerprint from the file-change list so the pill
  // appears even when aggregate totals net out (e.g. +10 in one file
  // and -10 in another).
  const showFileChanges = useMemo(() => {
    if (!gitBaseline?.isGitRepo || !gitStatus.isGitRepo) return false;
    const fp = (list: typeof gitStatus.fileChanges) =>
      (list ?? [])
        .map((f) => `${f.path}:+${f.additions}/-${f.removals}`)
        .sort()
        .join('|');
    return fp(gitStatus.fileChanges) !== fp(gitBaseline.fileChanges);
  }, [gitBaseline, gitStatus]);

  const handleSelectProject = useCallback((project: { workingDirectory: string; projectName: string }) => {
    setThreadWorkingDirectory(sessionId, project.workingDirectory, project.projectName);
  }, [sessionId, setThreadWorkingDirectory]);

  const handleUseExistingFolder = useCallback(() => {
    if (window.electronAPI?.dialog?.openFolder) {
      window.electronAPI.dialog.openFolder({
        title: "Select Project Folder",
      }).then(async (result: { canceled: boolean; filePaths: string[] }) => {
        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          const project = await addProjectFolder(workingDirectory);
          const projectName = project?.projectName ?? workingDirectory.split(/[\\/]/).pop() ?? "Untitled";
          setThreadWorkingDirectory(sessionId, workingDirectory, projectName);
        }
      });
    }
  }, [sessionId, addProjectFolder, setThreadWorkingDirectory]);

  const handleNewBlankProject = useCallback(() => {
    setIsNameProjectDialogOpen(true);
  }, []);

  const handleCreateNamedProject = useCallback(async (name: string) => {
    setIsNameProjectDialogOpen(false);
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      if (window.electronAPI?.app?.createProjectFolder) {
        const result = await window.electronAPI.app.createProjectFolder(trimmed);
        if (result.success && result.path) {
          await addProjectFolder(result.path);
          setThreadWorkingDirectory(sessionId, result.path, trimmed);
        }
      }
    } catch (error) {
      console.error("[ChatView] Failed to create blank project:", error);
    }
  }, [sessionId, addProjectFolder, setThreadWorkingDirectory]);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThread(threadId);
  }, [setActiveThread]);

  // Use fine-grained hooks for streaming state
  const phase = useStreamPhase(sessionId);
  const streamingError = useStreamingError(sessionId);
  const lastUserContentRef = useRef<string>('');
  const lastFilesRef = useRef<FileAttachment[] | undefined>(undefined);
  const lastOutputStyleRef = useRef<{ name: string; prompt: string; keepCodingInstructions?: boolean } | null | undefined>(undefined);
  // Permission mode drives both the composer selector and the in-session
  // prompt gating. Derived from the user's Ask/Auto/Bypass choice: Bypass maps
  // to full_access (prompts suppressed), Ask to default, Auto stays auto.
  const permissionProfile: 'default' | 'auto' | 'full_access' =
    permissionMode === 'bypass' ? 'full_access'
    : permissionMode === 'ask' ? 'default'
    : 'auto';

  // Permission system
  const {
    pendingPermission,
    permissionResolved,
    respondToPermission,
    handlePermissionRequest,
  } = usePermissions({
    sessionId,
    permissionProfile,
  });
  const isAskUserQuestionPending =
    pendingPermission?.toolName === 'AskUserQuestion' ||
    pendingPermission?.mode === 'ask_user_question';

  // Load session model and permission mode on mount
  // Priority: 1) session saved model (if not default) 2) lastSelectedModel
  useEffect(() => {
    if (sessionId) {
      getThreadIPC(sessionId)
        .then(async data => {
          if (data?.thread) {
            setSessionProviderId(data.thread.providerId || '');
            // Priority 1: Session has a specific model saved (and it's not the DB default)
            if (data.thread.model && data.thread.model !== DB_DEFAULT_MODEL) {
              // Check if model is in UI format "[providerName] modelId"
              const isUiFormat = data.thread.model.startsWith('[');
              if (isUiFormat) {
                setSessionModel(data.thread.model);
              } else {
                // Pure model name - need to rebuild UI format using provider_id
                let providerName = data.thread.providerId || 'Unknown';
                try {
                  const provider = await getProviderIPC(data.thread.providerId || '');
                  if (provider) {
                    providerName = provider.name || provider.providerType || provider.id;
                  }
                } catch {
                  // Ignore error, use providerId as fallback
                }
                setSessionModel(`[${providerName}] ${data.thread.model}`);
              }
            }
            // Priority 2: Use global lastSelectedModel if available
            else if (settings.lastSelectedModel) {
              setSessionModel(settings.lastSelectedModel);
              // Sync to session so provider_id gets updated too
              const { modelName } = parseModelName(settings.lastSelectedModel);
              updateThreadIPC(sessionId, { model: modelName }).catch(console.error);
            }

            // Restore the permission-mode selector from the session row so
            // the composer shows the mode the worker will actually use, and
            // the user always sees the current mode after switching sessions.
            setPermissionMode(permissionProfileToUi(data.thread.permissionProfile));

            // Load agent profile binding. The profile is fixed at session
            // creation (no in-session agent switching), so only sync the id.
            setAgentProfileId(data.thread.agentProfileId ?? getProfileIdForMode('main'));

            // Restore conductor mode state from the session row. When the
            // session has a bound canvas, reopen the sidebar conductor panel
            // so the user sees their canvas on thread load.
            if (data.thread.conductorModeEnabled) {
              setConductorEnabled(true);
              setConductorCanvasId(data.thread.conductorCanvasId ?? null);
              if (data.thread.conductorCanvasId) {
                openOrActivatePage('conductor', { canvasId: data.thread.conductorCanvasId });
              }
            } else {
              setConductorEnabled(false);
              setConductorCanvasId(null);
              // Clean up any stale conductor panel tabs for this session.
              // A previous bug may have persisted a conductor tab even though
              // the session row says conductor mode is off; leaving that tab
              // open would mount SidebarConductorView, which sets the global
              // activeCanvasId and triggers the auto-enable subscription.
              for (const tab of panelTabsRef.current.filter((t) => t.pageId === 'conductor')) {
                closePanel(tab.id);
              }
            }

            // Plan 413e: restore the plan-task session toggle from the
            // session row so the user's persisted plan mode survives
            // restarts. MessageInput syncs this prop back into its
            // activeModes set.
            setPlanModeEnabled(!!data.thread.planModeEnabled);
            setGoalModeEnabled(!!data.thread.goalModeEnabled);
          }
        })
        .catch(console.error);
    }
  }, [sessionId, settings.lastSelectedModel, openOrActivatePage]);

  // Parse UI model format "[providerName] modelId" to extract pure model name
  const parseModelName = useCallback((model: string): { providerName: string | null; modelName: string } => {
    const match = model.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return { providerName: match[1], modelName: match[2] };
    }
    // Fallback: treat as pure model name
    return { providerName: null, modelName: model.replace(/^"|"$/g, '') };
  }, []);

  // Resolve the model's `contextWindow` capability so the context ring
  // renders the right grid (10×10 for 200K, 20×10 for 1M+). Re-fires
  // whenever the session's (providerId, model) pair changes — including
  // model switches from the picker above the input.
  useEffect(() => {
    if (!sessionProviderId || !sessionModel) {
      setCapabilityContextWindow(undefined);
      setCapabilityPricing(undefined);
      return;
    }
    const { modelName: pureModel } = parseModelName(sessionModel);
    if (!pureModel) {
      setCapabilityContextWindow(undefined);
      setCapabilityPricing(undefined);
      return;
    }
    let cancelled = false;
    void getModelCapabilityIPC({
      providerId: sessionProviderId,
      modelId: pureModel,
    })
      .then((cap) => {
        if (cancelled) return;
        setCapabilityContextWindow(
          cap && typeof cap.contextWindow === 'number' && cap.contextWindow > 0
            ? cap.contextWindow
            : undefined,
        );
        // Same capability row carries the real pricing the ring's $ figure
        // uses (hidden when absent — no hardcoded fallback rates).
        setCapabilityPricing(cap?.pricing ?? undefined);
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilityContextWindow(undefined);
        setCapabilityPricing(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionProviderId, sessionModel, parseModelName]);

  // Handle model change - persist to session AND global settings
  const handleModelChange = useCallback((model: string, providerId?: string) => {
    setSessionModel(model);
    if (providerId) {
      setSessionProviderId(providerId);
    }
    // Save pure model name to session (parse UI format if needed).
    // The store action re-syncs the row to the DB, so the call below
    // covers what an inline updateThreadIPC used to do, plus the
    // in-memory store update that App.handleSendMessage reads.
    if (sessionId) {
      const { modelName } = parseModelName(model);
      setThreadModel(sessionId, modelName, providerId || sessionProviderId);
    }
    // Save to global settings for cross-session memory (keep UI format for display consistency)
    if (model) {
      saveSettings({ lastSelectedModel: model }).catch(console.error);
    }
  }, [sessionId, saveSettings, parseModelName, setThreadModel, sessionProviderId]);

  // Subscribe to permission events from SSE
  useEffect(() => {
    const unsubscribe = subscribeToPermissions(sessionId, (req) => handlePermissionRequest(req));
    return () => {
      unsubscribe();
    };
  }, [sessionId, handlePermissionRequest]);

  // Plan 450: connector re-authorization elicitation. A failed tool call
  // surfaces as a discrete event so we can prompt them with a re-auth
  // button without polluting the chat error stream.
  const [pendingAuthRequest, setPendingAuthRequest] = useState<ConnectorAuthRequiredData | null>(null);
  // Plan 498: ref mirror so the main-process `app-connection:connected`
  // broadcast (async, fires outside React state) can match the pending
  // elicitation without a stale-closure subscribe.
  const pendingAuthRequestRef = useRef(pendingAuthRequest);
  useEffect(() => {
    pendingAuthRequestRef.current = pendingAuthRequest;
  }, [pendingAuthRequest]);
  // Plan 498: provider whose (re-)authorization main confirmed — flips the
  // card to its real "connected" state. Cleared when a new elicitation
  // arrives so a stale completion can't auto-resolve a future card.
  const [authCompletedFor, setAuthCompletedFor] = useState<string | null>(null);
  // Plan 498: dedup guard — the card's own connect promise and the main
  // broadcast can both report the same completion; only one resume turn
  // may be sent. Re-armed whenever a new elicitation arrives. Declared
  // here; consumed by retryAfterAuth (defined after handleSend below).
  const resumeTriggeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const unsubscribe = subscribeToConnectorAuthRequired(sessionId, (data) => {
      resumeTriggeredRef.current = null;
      setAuthCompletedFor(null);
      setPendingAuthRequest(data);
    });
    return () => unsubscribe();
  }, [sessionId]);
  const dismissAuthRequest = useCallback(() => {
    setPendingAuthRequest(null);
    clearConnectorAuthRequired(sessionId);
  }, [sessionId]);

  // Plan 224 follow-up: subscribe to agent-initiated runtime mode
  // switches (EnterPlanMode / ExitPlanMode / SwitchMode). When the
  // agent moves into 'plan', mirror it as agentPlanMode so MessageInput
  // shows the same chip + glow as a user-toggled popover plan-task.
  // Switching to any non-plan mode clears it. Also reset on session
  // change so a stale chip from the previous session doesn't bleed in.
  useEffect(() => {
    setAgentPlanMode(false);
    if (!sessionId) return;
    const unsubscribe = subscribeToModeChanged(sessionId, (event) => {
      setAgentPlanMode(event.mode === 'plan');
    });
    return () => {
      unsubscribe();
    };
  }, [sessionId]);

  // When viewing a sub-agent session, periodically reload messages from DB
  // while the parent session is still streaming
  const parentSessionId = useConversationStore(s => s.parentSessionId);
  const loadThreadMessages = useConversationStore(s => s.loadThreadMessages);
  // Stable ref so the effect doesn't re-run when the store action identity
  // changes (plan 236 Phase 5).
  const loadThreadMessagesRef = useRef(loadThreadMessages);
  loadThreadMessagesRef.current = loadThreadMessages;

  // Latest parent-session phase, mirrored into a ref so the polling gate
  // below reads it per tick without restarting the interval (plan 426
  // Phase 4.2).
  const parentPhaseRef = useRef<string>('idle');

  useEffect(() => {
    if (!parentSessionId) return undefined;
    parentPhaseRef.current = 'idle';
    const unsubPhase = subscribeToPhase(parentSessionId, (phase) => {
      parentPhaseRef.current = phase;
    });
    return () => {
      unsubPhase();
    };
  }, [parentSessionId]);

  usePolling(
    () => {
      loadThreadMessagesRef.current(sessionId);
    },
    3000,
    {
      activeWhen: () =>
        Boolean(parentSessionId) && ACTIVE_STREAM_PHASES.has(parentPhaseRef.current),
      noImmediate: true,
    },
  );

  // Attach to streams started outside the renderer (e.g. a cron run kicked
  // off by the main-process scheduler). Renderer-initiated turns render live
  // through the stream manager already; without attaching, opening such a
  // session mid-run shows a frozen transcript. The agent server replays the
  // buffered events from Last-Event-ID 0, so a mid-run attach renders the
  // whole run, not just the tail.
  // Only attached (externally-started) streams need the poll fallback;
  // renderer-initiated turns already render live from their own stream.
  // The ref gates the polling hook below: ticks only run after a
  // successful attach and while the run's phase is active (plan 426
  // Phase 4.2).
  //
  // runCronNow resolves before the background POST /chat reaches the agent
  // server, so the session can still be IDLE (or absent) when this view
  // mounts — retry until it enters STREAMING instead of checking once.
  const ATTACH_RETRY_MS = 400;
  const ATTACH_RETRY_LIMIT_MS = 12_000;
  const attachDidAttachRef = useRef(false);
  const attachTryingRef = useRef(false);
  const attachCancelledRef = useRef(false);
  const attachStartedAtRef = useRef(0);

  const tryAttach = async (sid: string): Promise<void> => {
    if (attachCancelledRef.current || attachDidAttachRef.current || attachTryingRef.current) return;
    // A locally-active stream is already rendering — attaching would reset
    // its state and stack a duplicate SSE subscription.
    const local = getSnapshot(sid);
    if (local && ACTIVE_STREAM_PHASES.has(local.phase)) return;
    attachTryingRef.current = true;
    try {
      const status = await getAgentServerClient().getSessionStatus(sid);
      if (attachCancelledRef.current || !status || status.status !== 'STREAMING') return;
      await attachToExistingStream(sid);
      if (!attachCancelledRef.current) attachDidAttachRef.current = true;
    } catch {
      // Attach failed (e.g. the run finished between the status probe and the
      // GET /chat, or the agent server went away). Force a persisted-transcript
      // reload so a completed run still renders without a manual refresh;
      // harmless for transient failures while the retry loop keeps polling.
      void loadThreadMessagesRef.current(sid, { force: true });
    } finally {
      attachTryingRef.current = false;
    }
  };

  useEffect(() => {
    if (!sessionId) return undefined;
    attachCancelledRef.current = false;
    attachDidAttachRef.current = false;
    attachStartedAtRef.current = Date.now();

    void tryAttach(sessionId);

    return () => {
      attachCancelledRef.current = true;
      // Drop only the SSE transport this effect opened. stopStream would
      // mark the local phase 'aborted' for a run that is still executing in
      // the background, and cancelling unconditionally would abort a
      // renderer-initiated stream's fetch on every view switch.
      if (attachDidAttachRef.current) {
        attachDidAttachRef.current = false;
        getAgentServerClient().cancelStream(sessionId);
      }
    };
    // tryAttach is intentionally omitted: it only touches refs, so the
    // latest closure is always in effect after sessionId changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Retry the attach until the background run enters STREAMING or the
  // window expires. Once attached, this gate keeps the tick from running.
  usePolling(
    () => {
      void tryAttach(sessionId);
    },
    ATTACH_RETRY_MS,
    {
      activeWhen: () =>
        !attachDidAttachRef.current &&
        Date.now() - attachStartedAtRef.current < ATTACH_RETRY_LIMIT_MS,
      noImmediate: true,
    },
  );

  // Fallback for events the SSE attach misses: keep reloading persisted
  // rows while the background run is active (loadThreadMessages skips
  // streaming sessions unless forced).
  usePolling(
    () => {
      void loadThreadMessagesRef.current(sessionId, { force: true });
    },
    2000,
    {
      activeWhen: () =>
        attachDidAttachRef.current && ACTIVE_STREAM_PHASES.has(phase),
      noImmediate: true,
    },
  );

  const handleSend = useCallback(
    async (content: string, files?: FileAttachment[], outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, displayContent?: string) => {
      lastUserContentRef.current = content;
      lastFilesRef.current = files;
      lastOutputStyleRef.current = outputStyleConfig;
      if (isStreaming) {
        const queuedRow = await sendMailbox({
          sessionId,
          content,
          // Default in-run handling comes from the busyMessageMode setting
          // (agent.busy_message_mode): 'queued' rows are absorbed right
          // before the agent finalises (before_final_answer); 'followup'
          // rows inject immediately at the next before_model_turn
          // checkpoint. The mailbox bubble's "Guide" button can still flip
          // an individual queued row to followup mid-run.
          kind: busyMessageMode,
          submittedDuringRunId: sessionId,
          attachments: files,
        });
        if (queuedRow && !queuedRow.id.startsWith('optimistic-')) {
          const { modelName: actualModel } = parseModelName(sessionModel || '');
          onSendMessage(
            content,
            actualModel,
            files,
            agentProfileId,
            outputStyleConfig,
            mode,
            effort,
            displayContent,
            conductorEnabled,
            queuedRow.id,
            permissionMode,
          );
        }
        return;
      }
      // New round: reset the git baseline and capture the pre-turn state
      // immediately — before the agent can write any files — so the
      // streaming pill doesn't miss the turn's earliest edits.
      setGitBaseline(null);
      baselineCapturedRef.current = false;
      if (activeThread?.workingDirectory) {
        void getGitStatus(activeThread.workingDirectory).then((status) => {
          baselineCapturedRef.current = true;
          setGitBaseline({
            isGitRepo: status.isGitRepo,
            fileChanges: status.fileChanges ?? [],
            totals: status.totals ?? { additions: 0, removals: 0, fileCount: 0 },
          });
        }).catch(() => {});
      }
      // Parse model format: "[providerName] modelName" to extract pure model name
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      onSendMessage(content, actualModel, files, agentProfileId, outputStyleConfig, mode, effort, displayContent, conductorEnabled, undefined, permissionMode);
    },
    [agentProfileId, isStreaming, onSendMessage, parseModelName, sendMailbox, sessionId, sessionModel, effort, conductorEnabled, permissionMode, busyMessageMode, activeThread?.workingDirectory]
  );

  // Plan 498 auto-retry (Plan 450 B3): after a successful re-authorization
  // the card hands back through here. Clear the pending state and send a
  // localized resume message so the model re-issues the failed call with
  // the same arguments — it still has the original call in its context.
  // If a stream is active, handleSend routes the message through the
  // mailbox automatically (queued/followup), so mid-run completions are
  // safe. The card's own connect and the main broadcast both funnel here;
  // resumeTriggeredRef keeps it to one resume per elicitation.
  const retryAfterAuth = useCallback(() => {
    const request = pendingAuthRequestRef.current;
    setPendingAuthRequest(null);
    setAuthCompletedFor(null);
    clearConnectorAuthRequired(sessionId);
    if (!request?.provider || resumeTriggeredRef.current === request.provider) {
      return;
    }
    resumeTriggeredRef.current = request.provider;
    // Plan 503: a bot-initiated connect uses its own resume copy — there
    // is no failed call to re-issue, the model should continue where it
    // left off after the new connection came online.
    void handleSend(
      request.variant === 'connect'
        ? t('connectorAuth.connectResumeMessage', { provider: request.provider })
        : t('connectorAuth.resumeMessage', {
            provider: request.provider,
            tool: request.toolName ?? '',
          }),
    );
  }, [sessionId, handleSend, t]);
  // Plan 498: main-process completion broadcast — covers a re-authorization
  // completed from the settings page (or racing the card's own connect).
  // The card flips to "connected" and calls retryAfterAuth itself.
  useEffect(() => {
    if (!sessionId) return;
    const api = getAppConnectionAPI();
    if (!api) return;
    return api.onConnected((data) => {
      const request = pendingAuthRequestRef.current;
      if (!request || request.provider !== data.provider) return;
      setAuthCompletedFor(data.provider);
    });
  }, [sessionId]);

  // Toggle conductor mode for the current session. On enable, resolve the
  // canvas ID with the following priority (per project requirement:
  // "默认是项目画布；用户在侧栏手动打开其他画布则以侧栏为准"):
  //   1. Sidebar active canvas id (user explicitly opened another canvas)
  //   2. Session-bound canvas id (already stored on the session row)
  //   3. Project canvas (looked up by workingDirectory via project_path)
  //   4. Otherwise create a new project canvas named after projectName and
  //      bind it to the project path so subsequent sessions reuse it.
  // Reopening the sidebar conductor panel is deferred to the IPC success
  // path so a failed write doesn't open an orphan panel.
  const handleConductorChange = useCallback(
    async (enabled: boolean, options?: { openPanel?: boolean }) => {
      if (!sessionId) return;
      const { openPanel = true } = options ?? {};
      // Avoid redundant work when the requested state already matches the
      // current state. This also prevents double DB writes when both the
      // canvas-switch and tab-creation auto-enable subscriptions fire for
      // the same user action.
      if (enabled === conductorEnabledRef.current) return;
      setConductorEnabled(enabled);
      // Read the latest canvas id from the ref to keep this callback's deps
      // stable (see conductorCanvasIdRef comment above).
      const currentCanvasId = conductorCanvasIdRef.current;
      if (!enabled) {
        // Clear the canvas-id binding (both local and DB) and close any open
        // conductor panel tabs. When conductor is off the session should carry
        // no canvas binding, and leaving a conductor tab open would keep
        // SidebarConductorView mounted, which sets the global activeCanvasId
        // and can re-trigger the auto-enable subscription on canvas switches.
        setConductorCanvasId(null);
        for (const tab of panelTabsRef.current.filter((t) => t.pageId === 'conductor')) {
          closePanel(tab.id);
        }
        try {
          await window.electronAPI.session.setConductorMode(sessionId, false, null);
          useConversationStore.getState().setThreadConductorBinding(sessionId, false, null);
        } catch (err) {
          console.error('[ChatView] setConductorMode IPC failed (disable)', err);
        }
        return;
      }

      // Session-bound canvas takes priority over the sidebar's active canvas.
      // Otherwise switching canvases in the sidebar silently re-binds the
      // current session to a different (often empty) canvas, and after a
      // refresh the user's previously-created elements appear "lost".
      let canvasId: string | null =
        currentCanvasId ??
        useConductorStore.getState().activeCanvasId ??
        null;

      const thread = useConversationStore.getState().threads.find((t) => t.id === sessionId);
      const workingDirectory = thread?.workingDirectory ?? null;
      const projectName = thread?.projectName || (workingDirectory ? workingDirectory.split(/[\\/]/).pop() ?? 'Untitled' : 'Untitled');

      if (!canvasId && workingDirectory) {
        try {
          const existing = await window.electronAPI.conductor.getCanvasByProjectPath(workingDirectory);
          canvasId = (existing as { id?: string } | null)?.id ?? null;
        } catch (err) {
          console.error('[ChatView] getCanvasByProjectPath failed', err);
        }
      }

      if (!canvasId) {
        try {
          const newCanvas = await window.electronAPI.conductor.createCanvas({
            name: projectName,
            projectPath: workingDirectory ?? null,
          });
          canvasId = (newCanvas as { id?: string } | null)?.id ?? null;
        } catch (err) {
          console.error('[ChatView] failed to create conductor canvas', err);
        }
      }

      if (canvasId) setConductorCanvasId(canvasId);

      try {
        await window.electronAPI.session.setConductorMode(sessionId, true, canvasId ?? null);
        useConversationStore.getState().setThreadConductorBinding(sessionId, true, canvasId ?? null);
      } catch (err) {
        console.error('[ChatView] setConductorMode IPC failed', err);
      }
      // Only open/activate the panel when explicitly requested (user toggle
      // or session restore). When triggered by the panel-open subscription
      // below, the panel is already open and we'd create a duplicate tab.
      if (openPanel && canvasId) {
        openOrActivatePage('conductor', { canvasId });
      }
    },
    [sessionId, openOrActivatePage],
  );

  // Plan 413e: persist the plan-task session toggle to the DB. Unlike
  // conductor there is no canvas binding to resolve — just the boolean flag
  // in sessions.extensions.plan_mode_enabled, written through the dedicated
  // IPC and mirrored into the store thread for cross-component reads.
  const handlePlanModeChange = useCallback(
    async (enabled: boolean) => {
      if (!sessionId) return;
      // Avoid redundant DB writes when the requested state already matches
      // (e.g. both the popover toggle and the session-restore prop fire).
      if (enabled === planModeEnabledRef.current) return;
      setPlanModeEnabled(enabled);
      try {
        await window.electronAPI.session.setPlanMode(sessionId, enabled);
        useConversationStore.getState().setThreadPlanMode(sessionId, enabled);
      } catch (err) {
        console.error('[ChatView] setPlanMode IPC failed', err);
      }
    },
    [sessionId],
  );

  // Plan 413e: persist the goal mode session toggle to the DB. Mirrors the
  // plan-task handler — just the boolean flag in
  // sessions.extensions.goal_mode_enabled, written through the dedicated IPC
  // and mirrored into the store thread for cross-component reads.
  const handleGoalModeChange = useCallback(
    async (enabled: boolean) => {
      if (!sessionId) return;
      // Avoid redundant DB writes when the requested state already matches
      // (e.g. both the popover toggle and the session-restore prop fire).
      if (enabled === goalModeEnabledRef.current) return;
      setGoalModeEnabled(enabled);
      try {
        await window.electronAPI.session.setGoalMode(sessionId, enabled);
        useConversationStore.getState().setThreadGoalMode(sessionId, enabled);
      } catch (err) {
        console.error('[ChatView] setGoalMode IPC failed', err);
      }
    },
    [sessionId],
  );

  // Auto-enable conductor mode when the user switches canvases inside an
  // already-open conductor panel while conductor mode is off. Subscribes
  // to the conductor store's `activeCanvasId` — when it transitions to a
  // non-null value and conductor mode is currently off, call
  // `handleConductorChange(true)` with `openPanel: false` (the panel is
  // already open, so we must not call `openOrActivatePage` again or we'd
  // create a duplicate tab).
  const conductorStoreActiveCanvasId = useConductorStore(s => s.activeCanvasId);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevStoreCanvasIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    // On session change, reset the canvas-id baseline so the prev canvas id
    // from the last session does not leak in and produce a false "canvas
    // changed" detection. Return without auto-enabling; the session-loader
    // effect restores conductor state from the DB.
    if (prevSessionIdRef.current !== sessionId) {
      prevSessionIdRef.current = sessionId;
      prevStoreCanvasIdRef.current = conductorStoreActiveCanvasId;
      return;
    }
    const prev = prevStoreCanvasIdRef.current;
    prevStoreCanvasIdRef.current = conductorStoreActiveCanvasId;
    if (
      conductorStoreActiveCanvasId
      && prev !== conductorStoreActiveCanvasId
      && !conductorEnabledRef.current
    ) {
      void handleConductorChange(true, { openPanel: false });
    }
  }, [conductorStoreActiveCanvasId, sessionId, handleConductorChange]);

  // Auto-enable conductor mode when a conductor panel tab is created while
  // conductor mode is off. This captures the sidebar nav click path, which
  // opens a panel tab but does not change the global activeCanvasId when
  // the store already holds a canvas id for that canvas.
  const prevSessionIdForTabsRef = useRef<string | null>(null);
  const prevConductorTabCountRef = useRef(0);
  useEffect(() => {
    if (!sessionId) return;
    const count = panelTabs.filter((t) => t.pageId === 'conductor').length;
    // On session change, reset the tab-count baseline so the count from the
    // previous session does not leak in and auto-enable conductor based on
    // stale/dirty persisted panel state. The session-loader effect above is
    // responsible for restoring the correct conductor state from the DB.
    if (prevSessionIdForTabsRef.current !== sessionId) {
      prevSessionIdForTabsRef.current = sessionId;
      prevConductorTabCountRef.current = count;
      return;
    }
    const prev = prevConductorTabCountRef.current;
    prevConductorTabCountRef.current = count;
    if (count > 0 && prev === 0 && !conductorEnabledRef.current) {
      void handleConductorChange(true, { openPanel: false });
    }
  }, [panelTabs, sessionId, handleConductorChange]);

  const handleStop = useCallback(() => {
    onInterrupt?.();
  }, [onInterrupt]);

  // P2-β: global Esc shortcut to interrupt the current stream. Fires
  // only when the chat is actively streaming and the focus is not
  // inside an input / textarea / contenteditable (so we don't steal
  // Esc from the popover inside MessageInput, and don't fight the
  // browser's native Escape behavior in editable fields).
  useEffect(() => {
    if (!isStreaming) return undefined;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handleStop();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isStreaming, handleStop]);

  const handleRetry = useCallback(() => {
    const lastContent = lastUserContentRef.current;
    if (lastContent) {
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      // Use saved files and parsed docs for retry
      onSendMessage(lastContent, actualModel, lastFilesRef.current, agentProfileId, lastOutputStyleRef.current, undefined, effort, undefined, undefined, undefined, permissionMode);
    }
  }, [onSendMessage, sessionModel, parseModelName, agentProfileId, effort, permissionMode]);

  // Inline edit-and-resend: delete the target user message (and everything
  // after it), then send the edited text as a fresh message. Only the last
  // user message is editable (enforced by MessageList via isEditable).
  const handleEditSend = useCallback(async (messageId: string, text: string) => {
    if (isStreaming || !text.trim() || !sessionId) return;
    let restoredFiles: string[] | undefined;
    try {
      const result = await deleteMessageAndAfter(sessionId, messageId);
      restoredFiles = result.restoredFiles;
    } catch (err) {
      console.error('[ChatView] edit-and-resend: deleteMessageAndAfter failed', err);
      return;
    }
    // Plan 429 #3: tell the user when rewound tool calls rolled files on
    // disk back to their pre-edit snapshots.
    if (restoredFiles && restoredFiles.length > 0) {
      setCompressionNotification(`Restored ${restoredFiles.length} file${restoredFiles.length === 1 ? '' : 's'} to their pre-edit state.`);
      setTimeout(() => setCompressionNotification(null), 5000);
    }
    const { modelName: actualModel } = parseModelName(sessionModel || '');
    onSendMessage(text, actualModel, undefined, agentProfileId, lastOutputStyleRef.current, undefined, effort, text, conductorEnabled, undefined, permissionMode);
  }, [isStreaming, sessionId, deleteMessageAndAfter, parseModelName, sessionModel, onSendMessage, agentProfileId, effort, conductorEnabled, permissionMode]);

  const handleCompact = useCallback(() => {
    if (!sessionId) return;
    const compactStartedAt = Date.now();
    setIsCompacting(true);
    useCompactionStore.getState().setCompacting(sessionId);
    compactContext(sessionId, {
      onDone: (result) => {
        setIsCompacting(false);
        useCompactionStore.getState().setDone(sessionId, {
          strategy: result.strategy ?? 'session_memory',
          tokensRemoved: result.tokenReduction ?? 0,
          tokensRetained: 0,
        });
        // The worker broadcasts a fresh post-compaction token_usage before
        // compact:done, so a snapshot stamped during this compaction is the
        // authoritative new context size — keep it. Only fall back to
        // dropping the live entry when none arrived (e.g. an older worker
        // bundle), letting the reloaded messages drive the ring.
        const live = useContextUsageStore.getState().liveBySession[sessionId];
        if (!live || live.updatedAt < compactStartedAt) {
          useContextUsageStore.getState().clearLive(sessionId);
        }
        // Distinguish three outcomes so the toast stops lying when nothing happened:
        //   1. strategy === 'none'  → compaction was a no-op (session too short
        //      or nothing left to compact); tell the user instead of saying '0'.
        //   2. strategy ran but removedCount === 0  → ran with an empty cut;
        //      same as no-op from the user's perspective.
        //   3. removedCount > 0  → real compaction; show counts.
        let removedMsg: string;
        if (result.strategy === 'none') {
          removedMsg = 'No compaction needed (conversation too short)';
        } else if (result.removedCount == null || result.removedCount === 0) {
          removedMsg = 'Compaction ran, nothing removed';
        } else {
          removedMsg = `${result.removedCount} messages compacted`;
        }
        const tokenMsg = result.tokenReduction != null && result.tokenReduction > 0
          ? `, ~${Math.round(result.tokenReduction)} tokens saved`
          : '';
        setCompressionNotification(`${removedMsg}${tokenMsg}.`);
        loadThreadMessages(sessionId);
        // Clear the "done" divider after a short delay so it doesn't linger
        setTimeout(() => useCompactionStore.getState().clear(sessionId), 4000);
      },
      onError: (error) => {
        setIsCompacting(false);
        useCompactionStore.getState().setError(sessionId, error);
        setCompressionNotification(`Compression failed: ${error}`);
        setTimeout(() => useCompactionStore.getState().clear(sessionId), 5000);
      },
    });
  }, [sessionId, loadThreadMessages]);

  const requestRecap = useCallback(async () => {
    if (!sessionId) {
      return { success: false, recap: null, error: '暂无活动对话。' };
    }
    try {
      const result = await window.electronAPI?.recap.request(sessionId);
      return result ?? { success: false, recap: null, error: '对话回顾不可用。' };
    } catch {
      return { success: false, recap: null, error: '生成对话回顾失败。' };
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    window.electronAPI?.recap.setActiveSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const cleanup = window.electronAPI?.recap.onRecapResult((data) => {
      // Recap IPC notifications are forwarded so the main-process
      // RecapService can keep its active-session state machine warm;
      // the renderer-side recap UI lives in SlashCommandPopover, which
      // calls requestRecap directly and does not depend on this event.
      void data;
    });
    return () => {
      cleanup?.();
    };
  }, []);

  // End-of-turn next-step suggestions: predicted follow-up prompts shown
  // as cards at the end of the message list. Clicking one prefills (not
  // sends) the input box.
  const {
    suggestions: nextStepSuggestions,
    dismiss: dismissNextStepSuggestions,
  } = useNextStepSuggestions({ sessionId, isStreaming });

  const handleNextStepSelect = useCallback((value: string) => {
    dispatchPrefillChatInput(value);
    dismissNextStepSuggestions();
  }, [dismissNextStepSuggestions]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      ((window as unknown) as Record<string, unknown>).__widgetSendMessage = (text: string) => {
        handleSend(text);
      };
    }
    return () => {
      if (typeof window !== 'undefined') {
        delete ((window as unknown) as Record<string, unknown>).__widgetSendMessage;
      }
    };
  }, [handleSend]);

  const handleScrollToBottom = useCallback(() => {
    if (messageListRef.current) {
      messageListRef.current.scrollToBottom();
    }
  }, []);

  const handleScrollStateChange = useCallback((nearBottom: boolean) => {
    setIsNearBottom(nearBottom);
  }, []);

  return (
    <div className={`chat-view flex flex-col flex-1 min-h-0 relative${taskDrawerOpen ? ' task-card-open' : ''}${workspaceExpanded ? ' panel-expanded' : ''}`}>
      {!workspaceExpanded && activeThread && <ChatHeader thread={activeThread} />}

      {/* Back to parent button when viewing a sub-agent */}
      {(() => {
        const { parentSessionId, goToParentSession, threads } = useConversationStore.getState();
        if (parentSessionId) {
          const parentThread = threads.find(t => t.id === parentSessionId);
          return (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="sub-agent-back-btn"
              onClick={() => goToParentSession()}
              title={`Back to ${parentThread?.title || 'parent'}`}
            >
              <ArrowLeftIcon size={14} />
              <span>Back to {parentThread?.title || 'parent session'}</span>
            </Button>
          );
        }
        return null;
      })()}

      {/* Context compression notification */}
      {compressionNotification && (
        <ContextCompressionToast message={compressionNotification} />
      )}

      {/* Agent error banner with retry */}
      {(phase === 'error' || (streamingError && phase !== 'aborted')) && (() => {
        const isRateLimit = streamingError?.code === 'rate_limit_error';
        const isUsageLimit = streamingError?.code === 'usage_limit_exceeded';
        const isProviderSafetyFilter = streamingError?.code === 'provider_safety_filter';
        const bannerTitle = isRateLimit
          ? t('error.rateLimitTitle')
          : isUsageLimit
            ? t('error.usageLimitTitle')
            : isProviderSafetyFilter
              ? 'Provider safety filter stopped the response'
              : 'Agent Error';
        const bannerMessage = isRateLimit
          ? t('error.rateLimitMessage')
          : isUsageLimit
            ? t('error.usageLimitMessage')
            : isProviderSafetyFilter
              ? 'The model provider blocked the final generated output. DUYA keeps previous tool work and file edits; continue in this session with a narrower request or switch models.'
              : streamingError?.message || 'The agent process encountered an error. You can retry with the same session.';
        return (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex flex-col gap-2 px-4 py-3 bg-red-500/90 text-white text-sm rounded-lg shadow-lg backdrop-blur-sm max-w-md">
            <div className="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 5v3M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="font-medium">{bannerTitle}</span>
            </div>
            <p className="text-white/90 text-xs leading-relaxed">
              {bannerMessage}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleRetry}
              className="self-start px-3 py-1 mt-1 bg-white/20 hover:bg-white/30 text-white text-xs font-medium rounded transition-colors cursor-pointer"
            >
              {t('error.tryAgain')}
            </Button>
          </div>
        </div>
        );
      })()}

      <div className="chat-body-row">
        <div className="chat-main-column">
      <div className="flex-1 min-h-0">
        {messages.length === 0 && !isStreaming ? (
          /* Empty state with SessionSelector and centered input */
          <div className="h-full flex flex-col items-center justify-center px-4">
            <div className="w-full max-w-[800px] flex flex-col items-center">
              <SessionSelector
                selectedProject={selectedProject}
                onSelectProject={handleSelectProject}
                onNewBlankProject={handleNewBlankProject}
                onUseExistingFolder={handleUseExistingFolder}
                onSelectThread={handleSelectThread}
              >
                {/* Input between selector and recent threads */}
                <WorkspaceComposerLayer expanded={workspaceExpanded}>
                <div className={`w-full welcome-message-input workspace-floating-composer${workspaceExpanded ? ' workspace-floating-composer-expanded' : ''}`}>
                  <MessageInput
                    onSend={handleSend}
                    onRecapRequest={requestRecap}
                    onStop={handleStop}
                    disabled={false}
                    isStreaming={isStreaming}
                    hasQueuedMessages={hasQueuedMessages}
                    sessionId={sessionId}
                    modelName={sessionModel}
                    onModelChange={handleModelChange}
                    effort={effort}
                    onEffortChange={setEffort}
                    permissionMode={permissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
                    placeholder={t('chat.typeMessage')}
                    messages={messages}
                    conductorEnabled={conductorEnabled}
                    onConductorChange={handleConductorChange}
                    planModeEnabled={planModeEnabled}
                    onPlanModeChange={handlePlanModeChange}
                    agentPlanMode={agentPlanMode}
                    onCompact={handleCompact}
                    isCompacting={isCompacting}
                    // Welcome page: input sits in the middle, popup must open
                    // below so it doesn't cover the heading / selector above.
                    popoverPlacement="bottom"
                    tasks={floatingTasks}
                    gitStatus={gitStatus}
                    onToggleTaskStatus={handleToggleFloatingTask}
                    workingDirectory={activeThread?.workingDirectory ?? null}
                    showFileChanges={showFileChanges}
                    turnReview={isStreaming ? null : lastTurnReview}
                  />

                  {/* Bottom toolbar - outside input box */}
                  <div className="flex items-center justify-between mt-2 px-1">
                    <AgentProfileBadge profileId={agentProfileId} />
                  </div>
                </div>
                </WorkspaceComposerLayer>
              </SessionSelector>
            </div>
          </div>
        ) : (
          /* Normal message list - full width for scrollbar on right edge */
          <div className="h-full overflow-hidden">
            <MessageList
              ref={messageListRef}
              messages={renderedMessages}
              isStreaming={isStreaming}
              isFinalizing={isFinalizing}
              onForceStop={handleStop}
              onScrollStateChange={handleScrollStateChange}
              sessionId={sessionId}
              onEditSend={handleEditSend}
              nextStepSuggestions={nextStepSuggestions}
              onNextStepSelect={handleNextStepSelect}
            />
          </div>
        )}
      </div>

      {/* Normal input at bottom - only show when there are messages */}
      {(messages.length > 0 || isStreaming) && (
        <WorkspaceComposerLayer expanded={workspaceExpanded}>
        <div className={`p-4 pt-0 chat-composer-shell workspace-floating-composer${workspaceExpanded ? ' workspace-floating-composer-expanded' : ''}`}>
          <div className="max-w-[800px] mx-auto chat-composer-inner">
            {/* Plan 420: live goal status chip */}
            <GoalStatusChip sessionId={sessionId} />
            {/* Scroll to bottom button - shown when not near bottom, floats above content */}
            {!isNearBottom && (
              <div className="flex justify-center absolute left-1/2 -translate-x-1/2" style={{ top: '-48px' }}>
                <button
                  type="button"
                  onClick={handleScrollToBottom}
                  className="flex items-center justify-center w-9 h-9 rounded-full bg-[var(--surface-solid)] border border-[var(--border)] text-[var(--muted)] shadow-[0_4px_12px_rgba(0,0,0,0.15)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors duration-200 animate-in fade-in slide-in-from-bottom-2"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  <CaretDownIcon size={16} strokeWidth={2} />
                </button>
              </div>
            )}

            {pendingAuthRequest && (
              <ConnectorAuthRequiredCard
                request={pendingAuthRequest}
                authCompleted={authCompletedFor !== null && authCompletedFor === pendingAuthRequest.provider}
                onDismiss={dismissAuthRequest}
                onRetry={retryAfterAuth}
                resolveProviderLabel={(id) => id}
              />
            )}

            {!isAskUserQuestionPending && (
              <PermissionPrompt
                pendingPermission={pendingPermission}
                permissionResolved={permissionResolved}
                onPermissionResponse={respondToPermission}
                permissionProfile={permissionProfile}
              />
            )}

            {isStreaming && (
              <MailboxPanel sessionId={sessionId} />
            )}

            {/* Plan 416: task progress row now renders inside the
                composer (no longer a floating pill above it). */}
            {isAskUserQuestionPending ? (
              <PermissionPrompt
                pendingPermission={pendingPermission}
                permissionResolved={permissionResolved}
                onPermissionResponse={respondToPermission}
                permissionProfile={permissionProfile}
              />
            ) : (
              <MessageInput
                onSend={handleSend}
                onRecapRequest={requestRecap}
                onStop={handleStop}
                disabled={false}
                isStreaming={isStreaming}
                hasQueuedMessages={hasQueuedMessages}
                sessionId={sessionId}
                modelName={sessionModel}
                onModelChange={handleModelChange}
                effort={effort}
                onEffortChange={setEffort}
                permissionMode={permissionMode}
                onPermissionModeChange={handlePermissionModeChange}
                placeholder={t('chat.typeMessage')}
                messages={messages}
                conductorEnabled={conductorEnabled}
                onConductorChange={handleConductorChange}
                planModeEnabled={planModeEnabled}
                onPlanModeChange={handlePlanModeChange}
                goalModeEnabled={goalModeEnabled}
                onGoalModeChange={handleGoalModeChange}
                onCompact={handleCompact}
                isCompacting={isCompacting}
                tasks={floatingTasks}
                gitStatus={gitStatus}
                onToggleTaskStatus={handleToggleFloatingTask}
                workingDirectory={activeThread?.workingDirectory ?? null}
                showFileChanges={showFileChanges}
                turnReview={isStreaming ? null : lastTurnReview}
              />
            )}

            {/* Bottom toolbar - outside input box */}
            <div className="flex items-center justify-between mt-2 px-1">
              {/* Left: session-bound Agent Profile Badge (no in-session switching) */}
              <AgentProfileBadge profileId={agentProfileId} />

              {/* Right: Context Usage Ring */}
              {messages.length > 0 && (
                <ContextUsageRing
                  messages={messages}
                  sessionId={sessionId}
                  modelName={sessionModel}
                  contextWindow={capabilityContextWindow}
                  pricing={capabilityPricing}
                  onCompress={handleCompact}
                  isCompacting={isCompacting}
                />
              )}
            </div>
          </div>
        </div>
        </WorkspaceComposerLayer>
      )}
        </div>
        {!workspaceExpanded && <TaskDrawer />}
      </div>

      <InputDialog
        isOpen={isNameProjectDialogOpen}
        title={t('project.nameProject')}
        description={t('project.nameProjectDescription')}
        placeholder={t('project.nameProjectPlaceholder')}
        onConfirm={(value) => {
          handleCreateNamedProject(value);
        }}
        onCancel={() => setIsNameProjectDialogOpen(false)}
      />
    </div>
  );
}
