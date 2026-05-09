"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useConversationStore, type Thread, type ProjectGroup } from "@/stores/conversation-store";
import { ThreadListItem } from "./ThreadListItem";
import { FolderIcon, FolderOpenIcon, ArchiveIcon, DotsThreeIcon, FolderOpenIcon as OpenFolderIcon, CopyIcon, PlusIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

interface ProjectGroupItemProps {
  project: ProjectGroup;
  threads: Thread[];
  activeThreadId: string | null;
  threadChildren?: Map<string, Thread[]>;
}

export function ProjectGroupItem({ project, threads, activeThreadId, threadChildren }: ProjectGroupItemProps) {
  const { t } = useTranslation();
  const { deleteThread, createThread, setActiveThread } = useConversationStore();
  const [isExpanded, setIsExpanded] = useState(true);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Sort threads by updatedAt, most recent first
  const sortedThreads = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  const handleToggle = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const menuWidth = 160;
    const menuHeight = 120;
    let x = e.clientX;
    let y = e.clientY;

    // Adjust position if menu would go off screen
    if (x + menuWidth > window.innerWidth) {
      x = window.innerWidth - menuWidth - 8;
    }
    if (y + menuHeight > window.innerHeight) {
      y = window.innerHeight - menuHeight - 8;
    }

    setMenuPos({ x, y });
    setShowMenu(true);
  }, []);

  const handleOpenFolder = useCallback(() => {
    setShowMenu(false);
    if (project.workingDirectory && window.electronAPI?.shell?.openPath) {
      window.electronAPI.shell.openPath(project.workingDirectory);
    }
  }, [project.workingDirectory]);

  const handleCopyPath = useCallback(() => {
    setShowMenu(false);
    if (project.workingDirectory) {
      navigator.clipboard.writeText(project.workingDirectory);
    }
  }, [project.workingDirectory]);

  const handleDeleteProject = useCallback(() => {
    setShowMenu(false);
    // Delete all threads in this project
    for (const thread of sortedThreads) {
      deleteThread(thread.id);
    }
  }, [deleteThread, sortedThreads]);

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const menuWidth = 160;
      const menuHeight = 120;
      let x = rect.right - menuWidth;
      let y = rect.bottom + 4;

      // Adjust position if menu would go off screen
      if (x < 0) {
        x = 8;
      }
      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        y = rect.top - menuHeight - 4;
      }

      setMenuPos({ x, y });
    }
    setShowMenu((prev) => !prev);
  }, []);

  const handleNewThread = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    const thread = await createThread({
      workingDirectory: project.workingDirectory,
      projectName: project.projectName,
    });
    if (thread) {
      setActiveThread(thread.id);
    }
  }, [createThread, setActiveThread, project.workingDirectory, project.projectName]);

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showMenu]);

  return (
    <>
      <div className="project-group-item" onContextMenu={handleContextMenu}>
        {/* Project Header */}
        <div
          className="project-group-header"
          title={project.workingDirectory}
          onClick={handleToggle}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          {isExpanded ? (
            <FolderOpenIcon size={14} className="project-group-icon" />
          ) : (
            <FolderIcon size={14} className="project-group-icon" />
          )}
          <span className="project-group-name">{project.projectName}</span>

          {/* Plus button - visible on hover, for creating new thread */}
          <button
            type="button"
            className="project-group-add-btn"
            onClick={handleNewThread}
            style={{ opacity: isHovered ? 1 : 0 }}
            aria-label="New thread"
            title="New thread"
          >
            <PlusIcon size={14} weight="bold" />
          </button>

          {/* Three dots menu button - visible on hover */}
          <button
            ref={buttonRef}
            type="button"
            className="project-group-menu-btn"
            onClick={handleMenuClick}
            style={{ opacity: isHovered || showMenu ? 1 : 0 }}
            aria-label="Project options"
          >
            <DotsThreeIcon size={16} weight="bold" />
          </button>
        </div>

        {/* Thread List */}
        {isExpanded && (
          <div className="project-group-threads">
            {sortedThreads.map((thread) => (
              <ThreadListItem
                key={thread.id}
                thread={thread}
                isActive={thread.id === activeThreadId}
                childrenThreads={threadChildren?.get(thread.id) || []}
              />
            ))}
          </div>
        )}
      </div>

      {/* Dropdown Menu */}
      {showMenu && (
        <div
          ref={menuRef}
          className="project-dropdown-menu"
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <button
            type="button"
            className="project-dropdown-item"
            onClick={handleOpenFolder}
          >
            <OpenFolderIcon size={14} />
            <span>{t("project.openFolder")}</span>
          </button>
          <button
            type="button"
            className="project-dropdown-item"
            onClick={handleCopyPath}
          >
            <CopyIcon size={14} />
            <span>{t("project.copyFolderPath")}</span>
          </button>
          <div className="project-dropdown-divider" />
          <button
            type="button"
            className="project-dropdown-item danger"
            onClick={handleDeleteProject}
          >
            <ArchiveIcon size={14} />
            <span>{t("project.removeProject")}</span>
          </button>
        </div>
      )}
    </>
  );
}
