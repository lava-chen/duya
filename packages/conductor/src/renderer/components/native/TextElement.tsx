"use client";

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CanvasElement, CanvasPosition } from "../..//types/conductor";
import { executeAction } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";
import { FloatingTextToolbar } from "./FloatingTextToolbar";
import { looksLikeHtml, textToHtml, htmlToText } from "./text-html";
import { textContentSizeToGrid, MAX_TEXT_WIDTH_PX } from "../../domain/canvas/text-size";
import { useElementEditSession } from "./editing/useElementEditSession";
import { useElementPersistence } from "./editing/useElementPersistence";

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
  const persist = useElementPersistence(element);

  // native/text config historically allowed either `content` or `text`.
  const content = ((element.config.content as string | undefined) ?? (element.config.text as string | undefined)) ?? "";
  const fontFamily = (element.config.fontFamily as FontFamily) || "sans";
  const fontSize = (element.config.fontSize as number) || 16;
  const fontWeight = (element.config.fontWeight as number) || 400;
  const color = (element.config.color as string) || "var(--text)";
  const align = (element.config.align as "left" | "center" | "right") || "left";
  const lineHeight = (element.config.lineHeight as number) || 1.5;
  const highlightColor = element.config.highlightColor as string | null | undefined;

  const contentEditableRef = useRef<HTMLDivElement>(null);
  const [editorContainer, setEditorContainer] = useState<HTMLDivElement | null>(null);
  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    contentEditableRef.current = node;
    setEditorContainer(node);
  }, []);
  // Track whether this element was freshly created (empty) so Esc on an empty
  // new element deletes it instead of leaving an empty text box on canvas.
  const isNewAndEmptyRef = useRef<boolean>(content.trim().length === 0);

  useEffect(() => {
    isNewAndEmptyRef.current = content.trim().length === 0;
  }, [element.id, content]);

  const measureContentPosition = useCallback((html: string): CanvasPosition | null => {
    const editor = contentEditableRef.current;
    if (!editor || typeof document === "undefined") return null;

    const computed = window.getComputedStyle(editor);
    const measure = document.createElement("div");
    measure.style.position = "fixed";
    measure.style.visibility = "hidden";
    measure.style.pointerEvents = "none";
    measure.style.left = "-10000px";
    measure.style.top = "0";
    measure.style.display = "inline-block";
    measure.style.width = "max-content";
    measure.style.maxWidth = `${MAX_TEXT_WIDTH_PX}px`;
    measure.style.whiteSpace = "pre-wrap";
    measure.style.overflowWrap = "break-word";
    measure.style.wordBreak = "break-word";
    measure.style.fontFamily = computed.fontFamily;
    measure.style.fontSize = computed.fontSize;
    measure.style.fontWeight = computed.fontWeight;
    measure.style.fontStyle = computed.fontStyle;
    measure.style.lineHeight = computed.lineHeight;
    measure.innerHTML = html || "&nbsp;";
    document.body.appendChild(measure);
    const size = textContentSizeToGrid(measure.scrollWidth + 4, measure.scrollHeight + 4);
    measure.remove();

    const currentPosition = useConductorStore.getState().elements.find((candidate) => candidate.id === element.id)?.position ?? element.position;
    return { ...currentPosition, ...size };
  }, [element.id, element.position]);

  const fitContent = useCallback((html: string): CanvasPosition | null => {
    const nextPosition = measureContentPosition(html);
    if (!nextPosition) return null;
    const currentPosition = useConductorStore.getState().elements.find((candidate) => candidate.id === element.id)?.position;
    if (!currentPosition || Math.abs(currentPosition.w - nextPosition.w) > 0.001 || Math.abs(currentPosition.h - nextPosition.h) > 0.001) {
      updateElement(element.id, { position: nextPosition });
    }
    return nextPosition;
  }, [element.id, measureContentPosition, updateElement]);

  const deleteFreshEmpty = useCallback(() => {
    removeElement(element.id);
    if (activeCanvasId) {
      void executeAction({
        action: "element.delete",
        elementId: element.id,
        canvasId: activeCanvasId,
      }).catch(() => {});
    }
  }, [activeCanvasId, element.id, removeElement]);

  const commitDraft = useCallback((nextHtml: string) => {
    const normalized = htmlToText(nextHtml);

    if (normalized === "" && isNewAndEmptyRef.current) {
      deleteFreshEmpty();
      return;
    }

    const nextPosition = fitContent(nextHtml);
    const contentChanged = normalized !== content.trim();
    if (contentChanged || nextPosition) {
      persist({
        config: { content: normalized },
        ...(nextPosition ? { position: nextPosition } : {}),
      }, "Save text failed");
    }
    isNewAndEmptyRef.current = normalized === "";
  }, [content, deleteFreshEmpty, fitContent, persist]);

  const cancelDraft = useCallback(() => {
    if (content.trim() === "" && isNewAndEmptyRef.current) {
      deleteFreshEmpty();
    }
  }, [content, deleteFreshEmpty]);

  const focusEditor = useCallback(() => {
    const editor = contentEditableRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);

  const {
    isEditing,
    draft: editHtml,
    setDraft: setEditHtml,
    save,
    cancel,
    isComposingRef,
  } = useElementEditSession({
    elementId: element.id,
    source: content,
    createDraft: textToHtml,
    onCommit: commitDraft,
    onCancel: cancelDraft,
    focusEditor,
  });

  useLayoutEffect(() => {
    if (isEditing) fitContent(editHtml);
  }, [editHtml, fitContent, isEditing]);

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
            ref={setEditorRef}
            contentEditable
            suppressContentEditableWarning
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              setEditHtml(contentEditableRef.current?.innerHTML ?? "");
            }}
            onInput={() => {
              if (isComposingRef.current) return;
              setEditHtml(contentEditableRef.current?.innerHTML ?? "");
            }}
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
          <FloatingTextToolbar container={editorContainer} element={element} showWhenEditing />
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
