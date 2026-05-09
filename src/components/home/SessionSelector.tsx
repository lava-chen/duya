"use client";

import { useState, useRef, useEffect } from "react";
import { useConversationStore } from "@/stores/conversation-store";
import { ChevronDownIcon, FolderIcon } from "@/components/icons";

interface SessionSelectorProps {
  selectedProject: { workingDirectory: string; projectName: string } | null;
  onSelectProject: (project: { workingDirectory: string; projectName: string }) => void;
  onOpenNewProject: () => void;
  onSelectThread: (threadId: string) => void;
  showRecentThreads?: boolean;
  maxRecentThreads?: number;
  children?: React.ReactNode;
}

export function SessionSelector({
  selectedProject,
  onSelectProject,
  onOpenNewProject,
  onSelectThread,
  showRecentThreads = true,
  maxRecentThreads = 8,
  children,
}: SessionSelectorProps) {
  const { threads, projects, isHydrated } = useConversationStore();
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProjectDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelectProject = (project: { workingDirectory: string; projectName: string }) => {
    onSelectProject(project);
    setIsProjectDropdownOpen(false);
  };

  const recentThreads = threads.slice(0, maxRecentThreads);

  const formatDate = (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    const days = Math.floor(diff / 86400000);
    const date = new Date(timestamp);

    if (days < 7) {
      return date.toLocaleDateString("en-US", { weekday: "short" });
    }
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };

  return (
    <>
      {/* Project selector header */}
      <div className="welcome-input-header">
        <span className="welcome-input-label">What do you want to build in</span>
        <div className="welcome-project-selector" ref={dropdownRef}>
          <button
            className="welcome-project-dropdown-trigger"
            onClick={() => setIsProjectDropdownOpen(!isProjectDropdownOpen)}
            disabled={!isHydrated}
          >
            <span className="welcome-project-name">
              {selectedProject?.projectName || "Select project"}
            </span>
            <ChevronDownIcon size={14} />
          </button>
          {isProjectDropdownOpen && (
            <div className="welcome-project-dropdown">
              {projects.map((project) => (
                <button
                  key={project.workingDirectory}
                  className={`welcome-project-dropdown-item ${
                    selectedProject?.workingDirectory === project.workingDirectory ? "active" : ""
                  }`}
                  onClick={() => handleSelectProject({
                    workingDirectory: project.workingDirectory,
                    projectName: project.projectName,
                  })}
                >
                  <span className="welcome-project-dropdown-name">{project.projectName}</span>
                  <span className="welcome-project-dropdown-path">{project.workingDirectory}</span>
                </button>
              ))}
              <div className="welcome-project-dropdown-divider" />
              <button
                className="welcome-project-dropdown-item new-project"
                onClick={onOpenNewProject}
              >
                <FolderIcon size={14} />
                <span>Open New Project...</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Recent threads */}
      {showRecentThreads && recentThreads.length > 0 && (
        <div className="welcome-recent">
          <h2>Recent Threads</h2>
          <div className="recent-list">
            {recentThreads.map((thread) => (
              <button
                key={thread.id}
                className="recent-item"
                onClick={() => onSelectThread(thread.id)}
              >
                <div className="recent-item-left">
                  <span className="recent-title">{thread.title}</span>
                  <span className="recent-project">{thread.projectName || thread.workingDirectory}</span>
                </div>
                <span className="recent-date">{formatDate(thread.updatedAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input area rendered below recent threads */}
      {children}
    </>
  );
}
