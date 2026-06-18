"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasElement } from "../..//types/conductor";
import { updateElementContent } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";

const STICKY_COLORS: Record<string, { bg: string; text: string; placeholder: string; shadow: string }> = {
  yellow: { bg: "#FFF8B8", text: "#5C4A00", placeholder: "rgba(92,74,0,0.3)", shadow: "rgba(255,200,0,0.18)" },
  blue: { bg: "#B8DFFF", text: "#0D3A66", placeholder: "rgba(13,58,102,0.3)", shadow: "rgba(0,122,255,0.18)" },
  green: { bg: "#C4ECC4", text: "#1A4D1A", placeholder: "rgba(26,77,26,0.3)", shadow: "rgba(48,209,88,0.18)" },
  pink: { bg: "#FFC4DC", text: "#661A3D", placeholder: "rgba(102,26,61,0.3)", shadow: "rgba(255,79,108,0.18)" },
  purple: { bg: "#DCC4F0", text: "#3D1A5C", placeholder: "rgba(61,26,92,0.3)", shadow: "rgba(167,139,250,0.18)" },
  gray: { bg: "#E0E0E0", text: "#333333", placeholder: "rgba(51,51,51,0.3)", shadow: "rgba(0,0,0,0.1)" },
};

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
  const color = (element.config.color as string) || "yellow";
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow;
  const fontSize = (element.config.fontSize as number) || 14;
  const text = (element.config.text as string) || "";
  const pxW = Math.round(element.position.w * 80);
  const pxH = Math.round(element.position.h * 80);

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

  return (
    <div
      className="conductor-sticky-curl"
      style={{
        width: `${pxW}px`,
        height: `${pxH}px`,
        backgroundColor: theme.bg,
        borderRadius: "var(--radius-element)",
        padding: "14px 16px",
        fontSize: `${fontSize}px`,
        color: theme.text,
        lineHeight: 1.55,
        wordBreak: "break-word",
        cursor: isEditing ? "text" : "default",
        userSelect: isEditing ? "text" : "none",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        boxShadow: isSelected
          ? `var(--shadow-focusing)`
          : `0 1px 2px ${theme.shadow}, 0 2px 8px ${theme.shadow}, 0 8px 24px ${theme.shadow}`,
        transition: "box-shadow var(--motion-duration-small) var(--motion-smooth), transform var(--motion-duration-small) var(--motion-smooth)",
        transform: isSelected ? "scale(1.01)" : "none",
      }}
      onMouseDown={(e) => {
        if (isEditing) e.stopPropagation();
      }}
    >
      {isEditing ? (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
              fontSize: `${fontSize}px`,
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
                background: `linear-gradient(transparent, ${theme.bg} 60%)`,
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
                  backdropFilter: "blur(4px)",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
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
  );
};
