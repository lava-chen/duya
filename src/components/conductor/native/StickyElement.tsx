"use client";

import React, { useCallback, useRef, useState, useEffect } from "react";
import type { CanvasElement } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";

const STICKY_COLORS: Record<string, { bg: string; text: string; placeholder: string }> = {
  yellow: { bg: "#FFF9C4", text: "#3d3000",   placeholder: "rgba(0,0,0,0.3)" },
  blue:   { bg: "#BBDEFB", text: "#0d2a4a",   placeholder: "rgba(0,0,0,0.3)" },
  green:  { bg: "#C8E6C9", text: "#0d3318",   placeholder: "rgba(0,0,0,0.3)" },
  pink:   { bg: "#F8BBD0", text: "#4a0a22",   placeholder: "rgba(0,0,0,0.3)" },
  purple: { bg: "#E1BEE7", text: "#2d0a3d",   placeholder: "rgba(0,0,0,0.3)" },
  gray:   { bg: "#E0E0E0", text: "#1a1a1a",   placeholder: "rgba(0,0,0,0.3)" },
};

export const StickyElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const { updateElement, editingElementId, setEditingElementId } = useConductorStore();

  const isEditing = editingElementId === element.id;
  const color = (element.config.color as string) || "yellow";
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow;
  const fontSize = (element.config.fontSize as number) || 14;

  // Width/height come from position (grid units × 80px)
  const pxW = Math.round(element.position.w * 80);
  const pxH = Math.round(element.position.h * 80);

  const [localText, setLocalText] = useState((element.config.text as string) || "");
  const contentRef = useRef<HTMLDivElement>(null);

  // Sync from store when not editing
  useEffect(() => {
    if (!isEditing) {
      setLocalText((element.config.text as string) || "");
    }
  }, [element.config.text, isEditing]);

  // Focus + move cursor to end when editing starts
  useEffect(() => {
    if (isEditing && contentRef.current) {
      const el = contentRef.current;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const save = useCallback(() => {
    const currentText = contentRef.current?.textContent ?? "";
    if (currentText !== (element.config.text ?? "")) {
      updateElement(element.id, {
        config: { ...element.config, text: currentText },
      });
    }
    setEditingElementId(null);
  }, [element, updateElement, setEditingElementId]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        save();
      }
      // Allow Enter for newlines — do not intercept
    },
    [save]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // When editing, absorb the event so NativeChrome / drag doesn't fire
      if (isEditing) {
        e.stopPropagation();
      }
    },
    [isEditing]
  );

  const showPlaceholder = !localText && !isEditing;

  return (
    <div
      style={{
        width: `${pxW}px`,
        height: `${pxH}px`,
        backgroundColor: theme.bg,
        borderRadius: "6px",
        padding: "12px 14px",
        fontSize: `${fontSize}px`,
        color: theme.text,
        lineHeight: 1.55,
        wordBreak: "break-word",
        cursor: isEditing ? "text" : "default",
        userSelect: isEditing ? "text" : "none",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        // shadow handled by NativeChrome selection border
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        ref={contentRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onBlur={save}
        onInput={() => setLocalText(contentRef.current?.textContent ?? "")}
        onKeyDown={handleKeyDown}
        style={{ outline: "none", flex: 1, overflowY: "auto" }}
      >
        {showPlaceholder ? (
          <span style={{ color: theme.placeholder, pointerEvents: "none" }}>
            Add text…
          </span>
        ) : (
          localText
        )}
      </div>
    </div>
  );
};