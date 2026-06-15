// src/components/layout/PanelHeader.tsx
"use client";

import { useCallback, useState, type DragEvent as ReactDragEvent } from "react";
import { CaretLeftIcon, CaretRightIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { usePanel } from "@/hooks/usePanel";
import { getPageDescriptor } from "./panels/registry";

interface DragState {
  fromId: string;
  overId: string | null;
  position: "before" | "after";
}

/**
 * Header bar inside the side panel. Renders one of three shapes:
 *
 * - `picker` view: a "选择页面" label + ‹ back button.
 * - `empty` (no tabs): a "侧栏" label + `+` and `›` controls.
 * - `content` view: the full tab strip with drag-to-reorder, plus
 *   the `+` add button (switches to picker view) and `›` collapse.
 */
export function PanelHeader() {
  const {
    tabs,
    activeTabId,
    activateTab,
    closePanel,
    setPanelOpen,
    panelView,
    setPanelView,
    reorderTabs,
  } = usePanel();

  const [drag, setDrag] = useState<DragState | null>(null);

  const goPicker = useCallback(() => setPanelView("picker"), [setPanelView]);
  const goContent = useCallback(() => setPanelView("content"), [setPanelView]);

  const onTabDragStart = useCallback(
    (e: ReactDragEvent<HTMLButtonElement>, tabId: string) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", tabId);
      setDrag({ fromId: tabId, overId: null, position: "before" });
    },
    []
  );

  const onTabDragOver = useCallback(
    (e: ReactDragEvent<HTMLButtonElement>, tabId: string) => {
      if (!drag || drag.fromId === tabId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const position: "before" | "after" = x < rect.width / 2 ? "before" : "after";
      if (drag.overId !== tabId || drag.position !== position) {
        setDrag({ fromId: drag.fromId, overId: tabId, position });
      }
    },
    [drag]
  );

  const finishDrag = useCallback(() => {
    if (drag && drag.overId && drag.fromId !== drag.overId) {
      reorderTabs(drag.fromId, drag.overId, drag.position);
    }
    setDrag(null);
  }, [drag, reorderTabs]);

  if (panelView === "picker") {
    return (
      <div className="panel-header panel-header-picker">
        <span className="panel-header-picker-title">选择页面</span>
        <button
          type="button"
          className="panel-header-icon-btn"
          onClick={goContent}
          title="返回"
          aria-label="返回"
        >
          <CaretLeftIcon size={14} weight="bold" />
        </button>
      </div>
    );
  }

  if (tabs.length === 0) {
    return (
      <div className="panel-header panel-header-empty">
        <span className="panel-header-empty-text">侧栏</span>
        <div className="panel-header-actions">
          <button
            type="button"
            className="panel-header-icon-btn"
            onClick={goPicker}
            title="选择页面"
            aria-label="选择页面"
          >
            <PlusIcon size={14} weight="bold" />
          </button>
          <button
            type="button"
            className="panel-header-icon-btn"
            onClick={() => setPanelOpen(false)}
            title="收起侧栏"
            aria-label="收起侧栏"
          >
            <CaretRightIcon size={14} weight="bold" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="panel-header"
      onDragOver={(e) => {
        if (drag) e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        finishDrag();
      }}
    >
      <div className="panel-header-tabs">
        {tabs.map((tab) => {
          const desc = getPageDescriptor(tab.pageId);
          const Icon = desc.icon;
          const active = tab.id === activeTabId;
          const dropClass =
            drag && drag.overId === tab.id
              ? drag.position === "before"
                ? " drop-before"
                : " drop-after"
              : "";
          const isDragging = drag?.fromId === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              draggable
              className={`panel-header-tab${active ? " active" : ""}${dropClass}${isDragging ? " dragging" : ""}`}
              onClick={() => activateTab(tab.id)}
              onDragStart={(e) => onTabDragStart(e, tab.id)}
              onDragOver={(e) => onTabDragOver(e, tab.id)}
              onDragEnd={finishDrag}
              title={tab.title}
              aria-pressed={active}
            >
              <Icon size={12} weight={active ? "fill" : "regular"} />
              <span className="panel-header-tab-title">{tab.title}</span>
              <span
                role="button"
                aria-label="关闭标签"
                className="panel-header-tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closePanel(tab.id);
                }}
              >
                <XIcon size={10} weight="bold" />
              </span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="panel-header-icon-btn"
        onClick={goPicker}
        title="新增页面"
        aria-label="新增页面"
      >
        <PlusIcon size={14} weight="bold" />
      </button>
      <button
        type="button"
        className="panel-header-icon-btn"
        onClick={() => setPanelOpen(false)}
        title="收起侧栏"
        aria-label="收起侧栏"
      >
        <CaretRightIcon size={14} weight="bold" />
      </button>
    </div>
  );
}
