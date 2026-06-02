"use client";

import { useCallback } from "react";
import {
  SquaresFourIcon,
  FolderIcon,
  BrainIcon,
} from "@/components/icons";
import { usePanel, type PanelTab } from "@/hooks/usePanel";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { FileTreePanel } from "@/components/layout/panels/FileTreePanel";
import { SidebarConductorView } from "@/components/layout/panels/SidebarConductorView";
import { ResearchActivityPanel } from "@/components/layout/panels/ResearchActivityPanel";

interface TabDef {
  id: PanelTab;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

const tabs: TabDef[] = [
  { id: 'canvas', label: 'Canvas', icon: SquaresFourIcon },
  { id: 'files', label: 'Files', icon: FolderIcon },
  { id: 'research', label: 'Research', icon: BrainIcon },
];

export function SidebarPanel() {
  const { panelWidth, setPanelWidth, activeTab, setActiveTab } = usePanel();

  const handleResize = useCallback(
    (delta: number) => {
      setPanelWidth(panelWidth - delta);
    },
    [panelWidth, setPanelWidth]
  );

  return (
    <div className="sidebar-panel">
      <ResizeHandle side="left" onResize={handleResize} />
      <div className="sidebar-panel-inner" style={{ width: panelWidth }}>
        <div className="sidebar-panel-tabs">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                className={`sidebar-panel-tab${isActive ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <Icon size={14} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        <div className="sidebar-panel-content">
          {activeTab === 'files' && (
            <FileTreePanel embedded />
          )}
          {activeTab === 'canvas' && (
            <SidebarConductorView />
          )}
          {activeTab === 'research' && (
            <ResearchActivityPanel />
          )}
        </div>
      </div>
    </div>
  );
}