"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { MessageInput } from "@/components/chat/MessageInput";
import { SessionSelector } from "./SessionSelector";
import type { PermissionMode } from "@/components/chat/PermissionModeSelector";
import type { FileAttachment } from "@/types/message";

interface WelcomeViewProps {
  onSelectThread: (threadId: string) => void;
  onSendMessage?: (content: string, permissionMode?: PermissionMode, model?: string, files?: FileAttachment[], agentProfileId?: string | null, outputStyleConfig?: { name: string; prompt: string; keepCodingInstructions?: boolean } | null) => void;
}

export function WelcomeView({ onSelectThread, onSendMessage }: WelcomeViewProps) {
  const { projects, createThread, isHydrated } = useConversationStore();
  const [selectedProject, setSelectedProject] = useState<{ workingDirectory: string; projectName: string } | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('ask');
  const [sessionModel, setSessionModel] = useState<string>('');
  const [providerId, setProviderId] = useState<string>('');

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

  const handleOpenNewProject = () => {
    if (window.electronAPI?.dialog?.openFolder) {
      window.electronAPI.dialog.openFolder({
        title: "Select Project Folder",
      }).then((result: { canceled: boolean; filePaths: string[] }) => {
        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          const projectName = workingDirectory.split(/[\\/]/).pop() || "Untitled";
          setSelectedProject({ workingDirectory, projectName });
        }
      });
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
    async (content: string, files?: FileAttachment[]) => {
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
            send?.(content, permissionMode, actualModel, files);
          });
        });
      }
    },
    [selectedProject, createThread, onSelectThread, permissionMode, sessionModel, providerId, parseModelName]
  );

  const handleModelChange = useCallback((model: string) => {
    setSessionModel(model);
  }, []);

  const handleProviderChange = useCallback((pid: string) => {
    setProviderId(pid);
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
          onOpenNewProject={handleOpenNewProject}
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
              onProviderChange={handleProviderChange}
              permissionMode={permissionMode}
              onPermissionModeChange={handlePermissionModeChange}
              placeholder="Describe what you want to build..."
            />
          </div>
        </SessionSelector>
      </div>
    </div>
  );
}
