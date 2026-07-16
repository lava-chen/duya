"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { useTranslation } from "@/hooks/useTranslation";
import { MessageInput } from "@/components/chat/MessageInput";
import { SessionSelector } from "./SessionSelector";
import { InputDialog } from "@/components/ui/InputDialog";
import type { PermissionMode } from "@/components/chat/PermissionModeSelector";
import type { FileAttachment } from "@/types/message";

interface WelcomeViewProps {
  onSelectThread: (threadId: string) => void;
  onSendMessage?: (content: string, permissionMode?: PermissionMode, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null, mode?: string, effort?: string, displayContent?: string) => void;
}

export function WelcomeView({ onSelectThread, onSendMessage }: WelcomeViewProps) {
  const { projects, createThread, addProjectFolder, isHydrated } = useConversationStore();
  const { t } = useTranslation();
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');
  const [isNameProjectDialogOpen, setIsNameProjectDialogOpen] = useState(false);

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

  const handleSend = useCallback(
    async (
      content: string,
      files?: FileAttachment[],
      outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null,
    ) => {
      if (!selectedProject) return;

      const { modelName: actualModel } = parseModelName(sessionModel || '');

      const thread = await createThread({
        workingDirectory: selectedProject.workingDirectory,
        projectName: selectedProject.projectName,
        providerId: providerId || undefined,
        model: actualModel || undefined,
      });

      if (thread) {
        onSelectThread(thread.id);

        // Wait for React to render ChatView, then send via ref to avoid stale closure
        // Use requestAnimationFrame + microtask to ensure ChatView is mounted and streamingEffects are subscribed
        requestAnimationFrame(() => {
          // Double rAF ensures the ChatView mount effects (subscribeSession, etc.) have fired
          requestAnimationFrame(() => {
            const send = onSendMessageRef.current;
            send?.(content, permissionMode, actualModel, files, undefined, outputStyleConfig);
          });
        });
      }
    },
    [selectedProject, createThread, onSelectThread, permissionMode, sessionModel, providerId, parseModelName]
  );

  const handleModelChange = useCallback((model: string, nextProviderId?: string) => {
    setSessionModel(model);
    if (nextProviderId) {
      setProviderId(nextProviderId);
    }
  }, []);

  const handlePermissionModeChange = useCallback((mode: PermissionMode) => {
    setPermissionMode(mode);
  }, []);

  return (
    <div className="welcome-view">
      <div className="welcome-content">
        <SessionSelector
          selectedProject={selectedProject}
          onSelectProject={handleSelectProject}
          onNewBlankProject={handleNewBlankProject}
          onUseExistingFolder={handleUseExistingFolder}
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
              permissionMode={permissionMode}
              onPermissionModeChange={handlePermissionModeChange}
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
