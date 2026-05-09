"use client";

import {
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from "@tabler/icons-react";
import { useConversationStore } from "@/stores/conversation-store";
import { usePanel } from "@/hooks/usePanel";

interface TitleBarProps {
  sidebarWidth?: number;
}

export function TitleBar({ sidebarWidth = 260 }: TitleBarProps) {
  const { threads, activeThreadId, currentView } = useConversationStore();
  const { fileTreeOpen, toggleFileTree } = usePanel();
  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;

  // Only show title in chat view with active thread
  const showThreadInfo = currentView === 'chat' && activeThreadId;

  const spacerStyle = { width: sidebarWidth };

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const threadTitle = activeThread?.title || "New Thread";
  const projectName = activeThread?.projectName || "No Project";

  return (
    <div className="titlebar-drag-region">
      <div className="titlebar-brand">
        <img
          src={brandIconSrc}
          alt="DUYA"
          className="titlebar-logo"
        />
        <span className="titlebar-brand-text">Duya</span>
        <span
          className="titlebar-beta-badge"
          style={{
            fontSize: '10px',
            fontWeight: 600,
            padding: '2px 6px',
            borderRadius: '4px',
            background: 'var(--accent)',
            color: 'white',
            marginLeft: '6px',
            letterSpacing: '0.5px',
          }}
        >
          BETA
        </span>
      </div>
      <div className="titlebar-spacer" style={spacerStyle} />
      <div className="titlebar-content-area">
        {showThreadInfo && activeThread && (
          <>
            <span className="titlebar-thread-title">{threadTitle}</span>
            <span className="titlebar-project-name">{projectName}</span>
          </>
        )}
      </div>
      {/* Right side actions - next to window controls */}
      <div className="titlebar-actions">
        <button
          type="button"
          className={`titlebar-action-btn${fileTreeOpen ? ' active' : ''}`}
          onClick={toggleFileTree}
          title="Toggle File Tree"
          aria-label="Toggle File Tree"
        >
          {fileTreeOpen ? (
            <IconLayoutSidebarLeftCollapse size={16} />
          ) : (
            <IconLayoutSidebarLeftExpand size={16} />
          )}
        </button>
      </div>
    </div>
  );
}
