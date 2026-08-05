// ChatView.tsx - Main chat container component (CodePilot style)

'use client';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '@/hooks/useTranslation';
import type { Message } from '@/types';
import { MessageList, type MessageListRef } from './MessageList';
import { MessageInput } from './MessageInput';
import { PermissionPrompt } from './PermissionPrompt';
import { usePermissions } from '@/hooks/usePermissions';
import { subscribeToPermissions, subscribeToPhase, subscribeToModeChanged } from '@/lib/stream-session-manager';
import { InfoIcon, CaretDownIcon } from '@/components/icons';
import type { PermissionMode } from './PermissionModeSelector';
import { ChatHeader } from './ChatHeader';
import { DB_DEFAULT_MODEL } from '@/lib/constants';
import { getThreadIPC, updateThreadIPC, getProviderIPC, getModelCapabilityIPC } from '@/lib/ipc-client';
import { useSettings } from '@/hooks/useSettings';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingError } from '@/hooks/useStreamingError';
import { useConversationStore } from '@/stores/conversation-store';
import { useMailboxStore } from '@/stores/mailbox-store';
import { useShallow } from 'zustand/react/shallow';
import type { MailboxRow } from '@/stores/mailbox-store';
import type { FileAttachment } from '@/types/message';
import { MailboxPanel } from './MailboxPanel';
import { compactContext } from '@/lib/agent-sse-client';
import { projectMessageTranscript } from '@/lib/project-message-transcript';
import { AgentModeSelector, getProfileIdForMode, getModeForProfileId } from './AgentModeSelector';
import type { AgentMode } from './AgentModeSelector';
import { ContextUsageRing } from './ContextUsageRing';
import { setSessionAgentProfile } from '@/lib/agent-profile-ipc';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionSelector } from '@/components/home/SessionSelector';
import { InputDialog } from '@/components/ui/InputDialog';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { TaskDrawer } from '@/components/layout/TaskDrawer';
import { useTaskDrawerOpen } from '@/components/layout/task-drawer-store';
import { FloatingTaskPanel } from '@/components/layout/FloatingTaskPanel';
import { useTaskList } from '@/hooks/useTaskList';
import { useGitStatus } from '@/hooks/useGitStatus';
import { getGitStatus } from '@/lib/git-ipc';
import type { UseGitStatusResult } from '@/hooks/useGitStatus';
import { useOptionalPanel } from '@/hooks/usePanel';
import { useConductorStore } from '@duya/conductor/renderer/stores/conductor-store';
import type { ConductorCanvas } from '@duya/conductor/renderer/types/conductor';

interface ChatViewProps {
  sessionId: string;
  messages: Message[];
  /**
   * 普通 send 不再携带 permissionMode. worker 从 session row.permission_profile 派生.
   * 第一个参数 permissionMode 保留签名兼容 (App.handleSendMessage 还在声明), 但不使用.
   */
  onSendMessage: (content: string, permissionMode?: PermissionMode, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string, conductorMode?: boolean, queuedMailboxId?: string) => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
  /** The final persisted reply is loading; keep the existing stream view until it arrives. */
  isFinalizing?: boolean;
  hasQueuedMessages?: boolean;
}

const NOOP_OPEN_PANEL = () => '';
const NOOP_CLOSE_PANEL = () => {};

// Hoisted (plan 236 Phase 5) so the sub-agent poll timer doesn't
// allocate a fresh Set on every interval tick.
const ACTIVE_PARENT_PHASES = new Set<string>([
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
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [permissionUpdatePending, setPermissionUpdatePending] = useState(false);
  const [agentMode, setAgentMode] = useState<AgentMode>('main');
  const [agentProfileId, setAgentProfileId] = useState<string | null>(getProfileIdForMode('main'));
  const [effort, setEffortState] = useState<string | undefined>(settings.defaultThinkingEffort ?? undefined);

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
  const [compactionStatus, setCompactionStatus] = useState<'idle' | 'compacting' | 'done' | 'error'>('idle');
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

  // Poll tasks for the floating task panel above the composer.
  useEffect(() => {
    if (!sessionId) return;
    const id = setInterval(() => {
      void fetchFloatingTasks();
    }, 1500);
    return () => clearInterval(id);
  }, [sessionId, fetchFloatingTasks]);

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

  // Clear baseline when the session changes so the pill from a previous
  // session does not bleed into the new one.
  useEffect(() => {
    setGitBaseline(null);
    baselineCapturedRef.current = false;
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
  const permissionProfile = permissionMode === 'bypass' ? 'full_access' : permissionMode === 'auto' ? 'auto' : 'default';

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

            if (data.thread.permissionProfile) {
              // Map DB values to UI PermissionMode:
              // 'full_access'/'bypassPermissions'/'bypass' -> 'bypass'
              // 'auto' -> 'auto'
              // 'default' and others -> 'ask'
              const dbProfile = data.thread.permissionProfile;
              const mappedMode: PermissionMode = (dbProfile === 'full_access' || dbProfile === 'bypassPermissions' || dbProfile === 'bypass')
                ? 'bypass'
                : dbProfile === 'auto'
                  ? 'auto'
                  : 'ask';
              setPermissionMode(mappedMode);
            } else {
              // 历史 row 缺 permission_profile, 极少见 (schema DEFAULT 'default' 一直在).
              // 保守置 'ask', 让 selector 立即可用, 后续用户切 mode 会写入 row.
              console.warn('[ChatView] thread missing permissionProfile, defaulting UI to ask', { sessionId });
              setPermissionMode('ask');
            }

            // Load agent profile binding and sync to mode
            const agentProfileIdFromDb = data.thread.agentProfileId;
            if (agentProfileIdFromDb) {
              setAgentProfileId(agentProfileIdFromDb);
              // Sync mode to match loaded profile
              const mode = getModeForProfileId(agentProfileIdFromDb);
              if (mode) {
                setAgentMode(mode);
              }
            } else {
              // Reset to main when session has no profile set
              setAgentMode('main');
              setAgentProfileId(getProfileIdForMode('main'));
            }

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
      return;
    }
    const { modelName: pureModel } = parseModelName(sessionModel);
    if (!pureModel) {
      setCapabilityContextWindow(undefined);
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
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilityContextWindow(undefined);
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

  // Handle permission mode change - persist to session.
  // 改为 async + 设置 permissionUpdatePending, 防止用户切 mode 后立即发送, 出现 row 未落库就发消息的竞态.
  // DB stores 'default' for ask, 'auto' for auto, 'full_access' for bypass.
  const handlePermissionModeChange = useCallback(async (mode: PermissionMode) => {
    setPermissionMode(mode);
    if (sessionId) {
      const dbProfile = mode === 'bypass' ? 'full_access' : mode === 'auto' ? 'auto' : 'default';
      setPermissionUpdatePending(true);
      try {
        await updateThreadIPC(sessionId, { permissionProfile: dbProfile });
      } catch (err) {
        console.error('[ChatView] failed to persist permission mode', err);
      } finally {
        setPermissionUpdatePending(false);
      }
    }
  }, [sessionId]);

  // Subscribe to permission events from SSE
  useEffect(() => {
    const unsubscribe = subscribeToPermissions(sessionId, handlePermissionRequest);
    return () => {
      unsubscribe();
    };
  }, [sessionId, handlePermissionRequest]);

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

  useEffect(() => {
    if (!parentSessionId) return;

    let parentPhase: string = 'idle';
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (pollTimer || !ACTIVE_PARENT_PHASES.has(parentPhase)) return;
      pollTimer = setInterval(() => {
        if (!ACTIVE_PARENT_PHASES.has(parentPhase)) {
          stopPolling();
          return;
        }
        loadThreadMessagesRef.current(sessionId);
      }, 3000);
    };

    const unsubPhase = subscribeToPhase(parentSessionId, (phase) => {
      parentPhase = phase;
      if (ACTIVE_PARENT_PHASES.has(parentPhase)) {
        startPolling();
      } else {
        stopPolling();
      }
    });

    return () => {
      stopPolling();
      unsubPhase();
    };
  }, [sessionId, parentSessionId]);

  const handleSend = useCallback(
    async (content: string, files?: FileAttachment[], outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, displayContent?: string) => {
      lastUserContentRef.current = content;
      lastFilesRef.current = files;
      lastOutputStyleRef.current = outputStyleConfig;
      if (isStreaming) {
        const queuedRow = await sendMailbox({
          sessionId,
          content,
          kind: 'followup',
          submittedDuringRunId: sessionId,
          attachments: files,
        });
        if (queuedRow && !queuedRow.id.startsWith('optimistic-')) {
          const { modelName: actualModel } = parseModelName(sessionModel || '');
          onSendMessage(
            content,
            permissionMode ?? undefined,
            actualModel,
            files,
            agentProfileId,
            outputStyleConfig,
            mode,
            effort,
            displayContent,
            conductorEnabled,
            queuedRow.id,
          );
        }
        return;
      }
      // New round: reset the git baseline so the floating pill captures
      // a fresh snapshot when streaming begins.
      setGitBaseline(null);
      baselineCapturedRef.current = false;
      // Parse model format: "[providerName] modelName" to extract pure model name
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      onSendMessage(content, permissionMode ?? undefined, actualModel, files, agentProfileId, outputStyleConfig, mode, effort, displayContent, conductorEnabled);
    },
    [agentProfileId, isStreaming, onSendMessage, parseModelName, permissionMode, sendMailbox, sessionId, sessionModel, effort, conductorEnabled]
  );

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
      onSendMessage(lastContent, permissionMode ?? undefined, actualModel, lastFilesRef.current, agentProfileId, lastOutputStyleRef.current, undefined, effort);
    }
  }, [onSendMessage, permissionMode, sessionModel, parseModelName, agentProfileId, effort]);

  // Inline edit-and-resend: delete the target user message (and everything
  // after it), then send the edited text as a fresh message. Only the last
  // user message is editable (enforced by MessageList via isEditable).
  const handleEditSend = useCallback(async (messageId: string, text: string) => {
    if (isStreaming || !text.trim() || !sessionId) return;
    try {
      await deleteMessageAndAfter(sessionId, messageId);
    } catch (err) {
      console.error('[ChatView] edit-and-resend: deleteMessageAndAfter failed', err);
      return;
    }
    const { modelName: actualModel } = parseModelName(sessionModel || '');
    onSendMessage(text, permissionMode ?? undefined, actualModel, undefined, agentProfileId, lastOutputStyleRef.current, undefined, effort, text, conductorEnabled);
  }, [isStreaming, sessionId, deleteMessageAndAfter, parseModelName, sessionModel, permissionMode, onSendMessage, agentProfileId, effort, conductorEnabled]);

  const handleCompact = useCallback(() => {
    if (!sessionId) return;
    setIsCompacting(true);
    setCompactionStatus('compacting');
    compactContext(sessionId, {
      onDone: (result) => {
        setIsCompacting(false);
        setCompactionStatus('done');
        const removedMsg = result.removedCount != null ? `${result.removedCount} messages compacted` : 'Context compressed';
        const tokenMsg = result.tokenReduction != null ? `, ~${Math.round(result.tokenReduction)} tokens saved` : '';
        setCompressionNotification(`${removedMsg}${tokenMsg}.`);
        loadThreadMessages(sessionId);
        // Clear the "done" divider after a short delay so it doesn't linger
        setTimeout(() => setCompactionStatus('idle'), 4000);
      },
      onError: (error) => {
        setIsCompacting(false);
        setCompactionStatus('error');
        setCompressionNotification(`Compression failed: ${error}`);
        setTimeout(() => setCompactionStatus('idle'), 5000);
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
                  <FloatingTaskPanel
                  tasks={floatingTasks}
                  gitStatus={gitStatus}
                  onToggleStatus={handleToggleFloatingTask}
                  workingDirectory={activeThread?.workingDirectory ?? null}
                  showFileChanges={showFileChanges}
                />

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
                    permissionUpdatePending={permissionUpdatePending}
                    placeholder={t('chat.typeMessage')}
                    messages={messages}
                    conductorEnabled={conductorEnabled}
                    onConductorChange={handleConductorChange}
                    agentPlanMode={agentPlanMode}
                    onCompact={handleCompact}
                    isCompacting={isCompacting}
                    // Welcome page: input sits in the middle, popup must open
                    // below so it doesn't cover the heading / selector above.
                    popoverPlacement="bottom"
                  />

                  {/* Bottom toolbar - outside input box */}
                  <div className="flex items-center justify-between mt-2 px-1">
                    <AgentModeSelector
                      value={agentMode}
                      onChange={async (mode) => {
                        setAgentMode(mode);
                        const profileId = getProfileIdForMode(mode);
                        setAgentProfileId(profileId);
                        if (sessionId) {
                          try {
                            await setSessionAgentProfile(sessionId, profileId);
                          } catch (error) {
                            console.error('[ChatView] Failed to set agent profile:', error);
                          }
                        }
                      }}
                      disabled={isStreaming}
                    />
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
              compactionStatus={compactionStatus}
            />
          </div>
        )}
      </div>

      {/* Normal input at bottom - only show when there are messages */}
      {(messages.length > 0 || isStreaming) && (
        <WorkspaceComposerLayer expanded={workspaceExpanded}>
        <div className={`p-4 pt-0 chat-composer-shell workspace-floating-composer${workspaceExpanded ? ' workspace-floating-composer-expanded' : ''}`}>
          <div className="max-w-[800px] mx-auto chat-composer-inner">
            {/* Scroll to bottom button - shown when not near bottom, floats above content */}
            {!isNearBottom && (
              <div className="flex justify-center absolute left-1/2 -translate-x-1/2" style={{ top: '-44px' }}>
                <IconButton
                  variant="default"
                  size="md"
                  shape="round"
                  onClick={handleScrollToBottom}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--main-bg)] border border-[var(--border)] shadow-md hover:shadow-lg transition-all duration-200 hover:scale-105"
                  style={{
                    boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 0 0 1px var(--border)',
                  }}
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                >
                  <CaretDownIcon size={18} style={{ color: 'var(--muted)' }} />
                </IconButton>
              </div>
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

            {/* Floating task progress above the composer */}
            <FloatingTaskPanel
              tasks={floatingTasks}
              gitStatus={gitStatus}
              onToggleStatus={handleToggleFloatingTask}
              workingDirectory={activeThread?.workingDirectory ?? null}
              showFileChanges={showFileChanges}
            />

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
                permissionUpdatePending={permissionUpdatePending}
                placeholder={t('chat.typeMessage')}
                messages={messages}
                conductorEnabled={conductorEnabled}
                onConductorChange={handleConductorChange}
                onCompact={handleCompact}
                isCompacting={isCompacting}
              />
            )}

            {/* Bottom toolbar - outside input box */}
            <div className="flex items-center justify-between mt-2 px-1">
              {/* Left: Agent Mode Selector */}
              <AgentModeSelector
                value={agentMode}
                onChange={async (mode) => {
                  setAgentMode(mode);
                  const profileId = getProfileIdForMode(mode);
                  setAgentProfileId(profileId);
                  // Persist to session
                  if (sessionId) {
                    try {
                      await setSessionAgentProfile(sessionId, profileId);
                    } catch (error) {
                      console.error('[ChatView] Failed to set agent profile:', error);
                    }
                  }
                }}
                disabled={isStreaming}
              />

              {/* Right: Context Usage Ring */}
              {messages.length > 0 && (
                <ContextUsageRing
                  messages={messages}
                  modelName={sessionModel}
                  contextWindow={capabilityContextWindow}
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
