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
import { useShallow } from 'zustand/react/shallow';
import { useConversationStore } from '@/stores/conversation-store';
import { getActiveProviderIPC, listProvidersIPC } from '@/lib/ipc-client';
import { useTranslation } from '@/hooks/useTranslation';
import { useSettings } from '@/hooks/useSettings';
import { isKeylessLocalProvider } from '@/lib/providers';
import { MessageInput } from './MessageInput';
import { getProfileIdForMode } from './AgentModeSelector';
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
  // Actions: stable references via useShallow
  const {
    createThread,
    setActiveThread,
    addProjectFolder,
    updateNewChatDraft,
    clearNewChatDraft,
    clearNewChatPresetProject,
  } = useConversationStore(
    useShallow((s) => ({
      createThread: s.createThread,
      setActiveThread: s.setActiveThread,
      addProjectFolder: s.addProjectFolder,
      updateNewChatDraft: s.updateNewChatDraft,
      clearNewChatDraft: s.clearNewChatDraft,
      clearNewChatPresetProject: s.clearNewChatPresetProject,
    }))
  );

  // State: only subscribe to what this view actually needs
  const { projects, isHydrated, newChatDraft, newChatPresetProject } = useConversationStore(
    useShallow((s) => ({
      projects: s.projects,
      isHydrated: s.isHydrated,
      newChatDraft: s.newChatDraft,
      newChatPresetProject: s.newChatPresetProject,
    }))
  );

  const [isSending, setIsSending] = useState(false);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  // Permission mode picked in the composer; persisted to the session row on
  // creation and passed along on the first send as a per-turn override.
  const [permissionMode, setPermissionMode] = useState<PermissionModeUi>('auto');
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
  // Time-of-day greeting shown above the composer.
  const hour = new Date().getHours();
  const greeting =
    hour >= 5 && hour < 12
      ? t('chat.greeting.morning')
      : hour >= 12 && hour < 18
        ? t('chat.greeting.afternoon')
        : hour >= 18 && hour < 23
          ? t('chat.greeting.evening')
          : t('chat.greeting.night');

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
  //
  // Priority for the *new-chat composer* (no backing session yet):
  //   0. settings.lastSelectedModel — what the user picked last time, as
  //      long as the named provider still exists in the provider store.
  //   1. active provider's defaultModel / enabled_models[0].
  // Existing ChatView sessions keep their own per-session model (the
  // thread row is the source of truth there) — this effect never runs
  // for them, so older sessions are unaffected.
  useEffect(() => {
    let cancelled = false;
    const resolveDefaultModel = async () => {
      if (sessionModel) return;
      // Priority 0: try the remembered model first. We only adopt it when
      // the named provider still exists — otherwise we'd seed the picker
      // with a ghost that the user can never resolve.
      const remembered = settings.lastSelectedModel;
      if (remembered) {
        try {
          const { providerName, modelName } = parseModelName(remembered);
          if (providerName && modelName) {
            const providers = await listProvidersIPC();
            if (!cancelled) {
              const matched = providers.find((p) => p.name === providerName);
              if (matched) {
                setSessionModel(remembered);
                setProviderId(matched.id);
                return;
              }
            }
          }
        } catch {
          // Fall through to the active-provider path.
        }
      }
      // Priority 1: the active provider's configured default.
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
  }, [sessionModel, settings.lastSelectedModel, parseModelName]);

  const handleModelChange = useCallback((model: string, nextProviderId?: string) => {
    setSessionModel(model);
    if (nextProviderId) {
      setProviderId(nextProviderId);
    }
    // Remember the pick so the next new-chat composer pre-selects it.
    // We only persist when the user actually chose a model (an empty
    // string is the "follow the default" reset).
    if (model && model !== settings.lastSelectedModel) {
      saveSettings({ lastSelectedModel: model }).catch(console.error);
    }
  }, [saveSettings, settings.lastSelectedModel]);

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

        const thread = await createThread({
          workingDirectory,
          projectName,
          noProject: !workingDirectory,
          providerId: effectiveProviderId || undefined,
          model: actualModel || undefined,
          agentProfileId: getProfileIdForMode('main'),
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
            send?.(content, actualModel, files, getProfileIdForMode('main'), outputStyleConfig, mode, effort, displayContent, conductorMode, undefined, permissionMode);
          });
        });
      } catch (error) {
        console.error('[NewChatView] Failed to create thread:', error);
      } finally {
        setIsSending(false);
      }
    },
    [selectedProject, createThread, setActiveThread, clearNewChatDraft, parseModelName, resolveDefaultModelSync, isSending, effort, permissionMode],
  );

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <SessionSelector
          greeting={greeting}
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