"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore } from "@/stores/conversation-store";
import { getActiveProviderIPC, listProvidersIPC } from "@/lib/ipc-client";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { isKeylessLocalProvider } from "@/lib/providers";
import { MessageInput } from "@/components/chat/MessageInput";
import { AgentModeSelector, getProfileIdForMode } from "@/components/chat/AgentModeSelector";
import { SessionSelector } from "./SessionSelector";
import { InputDialog } from "@/components/ui/InputDialog";
import type { FileAttachment } from "@/types/message";

interface WelcomeViewProps {
  onSelectThread: (threadId: string) => void;
  onSendMessage?: (content: string, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string, conductorMode?: boolean) => void;
}

export function WelcomeView({ onSelectThread, onSendMessage }: WelcomeViewProps) {
  // Actions: stable references via useShallow
  const { createThread, addProjectFolder } = useConversationStore(
    useShallow((s) => ({
      createThread: s.createThread,
      addProjectFolder: s.addProjectFolder,
    }))
  );

  // State: only subscribe to what this view actually needs
  const { projects, isHydrated } = useConversationStore(
    useShallow((s) => ({
      projects: s.projects,
      isHydrated: s.isHydrated,
    }))
  );
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [agentProfileId, setAgentProfileId] = useState<string | null>(getProfileIdForMode('main'));
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);
  // Remember the last-used thinking effort so it carries over to new sessions.
  const [effort, setEffortState] = useState<string | undefined>(settings.defaultThinkingEffort ?? undefined);

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

  // Refs to always read the latest values inside useCallback closures.
  // Without these, handleSend captures the initial '' and never sees
  // the model resolved by the async useEffect or handleModelChange.
  const sessionModelRef = useRef(sessionModel);
  sessionModelRef.current = sessionModel;
  const providerIdRef = useRef(providerId);
  providerIdRef.current = providerId;

  const onSendMessageRef = useRef(onSendMessage);
  onSendMessageRef.current = onSendMessage;

  useEffect(() => {
    if (projects.length > 0 && !selectedProject) {
      setSelectedProject({
        workingDirectory: projects[0].workingDirectory,
        projectName: projects[0].projectName,
      });
    }
  }, [projects, selectedProject]);

  const handleSelectProject = (project: { workingDirectory: string; projectName: string }) => {
    setSelectedProject(project);
  };

  const handleUseExistingFolder = () => {
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
  };

  const handleNewBlankProject = () => {
    setIsNameProjectDialogOpen(true);
  };

  const handleCreateNamedProject = async (name: string) => {
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
      console.error("[WelcomeView] Failed to create blank project:", error);
    }
  };

  const parseModelName = useCallback((model: string): { providerName: string | null; modelName: string } => {
    const match = model.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (match) {
      return { providerName: match[1], modelName: match[2] };
    }
    return { providerName: null, modelName: model.replace(/^"|"$/g, '') };
  }, []);

  // Synchronous fallback: resolve the default provider model when
  // sessionModel is still empty (e.g. user sends before the async
  // useEffect has finished). Returns { modelName, providerId } or null.
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
      } catch { /* ignore */ }
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
      if (!selectedProject) return;

      // Read from refs to always get the latest values, even if the
      // async useEffect hasn't updated state yet. Without this, the
      // useCallback closure captures the initial '' and the backend
      // receives an empty model → "No provider or model configured".
      let effectiveModel = sessionModelRef.current;
      let effectiveProviderId = providerIdRef.current;
      if (!effectiveModel) {
        const resolved = await resolveDefaultModelSync();
        if (resolved) {
          effectiveModel = resolved.modelName;
          effectiveProviderId = resolved.providerId;
          // Sync to state so the UI reflects the resolved model
          setSessionModel(effectiveModel);
          setProviderId(effectiveProviderId);
        }
      }

      const { modelName: actualModel } = parseModelName(effectiveModel || '');

      const thread = await createThread({
        workingDirectory: selectedProject.workingDirectory,
        projectName: selectedProject.projectName,
        providerId: effectiveProviderId || undefined,
        model: actualModel || undefined,
        agentProfileId,
      });

      if (thread) {
        // Wait for the session switch to settle (force-reloads the thread
        // from the DB) before sending, so the first optimistic user message
        // never races with the reload and is always rendered immediately.
        await onSelectThread(thread.id);

        // Wait for React to render ChatView, then send via ref to avoid stale closure
        // Use requestAnimationFrame + microtask to ensure ChatView is mounted and streamingEffects are subscribed
        requestAnimationFrame(() => {
          // Double rAF ensures the ChatView mount effects (subscribeSession, etc.) have fired
          requestAnimationFrame(() => {
            const send = onSendMessageRef.current;
            send?.(content, actualModel, files, agentProfileId, outputStyleConfig, mode, effort, displayContent, conductorMode);
          });
        });
      }
    },
    [selectedProject, createThread, onSelectThread, parseModelName, resolveDefaultModelSync, agentProfileId, effort]
  );

  const handleNewNoProjectSession = useCallback(async () => {
    const thread = await createThread({ noProject: true });
    if (thread) {
      onSelectThread(thread.id);
    }
  }, [createThread, onSelectThread]);

  // Auto-select the default provider's model so a brand-new session can
  // chat immediately without the user manually picking a model first.
  // Without this, `sessionModel` stays empty, the send path passes an
  // empty model, and the backend reports "no provider configured".
  //
  // Priority for the welcome composer (no backing session yet):
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
      } catch (err) {
        console.error('[WelcomeView] Failed to resolve default model:', err);
      }
    };

    void resolveDefaultModel();
    // Retry once in case the provider store is still loading on boot.
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
          onSelectThread={onSelectThread}
        >
          {/* Message Input rendered between greeting and project selector */}
          <div className="welcome-message-input">
            <MessageInput
              onSend={handleSend}
              disabled={!isHydrated || !selectedProject}
              isStreaming={false}
              modelName={sessionModel}
              onModelChange={handleModelChange}
              effort={effort}
              onEffortChange={setEffort}
              placeholder={t('chat.describeWhatToBuild')}
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
