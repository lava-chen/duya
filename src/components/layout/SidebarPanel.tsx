"use client";

import { useCallback } from "react";
import { usePanel } from "@/hooks/usePanel";
import { ResizeHandle } from "@/components/layout/ResizeHandle";
import { FileTreePanel } from "@/components/layout/panels/FileTreePanel";
import { SidebarConductorView } from "@/components/layout/panels/SidebarConductorView";
import { ResearchActivityPanel } from "@/components/layout/panels/ResearchActivityPanel";

export function SidebarPanel() {
  const { panelWidth, setPanelWidth, activeTab } = usePanel();

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