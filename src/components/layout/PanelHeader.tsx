// src/components/layout/PanelHeader.tsx
"use client";

import { useState, useRef, useCallback } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import { usePanel } from "@/hooks/usePanel";
import { getPageDescriptor, type PageId } from "./panels/registry";
import { PagePickerMenu } from "./PagePickerMenu";

export function PanelHeader() {
  const { tabs, activeTabId, activateTab, closePanel, openOrActivatePage, setPanelOpen } = usePanel();
  const [pickerOpen, setPickerOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const handleAdd = useCallback(
    (pageId: PageId) => {
      openOrActivatePage(pageId);
    },
    [openOrActivatePage]
  );

  if (tabs.length === 0) {
    return (
      <div className="panel-header panel-header-empty">
        <span className="panel-header-empty-text">侧栏</span>
        <button
          ref={addBtnRef}
          type="button"
          className="panel-header-add"
          onClick={() => setPickerOpen((v) => !v)}
          title="新增页面"
          aria-label="新增页面"
        >
          <PlusIcon size={14} weight="bold" />
        </button>
        {pickerOpen && (
          <PagePickerMenu
            anchor={addBtnRef.current}
            onSelect={handleAdd}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="panel-header">
      <div className="panel-header-tabs">
        {tabs.map((tab) => {
          const desc = getPageDescriptor(tab.pageId);
          const Icon = desc.icon;
          const active = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              className={`panel-header-tab${active ? " active" : ""}`}
              onClick={() => activateTab(tab.id)}
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
        ref={addBtnRef}
        type="button"
        className="panel-header-add"
        onClick={() => setPickerOpen((v) => !v)}
        title="新增页面"
        aria-label="新增页面"
        aria-expanded={pickerOpen}
      >
        <PlusIcon size={14} weight="bold" />
      </button>
      {pickerOpen && (
        <PagePickerMenu
          anchor={addBtnRef.current}
          onSelect={handleAdd}
          onClose={() => setPickerOpen(false)}
        />
      )}
      <button
        type="button"
        className="panel-header-collapse"
        onClick={() => setPanelOpen(false)}
        title="收起侧栏"
        aria-label="收起侧栏"
      >
        ›
      </button>
    </div>
  );
}
