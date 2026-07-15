"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { TextBolderIcon, TextItalicIcon, TextUnderlineIcon, TextStrikethroughIcon } from "@/components/icons";
import {
  CapsuleToolbar,
  CAPSULE_BTN_BASE,
  CAPSULE_BTN_ACTIVE,
  CAPSULE_DIVIDER,
} from "../toolbar/CapsuleToolbar";

interface FloatingTextToolbarProps {
  container: HTMLElement | null;
}

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

export const FloatingTextToolbar: React.FC<FloatingTextToolbarProps> = ({ container }) => {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [active, setActive] = useState({ bold: false, italic: false, underline: false, strike: false });
  const toolbarRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    if (!container) {
      setVisible(false);
      return;
    }
    if (!isSelectionInside(container)) {
      setVisible(false);
      return;
    }
    const rect = getSelectionRect(container);
    if (!rect) {
      setVisible(false);
      return;
    }

    const host = container.getBoundingClientRect();
    const toolbarWidth = toolbarRef.current?.offsetWidth ?? 220;
    let x = rect.left + rect.width / 2 - toolbarWidth / 2 - host.left;
    let y = rect.top - host.top - 48;

    // Clamp horizontally inside the sticky note.
    x = Math.max(8, Math.min(x, host.width - toolbarWidth - 8));
    // If there is not enough room above, show below the selection.
    if (y < 8) {
      y = rect.bottom - host.top + 8;
    }

    setPosition({ x, y });
    setActive({
      bold: queryCommandState("bold"),
      italic: queryCommandState("italic"),
      underline: queryCommandState("underline"),
      strike: queryCommandState("strikeThrough"),
    });
    setVisible(true);
  }, [container]);

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

  const exec = useCallback((command: string, value: string | undefined = undefined) => {
    document.execCommand(command, false, value);
    refresh();
  }, [refresh]);

  const adjustFontSize = useCallback((delta: number) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (range.collapsed) return;

    // Wrap the selected contents in a span with an adjusted font size.
    const wrapper = document.createElement("span");
    wrapper.appendChild(range.extractContents());

    const currentSize = window.getComputedStyle(wrapper).fontSize;
    const parsed = parseFloat(currentSize);
    const nextSize = Number.isFinite(parsed) ? Math.max(10, parsed + delta) : 16;
    wrapper.style.fontSize = `${nextSize}px`;

    range.insertNode(wrapper);
    selection.removeAllRanges();
    const newRange = document.createRange();
    newRange.selectNodeContents(wrapper);
    selection.addRange(newRange);
    refresh();
  }, [refresh]);

  if (!visible) return null;

  return (
    <div ref={toolbarRef}>
      <CapsuleToolbar
        left={position.x}
        top={position.y}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          type="button"
          title="Decrease font size"
          onClick={() => adjustFontSize(-2)}
          style={{ ...CAPSULE_BTN_BASE, fontSize: 14, fontWeight: 600 }}
        >
          −
        </button>
        <button
          type="button"
          title="Increase font size"
          onClick={() => adjustFontSize(2)}
          style={{ ...CAPSULE_BTN_BASE, fontSize: 14, fontWeight: 600 }}
        >
          +
        </button>

        <div style={CAPSULE_DIVIDER} />

        <button
          type="button"
          title="Bold"
          onClick={() => exec("bold")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.bold ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextBolderIcon size={15} />
        </button>
        <button
          type="button"
          title="Italic"
          onClick={() => exec("italic")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.italic ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextItalicIcon size={15} />
        </button>
        <button
          type="button"
          title="Underline"
          onClick={() => exec("underline")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.underline ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextUnderlineIcon size={15} />
        </button>
        <button
          type="button"
          title="Strikethrough"
          onClick={() => exec("strikeThrough")}
          style={{ ...CAPSULE_BTN_BASE, ...(active.strike ? CAPSULE_BTN_ACTIVE : {}) }}
        >
          <TextStrikethroughIcon size={15} />
        </button>
      </CapsuleToolbar>
    </div>
  );
};
