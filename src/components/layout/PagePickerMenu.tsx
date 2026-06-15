// src/components/layout/PagePickerMenu.tsx
"use client";

import { useEffect, useRef } from "react";
import { PAGE_REGISTRY, type PageId } from "./panels/registry";

interface PagePickerMenuProps {
  anchor: HTMLElement | null;
  onSelect: (pageId: PageId) => void;
  onClose: () => void;
}

export function PagePickerMenu({ anchor, onSelect, onClose }: PagePickerMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!anchor) return;
    const handleDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleDown);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleDown);
      document.removeEventListener("keydown", handleKey);
    };
  }, [anchor, onClose]);

  useEffect(() => {
    if (!anchor || !menuRef.current) return;
    const menu = menuRef.current;
    const trigger = anchor.getBoundingClientRect();
    const pad = 8;
    const gap = 4;
    const menuW = menu.offsetWidth || 200;
    const menuH = menu.offsetHeight || 160;
    let left = trigger.right - menuW;
    let top = trigger.bottom + gap;
    if (left < pad) left = pad;
    if (left + menuW > window.innerWidth - pad) left = window.innerWidth - pad - menuW;
    if (top + menuH > window.innerHeight - pad) top = trigger.top - gap - menuH;
    if (top < pad) top = pad;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [anchor]);

  if (!anchor) return null;

  const entries = Object.values(PAGE_REGISTRY);

  return (
    <div ref={menuRef} className="page-picker-menu" role="menu">
      <div className="page-picker-menu-title">选择要打开的页面</div>
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className={`page-picker-item${entry.available ? "" : " disabled"}`}
            disabled={!entry.available}
            onClick={() => {
              if (!entry.available) return;
              onSelect(entry.id);
              onClose();
            }}
            title={entry.available ? entry.label : `${entry.label}（未实现）`}
          >
            <Icon size={14} weight="regular" />
            <span className="page-picker-item-label">{entry.label}</span>
            {!entry.available && (
              <span className="page-picker-item-hint">未实现</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
