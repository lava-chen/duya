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
  const { panelOpen, togglePanel } = usePanel();
  const brandIconSrc = `${import.meta.env.BASE_URL}icon.png`;

  // Only show title in chat view with active thread
  const showThreadInfo = currentView === 'chat' && activeThreadId;

  const activeThread = threads.find((t) => t.id === activeThreadId);

  // Only show panel toggle when in a project
  const showPanelToggle = !!activeThread?.workingDirectory;

  const threadTitle = activeThread?.title || "New Thread";
  const projectName = activeThread?.projectName || "No Project";

  // Detect platform for window controls layout (macOS traffic lights on left, Windows on right)
  const isMac = window.electronAPI?.versions?.platform === 'darwin';

  return (
    <div
      className={`titlebar-drag-region${isMac ? ' is-mac' : ' is-win'}`}
      style={{
        '--window-controls-offset': isMac ? '70px' : '0px',
      } as React.CSSProperties}
    >
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
      <div className="titlebar-spacer" style={{ width: sidebarWidth }} />
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
        {showPanelToggle && (
          <button
            type="button"
            className={`titlebar-action-btn${panelOpen ? ' active' : ''}`}
            onClick={togglePanel}
            title="Toggle Panel"
            aria-label="Toggle Panel"
          >
            {panelOpen ? (
              <IconLayoutSidebarLeftCollapse size={16} />
            ) : (
              <IconLayoutSidebarLeftExpand size={16} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
