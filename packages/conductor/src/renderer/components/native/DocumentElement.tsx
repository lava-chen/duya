"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowsOut,
  Copy,
  DownloadSimple,
  LinkSimple,
  PencilSimple,
  TextAa,
  TextB,
  TextItalic,
  X,
} from "@phosphor-icons/react";
import type { CanvasElement } from "../..//types/conductor";
import { useConductorStore } from "../..//stores/conductor-store";
import { useElementEditSession } from "./editing/useElementEditSession";
import { useElementPersistence } from "./editing/useElementPersistence";
import { CapsuleToolbar, CAPSULE_BTN_BASE, CAPSULE_DIVIDER } from "../toolbar/CapsuleToolbar";

type SelectionRange = { start: number; end: number };
type BlockKind = "paragraph" | "heading-1" | "heading-2" | "heading-3" | "ordered" | "bullet" | "checklist";

const BLOCK_OPTIONS: Array<{ value: BlockKind; label: string }> = [
  { value: "paragraph", label: "Text" },
  { value: "heading-1", label: "Heading 1" },
  { value: "heading-2", label: "Heading 2" },
  { value: "heading-3", label: "Heading 3" },
  { value: "ordered", label: "Ordered list" },
  { value: "bullet", label: "Bullet list" },
  { value: "checklist", label: "Checklist" },
];

function stripBlockPrefix(line: string): string {
  return line.replace(/^(#{1,3}\s+|[-*+]\s+|\d+\.\s+|-\s+\[[ xX]\]\s+)/, "");
}

function formatBlock(kind: BlockKind, source: string): string {
  const lines = source.split("\n");
  return lines.map((line, index) => {
    const text = stripBlockPrefix(line);
    if (!text.trim()) return text;
    switch (kind) {
      case "heading-1": return `# ${text}`;
      case "heading-2": return `## ${text}`;
      case "heading-3": return `### ${text}`;
      case "ordered": return `${index + 1}. ${text}`;
      case "bullet": return `- ${text}`;
      case "checklist": return `- [ ] ${text}`;
      default: return text;
    }
  }).join("\n");
}

function documentFileName(title: string): string {
  const normalized = title.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, "-");
  return `${normalized || "document"}.md`;
}

function markdownToDraft(source: string): string {
  return source;
}

interface EditorSurfaceProps {
  editorRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  draft: string;
  title: string;
  selection: SelectionRange;
  showToolbar: boolean;
  toolbarTop: number;
  blockMenuOpen: boolean;
  onChange: (value: string) => void;
  onSelectionChange: (target: HTMLTextAreaElement) => void;
  onBlur: () => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onToggleBold: () => void;
  onToggleItalic: () => void;
  onCreateLink: () => void;
  onBlockChange: (kind: BlockKind) => void;
  onToggleBlockMenu: () => void;
  onRequestChange: () => void;
  onEmptyAreaClick?: () => void;
  focused?: boolean;
}

function EditorSurface({
  editorRef,
  draft,
  title,
  selection,
  showToolbar,
  toolbarTop,
  blockMenuOpen,
  onChange,
  onSelectionChange,
  onBlur,
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  onToggleBold,
  onToggleItalic,
  onCreateLink,
  onBlockChange,
  onToggleBlockMenu,
  onRequestChange,
  onEmptyAreaClick,
  focused = false,
}: EditorSurfaceProps) {
  return (
    <div
      className={`canvas-document__editor ${focused ? "canvas-document__editor--focused" : ""}`}
      onMouseDown={(event) => {
        if (!focused && event.target === event.currentTarget) onEmptyAreaClick?.();
      }}
    >
      {showToolbar && (
        <div
          style={{ position: "absolute", left: 8, top: toolbarTop, zIndex: 20 }}
          role="toolbar"
          aria-label="Selected Markdown text tools"
        >
          <CapsuleToolbar positioned={false} zoomAware={false} onMouseDown={(event) => event.preventDefault()}>
            <button type="button" onClick={onRequestChange} style={{ ...CAPSULE_BTN_BASE, width: "auto", padding: "0 10px", gap: 6 }}>Request change <kbd>Ctrl K</kbd></button>
            <div style={CAPSULE_DIVIDER} />
            <button type="button" aria-label="Add link" title="Add link" onClick={onCreateLink} style={CAPSULE_BTN_BASE}><LinkSimple size={16} weight="bold" /></button>
            <button type="button" aria-label="Bold" title="Bold" onClick={onToggleBold} style={CAPSULE_BTN_BASE}><TextB size={17} weight="bold" /></button>
            <button type="button" aria-label="Italic" title="Italic" onClick={onToggleItalic} style={CAPSULE_BTN_BASE}><TextItalic size={17} weight="bold" /></button>
            <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
              <button
                type="button"
                aria-label="Text type"
                aria-expanded={blockMenuOpen}
                onClick={onToggleBlockMenu}
                style={{ ...CAPSULE_BTN_BASE, width: "auto", padding: "0 8px", gap: 4 }}
              ><TextAa size={16} weight="bold" /> Text <span aria-hidden="true">⌄</span></button>
              {blockMenuOpen && (
                <div className="canvas-document__block-menu" role="menu" aria-label="Text type options">
                  {BLOCK_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="menuitem"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => onBlockChange(option.value)}
                    >{option.label}</button>
                  ))}
                </div>
              )}
            </div>
          </CapsuleToolbar>
        </div>
      )}
      <textarea
        ref={editorRef}
        value={draft}
        onChange={(event) => onChange(event.target.value)}
        onSelect={(event) => onSelectionChange(event.currentTarget)}
        onKeyUp={(event) => onSelectionChange(event.currentTarget)}
        onMouseUp={(event) => onSelectionChange(event.currentTarget)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        aria-label={`Edit ${title}`}
        className="canvas-document__textarea"
        style={focused ? undefined : { height: `${Math.max(52, Math.min(420, draft.split("\n").length * 23 + 22))}px` }}
        data-selection-start={selection.start}
      />
    </div>
  );
}

export const DocumentElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);
  const persist = useElementPersistence(element);
  const markdown = (element.config.markdown as string) ?? "";
  const title = (element.config.title as string) ?? "Untitled document";
  const filePath = (element.config.filePath as string) ?? "";
  const [selection, setSelection] = useState<SelectionRange>({ start: 0, end: 0 });
  const [toolbarTop, setToolbarTop] = useState(8);
  const [blockMenuOpen, setBlockMenuOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const articleRef = useRef<HTMLElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const focusEditorRef = useRef<HTMLTextAreaElement>(null);
  const activeEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const focusModeRef = useRef(false);

  const commitDraft = useCallback((nextDraft: string) => {
    focusModeRef.current = false;
    setFocusMode(false);
    setBlockMenuOpen(false);
    if (nextDraft !== markdown) {
      persist({ config: { markdown: nextDraft } }, "Save Markdown document failed");
    }
  }, [markdown, persist]);

  const cancelDraft = useCallback(() => {
    focusModeRef.current = false;
    setFocusMode(false);
    setBlockMenuOpen(false);
  }, []);

  const focusEditor = useCallback(() => {
    const editor = focusModeRef.current ? focusEditorRef.current : editorRef.current;
    activeEditorRef.current = editor;
    editor?.focus();
  }, []);

  const {
    isEditing,
    draft,
    setDraft,
    save,
    cancel,
    isComposingRef,
  } = useElementEditSession({
    elementId: element.id,
    source: markdown,
    createDraft: markdownToDraft,
    onCommit: commitDraft,
    onCancel: cancelDraft,
    focusEditor,
  });

  useEffect(() => {
    if (!isEditing) {
      setFocusMode(false);
      focusModeRef.current = false;
      setBlockMenuOpen(false);
    }
  }, [isEditing]);

  const handleBlur = useCallback(() => {
    window.setTimeout(() => {
      if (!focusModeRef.current && articleRef.current && !articleRef.current.contains(document.activeElement)) {
        save();
      }
    }, 0);
  }, [save]);

  const handleSelectionChange = useCallback((target: HTMLTextAreaElement) => {
    activeEditorRef.current = target;
    setSelection({ start: target.selectionStart, end: target.selectionEnd });
    const precedingLines = draft.slice(0, target.selectionStart).split("\n").length - 1;
    setToolbarTop(Math.max(8, Math.min(target.clientHeight - 35, 8 + precedingLines * 20)));
    if (target.selectionStart === target.selectionEnd) setBlockMenuOpen(false);
  }, [draft]);

  const replaceRange = useCallback((start: number, end: number, replacement: string, selectReplacement = true) => {
    setDraft((current) => `${current.slice(0, start)}${replacement}${current.slice(end)}`);
    const nextSelection = { start, end: selectReplacement ? start + replacement.length : start + replacement.length };
    setSelection(nextSelection);
    requestAnimationFrame(() => {
      const editor = activeEditorRef.current;
      editor?.focus();
      editor?.setSelectionRange(nextSelection.start, nextSelection.end);
    });
  }, []);

  const wrapSelection = useCallback((marker: string) => {
    if (selection.start === selection.end) return;
    const selected = draft.slice(selection.start, selection.end);
    const wrapped = selected.startsWith(marker) && selected.endsWith(marker)
      ? selected.slice(marker.length, -marker.length)
      : `${marker}${selected}${marker}`;
    replaceRange(selection.start, selection.end, wrapped);
  }, [draft, replaceRange, selection]);

  const createLink = useCallback(() => {
    if (selection.start === selection.end) return;
    const href = window.prompt("Link URL");
    if (!href) return;
    const selected = draft.slice(selection.start, selection.end);
    replaceRange(selection.start, selection.end, `[${selected}](${href})`);
  }, [draft, replaceRange, selection]);

  const changeBlock = useCallback((kind: BlockKind) => {
    if (selection.start === selection.end) return;
    const start = draft.lastIndexOf("\n", selection.start - 1) + 1;
    const nextNewline = draft.indexOf("\n", selection.end);
    const end = nextNewline === -1 ? draft.length : nextNewline;
    replaceRange(start, end, formatBlock(kind, draft.slice(start, end)));
    setBlockMenuOpen(false);
  }, [draft, replaceRange, selection]);

  const requestChange = useCallback(() => {
    if (selection.start === selection.end) return;
    const selectedText = draft.slice(selection.start, selection.end);
    window.dispatchEvent(new CustomEvent("conductor:forward-message", {
      detail: {
        text: `Please revise the selected Markdown passage below. Keep the surrounding document coherent.\n\nSelected passage:\n${selectedText}\n\nRequested change: `,
        elementContext: { type: "markdown-document", title, filePath, selectedText },
      },
    }));
  }, [draft, filePath, selection, title]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposingRef.current) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
      event.preventDefault();
      wrapSelection("**");
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      wrapSelection("_");
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      requestChange();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      save();
    }
  }, [cancel, requestChange, save, wrapSelection]);

  const copyDocument = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft);
    } catch (error) {
      setUiError(`Copy Markdown failed: ${error instanceof Error ? error.message : error}`);
    }
  }, [draft, setUiError]);

  const downloadDocument = useCallback(() => {
    const blob = new Blob([draft], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = documentFileName(title);
    link.click();
    URL.revokeObjectURL(href);
  }, [draft, title]);

  const openFocus = useCallback(() => {
    focusModeRef.current = true;
    setFocusMode(true);
    setEditingElementId(element.id);
    requestAnimationFrame(() => {
      activeEditorRef.current = focusEditorRef.current;
      focusEditorRef.current?.focus();
    });
  }, [element.id, setEditingElementId]);

  const showToolbar = isEditing && selection.start !== selection.end;
  const surfaceProps: EditorSurfaceProps = {
    editorRef,
    draft,
    title,
    selection,
    showToolbar,
    toolbarTop,
    blockMenuOpen,
    onChange: setDraft,
    onSelectionChange: handleSelectionChange,
    onBlur: handleBlur,
    onKeyDown: handleKeyDown,
    onCompositionStart: () => { isComposingRef.current = true; },
    onCompositionEnd: () => { isComposingRef.current = false; },
    onToggleBold: () => wrapSelection("**"),
    onToggleItalic: () => wrapSelection("_"),
    onCreateLink: createLink,
    onBlockChange: changeBlock,
    onToggleBlockMenu: () => setBlockMenuOpen((open) => !open),
    onRequestChange: requestChange,
    onEmptyAreaClick: save,
  };

  const focusDialog = focusMode && typeof document !== "undefined" ? createPortal(
    <div className="canvas-document-focus" role="dialog" aria-modal="true" aria-label={`Focused editor for ${title}`}>
      <div className="canvas-document-focus__scrim" onMouseDown={save} />
      <section className="canvas-document-focus__panel">
        <header className="canvas-document-focus__header">
          <div><PencilSimple size={18} weight="bold" /><strong>{title}</strong></div>
          <div className="canvas-document__header-actions">
            <button type="button" onClick={() => void copyDocument()} aria-label="Copy Markdown" title="Copy Markdown"><Copy size={18} /></button>
            <button type="button" onClick={downloadDocument} aria-label="Download Markdown" title="Download Markdown"><DownloadSimple size={18} /></button>
            <button type="button" onClick={save} aria-label="Close focused editor" title="Save and close"><X size={18} /></button>
          </div>
        </header>
        <EditorSurface {...surfaceProps} editorRef={focusEditorRef} focused />
      </section>
    </div>,
    document.body,
  ) : null;

  return (
    <article ref={articleRef} className="canvas-document" onMouseDown={(event) => { if (isEditing) event.stopPropagation(); }}>
      <header className="canvas-document__header">
        <button type="button" className="canvas-document__title" onClick={() => setEditingElementId(element.id)} title="Edit Markdown document">
          <PencilSimple size={14} weight="bold" />
          <strong>{title}</strong>
        </button>
        <div className="canvas-document__header-actions">
          <button type="button" onClick={() => void copyDocument()} aria-label="Copy Markdown" title="Copy Markdown"><Copy size={16} /></button>
          <button type="button" onClick={downloadDocument} aria-label="Download Markdown" title="Download Markdown"><DownloadSimple size={16} /></button>
          <button type="button" onClick={openFocus} aria-label="Focus Markdown editor" title="Focus Markdown editor"><ArrowsOut size={16} /></button>
        </div>
      </header>
      {isEditing ? <EditorSurface {...surfaceProps} /> : (
        <div className="canvas-document__preview">
          {markdown.trim() ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown> : <span>Double-click to start a shared draft.</span>}
        </div>
      )}
      {filePath && <footer className="canvas-document__path">{filePath}</footer>}
      {focusDialog}
    </article>
  );
};
