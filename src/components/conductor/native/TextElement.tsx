"use client";
 
import React, { useCallback, useRef, useState, useEffect } from "react";
import type { CanvasElement } from "@/types/conductor";
import { useConductorStore } from "@/stores/conductor-store";
 
export const TextElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const { updateElement, editingElementId, setEditingElementId } = useConductorStore();
 
  const isEditing = editingElementId === element.id;
  const fontSize = (element.config.fontSize as number) || 14;
  const pxW = element.position.w * 80;
 
  const [localText, setLocalText] = useState((element.config.text as string) || "");
  const contentRef = useRef<HTMLDivElement>(null);
 
  useEffect(() => {
    if (!isEditing) {
      setLocalText((element.config.text as string) || "");
    }
  }, [element.config.text, isEditing]);
 
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
 
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) e.stopPropagation();
    },
    [isEditing]
  );
 
  return (
    <div
      style={{
        width: `${pxW}px`,
        minHeight: "24px",
        padding: "4px 6px",
        fontSize: `${fontSize}px`,
        color: "var(--text)",
        lineHeight: 1.5,
        wordBreak: "break-word",
        cursor: isEditing ? "text" : "default",
        userSelect: isEditing ? "text" : "none",
        borderRadius: "4px",
        background: "transparent",
      }}
      onMouseDown={handleMouseDown}
    >
      <div
        ref={contentRef}
        contentEditable={isEditing}
        suppressContentEditableWarning
        onBlur={save}
        onInput={() => setLocalText(contentRef.current?.textContent ?? "")}
        onKeyDown={(e) => { if (e.key === "Escape") save(); }}
        style={{ outline: "none", minHeight: "1em" }}
      >
        {localText || (
          <span style={{ color: "var(--muted)", pointerEvents: "none" }}>
            {isEditing ? "" : "Click to edit…"}
          </span>
        )}
      </div>
    </div>
  );
};