"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { getActiveProviderIPC } from "@/lib/ipc-client";
import { useTranslation } from "@/hooks/useTranslation";
import { useSettings } from "@/hooks/useSettings";
import { MessageInput } from "@/components/chat/MessageInput";
import { AgentModeSelector, getProfileIdForMode } from "@/components/chat/AgentModeSelector";
import { SessionSelector } from "./SessionSelector";
import { InputDialog } from "@/components/ui/InputDialog";
import type { FileAttachment } from "@/types/message";

interface WelcomeViewProps {
  onSelectThread: (threadId: string) => void;
  onSendMessage?: (content: string, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string) => void;
}

export function WelcomeView({ onSelectThread, onSendMessage }: WelcomeViewProps) {
  const { projects, createThread, addProjectFolder, isHydrated } = useConversationStore();
  const { t } = useTranslation();
  const { settings, save: saveSettings } = useSettings();
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [agentProfileId, setAgentProfileId] = useState<string | null>(getProfileIdForMode('main'));
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
      const isUsable = provider.hasApiKey || provider.providerType === 'ollama';
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
            send?.(content, actualModel, files, agentProfileId, outputStyleConfig, undefined, effort);
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
  useEffect(() => {
    let cancelled = false;
    const resolveDefaultModel = async () => {
      if (sessionModel) return;
      try {
        const provider = await getActiveProviderIPC();
        if (cancelled || !provider) return;
        const isUsable = provider.hasApiKey || provider.providerType === 'ollama';
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
  }, [sessionModel]);

  const handleModelChange = useCallback((model: string, nextProviderId?: string) => {
    setSessionModel(model);
    if (nextProviderId) {
      setProviderId(nextProviderId);
    }
  }, []);

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <SessionSelector
          selectedProject={selectedProject}
          onSelectProject={handleSelectProject}
          onNewBlankProject={handleNewBlankProject}
          onUseExistingFolder={handleUseExistingFolder}
          onNewNoProjectSession={handleNewNoProjectSession}
          onSelectThread={onSelectThread}
        >
          {/* Message Input rendered between selector and recent threads */}
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
            {/* Agent chosen once at session creation; fixed afterwards. */}
            <div className="flex items-center justify-between mt-2 px-1">
              <AgentModeSelector
                value={agentProfileId ?? getProfileIdForMode('main')}
                onChange={(profileId) => setAgentProfileId(profileId)}
                disabled={!isHydrated || !selectedProject}
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
