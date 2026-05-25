"use client";

import React, { useCallback, useEffect, useRef } from "react";
import type { CanvasElement } from "@/types/conductor";
import { updateElementContent } from "@/lib/conductor-ipc";
import { useConductorStore } from "@/stores/conductor-store";

export const TextElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const isEditing = editingElementId === element.id;
  const fontSize = (element.config.fontSize as number) || 18;
  const text = (element.config.text as string) || "";
  const pxW = element.position.w * 80;

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
          .catch((err) => setUiError(`Save text failed: ${err instanceof Error ? err.message : err}`));
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
        minHeight: "28px",
        padding: "4px 6px",
        fontSize: `${fontSize}px`,
        color: "var(--text)",
        lineHeight: 1.45,
        wordBreak: "break-word",
        cursor: isEditing ? "text" : "default",
        userSelect: isEditing ? "text" : "none",
        borderRadius: "4px",
        background: "transparent",
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
          style={{ outline: "none", minHeight: "1em", whiteSpace: "pre-wrap" }}
        />
      ) : (
        <div style={{ minHeight: "1em", whiteSpace: "pre-wrap" }}>
          {text || <span style={{ color: "var(--muted)" }}>Click to edit</span>}
        </div>
      )}
    </div>
  );
};
