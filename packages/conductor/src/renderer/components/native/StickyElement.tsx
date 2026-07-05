"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasElement } from "../..//types/conductor";
import { updateElementContent } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";
import { STICKY_COLORS, type StickyColorKey } from "./sticky-colors";

const STICKY_MARKDOWN_COMPONENTS = {
  h1: ({ children, ...props }: any) => (
    <h1 style={{ fontSize: "1.1em", fontWeight: 700, margin: "0.2em 0", lineHeight: 1.3 }} {...props}>{children}</h1>
  ),
  h2: ({ children, ...props }: any) => (
    <h2 style={{ fontSize: "1em", fontWeight: 700, margin: "0.2em 0", lineHeight: 1.3 }} {...props}>{children}</h2>
  ),
  h3: ({ children, ...props }: any) => (
    <h3 style={{ fontSize: "0.95em", fontWeight: 700, margin: "0.15em 0", lineHeight: 1.3 }} {...props}>{children}</h3>
  ),
  p: ({ children, ...props }: any) => (
    <p style={{ margin: "0.15em 0" }} {...props}>{children}</p>
  ),
  ul: ({ children, ...props }: any) => (
    <ul style={{ margin: "0.15em 0", paddingLeft: "1.2em" }} {...props}>{children}</ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol style={{ margin: "0.15em 0", paddingLeft: "1.2em" }} {...props}>{children}</ol>
  ),
  li: ({ children, ...props }: any) => (
    <li style={{ margin: "0.05em 0" }} {...props}>{children}</li>
  ),
  code: ({ children, className, ...props }: any) => {
    const isInline = !className;
    return isInline ? (
      <code style={{ backgroundColor: "rgba(0,0,0,0.08)", borderRadius: 3, padding: "1px 4px", fontSize: "0.9em" }} {...props}>{children}</code>
    ) : (
      <code style={{ display: "block", backgroundColor: "rgba(0,0,0,0.06)", borderRadius: 4, padding: "4px 8px", fontSize: "0.85em", overflow: "auto" }} {...props}>{children}</code>
    );
  },
  blockquote: ({ children, ...props }: any) => (
    <blockquote style={{ borderLeft: "3px solid rgba(0,0,0,0.18)", paddingLeft: 8, margin: "0.2em 0", opacity: 0.85 }} {...props}>{children}</blockquote>
  ),
  hr: (props: any) => <hr style={{ border: "none", borderTop: "1px solid rgba(0,0,0,0.12)", margin: "0.3em 0" }} {...props} />,
  a: ({ children, ...props }: any) => (
    <a style={{ color: "inherit", textDecoration: "underline", opacity: 0.85 }} {...props}>{children}</a>
  ),
  strong: ({ children, ...props }: any) => (
    <strong style={{ fontWeight: 700 }} {...props}>{children}</strong>
  ),
  em: ({ children, ...props }: any) => (
    <em style={{ fontStyle: "italic" }} {...props}>{children}</em>
  ),
  del: ({ children, ...props }: any) => (
    <del style={{ textDecoration: "line-through", opacity: 0.6 }} {...props}>{children}</del>
  ),
};

export const StickyElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const updateElement = useConductorStore((state) => state.updateElement);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);

  const isSelected = selectedElementId === element.id;
  const isEditing = editingElementId === element.id;
  const color = (element.config.color as StickyColorKey) || "yellow";
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow;
  const fontSize = (element.config.fontSize as number) || 14;
  const text = (element.config.text as string) || "";

  // New style fields (optional, fall back to defaults for old data).
  const shape = (element.config.shape as "rect" | "diamond" | "ellipse" | undefined) || "rect";
  const bgColor = element.config.bgColor as string | undefined;
  const borderStyleCfg = element.config.borderStyle as
    | { color?: string; width?: number; style?: "solid" | "dashed" | "dotted" }
    | undefined;
  const borderWidth = borderStyleCfg?.width ?? 0;
  const borderColor = borderStyleCfg?.color ?? "transparent";
  const borderStyleValue = borderStyleCfg?.style ?? "solid";

  // Short shapes (diamond/ellipse) downgrade font size for long text to avoid overflow.
  const isShortShape = shape === "diamond" || shape === "ellipse";
  const effectiveFontSize = isShortShape && text.length > 20 ? 12 : fontSize;

  const [editText, setEditText] = useState(text);
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setEditText(text);
  }, [element.id, text]);

  useEffect(() => {
    if (isEditing && editTextareaRef.current) {
      editTextareaRef.current.focus();
    }
  }, [isEditing]);

  const save = useCallback(() => {
    const trimmed = editText.trim();
    if (trimmed !== text) {
      const newConfig = { ...element.config, text: trimmed };
      updateElement(element.id, { config: newConfig });
      if (activeCanvasId) {
        updateElementContent(element.id, activeCanvasId, { text: trimmed })
          .catch((err) => setUiError(`Save sticky failed: ${err instanceof Error ? err.message : err}`));
      }
    }
    setEditingElementId(null);
  }, [activeCanvasId, editText, element.config, element.id, setEditingElementId, setUiError, text, updateElement]);

  const cancel = useCallback(() => {
    setEditText(text);
    setEditingElementId(null);
  }, [setEditingElementId, text]);

  const hasText = text.trim().length > 0;
  const showToolbar = isSelected && !isEditing;

  const startEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setEditingElementId(element.id);
  }, [element.id, setEditingElementId]);

  // Shape-driven outer styles.
  const borderRadius = shape === "ellipse" ? "50%" : "var(--radius-element)";
  const padding = shape === "ellipse" ? "20px 22px" : shape === "diamond" ? "18px 20px" : "14px 16px";
  const shapeRotate = shape === "diamond" ? "rotate(45deg)" : "";
  const combinedTransform = shapeRotate || "none";
  const outerBackground = bgColor ?? theme.bg;
  // When the user hasn't configured a borderStyle, default to a 1px solid
  // border using the diagram stroke color so sticky notes share the visual
  // language of diagram module nodes.
  const outerBorder =
    borderWidth > 0
      ? `${borderWidth}px ${borderStyleValue} ${borderColor}`
      : `1px solid ${theme.stroke}`;
  // Counter-rotate inner content so it stays upright inside a diamond.
  const contentWrapperTransform = shape === "diamond" ? "rotate(-45deg)" : "none";

  return (
    <div
      className="conductor-sticky-curl"
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: outerBackground,
        borderRadius,
        padding,
        fontSize: `${effectiveFontSize}px`,
        color: theme.text,
        lineHeight: 1.55,
        wordBreak: "break-word",
        cursor: isEditing ? "text" : "default",
        userSelect: isEditing ? "text" : "none",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        border: outerBorder,
        boxShadow: "none",
        transform: combinedTransform,
      }}
      onMouseDown={(e) => {
        if (isEditing) e.stopPropagation();
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          transform: contentWrapperTransform,
          // Center content for short shapes where the usable area is smaller.
          alignItems: isShortShape ? "center" : "stretch",
          justifyContent: isShortShape ? "center" : "flex-start",
          textAlign: isShortShape ? "center" : "left",
        }}
      >
      {isEditing ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: "100%" }}>
          <textarea
            ref={editTextareaRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
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
              resize: "none",
              border: "none",
              outline: "none",
              background: "rgba(0,0,0,0.04)",
              borderRadius: 4,
              padding: "6px 8px",
              fontSize: `${effectiveFontSize}px`,
              color: theme.text,
              lineHeight: 1.55,
              fontFamily: "inherit",
              whiteSpace: "pre-wrap",
              overflowY: "auto",
            }}
            placeholder="Write markdown..."
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={cancel}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                borderRadius: 4,
                border: "none",
                background: "rgba(0,0,0,0.08)",
                color: theme.text,
                cursor: "pointer",
                opacity: 0.7,
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                borderRadius: 4,
                border: "none",
                background: "rgba(0,0,0,0.16)",
                color: theme.text,
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              overflowX: "hidden",
            }}
            className="sticky-markdown-content"
          >
            {hasText ? (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={STICKY_MARKDOWN_COMPONENTS}
              >
                {text}
              </ReactMarkdown>
            ) : (
              <span style={{ color: theme.placeholder }}>Add text</span>
            )}
          </div>
          {showToolbar && (
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                display: "flex",
                justifyContent: "center",
                padding: "4px 0",
                background: theme.bg,
                pointerEvents: "auto",
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={startEditing}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "3px 12px",
                  fontSize: 11,
                  borderRadius: 5,
                  border: "1px solid rgba(0,0,0,0.15)",
                  background: "rgba(255,255,255,0.7)",
                  color: theme.text,
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M8.5 1.5L10.5 3.5L3.5 10.5H1.5V8.5L8.5 1.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                </svg>
                Edit
              </button>
            </div>
          )}
        </>
      )}
      </div>
    </div>
  );
};
