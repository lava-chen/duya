"use client";

import { useState, useCallback } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { PlusIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export function NewThreadDropdown() {
  const { t } = useTranslation();
  const { createThread, setActiveThread } = useConversationStore();
  const [isCreating, setIsCreating] = useState(false);

  const getRecentFolders = useCallback(async (): Promise<string[]> => {
    if (!window.electronAPI?.projects?.getRecentFolders) return [];
    try {
      return await window.electronAPI.projects.getRecentFolders();
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to load recent folders:", error);
      return [];
    }
  }, []);

  const getDefaultWorkspace = useCallback(async (): Promise<string | null> => {
    if (!window.electronAPI?.app?.getDefaultWorkspace) return null;
    try {
      return await window.electronAPI.app.getDefaultWorkspace();
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to get default workspace:", error);
      return null;
    }
  }, []);

  const createThreadInProject = async (workingDirectory: string) => {
    const projectName = workingDirectory.split(/[\\/]/).pop() || "Untitled";
    const newThread = await createThread({ workingDirectory, projectName });
    if (newThread) {
      setActiveThread(newThread.id);
    }
  };

  const handleOpenFolderDialog = async () => {
    try {
      if (window.electronAPI?.dialog?.openFolder) {
        const result = await window.electronAPI.dialog.openFolder({
          title: "Select Project Folder",
        });

        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          await window.electronAPI.projects.addRecentFolder(workingDirectory);
          await createThreadInProject(workingDirectory);
        }
      } else {
        const workingDirectory = prompt("Enter project folder path:");
        if (workingDirectory) {
          await createThreadInProject(workingDirectory);
        }
      }
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to create thread:", error);
    }
  };

  const handleNewThread = async () => {
    setIsCreating(true);

    try {
      // First, try to create thread with current active thread's working directory
      const thread = await createThread();

      if (thread) {
        // Found working directory from active thread, navigate directly
        setActiveThread(thread.id);
        return;
      }

      // No active thread with working directory, check recent folders
      const recentFolders = await getRecentFolders();

      if (recentFolders.length > 0) {
        // Use the most recent folder (first in the list)
        await createThreadInProject(recentFolders[0]);
      } else {
        // No recent folders, use default workspace if available, otherwise open folder dialog
        const defaultWorkspace = await getDefaultWorkspace();
        if (defaultWorkspace) {
          await createThreadInProject(defaultWorkspace);
        } else {
          await handleOpenFolderDialog();
        }
      }
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to create thread:", error);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <button
      type="button"
      className="sidebar-primary-link new-thread-btn w-full"
      onClick={handleNewThread}
      disabled={isCreating}
    >
      <span className="nav-icon">
        <PlusIcon size={16} />
      </span>
      <span>{t('nav.newChat')}</span>
    </button>
  );
}
