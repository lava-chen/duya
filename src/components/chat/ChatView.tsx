// ChatView.tsx - Main chat container component (CodePilot style)

'use client';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '@/hooks/useTranslation';
import type { Message } from '@/types';
import { MessageList, type MessageListRef } from './MessageList';
import { MessageInput } from './MessageInput';
import { PermissionPrompt } from './PermissionPrompt';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { SkillReviewIndicator } from './SkillReviewIndicator';
import { usePermissions } from '@/hooks/usePermissions';
import { subscribeToPermissions, subscribeToPhase } from '@/lib/stream-session-manager';
import { Info, CaretDown } from '@phosphor-icons/react';
import type { PermissionMode } from './PermissionModeSelector';
import { ChatHeader } from './ChatHeader';
import { DB_DEFAULT_MODEL } from '@/lib/constants';
import { getThreadIPC, updateThreadIPC, listThreadsByParentIdIPC, getProviderIPC, getModelCapabilityIPC } from '@/lib/ipc-client';
import { useSettings } from '@/hooks/useSettings';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingContextUsage } from '@/hooks/useStreamingContextUsage';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingError } from '@/hooks/useStreamingError';
import { useConversationStore } from '@/stores/conversation-store';
import { useMailboxStore } from '@/stores/mailbox-store';
import type { FileAttachment } from '@/types/message';
import { SubAgentPanel } from './SubAgentPanel';
import { MailboxPanel } from './MailboxPanel';
import { compactContext } from '@/lib/agent-sse-client';
import { AgentModeSelector, getProfileIdForMode, getModeForProfileId } from './AgentModeSelector';
import type { AgentMode } from './AgentModeSelector';
import { ContextUsageRing } from './ContextUsageRing';
import { setSessionAgentProfile } from '@/lib/agent-profile-ipc';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionSelector } from '@/components/home/SessionSelector';
import { InputDialog } from '@/components/ui/InputDialog';
import { setRecap } from '@/components/layout/recap-store';
import { subscribeWikiActivityIPC } from '@/lib/memory-ipc';
import { TaskDrawer } from '@/components/layout/TaskDrawer';
import { useTaskDrawerOpen } from '@/components/layout/task-drawer-store';
import { usePanel } from '@/hooks/usePanel';

interface ChatViewProps {
  sessionId: string;
  messages: Message[];
  /**
   * 普通 send 不再携带 permissionMode. worker 从 session row.permission_profile 派生.
   * 第一个参数 permissionMode 保留签名兼容 (App.handleSendMessage 还在声明), 但不使用.
   */
  onSendMessage: (content: string, permissionMode?: PermissionMode, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string) => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
  hasQueuedMessages?: boolean;
}

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
        <Info size={16} weight="fill" />
        <span>{message}</span>
      </div>
    </div>
  );
}

function WikiAgentToast({
  message,
  error = false,
}: {
  message: string;
  error?: boolean;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
    }, 4500);
    return () => clearTimeout(timer);
  }, [message]);

  if (!visible) return null;

  return (
    <div className="absolute top-16 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300">
      <div
        className="flex items-center gap-2 px-4 py-2 text-white text-sm rounded-lg shadow-lg backdrop-blur-sm"
        style={{ background: error ? 'rgba(220, 38, 38, 0.9)' : 'rgba(31, 41, 55, 0.92)' }}
      >
        <span className="font-medium">WikiAgent</span>
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
  const [effort, setEffort] = useState<string | undefined>(undefined);
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isCompacting, setIsCompacting] = useState(false);
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
  const [wikiActivityMessage, setWikiActivityMessage] = useState<{ text: string; error: boolean; nonce: number } | null>(null);
  const messageListRef = useRef<MessageListRef>(null);
  const taskDrawerOpen = useTaskDrawerOpen();
  const { workspaceExpanded } = usePanel();

  // Project state derived from store threads
  const storeThreads = useConversationStore(s => s.threads);
  const setThreadWorkingDirectory = useConversationStore(s => s.setThreadWorkingDirectory);
  const setThreadModel = useConversationStore(s => s.setThreadModel);
  const addProjectFolder = useConversationStore(s => s.addProjectFolder);
  const setActiveThread = useConversationStore(s => s.setActiveThread);
  const rewindToMessage = useConversationStore(s => s.rewindToMessage);
  const sendMailbox = useMailboxStore(s => s.send);

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
  const contextUsage = useStreamingContextUsage(sessionId);
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
          }
        })
        .catch(console.error);
    }
  }, [sessionId, settings.lastSelectedModel]);

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
  const handleModelChange = useCallback((model: string) => {
    setSessionModel(model);
    // Save pure model name to session (parse UI format if needed).
    // The store action re-syncs the row to the DB, so the call below
    // covers what an inline updateThreadIPC used to do, plus the
    // in-memory store update that App.handleSendMessage reads.
    if (sessionId) {
      const { modelName } = parseModelName(model);
      setThreadModel(sessionId, modelName, sessionProviderId);
    }
    // Save to global settings for cross-session memory (keep UI format for display consistency)
    if (model) {
      saveSettings({ lastSelectedModel: model }).catch(console.error);
    }
  }, [sessionId, saveSettings, parseModelName, setThreadModel, sessionProviderId]);

  // Handle provider change - persist provider ID to session.
  // Mirror to the store so App.handleSendMessage reads the new
  // providerId without an extra DB round-trip. Without this, the
  // worker keeps using the previous provider's API key/baseURL even
  // though the user just picked a different provider.
  const handleProviderChange = useCallback((providerId: string) => {
    if (sessionId && providerId) {
      const { modelName } = parseModelName(sessionModel);
      setThreadModel(sessionId, modelName, providerId);
    }
  }, [sessionId, sessionModel, parseModelName, setThreadModel]);

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

  // When viewing a sub-agent session, periodically reload messages from DB
  // while the parent session is still streaming
  const parentSessionId = useConversationStore(s => s.parentSessionId);
  const loadThreadMessages = useConversationStore(s => s.loadThreadMessages);

  useEffect(() => {
    if (!parentSessionId) return;

    let parentPhase: string = 'idle';
    const unsubPhase = subscribeToPhase(parentSessionId, (phase) => {
      parentPhase = phase;
    });

    const isActive = () =>
      parentPhase === 'starting' || parentPhase === 'streaming' ||
      parentPhase === 'awaiting_permission' || parentPhase === 'persisting';

    const stopPhases = new Set(['completed', 'error', 'idle']);
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    pollTimer = setInterval(() => {
      if (stopPhases.has(parentPhase)) {
        if (pollTimer) clearInterval(pollTimer);
        return;
      }
      if (isActive()) {
        loadThreadMessages(sessionId);
      }
    }, 3000);

    return () => {
      if (pollTimer) clearInterval(pollTimer);
      unsubPhase();
    };
  }, [sessionId, parentSessionId, loadThreadMessages]);

  const handleSend = useCallback(
    (content: string, files?: FileAttachment[], outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, displayContent?: string) => {
      lastUserContentRef.current = content;
      lastFilesRef.current = files;
      lastOutputStyleRef.current = outputStyleConfig;
      if (isStreaming) {
        void sendMailbox({
          sessionId,
          content,
          kind: 'followup',
          submittedDuringRunId: sessionId,
          attachments: files,
        });
        return;
      }
      // Parse model format: "[providerName] modelName" to extract pure model name
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      onSendMessage(content, permissionMode ?? undefined, actualModel, files, agentProfileId, outputStyleConfig, mode, effort, displayContent);
    },
    [agentProfileId, isStreaming, onSendMessage, parseModelName, permissionMode, sendMailbox, sessionId, sessionModel, effort]
  );

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

  const handleRewindToMessage = useCallback((messageId: string) => {
    if (isStreaming) return;
    const targetIndex = messages.findIndex(m => m.id === messageId);
    if (targetIndex === -1 || targetIndex === messages.length - 1) return;
    const confirmed = window.confirm('回退到此消息后，该消息之后的所有对话将被删除，是否继续？');
    if (!confirmed) return;
    rewindToMessage(sessionId, messageId);
  }, [isStreaming, messages, sessionId, rewindToMessage]);

  const handleCompact = useCallback(() => {
    if (!sessionId) return;
    setIsCompacting(true);
    compactContext(sessionId, {
      onDone: (result) => {
        setIsCompacting(false);
        const removedMsg = result.removedCount != null ? `${result.removedCount} messages compacted` : 'Context compressed';
        const tokenMsg = result.tokenReduction != null ? `, ~${Math.round(result.tokenReduction)} tokens saved` : '';
        setCompressionNotification(`${removedMsg}${tokenMsg}.`);
        loadThreadMessages(sessionId);
      },
      onError: (error) => {
        setIsCompacting(false);
        setCompressionNotification(`Compression failed: ${error}`);
      },
    });
  }, [sessionId, loadThreadMessages]);

  const handleRecapCommand = useCallback(async (command: string) => {
    if (command === '/recap' && sessionId) {
      const result = await window.electronAPI?.recap.request(sessionId);
      if (result?.success && result.recap) {
        setRecap({ text: result.recap, receivedAt: Date.now(), sessionId });
      }
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    window.electronAPI?.recap.setActiveSession(sessionId);
  }, [sessionId]);

  useEffect(() => {
    const cleanup = window.electronAPI?.recap.onRecapResult((data) => {
      if (data.recap) {
        setRecap({
          text: data.recap,
          receivedAt: data.timestamp,
          sessionId: data.sessionId,
        });
      }
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

  useEffect(() => {
    const unsubscribe = subscribeWikiActivityIPC((activity) => {
      if (activity.sessionId !== sessionId || !activity.summary) {
        return;
      }

      setWikiActivityMessage({
        text: activity.summary,
        error: activity.state === 'error' || activity.phase === 'error',
        nonce: Date.now(),
      });
    });

    return unsubscribe;
  }, [sessionId]);

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
            <button
              type="button"
              className="sub-agent-back-btn"
              onClick={() => goToParentSession()}
              title={`Back to ${parentThread?.title || 'parent'}`}
            >
              <ArrowLeftIcon size={14} />
              <span>Back to {parentThread?.title || 'parent session'}</span>
            </button>
          );
        }
        return null;
      })()}

      {/* Context compression notification */}
      {compressionNotification && (
        <ContextCompressionToast message={compressionNotification} />
      )}

      {wikiActivityMessage && (
        <WikiAgentToast
          key={wikiActivityMessage.nonce}
          message={wikiActivityMessage.text}
          error={wikiActivityMessage.error}
        />
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
            <button
              type="button"
              onClick={handleRetry}
              className="self-start px-3 py-1 mt-1 bg-white/20 hover:bg-white/30 text-white text-xs font-medium rounded transition-colors cursor-pointer"
            >
              {t('error.tryAgain')}
            </button>
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
                  <SkillReviewIndicator sessionId={sessionId} />
                  <MessageInput
                    onSend={handleSend}
                    onCommand={handleRecapCommand}
                    onStop={handleStop}
                    disabled={false}
                    isStreaming={isStreaming}
                    hasQueuedMessages={hasQueuedMessages}
                    sessionId={sessionId}
                    modelName={sessionModel}
                    onModelChange={handleModelChange}
                    onProviderChange={handleProviderChange}
                    effort={effort}
                    onEffortChange={setEffort}
                    permissionMode={permissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
                    permissionUpdatePending={permissionUpdatePending}
                    placeholder={t('chat.typeMessage')}
                    messages={messages}
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
            {/* Context usage indicator - only show when streaming */}
            {isStreaming && (
              <div className="max-w-[800px] mx-auto px-4 py-2">
                <ContextUsageIndicator contextUsage={contextUsage} />
              </div>
            )}
            <MessageList
              ref={messageListRef}
              messages={messages}
              isStreaming={isStreaming}
              onForceStop={handleStop}
              onScrollStateChange={handleScrollStateChange}
              sessionId={sessionId}
              onRewindToMessage={handleRewindToMessage}
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
                <button
                  onClick={handleScrollToBottom}
                  className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--main-bg)] border border-[var(--border)] shadow-md hover:shadow-lg transition-all duration-200 hover:scale-105"
                  style={{
                    boxShadow: '0 2px 8px rgba(0,0,0,0.12), 0 0 0 1px var(--border)',
                  }}
                  title="Scroll to bottom"
                >
                  <CaretDown size={18} style={{ color: 'var(--muted)' }} />
                </button>
              </div>
            )}

            {/* Sub-agent panel - aligned to input width so it tracks the input box on resize */}
            <SubAgentPanel
              sessionId={sessionId}
              onOpenSubAgent={async (_agentName, agentSessionId) => {
                console.log('[ChatView] onOpenSubAgent called:', agentSessionId?.slice(0, 8));
                if (agentSessionId) {
                  useConversationStore.getState().setActiveThread(agentSessionId);
                } else {
                  console.log('[ChatView] No agentSessionId, trying fallback...');
                  try {
                    const children = await listThreadsByParentIdIPC(sessionId);
                    console.log('[ChatView] listThreadsByParentIdIPC children:', children.length);
                    const fallback = children.find(c => c.agentType === 'sub-agent');
                    if (fallback) {
                      console.log('[ChatView] Using fallback:', fallback.id.slice(0, 8));
                      useConversationStore.getState().setActiveThread(fallback.id);
                    }
                  } catch (err) {
                    console.error('[ChatView] Failed to open sub-agent:', err);
                  }
                }
              }}
            />

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
                onCommand={handleRecapCommand}
                onStop={handleStop}
                disabled={false}
                isStreaming={isStreaming}
                hasQueuedMessages={hasQueuedMessages}
                sessionId={sessionId}
                modelName={sessionModel}
                onModelChange={handleModelChange}
                onProviderChange={handleProviderChange}
                effort={effort}
                onEffortChange={setEffort}
                permissionMode={permissionMode}
                onPermissionModeChange={handlePermissionModeChange}
                permissionUpdatePending={permissionUpdatePending}
                placeholder={t('chat.typeMessage')}
                messages={messages}
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
