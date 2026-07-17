"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  LinkSimple,
  ListBullets,
  Minus,
  PaintBucket,
  Plus,
  TextAlignCenter,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  TextT,
  Trash,
} from "@phosphor-icons/react";
import {
  CapsuleToolbar,
  CapsuleMoreMenu,
  CAPSULE_BTN_BASE,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_DIVIDER,
} from "../toolbar/CapsuleToolbar";
import type { CanvasElement } from "../../types/conductor";
import { useElementLock } from "../toolbar/useElementLock";

interface FloatingTextToolbarProps {
  container: HTMLElement | null;
  element: CanvasElement;
  /** Keep the table-style editor controls available while the caret is active. */
  showWhenEditing?: boolean;
}

const TEXT_COLORS = ["#3289d1", "#6d5ce8", "#8618d4", "#bd35ca", "#12a99b", "#2f8f83", "#a28e6f", "#be6d6d", "#df455a", "#f28a37", "#f5bf28"];

function isSelectionInside(container: HTMLElement | null): boolean {
  if (!container) return false;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return container.contains(range.commonAncestorContainer);
}

function getSelectionRect(container: HTMLElement | null): DOMRect | null {
  if (!container) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const rects = range.getClientRects();
  if (rects.length === 0) return null;
  const first = rects[0];
  const last = rects[rects.length - 1];
  return new DOMRect(
    first.left,
    first.top,
    last.right - first.left,
    last.bottom - first.top,
  );
}

function queryCommandState(command: string): boolean {
  try {
    return document.queryCommandState(command);
  } catch {
    return false;
  }
}

export const FloatingTextToolbar: React.FC<FloatingTextToolbarProps> = ({ container, element, showWhenEditing = false }) => {
  const { locked, toggleLocked } = useElementLock(element);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, strike: false });
  const [picker, setPicker] = useState<"text" | "fill" | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!container) {
      setVisible(false);
      return;
    }
    const hasSelection = isSelectionInside(container);
    if (!hasSelection && !showWhenEditing) {
      setVisible(false);
      return;
    }

    const host = container.getBoundingClientRect();
    const rect = getSelectionRect(container) ?? host;
    const toolbarWidth = toolbarRef.current?.offsetWidth ?? 470;
    let x = rect.left + rect.width / 2 - toolbarWidth / 2;
    let y = rect.top - 50;

    // Clamp in viewport coordinates. The editor content may be visually
    // rotated, but selection client rects are already viewport-relative.
    x = Math.max(host.left + 8, Math.min(x, host.right - toolbarWidth - 8));
    // If there is not enough room above, show below the selection.
    if (y < host.top + 8) {
      y = rect.bottom + 8;
    }

    setPosition({ x, y });
    setActive({
      bold: queryCommandState("bold"),
      italic: queryCommandState("italic"),
      underline: queryCommandState("underline"),
      strike: queryCommandState("strikeThrough"),
    });
    setVisible(true);
  }, [container, showWhenEditing]);

  useEffect(() => {
    if (!container) return;

    const handleSelectionChange = () => {
      window.requestAnimationFrame(refresh);
    };

    const handleMouseUp = () => {
      window.requestAnimationFrame(refresh);
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [container, refresh]);

  useEffect(() => {
    if (!container) return;
    const frame = window.requestAnimationFrame(refresh);
    return () => window.cancelAnimationFrame(frame);
  }, [container, refresh]);

  const exec = useCallback((command: string, value: string | undefined = undefined) => {
    document.execCommand(command, false, value);
    refresh();
  }, [refresh]);

  const createLink = useCallback(() => {
    const url = window.prompt("Link URL");
    if (url?.trim()) exec("createLink", url.trim());
  }, [exec]);

  const adjustFontSize = useCallback((delta: number) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return;

    // Wrap the selected contents in a span with an adjusted font size. This
    // matches table-cell sizing while retaining rich-text selections.
    const wrapper = document.createElement("span");
    wrapper.appendChild(range.extractContents());

    const styleTarget = range.startContainer.parentElement ?? container;
    if (!styleTarget) return;
    const currentSize = window.getComputedStyle(styleTarget).fontSize;
    const parsed = parseFloat(currentSize);
    const nextSize = Number.isFinite(parsed) ? Math.max(10, parsed + delta) : 16;
    wrapper.style.fontSize = `${nextSize}px`;

    range.insertNode(wrapper);
    selection.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    selection.addRange(newRange);
    refresh();
  }, [container, refresh]);

  const applyColor = useCallback((target: "text" | "fill", color: string) => {
    document.execCommand(target === "text" ? "foreColor" : "hiliteColor", false, color);
    setPicker(null);
    refresh();
  }, [refresh]);

  if (!visible || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={toolbarRef}
      style={{ position: "fixed", left: position.x, top: position.y, zIndex: 100 }}
    >
      <CapsuleToolbar
        left={0}
        top={0}
        zoomAware={false}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          title="Bold"
          onClick={() => exec("bold")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.bold ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextB size={17} weight="bold" />
        </button>
        <button
          type="button"
          title="Italic"
          onClick={() => exec("italic")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.italic ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextItalic size={17} weight="bold" />
        </button>
        <div style={CAPSULE_DIVIDER} />

        <button type="button" title="Decrease font size" onClick={() => adjustFontSize(-2)} style={CAPSULE_BTN_BASE}>
          <Minus size={15} weight="bold" />
        </button>
        <button type="button" title="Font size" style={{ ...CAPSULE_BTN_BASE, width: 24, fontSize: 13, fontWeight: 700 }}>
          M
        </button>
        <button type="button" title="Increase font size" onClick={() => adjustFontSize(2)} style={CAPSULE_BTN_BASE}>
          <Plus size={15} weight="bold" />
        </button>
        <div style={CAPSULE_DIVIDER} />

        {(["text", "fill"] as const).map((target) => {
          const Icon = target === "text" ? TextT : PaintBucket;
          return (
            <button
              key={target}
              type="button"
              title={target === "text" ? "Text color" : "Text highlight color"}
              onClick={() => setPicker((current) => current === target ? null : target)}
              style={{ ...CAPSULE_BTN_BASE, ...(picker === target ? CAPSULE_BTN_ACTIVE : {}) }}
            >
              <Icon size={17} weight="bold" />
            </button>
          );
        })}
        <div style={CAPSULE_DIVIDER} />

        <button type="button" title="Align left" onClick={() => exec("justifyLeft")} style={CAPSULE_BTN_BASE}><TextAlignLeft size={17} weight="bold" /></button>
        <button type="button" title="Align center" onClick={() => exec("justifyCenter")} style={CAPSULE_BTN_BASE}><TextAlignCenter size={17} weight="bold" /></button>
        <button type="button" title="Align right" onClick={() => exec("justifyRight")} style={CAPSULE_BTN_BASE}><TextAlignRight size={17} weight="bold" /></button>
        <div style={CAPSULE_DIVIDER} />

        <button type="button" title="Delete selected text" onClick={() => exec("delete")} style={{ ...CAPSULE_BTN_BASE, color: "#ff9d9d" }}><Trash size={16} weight="bold" /></button>
        <CapsuleMoreMenu
          items={[
            { label: locked ? "Unlock position" : "Lock position", onSelect: toggleLocked },
            { label: "Add link", onSelect: createLink },
            { label: "Bulleted list", onSelect: () => exec("insertUnorderedList") },
            { label: active.underline ? "Remove underline" : "Underline", onSelect: () => exec("underline") },
            { label: active.strike ? "Remove strikethrough" : "Strikethrough", onSelect: () => exec("strikeThrough") },
            { label: "Clear formatting", onSelect: () => exec("removeFormat") },
          ]}
        />
      </CapsuleToolbar>
      {picker && (
        <div
          role="menu"
          aria-label={`${picker} color palette`}
          style={{
            position: "fixed",
            left: position.x,
            top: position.y + 48,
            display: "grid",
            gridTemplateColumns: "repeat(6, 24px)",
            gap: 6,
            padding: 8,
            background: "var(--command-menu-bg)",
            border: "1px solid var(--command-menu-border)",
            borderRadius: 10,
            zIndex: 101,
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {TEXT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              title={color}
              onClick={() => applyColor(picker, color)}
              style={{ width: 20, height: 20, padding: 0, border: 0, borderRadius: "50%", background: color, cursor: "pointer" }}
            />
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
};
