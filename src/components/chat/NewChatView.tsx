// NewChatView.tsx - Lazy new-chat composer.
//
// Unlike ChatView (which always has a backing session), this view is shown
// when the user clicks "new chat" but has NOT sent anything yet. No real
// thread is created or shown in the sidebar until the user sends. Text +
// attachments are kept in a global draft (conversation-store) that survives
// navigation and app restarts, so the user can resume an unsent draft.
//
// Layout mirrors WelcomeView (SessionSelector + project picker + recent
// threads) so the composer is not a bare, unconstrained input box.

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConversationStore } from '@/stores/conversation-store';
import { getActiveProviderIPC } from '@/lib/ipc-client';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettings } from '@/hooks/useSettings';
import { isKeylessLocalProvider } from '@/lib/providers';
import { MessageInput } from './MessageInput';
import { AgentModeSelector, getProfileIdForMode } from './AgentModeSelector';
import { listCustomAgents } from '@/lib/agent-profile-ipc';
import { SessionSelector } from '@/components/home/SessionSelector';
import { InputDialog } from '@/components/ui/InputDialog';
import { updateThreadIPC } from '@/lib/ipc-client';
import type { FileAttachment } from '@/types/message';

/** Composer permission selector mode (Ask / Auto / Bypass), mirrors ChatView. */
type PermissionModeUi = 'ask' | 'auto' | 'bypass';

interface NewChatViewProps {
  onSendMessage: (
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
  ) => void;
}

export function NewChatView({ onSendMessage }: NewChatViewProps) {
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const {
    projects,
    isHydrated,
    newChatDraft,
    newChatPresetProject,
    createThread,
    setActiveThread,
    addProjectFolder,
    updateNewChatDraft,
    clearNewChatDraft,
    clearNewChatPresetProject,
  } = useConversationStore();

  const [isSending, setIsSending] = useState(false);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [agentProfileId, setAgentProfileId] = useState<string | null>(getProfileIdForMode('main'));
  // Permission mode picked in the composer; persisted to the session row on
  // creation and passed along on the first send as a per-turn override.
  const [permissionMode, setPermissionMode] = useState<PermissionModeUi>('auto');
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
  // Remember the last-used thinking effort so it carries over to new sessions.
  const [effort, setEffortState] = useState<string | undefined>(settings.defaultThinkingEffort ?? undefined);

  // Sync effort from settings when they load for the first time.
  useEffect(() => {
    setEffortState(settings.defaultThinkingEffort ?? undefined);
  }, [settings.defaultThinkingEffort]);

  const setEffort = useCallback((newEffort: string | undefined) => {
    setEffortState(newEffort);
    if (newEffort !== settings.defaultThinkingEffort) {
      saveSettings({ defaultThinkingEffort: newEffort ?? null }).catch(console.error);
    }
  }, [saveSettings, settings.defaultThinkingEffort]);

  // Refs to always read the latest values inside stable callbacks.
  const sessionModelRef = useRef(sessionModel);
  sessionModelRef.current = sessionModel;
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;
  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;

  // Default to the first project so the composer mirrors WelcomeView, but
  // never block sending when no project exists (new-chat supports drafting
  // against an auto-resolved working directory / no-project session). A
  // preset project (from a project-group "new thread" entry) wins over the
  // first project and is consumed afterwards so it never re-asserts over a
  // later manual selection in the same composer session.
  useEffect(() => {
    if (newChatPresetProject) {
      setSelectedProject(newChatPresetProject);
      clearNewChatPresetProject();
    } else if (projects.length > 0 && !selectedProject) {
      setSelectedProject({
        workingDirectory: projects[0].workingDirectory,
        projectName: projects[0].projectName,
      });
    }
  }, [projects, selectedProject, newChatPresetProject, clearNewChatPresetProject]);

  const parseModelName = useCallback((model: string): { providerName: string | null; modelName: string } => {
    const match = model.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return { providerName: match[1], modelName: match[2] };
    }
    return { providerName: null, modelName: model.replace(/^"|"$/g, '') };
  }, []);

  // Auto-select the default provider's model so a brand-new session can chat
  // immediately without the user picking a model first.
  useEffect(() => {
    let cancelled = false;
    const resolveDefaultModel = async () => {
      if (sessionModel) return;
      try {
        const provider = await getActiveProviderIPC();
        if (cancelled || !provider) return;
        const isUsable = provider.hasApiKey || isKeylessLocalProvider(provider.providerType, provider.baseUrl);
        if (!isUsable) return;
        let modelId = '';
        try {
          const opts = JSON.parse(provider.options || '{}');
          if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
            modelId = opts.enabled_models[0];
          } else if (typeof opts.defaultModel === 'string' && opts.defaultModel) {
            modelId = opts.defaultModel;
          }
        } catch {
          // Ignore malformed options; fall through to provider.defaultModel.
        }
        if (!modelId && provider.defaultModel) modelId = provider.defaultModel;
        if (!modelId) return;
        const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
        const providerName = provider.name || provider.providerType || provider.id;
        setSessionModel(`[${providerName}] ${cleanId}`);
        setProviderId(provider.id);
      } catch {
        // Ignore provider resolution errors.
      }
    };
    void resolveDefaultModel();
    const retryTimer = setTimeout(() => void resolveDefaultModel(), 1500);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
    };
  }, [sessionModel]);

  const handleModelChange = useCallback((model: string, nextProviderId?: string) => {
    setSessionModel(model);
    if (nextProviderId) {
      setProviderId(nextProviderId);
    }
  }, []);

  const handleDraftChange = useCallback(
    (text: string, attachments: FileAttachment[]) => {
      updateNewChatDraft({
        text,
        attachments,
        hasContent: text.trim().length > 0 || attachments.length > 0,
      });
    },
    [updateNewChatDraft],
  );

  const handleSelectProject = useCallback((project: { workingDirectory: string; projectName: string }) => {
    setSelectedProject(project);
  }, []);

  const handleUseExistingFolder = useCallback(() => {
    if (window.electronAPI?.dialog?.openFolder) {
      window.electronAPI.dialog.openFolder({
        title: t('project.selectNewProjectFolder'),
      }).then(async (result: { canceled: boolean; filePaths: string[] }) => {
        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          const project = await addProjectFolder(workingDirectory);
          if (project) {
            setSelectedProject({
              workingDirectory: project.workingDirectory,
              projectName: project.projectName,
            });
          }
        }
      });
    }
  }, [addProjectFolder, t]);

  const handleNewBlankProject = useCallback(() => {
    setIsNameProjectDialogOpen(true);
  }, []);

  const handleCreateNamedProject = useCallback(
    async (name: string) => {
      setIsNameProjectDialogOpen(false);
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        if (window.electronAPI?.app?.createProjectFolder) {
          const result = await window.electronAPI.app.createProjectFolder(trimmed);
          if (result.success && result.path) {
            const project = await addProjectFolder(result.path);
            setSelectedProject({
              workingDirectory: project?.workingDirectory ?? result.path,
              projectName: trimmed,
            });
          }
        }
      } catch (error) {
        console.error('[NewChatView] Failed to create blank project:', error);
      }
    },
    [addProjectFolder],
  );

  const handleNewNoProjectSession = useCallback(async () => {
    const thread = await createThread({ noProject: true });
    if (thread) {
      clearNewChatDraft();
      setActiveThread(thread.id);
    }
  }, [createThread, setActiveThread, clearNewChatDraft]);

  // Synchronous fallback: resolve the default provider model when the async
  // effect hasn't finished yet, so the first send never passes an empty model.
  const resolveDefaultModelSync = useCallback(async (): Promise<{ modelName: string; providerId: string } | null> => {
    try {
      const provider = await getActiveProviderIPC();
      if (!provider) return null;
      const isUsable = provider.hasApiKey || isKeylessLocalProvider(provider.providerType, provider.baseUrl);
      if (!isUsable) return null;
      let modelId = '';
      try {
        const opts = JSON.parse(provider.options || '{}');
        if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
          modelId = opts.enabled_models[0];
        } else if (typeof opts.defaultModel === 'string' && opts.defaultModel) {
          modelId = opts.defaultModel;
        }
      } catch {
        // ignore
      }
      if (!modelId && provider.defaultModel) modelId = provider.defaultModel;
      if (!modelId) return null;
      const cleanId = modelId.startsWith('"') && modelId.endsWith('"') ? modelId.slice(1, -1) : modelId;
      const providerName = provider.name || provider.providerType || provider.id;
      return { modelName: `[${providerName}] ${cleanId}`, providerId: provider.id };
    } catch {
      return null;
    }
  }, []);

  const handleSend = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
      mode?: string,
      displayContent?: string,
      conductorMode?: boolean,
    ) => {
      if (!content.trim() && (files?.length ?? 0) === 0) return;
      if (isSending) return;
      setIsSending(true);
      try {
        // Read from refs to always get the latest model/provider.
        let effectiveModel = sessionModelRef.current;
        let effectiveProviderId = providerIdRef.current;
        if (!effectiveModel) {
          const resolved = await resolveDefaultModelSync();
          if (resolved) {
            effectiveModel = resolved.modelName;
            effectiveProviderId = resolved.providerId;
            setSessionModel(effectiveModel);
            setProviderId(effectiveProviderId);
          }
        }
        const { modelName: actualModel } = parseModelName(effectiveModel || '');

        // Prefer the project picked in the SessionSelector; otherwise resolve
        // a working directory so the new session is grouped under a project when
        // possible (most recent folder, then default workspace, then no-project).
        let workingDirectory = selectedProject?.workingDirectory;
        let projectName = selectedProject?.projectName;
        if (!workingDirectory) {
          try {
            const folders = await ((window.electronAPI?.projects?.getRecentFolders?.()) ?? Promise.resolve([]));
            if (Array.isArray(folders) && folders.length > 0) {
              workingDirectory = folders[0];
              projectName = workingDirectory.split(/[\\/]/).pop() || undefined;
            }
          } catch {
            // ignore
          }
        }
        if (!workingDirectory) {
          try {
            const ws = await window.electronAPI?.app?.getDefaultWorkspace?.();
            if (ws) {
              workingDirectory = ws;
              projectName = ws.split(/[\\/]/).pop() || undefined;
            }
          } catch {
            // ignore
          }
        }

        // Plan 424: when a config-driven custom agent ([agents.<id>]) is
        // selected, its model and workspace override the session parameters.
        const customAgents = await listCustomAgents();
        const custom = agentProfileId ? customAgents[agentProfileId] : undefined;
        let sessionModelName = actualModel;
        if (custom) {
          workingDirectory = custom.workspace || workingDirectory;
          if (custom.model) sessionModelName = parseModelName(custom.model).modelName || custom.model;
        }

        const thread = await createThread({
          workingDirectory,
          projectName,
          noProject: !workingDirectory,
          providerId: effectiveProviderId || undefined,
          model: sessionModelName || undefined,
          agentProfileId,
        });
        if (!thread) return;

        // Persist the composer's permission choice into the session row so
        // ChatView's selector restores it and later turns keep using it.
        const permissionProfile = permissionMode === 'bypass' ? 'full_access'
          : permissionMode === 'ask' ? 'default'
          : 'auto';
        updateThreadIPC(thread.id, { permissionProfile }).catch(console.error);

        // Draft consumed — clear it now that a real thread exists.
        clearNewChatDraft();
        // Wait for the session switch to fully settle (it force-reloads the
        // thread from the DB) before sending. Without this, the async DB
        // reload inside setActiveThread can race with the optimistic user
        // message added by handleSendMessage, and the first message of a
        // brand-new session never renders until the turn finishes.
        await setActiveThread(thread.id);

        // Wait for React to render ChatView, then send via ref to avoid a
        // stale closure (mirrors WelcomeView's double-rAF handoff).
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const send = onSendMessageRef.current;
            send?.(content, actualModel, files, agentProfileId, outputStyleConfig, mode, effort, displayContent, conductorMode, undefined, permissionMode);
          });
        });
      } catch (error) {
        console.error('[NewChatView] Failed to create thread:', error);
      } finally {
        setIsSending(false);
      }
    },
    [selectedProject, createThread, setActiveThread, clearNewChatDraft, parseModelName, resolveDefaultModelSync, isSending, agentProfileId, effort, permissionMode],
  );

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <SessionSelector
          selectedProject={selectedProject}
          onSelectProject={handleSelectProject}
          onNewBlankProject={handleNewBlankProject}
          onUseExistingFolder={handleUseExistingFolder}
          onNewNoProjectSession={handleNewNoProjectSession}
          onSelectThread={setActiveThread}
        >
          {/* Message Input rendered between selector and recent threads */}
          <div className="welcome-message-input">
            <MessageInput
              onSend={handleSend}
              disabled={!isHydrated || isSending}
              isStreaming={false}
              modelName={sessionModel}
              onModelChange={handleModelChange}
              effort={effort}
              onEffortChange={setEffort}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              placeholder={t('chat.describeWhatToBuild')}
              popoverPlacement="bottom"
              draftMode
              initialDraft={{ text: newChatDraft.text, attachments: newChatDraft.attachments }}
              onDraftChange={handleDraftChange}
            />
            {/* Agent chosen once at session creation; fixed afterwards. */}
            <div className="flex items-center justify-between mt-2 px-1">
              <AgentModeSelector
                value={agentProfileId ?? getProfileIdForMode('main')}
                onChange={(profileId) => setAgentProfileId(profileId)}
                disabled={!isHydrated || isSending}
              />
            </div>
          </div>
        </SessionSelector>
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