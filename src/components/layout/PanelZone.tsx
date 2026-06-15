"use client";

import { usePanel } from "@/hooks/usePanel";
import { PanelHeader } from "./PanelHeader";
import { PAGE_REGISTRY, getPageDescriptor, type PageId, type PageDescriptor } from "./panels/registry";
import { ResizeHandle } from "./ResizeHandle";

function shortcutFor(id: PageId): string | null {
  switch (id) {
    case "research": return "Ctrl+Shift+G";
    case "terminal": return "Ctrl+`";
    case "browser": return "Ctrl+T";
    case "files": return "Ctrl+P";
    case "conductor": return "Ctrl+Alt+S";
    default: return null;
  }
}

function PagePickerList() {
  const { openOrActivatePage } = usePanel();
  const entries = Object.values(PAGE_REGISTRY);

  return (
    <div className="page-picker">
      {entries.map((entry) => (
        <PickerRow
          key={entry.id}
          entry={entry}
          shortcut={shortcutFor(entry.id)}
          onSelect={() => openOrActivatePage(entry.id)}
        />
      ))}
    </div>
  );
}

function PickerRow({
  entry,
  shortcut,
  onSelect,
}: {
  entry: PageDescriptor;
  shortcut: string | null;
  onSelect: () => void;
}) {
  const Icon = entry.icon;

  return (
    <button
      type="button"
      role="menuitem"
      className={`page-picker-row${entry.available ? "" : " disabled"}`}
      disabled={!entry.available}
      onClick={() => {
        if (!entry.available) return;
        onSelect();
      }}
      title={entry.available ? entry.label : `${entry.label}（未实现）`}
    >
      <span className="page-picker-row-main">
        <span className="page-picker-row-icon">
          <Icon size={16} weight="regular" />
        </span>
        <span className="page-picker-row-name">{entry.label}</span>
      </span>

      <span className="page-picker-row-meta">
        {shortcut && (
          <span className="page-picker-row-shortcut">{shortcut}</span>
        )}
        {!entry.available && (
          <span className="page-picker-row-hint">未实现</span>
        )}
      </span>
    </button>
  );
}

export function PanelZone() {
  const {
    panelOpen,
    panelWidth,
    setPanelWidth,
    tabs,
    activeTabId,
    panelView,
  } = usePanel();

  if (!panelOpen) {
    return null;
  }

  if (tabs.length === 0 || panelView === "picker") {
    return (
      <div className="panel-zone">
        <ResizeHandle
          side="left"
          onResize={(delta) => setPanelWidth(panelWidth - delta)}
        />
        <div className="sidebar-panel-inner sidebar-panel-launcher" style={{ width: panelWidth }}>
          <PanelHeader />
          <PagePickerList />
        </div>
      </div>
    );
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
