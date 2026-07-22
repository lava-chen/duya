"use client";

import React, { useCallback, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasElement } from "../..//types/conductor";
import { STICKY_COLORS, type StickyColorKey } from "./sticky-colors";
import { FloatingTextToolbar } from "./FloatingTextToolbar";
import { looksLikeHtml, textToHtml, htmlToText } from "./text-html";
import { useElementEditSession } from "./editing/useElementEditSession";
import { useElementPersistence } from "./editing/useElementPersistence";

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

type DiagramShape = "rect" | "rounded" | "ellipse" | "diamond" | "parallelogram" | "triangle" | "hexagon";

function DiagramShapeBackdrop({
  shape,
  fill,
  stroke,
  strokeWidth,
  strokeStyle,
}: {
  shape: DiagramShape;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeStyle: "solid" | "dashed" | "dotted";
}) {
  const common = {
    fill,
    stroke,
    strokeWidth: Math.max(strokeWidth, 1),
    strokeDasharray: strokeStyle === "dashed" ? "7 4" : strokeStyle === "dotted" ? "2 3" : undefined,
    vectorEffect: "non-scaling-stroke" as const,
  };

  let primitive: React.ReactNode;
  switch (shape) {
    case "diamond":
      primitive = <polygon points="50,1 99,50 50,99 1,50" {...common} />;
      break;
    case "parallelogram":
      primitive = <polygon points="14,1 99,1 86,99 1,99" {...common} />;
      break;
    case "triangle":
      primitive = <polygon points="50,1 99,99 1,99" {...common} />;
      break;
    case "hexagon":
      primitive = <polygon points="25,1 75,1 99,50 75,99 25,99 1,50" {...common} />;
      break;
    default:
      primitive = <rect x="1" y="1" width="98" height="98" {...common} />;
  }

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
    >
      {primitive}
    </svg>
  );
}

export const StickyElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const persist = useElementPersistence(element);
  const color = (element.config.color as StickyColorKey) || "yellow";
  const theme = STICKY_COLORS[color] ?? STICKY_COLORS.yellow;
  const text = (element.config.text as string) || "";

  // New style fields (optional, fall back to defaults for old data).
  const isDiagramShape =
    element.elementKind === "native/shape" ||
    element.config.presentation === "shape" ||
    ["filled", "outline", "dashed"].includes(element.config.shapePreset as string);
  const shape = (element.config.shape as DiagramShape | undefined) || "rect";
  const bgColor = element.config.bgColor as string | undefined;
  const borderStyleCfg = element.config.borderStyle as
    | { color?: string; width?: number; style?: "solid" | "dashed" | "dotted" }
    | undefined;
  const borderWidth = borderStyleCfg?.width ?? 0;
  const borderColor = borderStyleCfg?.color ?? "transparent";
  const borderStyleValue = borderStyleCfg?.style ?? "solid";

  const hGrid = element.position?.h ?? 3;
  const isCompactLabel = shape === "rect"
    && hGrid <= 2
    && text.trim().length > 0
    && text.trim().length <= 12
    && !text.includes("\n");

  // Compact labels are the common building block for mind maps and flows.
  // Give them stronger typography than paragraph notes. Explicit legacy
  // values below 18px are clamped so old agent-created canvases become
  // readable without requiring a migration.
  const defaultFontSize = isCompactLabel
    ? 22
    : Math.min(26, 20 + Math.max(0, hGrid - 2) * 2);
  const configuredFontSize = element.config.fontSize as number | undefined;
  const fontSize = typeof configuredFontSize === "number" && configuredFontSize > 0
    ? Math.max(isCompactLabel ? 20 : 18, configuredFontSize)
    : defaultFontSize;

  // Short shapes (diamond/ellipse) downgrade font size for long text to avoid overflow.
  const isShortShape = shape === "diamond" || shape === "ellipse" || shape === "triangle" || shape === "hexagon";
  const effectiveFontSize = isShortShape && text.length > 20 ? Math.max(16, fontSize - 4) : fontSize;

  const contentEditableRef = useRef<HTMLDivElement>(null);
  const [editorContainer, setEditorContainer] = useState<HTMLDivElement | null>(null);
  const setEditorRef = useCallback((node: HTMLDivElement | null) => {
    contentEditableRef.current = node;
    setEditorContainer(node);
  }, []);
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

  const commitDraft = useCallback((nextHtml: string) => {
    const normalized = htmlToText(nextHtml);
    if (normalized !== text.trim()) {
      persist({ config: { text: normalized } }, "Save sticky failed");
    }
  }, [persist, text]);

  const {
    isEditing,
    draft: editHtml,
    setDraft: setEditHtml,
    save,
    cancel,
    isComposingRef,
  } = useElementEditSession({
    elementId: element.id,
    source: text,
    createDraft: textToHtml,
    onCommit: commitDraft,
    focusEditor,
  });

  const hasText = text.trim().length > 0;
  const isEmptyEditor = htmlToText(editHtml).trim().length === 0;

  // Shape-driven outer styles.
  // Rectangles, rounded rectangles and ellipses are rendered with CSS instead
  // of the SVG backdrop so they hug the element edge and keep circular corners
  // under non-uniform scaling.
  const isCssShape = isDiagramShape && (shape === "rect" || shape === "rounded" || shape === "ellipse");
  const borderRadius = shape === "ellipse" ? "50%" : shape === "rounded" ? "12px" : isDiagramShape ? "0" : "6px";
  const padding = isDiagramShape ? "18px 24px" : shape === "ellipse" ? "16px 18px" : shape === "diamond" ? "16px 18px" : "10px 12px";
  const shapeRotate = !isDiagramShape && shape === "diamond" ? "rotate(45deg)" : "";
  const combinedTransform = shapeRotate || "none";
  const diagramStrokeWidth = borderWidth > 0 ? borderWidth : 1;
  const diagramStrokeColor = borderWidth > 0 ? borderColor : theme.stroke;
  const outerBackground = isCssShape ? (bgColor ?? theme.bg) : isDiagramShape ? "transparent" : bgColor ?? theme.bg;
  // When the user hasn't configured a borderStyle, default to a 1px solid
  // border using the diagram stroke color so sticky notes share the visual
  // language of diagram module nodes.
  const outerBorder = isDiagramShape
    ? isCssShape
      ? `${diagramStrokeWidth}px ${borderStyleValue} ${diagramStrokeColor}`
      : "none"
    : borderWidth > 0
      ? `${borderWidth}px ${borderStyleValue} ${borderColor}`
      : `1px solid ${theme.stroke}`;
  // Counter-rotate inner content so it stays upright inside a diamond.
  const contentWrapperTransform = !isDiagramShape && shape === "diamond" ? "rotate(-45deg)" : "none";

  return (
    <div
      className="conductor-sticky-curl"
      data-density={isCompactLabel ? "compact-label" : "note"}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: outerBackground,
        borderRadius,
        padding,
        fontSize: `${effectiveFontSize}px`,
        color: theme.text,
        lineHeight: isCompactLabel ? 1.3 : 1.5,
        fontWeight: isCompactLabel ? 600 : 400,
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
        if (isEditing) {
          // Keep focus in the textarea — only a click OUTSIDE the sticky
          // should blur (and thus auto-save).
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      {isDiagramShape && !isCssShape && (
        <DiagramShapeBackdrop
          shape={shape}
          fill={bgColor ?? theme.bg}
          stroke={diagramStrokeColor}
          strokeWidth={diagramStrokeWidth}
          strokeStyle={borderStyleValue}
        />
      )}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          minHeight: 0,
          transform: contentWrapperTransform,
          position: "relative",
          zIndex: 1,
          // Short diagram labels should read as nodes, not as mostly-empty
          // note cards. Longer notes keep the familiar top-left flow.
          alignItems: isDiagramShape || isShortShape || isCompactLabel ? "center" : "stretch",
          justifyContent: isDiagramShape || isShortShape || isCompactLabel ? "center" : "flex-start",
          textAlign: isDiagramShape || isShortShape || isCompactLabel ? "center" : "left",
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
              fontSize: `${effectiveFontSize}px`,
              color: theme.text,
              lineHeight: isCompactLabel ? 1.3 : 1.5,
              textAlign: isCompactLabel ? "center" : "left",
              fontFamily: "inherit",
              overflowY: "auto",
              wordBreak: "break-word",
              userSelect: "text",
              cursor: "text",
            }}
            dangerouslySetInnerHTML={{ __html: editHtml }}
          />
          {isEmptyEditor && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: isDiagramShape || isShortShape || isCompactLabel ? "center" : "flex-start",
                color: theme.placeholder,
                fontSize: `${effectiveFontSize}px`,
                lineHeight: isCompactLabel ? 1.3 : 1.5,
                pointerEvents: "none",
              }}
            >
              Add text
            </span>
          )}
          <FloatingTextToolbar container={editorContainer} element={element} showWhenEditing />
        </>
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
              looksLikeHtml(text) ? (
                <div dangerouslySetInnerHTML={{ __html: text }} />
              ) : (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={STICKY_MARKDOWN_COMPONENTS}
                >
                  {text}
                </ReactMarkdown>
              )
            ) : null}
          </div>
        </>
      )}
      </div>
    </div>
  );
};
