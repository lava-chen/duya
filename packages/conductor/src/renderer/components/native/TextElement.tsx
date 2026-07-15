"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { CanvasElement } from "../..//types/conductor";
import { updateElementContent, executeAction } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";
import { FloatingTextToolbar } from "./FloatingTextToolbar";
import { looksLikeHtml, textToHtml, htmlToText } from "./text-html";

/**
 * Standalone text element. Unlike sticky, it has no card styling (no
 * background, border, shadow) — it is a pure text label / heading / annotation
 * for diagrams. Content follows the same plain-text-or-HTML model as sticky
 * so the same contenteditable editing flow and FloatingTextToolbar apply.
 *
 * Typography (font family / size / weight / color / align / line height) and
 * highlight color live in `config` and are edited via the right-side
 * StylePanel; the floating toolbar only handles inline formatting (bold /
 * italic / underline / strike / font size +/-) on the current selection.
 */

type FontFamily = "sans" | "serif" | "mono";

const FONT_FAMILY_STACK: Record<FontFamily, string> = {
  sans: 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Songti SC", serif',
  mono: '"Fira Mono", "JetBrains Mono", Menlo, Consolas, monospace',
};

const FONT_SIZE_MIN = 10;

export const TextElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const updateElement = useConductorStore((state) => state.updateElement);
  const removeElement = useConductorStore((state) => state.removeElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const isEditing = editingElementId === element.id;

  const content = (element.config.content as string) ?? "";
  const fontFamily = (element.config.fontFamily as FontFamily) || "sans";
  const fontSize = (element.config.fontSize as number) || 16;
  const fontWeight = (element.config.fontWeight as number) || 400;
  const color = (element.config.color as string) || "var(--text)";
  const align = (element.config.align as "left" | "center" | "right") || "left";
  const lineHeight = (element.config.lineHeight as number) || 1.5;
  const highlightColor = element.config.highlightColor as string | null | undefined;

  const [editHtml, setEditHtml] = useState(() => textToHtml(content));
  const contentEditableRef = useRef<HTMLDivElement>(null);
  // Guards against double-handling when Escape triggers blur during unmount.
  const exitModeRef = useRef<"save" | "cancel" | null>(null);
  // Track whether this element was freshly created (empty) so Esc on an empty
  // new element deletes it instead of leaving an empty text box on canvas.
  const isNewAndEmptyRef = useRef<boolean>(content.trim().length === 0);

  useEffect(() => {
    setEditHtml(textToHtml(content));
    isNewAndEmptyRef.current = content.trim().length === 0;
  }, [element.id, content]);

  useEffect(() => {
    if (isEditing) {
      exitModeRef.current = null;
      if (contentEditableRef.current) {
        contentEditableRef.current.focus();
        // Place caret at end so typing appends rather than prepends.
        const selection = window.getSelection();
        if (selection) {
          const range = document.createRange();
          range.selectNodeContents(contentEditableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
  }, [isEditing]);

  const save = useCallback(() => {
    if (exitModeRef.current !== null) return;
    exitModeRef.current = "save";
    const nextHtml = contentEditableRef.current?.innerHTML ?? editHtml;
    const normalized = htmlToText(nextHtml);

    // Empty content handling: delete fresh elements, keep existing ones
    // (they will render a placeholder instead).
    if (normalized === "" && isNewAndEmptyRef.current) {
      removeElement(element.id);
      if (activeCanvasId) {
        executeAction({
          action: "element.delete",
          elementId: element.id,
          canvasId: activeCanvasId,
        }).catch(() => {});
      }
      setEditingElementId(null);
      return;
    }

    if (normalized !== content.trim()) {
      const newConfig = { ...element.config, content: normalized };
      updateElement(element.id, { config: newConfig });
      if (activeCanvasId) {
        updateElementContent(element.id, activeCanvasId, { content: normalized })
          .catch((err) => setUiError(`Save text failed: ${err instanceof Error ? err.message : err}`));
      }
    }
    isNewAndEmptyRef.current = normalized === "";
    setEditingElementId(null);
  }, [activeCanvasId, content, editHtml, element.config, element.id, removeElement, setEditingElementId, setUiError, updateElement]);

  const cancel = useCallback(() => {
    if (exitModeRef.current !== null) return;
    exitModeRef.current = "cancel";
    setEditHtml(textToHtml(content));
    // Esc on a fresh empty element also deletes it — matches the "click away
    // on empty new element" behavior so users don't get stranded boxes.
    if (content.trim() === "" && isNewAndEmptyRef.current) {
      removeElement(element.id);
      if (activeCanvasId) {
        executeAction({
          action: "element.delete",
          elementId: element.id,
          canvasId: activeCanvasId,
        }).catch(() => {});
      }
    }
    setEditingElementId(null);
  }, [activeCanvasId, content, element.id, removeElement, setEditingElementId]);

  const hasContent = content.trim().length > 0;

  const commonStyle: React.CSSProperties = {
    width: "100%",
    height: "100%",
    fontFamily: FONT_FAMILY_STACK[fontFamily],
    fontSize: Math.max(FONT_SIZE_MIN, fontSize),
    fontWeight,
    color,
    textAlign: align,
    lineHeight,
    wordBreak: "break-word",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    cursor: isEditing ? "text" : "default",
    userSelect: isEditing ? "text" : "none",
    padding: 2,
  };

  // Highlight is applied as a CSS background on the inner content wrapper so
  // it covers the actual text area rather than the whole element box.
  const highlightStyle: React.CSSProperties = highlightColor
    ? { background: highlightColor, boxDecorationBreak: "clone", WebkitBoxDecorationBreak: "clone" }
    : {};

  return (
    <div
      className="conductor-text-element"
      style={commonStyle}
      onMouseDown={(e) => {
        if (isEditing) {
          // Keep focus in the editor — only a click OUTSIDE should blur
          // (and thus auto-save).
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      {isEditing ? (
        <>
          <div
            ref={contentEditableRef}
            contentEditable
            suppressContentEditableWarning
            onInput={() => setEditHtml(contentEditableRef.current?.innerHTML ?? "")}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              }
            }}
            style={{
              flex: 1,
              width: "100%",
              border: "none",
              outline: "none",
              background: "transparent",
              padding: 0,
              fontFamily: FONT_FAMILY_STACK[fontFamily],
              fontSize: Math.max(FONT_SIZE_MIN, fontSize),
              fontWeight,
              color,
              textAlign: align,
              lineHeight,
              overflowY: "auto",
              wordBreak: "break-word",
              userSelect: "text",
              cursor: "text",
              ...highlightStyle,
            }}
            dangerouslySetInnerHTML={{ __html: editHtml }}
          />
          <FloatingTextToolbar container={contentEditableRef.current} />
        </>
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            ...highlightStyle,
          }}
          className="text-element-content"
        >
          {hasContent ? (
            looksLikeHtml(content) ? (
              <div dangerouslySetInnerHTML={{ __html: content }} />
            ) : (
              <div style={{ whiteSpace: "pre-wrap" }}>{content}</div>
            )
          ) : (
            <span style={{ color: "var(--muted)", opacity: 0.6 }}>Add text</span>
          )}
        </div>
      )}
    </div>
  );
};
