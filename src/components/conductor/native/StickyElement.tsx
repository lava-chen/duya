"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement } from "@/types/conductor";
import { updateElementContent } from "@/lib/conductor-ipc";
import { useConductorStore } from "@/stores/conductor-store";

const STICKY_COLORS: Record<string, { bg: string; text: string; placeholder: string }> = {
  yellow: { bg: "#FFF9C4", text: "#3d3000", placeholder: "rgba(0,0,0,0.3)" },
  blue: { bg: "#BBDEFB", text: "#0d2a4a", placeholder: "rgba(0,0,0,0.3)" },
  green: { bg: "#C8E6C9", text: "#0d3318", placeholder: "rgba(0,0,0,0.3)" },
  pink: { bg: "#F8BBD0", text: "#4a0a22", placeholder: "rgba(0,0,0,0.3)" },
  purple: { bg: "#E1BEE7", text: "#2d0a3d", placeholder: "rgba(0,0,0,0.3)" },
  gray: { bg: "#E0E0E0", text: "#1a1a1a", placeholder: "rgba(0,0,0,0.3)" },
};

export const StickyElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const isEditing = editingElementId === element.id;
  const color = (element.config.color as string) || "yellow";
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow;
  const fontSize = (element.config.fontSize as number) || 18;
  const text = (element.config.text as string) || "";
  const pxW = Math.round(element.position.w * 80);
  const pxH = Math.round(element.position.h * 80);

  const contentRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const initialTextRef = useRef(text);

  useEffect(() => {
    if (!isEditing || !contentRef.current) return;
    const el = contentRef.current;
    initialTextRef.current = text;
    el.textContent = text;
    el.focus();

    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, [isEditing, text]);

  const save = useCallback(() => {
    const currentText = contentRef.current?.textContent ?? "";
    if (currentText !== text) {
      updateElement(element.id, { config: { ...element.config, text: currentText } });
      if (activeCanvasId) {
        updateElementContent(element.id, activeCanvasId, { text: currentText })
          .catch((err) => setUiError(`Save sticky failed: ${err instanceof Error ? err.message : err}`));
      }
    }
    setEditingElementId(null);
  }, [activeCanvasId, element.config, element.id, setEditingElementId, setUiError, text, updateElement]);

  const cancel = useCallback(() => {
    if (contentRef.current) contentRef.current.textContent = initialTextRef.current;
    setEditingElementId(null);
  }, [setEditingElementId]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
  }, []);

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
      }}
      onMouseDown={(e) => {
        if (isEditing) e.stopPropagation();
      }}
    >
      {isEditing ? (
        <div
          ref={contentRef}
          contentEditable
          suppressContentEditableWarning
          onBlur={save}
          onPaste={handlePaste}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          onKeyDown={(e) => {
            if (composingRef.current || e.nativeEvent.isComposing) return;
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          style={{ outline: "none", flex: 1, overflowY: "auto", whiteSpace: "pre-wrap" }}
        />
      ) : (
        <div style={{ flex: 1, overflowY: "auto", whiteSpace: "pre-wrap" }}>
          {text || <span style={{ color: theme.placeholder }}>Add text</span>}
        </div>
      )}
    </div>
  );
};
