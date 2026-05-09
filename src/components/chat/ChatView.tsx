// ChatView.tsx - Main chat container component (CodePilot style)

'use client';

import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { Message } from '@/types';
import { MessageList, type MessageListRef } from './MessageList';
import { MessageInput } from './MessageInput';
import { PermissionPrompt } from './PermissionPrompt';
import { ContextUsageIndicator } from './ContextUsageIndicator';
import { usePermissions } from '@/hooks/usePermissions';
import { subscribeToPermissions, subscribeToPhase } from '@/lib/stream-session-manager';
import { Info, CaretDown } from '@phosphor-icons/react';
import type { PermissionMode } from './PermissionModeSelector';
import { DB_DEFAULT_MODEL } from '@/lib/constants';
import { getThreadIPC, updateThreadIPC, listThreadsByParentIdIPC } from '@/lib/ipc-client';
import { useSettings } from '@/hooks/useSettings';
import { useStreamPhase } from '@/hooks/useStreamPhase';
import { useStreamingContextUsage } from '@/hooks/useStreamingContextUsage';
import { useStreamingTools } from '@/hooks/useStreamingTools';
import { useStreamingError } from '@/hooks/useStreamingError';
import { useConversationStore } from '@/stores/conversation-store';
import type { FileAttachment } from '@/types/message';
import { SubAgentPanel } from './SubAgentPanel';
import { AgentModeSelector, getProfileIdForMode, getModeForProfileId } from './AgentModeSelector';
import type { AgentMode } from './AgentModeSelector';
import { ContextUsageRing } from './ContextUsageRing';
import { setSessionAgentProfile } from '@/lib/agent-profile-ipc';
import { ArrowLeftIcon } from '@/components/icons';
import { SessionSelector } from '@/components/home/SessionSelector';

interface ChatViewProps {
  sessionId: string;
  messages: Message[];
  onSendMessage: (content: string, permissionMode?: PermissionMode, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null) => void;
  onInterrupt?: () => void;
  isStreaming?: boolean;
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

export function ChatView({
  sessionId,
  messages,
  onSendMessage,
  onInterrupt,
  isStreaming = false,
}: ChatViewProps) {
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const [compressionNotification, setCompressionNotification] = useState<string | null>(null);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [agentProfileId, setAgentProfileId] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>('main');
  const [isNearBottom, setIsNearBottom] = useState(true);
  const [isCompacting, setIsCompacting] = useState(false);
  const messageListRef = useRef<MessageListRef>(null);

  // Project state derived from store threads
  const storeThreads = useConversationStore(s => s.threads);
  const setThreadWorkingDirectory = useConversationStore(s => s.setThreadWorkingDirectory);
  const setActiveThread = useConversationStore(s => s.setActiveThread);

  const selectedProject = useMemo(() => {
    const thread = storeThreads.find(t => t.id === sessionId);
    if (thread?.workingDirectory) {
      return { workingDirectory: thread.workingDirectory, projectName: thread.projectName || thread.workingDirectory };
    }
    return null;
  }, [storeThreads, sessionId]);

  const handleSelectProject = useCallback((project: { workingDirectory: string; projectName: string }) => {
    setThreadWorkingDirectory(sessionId, project.workingDirectory, project.projectName);
  }, [sessionId, setThreadWorkingDirectory]);

  const handleOpenNewProject = useCallback(() => {
    if (window.electronAPI?.dialog?.openFolder) {
      window.electronAPI.dialog.openFolder({
        title: "Select Project Folder",
      }).then((result: { canceled: boolean; filePaths: string[] }) => {
        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          const projectName = workingDirectory.split(/[\\/]/).pop() || "Untitled";
          setThreadWorkingDirectory(sessionId, workingDirectory, projectName);
        }
      });
    }
  }, [sessionId, setThreadWorkingDirectory]);

  const handleSelectThread = useCallback((threadId: string) => {
    setActiveThread(threadId);
  }, [setActiveThread]);

  // Use fine-grained hooks for streaming state
  const phase = useStreamPhase(sessionId);
  const contextUsage = useStreamingContextUsage(sessionId);
  const { uses } = useStreamingTools(sessionId);
  const streamingError = useStreamingError(sessionId);
  const lastUserContentRef = useRef<string>('');

  // Permission system
  const {
    pendingPermission,
    permissionResolved,
    respondToPermission,
    handlePermissionRequest,
  } = usePermissions({
    sessionId,
    permissionProfile: permissionMode === 'bypass' ? 'full_access' : 'default',
  });

  // Load session model and permission mode on mount
  // Priority: 1) session saved model (if not default) 2) lastSelectedModel
  useEffect(() => {
    if (sessionId) {
      getThreadIPC(sessionId)
        .then(async data => {
          if (data?.thread) {
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
                  const { getProviderIPC } = await import('@/lib/ipc-client');
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
              // Map DB values to UI PermissionMode: 'full_access'/'bypassPermissions' -> 'bypass', others -> 'ask'
              const dbProfile = data.thread.permissionProfile;
              const mappedMode: PermissionMode = (dbProfile === 'full_access' || dbProfile === 'bypassPermissions' || dbProfile === 'bypass')
                ? 'bypass'
                : 'ask';
              setPermissionMode(mappedMode);
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
              setAgentProfileId(null);
              setAgentMode('main');
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

  // Handle model change - persist to session AND global settings
  const handleModelChange = useCallback((model: string) => {
    setSessionModel(model);
    // Save pure model name to session (parse UI format if needed)
    if (sessionId) {
      const { modelName } = parseModelName(model);
      updateThreadIPC(sessionId, { model: modelName }).catch(console.error);
    }
    // Save to global settings for cross-session memory (keep UI format for display consistency)
    if (model) {
      saveSettings({ lastSelectedModel: model }).catch(console.error);
    }
  }, [sessionId, saveSettings, parseModelName]);

  // Handle provider change - persist provider ID to session
  const handleProviderChange = useCallback((providerId: string) => {
    if (sessionId && providerId) {
      updateThreadIPC(sessionId, { providerId }).catch(console.error);
    }
  }, [sessionId]);

  // Handle permission mode change - persist to session
  // DB stores 'default' for ask mode and 'full_access' for bypass mode (CodePilot compatible)
  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
    if (sessionId) {
      const dbProfile = mode === 'bypass' ? 'full_access' : 'default';
      updateThreadIPC(sessionId, { permissionProfile: dbProfile }).catch(console.error);
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
    (content: string, files?: FileAttachment[], outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null) => {
      lastUserContentRef.current = content;
      // Parse model format: "[providerName] modelName" to extract pure model name
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      onSendMessage(content, permissionMode, actualModel, files, agentProfileId, outputStyleConfig);
    },
    [onSendMessage, permissionMode, sessionModel, parseModelName, agentProfileId]
  );

  const handleStop = useCallback(() => {
    onInterrupt?.();
  }, [onInterrupt]);

  const handleRetry = useCallback(() => {
    const lastContent = lastUserContentRef.current;
    if (lastContent) {
      const { modelName: actualModel } = parseModelName(sessionModel || '');
      onSendMessage(lastContent, permissionMode, actualModel, undefined, agentProfileId);
    }
  }, [onSendMessage, permissionMode, sessionModel, parseModelName, agentProfileId]);

  const handleCompact = useCallback(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (api && sessionId) {
      setIsCompacting(true);
      api.compactContext(sessionId);
    }
  }, [sessionId]);

  // Listen for compaction completion and errors
  useEffect(() => {
    const api = window.electronAPI?.getAgentPort?.();
    if (!api) return;

    const cleanupDone = api.onCompactDone(() => {
      setIsCompacting(false);
      setCompressionNotification('Context compressed successfully.');
    });
    const cleanupError = api.onCompactError((message) => {
      setIsCompacting(false);
      setCompressionNotification(`Compression failed: ${message}`);
    });

    return () => {
      cleanupDone();
      cleanupError();
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
    <div className="chat-view flex flex-col flex-1 min-h-0 relative">
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

      {/* Agent error banner with retry */}
      {(phase === 'error' || streamingError) && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-in fade-in slide-in-from-top-2 duration-300">
          <div className="flex flex-col gap-2 px-4 py-3 bg-red-500/90 text-white text-sm rounded-lg shadow-lg backdrop-blur-sm max-w-md">
            <div className="flex items-center gap-2">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 5v3M8 10.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span className="font-medium">Agent Error</span>
            </div>
            <p className="text-white/90 text-xs leading-relaxed">
              {streamingError || 'The agent process encountered an error. You can retry with the same session.'}
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
      )}

      <div className="flex-1 min-h-0">
        {messages.length === 0 && !isStreaming ? (
          /* Empty state with SessionSelector and centered input */
          <div className="h-full flex flex-col items-center justify-center px-4">
            <div className="w-full max-w-[800px] flex flex-col items-center">
              <SessionSelector
                selectedProject={selectedProject}
                onSelectProject={handleSelectProject}
                onOpenNewProject={handleOpenNewProject}
                onSelectThread={handleSelectThread}
              >
                {/* Input between selector and recent threads */}
                <div className="w-full welcome-message-input">
                  <MessageInput
                    onSend={handleSend}
                    onStop={handleStop}
                    disabled={false}
                    isStreaming={isStreaming}
                    sessionId={sessionId}
                    modelName={sessionModel}
                    onModelChange={handleModelChange}
                    onProviderChange={handleProviderChange}
                    permissionMode={permissionMode}
                    onPermissionModeChange={handlePermissionModeChange}
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
            />
          </div>
        )}
      </div>

      {/* Normal input at bottom - only show when there are messages */}
      {(messages.length > 0 || isStreaming) && (
        <div className="p-4 pt-0">
          <div className="max-w-[800px] mx-auto">
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

            {/* Sub-agent panel - above input, slightly narrower than input */}
            <div className="max-w-[750px] mx-auto">
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
            </div>

            {/* Permission prompt - attached above input */}
            <PermissionPrompt
              pendingPermission={pendingPermission}
              permissionResolved={permissionResolved}
              onPermissionResponse={respondToPermission}
              toolUses={uses}
            />

            <MessageInput
              onSend={handleSend}
              onStop={handleStop}
              disabled={false}
              isStreaming={isStreaming}
              sessionId={sessionId}
              modelName={sessionModel}
              onModelChange={handleModelChange}
              onProviderChange={handleProviderChange}
              permissionMode={permissionMode}
              onPermissionModeChange={handlePermissionModeChange}
              placeholder={t('chat.typeMessage')}
              messages={messages}
            />

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
                  onCompress={handleCompact}
                  isCompacting={isCompacting}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
