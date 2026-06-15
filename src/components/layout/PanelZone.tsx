// src/components/layout/PanelZone.tsx
"use client";

import { usePanel } from "@/hooks/usePanel";
import { PanelHeader } from "./PanelHeader";
import { getPageDescriptor } from "./panels/registry";
import { ResizeHandle } from "./ResizeHandle";

function PanelCollapsedButton() {
  const { setPanelOpen } = usePanel();
  return (
    <div className="panel-zone panel-zone-collapsed">
      <button
        type="button"
        className="panel-collapsed-button"
        onClick={() => setPanelOpen(true)}
        title="打开侧栏"
        aria-label="打开侧栏"
      >
        <span className="panel-collapsed-button-glyph">‹</span>
      </button>
    </div>
  );
}

export function PanelZone() {
  const { panelOpen, panelWidth, setPanelWidth, tabs, activeTabId } = usePanel();

  if (!panelOpen && tabs.length === 0) {
    return <PanelCollapsedButton />;
  }

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <div className="panel-zone">
      <ResizeHandle
        side="left"
        onResize={(delta) => setPanelWidth(panelWidth - delta)}
      />
      <div className="sidebar-panel-inner" style={{ width: panelWidth }}>
        <PanelHeader />
        <div className="sidebar-panel-content">
          {activeTab ? (
            (() => {
              const desc = getPageDescriptor(activeTab.pageId);
              const Component = desc.component;
              return <Component tab={activeTab} embedded />;
            })()
          ) : (
            <div className="panel-empty-state">
              <p>从右上角 + 按钮选择要打开的页面</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
