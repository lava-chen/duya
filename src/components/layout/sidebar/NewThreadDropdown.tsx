"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { PlusIcon, CaretDownIcon, NotePencilIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

export function NewThreadDropdown() {
  const { t } = useTranslation();
  const { createThread, setActiveThread } = useConversationStore();
  const [isCreating, setIsCreating] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
    const projectName = workingDirectory.split(/[\\/]/).pop() || t('project.untitled');
    const newThread = await createThread({ workingDirectory, projectName });
    if (newThread) {
      setActiveThread(newThread.id);
    }
  };

  const handleOpenFolderDialog = async () => {
    try {
      if (window.electronAPI?.dialog?.openFolder) {
        const result = await window.electronAPI.dialog.openFolder({
          title: t('project.selectNewProjectFolder'),
        });

        if (!result.canceled && result.filePaths.length > 0) {
          const workingDirectory = result.filePaths[0];
          await window.electronAPI.projects.addRecentFolder(workingDirectory);
          await createThreadInProject(workingDirectory);
        }
      } else {
        const workingDirectory = prompt(t('project.enterFolderPath'));
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

  const handleNewNoProjectThread = useCallback(async () => {
    setIsMenuOpen(false);
    setIsCreating(true);
    try {
      const thread = await createThread({ noProject: true });
      if (thread) {
        setActiveThread(thread.id);
      }
    } catch (error) {
      console.error("[NewThreadDropdown] Failed to create no-project thread:", error);
    } finally {
      setIsCreating(false);
    }
  }, [createThread, setActiveThread]);

  // Close menu on click outside
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  return (
    <div className="new-thread-dropdown" ref={menuRef}>
      <button
        type="button"
        className="sidebar-primary-link new-thread-btn"
        onClick={handleNewThread}
        disabled={isCreating}
      >
        <span className="nav-icon">
          <PlusIcon size={16} />
        </span>
        <span>{t('nav.newChat')}</span>
      </button>
      <button
        type="button"
        className="new-thread-caret"
        onClick={() => setIsMenuOpen((v) => !v)}
        disabled={isCreating}
        aria-label={t('project.options')}
        aria-expanded={isMenuOpen}
      >
        <CaretDownIcon size={14} />
      </button>
      {isMenuOpen && (
        <div className="project-dropdown-menu new-thread-menu">
          <button
            type="button"
            className="project-dropdown-item"
            onClick={handleNewNoProjectThread}
          >
            <NotePencilIcon size={14} />
            <span>{t('project.newNoProjectSession')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
