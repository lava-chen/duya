"use client";

import {
  ArrowSquareOut,
  ArrowsClockwise,
  FileDoc,
  FolderOpen,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  MicrosoftExcelLogo,
  MicrosoftPowerpointLogo,
  MicrosoftWordLogo,
  Sparkle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { usePanel } from "@/hooks/usePanel";
import { PanelFileTreeSplit } from "./PanelFileTreeSplit";
import type { PageTab } from "./registry";

type OfficeKind = "docx" | "pptx" | "xlsx";

interface SelectionContext {
  text: string;
  locator: string;
  x: number;
  y: number;
}

interface SpreadsheetCell {
  ref: string;
  value: string;
}

interface SpreadsheetSheet {
  name: string;
  rows: SpreadsheetCell[][];
}

function officeKind(filePath: string): OfficeKind | null {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return extension === "docx" || extension === "pptx" || extension === "xlsx"
    ? extension
    : null;
}

function fileName(filePath: string): string {
  return filePath.split(/[/\\]/).pop() || filePath;
}

function textFromParseResult(result: { chunks: Array<{ type: string; text?: string }> }): string {
  return result.chunks
    .filter((chunk) => chunk.type === "text" && typeof chunk.text === "string")
    .map((chunk) => chunk.text as string)
    .join("\n");
}

function parseSlides(text: string): Array<{ number: number; content: string }> {
  const matches = [...text.matchAll(/--- Slide (\d+) ---\s*([\s\S]*?)(?=--- Slide \d+ ---|$)/g)];
  if (matches.length === 0) return [{ number: 1, content: text }];
  return matches.map((match) => ({ number: Number(match[1]), content: match[2].trim() }));
}

function parseSheets(text: string): SpreadsheetSheet[] {
  const sheets: SpreadsheetSheet[] = [];
  let current: SpreadsheetSheet | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const heading = line.match(/^--- Sheet: (.+) ---$/);
    if (heading) {
      current = { name: heading[1], rows: [] };
      sheets.push(current);
      continue;
    }
    if (!line || !current) continue;
    const cells = line.split(" | ").flatMap((part) => {
      const match = part.match(/^([A-Z]+\d+):\s?(.*)$/);
      return match ? [{ ref: match[1], value: match[2] }] : [];
    });
    if (cells.length > 0) current.rows.push(cells);
  }
  return sheets;
}

function iconFor(kind: OfficeKind) {
  if (kind === "docx") return MicrosoftWordLogo;
  if (kind === "pptx") return MicrosoftPowerpointLogo;
  return MicrosoftExcelLogo;
}

function paragraphRole(paragraph: string, index: number): "title" | "meta" | "heading" | "body" {
  if (index === 0) return "title";
  if (/^(输入|模型|评价依据)[：:]/.test(paragraph)) return "meta";
  if (/^\d+\.\s*(任务|方法|背景|结果|结论|概述)/.test(paragraph) || /^模型结构/.test(paragraph)) {
    return "heading";
  }
  return "body";
}

export function OfficePanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const filePath = typeof tab.params?.filePath === "string" ? tab.params.filePath : "";
  const workingDirectory = typeof tab.params?.workingDirectory === "string" ? tab.params.workingDirectory : "";
  const kind = officeKind(filePath);
  const { closePanel } = usePanel();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [content, setContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);
  const [selection, setSelection] = useState<SelectionContext | null>(null);

  const openFiles = useCallback(async () => {
    const result = await window.electronAPI?.dialog?.openOfficeFiles?.({
      defaultPath: typeof tab.params?.workingDirectory === "string" ? tab.params.workingDirectory : undefined,
      title: "Open in DUYA Office",
    });
    if (!result || result.canceled) return;
    for (const path of result.filePaths) {
      window.dispatchEvent(new CustomEvent("duya:open-office-panel", { detail: { filePath: path } }));
    }
    if (!filePath && result.filePaths.length > 0) closePanel(tab.id);
  }, [closePanel, filePath, tab.id, tab.params?.workingDirectory]);

  const loadDocument = useCallback(async () => {
    if (!filePath || !kind) return;
    if (!window.electronAPI?.parser?.parse) {
      setError("Document parser unavailable. Rebuild Electron and try again.");
      return;
    }
    setLoading(true);
    setError(null);
    setSelection(null);
    try {
      const result = await window.electronAPI.parser.parse(filePath);
      setContent(textFromParseResult(result));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setContent("");
    } finally {
      setLoading(false);
    }
  }, [filePath, kind]);

  useEffect(() => {
    void loadDocument();
  }, [loadDocument]);

  const captureSelection = useCallback(() => {
    const nativeSelection = window.getSelection();
    const text = nativeSelection?.toString().trim() ?? "";
    const anchorElement = nativeSelection?.anchorNode instanceof Element
      ? nativeSelection.anchorNode
      : nativeSelection?.anchorNode?.parentElement;
    if (!text || !anchorElement || !canvasRef.current?.contains(anchorElement)) return;
    const locatorElement = anchorElement.closest<HTMLElement>("[data-office-locator]");
    const range = nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    if (!rect) return;
    setSelection({
      text: text.slice(0, 8000),
      locator: locatorElement?.dataset.officeLocator || "document selection",
      x: canvasRef.current.scrollLeft + Math.min(canvasRect.width - 126, Math.max(12, rect.left - canvasRect.left + rect.width / 2 - 58)),
      y: canvasRef.current.scrollTop + Math.max(12, rect.bottom - canvasRect.top + 10),
    });
  }, []);

  const selectCell = useCallback((event: MouseEvent<HTMLButtonElement>, sheet: string, cell: SpreadsheetCell) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    setSelection({
      text: cell.value,
      locator: `${sheet}!${cell.ref}`,
      x: canvas.scrollLeft + Math.min(canvasRect.width - 126, Math.max(12, rect.left - canvasRect.left + rect.width / 2 - 58)),
      y: canvas.scrollTop + Math.max(12, rect.bottom - canvasRect.top + 8),
    });
  }, []);

  const askDuya = useCallback(() => {
    if (!selection || !filePath || !kind) return;
    window.dispatchEvent(new CustomEvent("file-tree-add-to-input", { detail: { path: filePath } }));
    window.dispatchEvent(new CustomEvent("browser-add-to-input", {
      detail: {
        text: [
          "请修改这个 Office 文件中选中的内容。",
          `文件：${filePath}`,
          `格式：${kind.toUpperCase()}`,
          `位置：${selection.locator}`,
          "选中内容：",
          selection.text,
          "\n修改要求：",
        ].join("\n"),
      },
    }));
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, [filePath, kind, selection]);

  const paragraphs = useMemo(() => content.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean), [content]);
  const slides = useMemo(() => parseSlides(content), [content]);
  const sheets = useMemo(() => parseSheets(content), [content]);

  if (!filePath) {
    return (
      <PanelFileTreeSplit workingDirectory={workingDirectory}>
      <div className="office-panel office-panel-empty">
        <div className="office-empty-card">
          <span className="office-empty-icon"><FileDoc size={30} weight="duotone" /></span>
          <strong>Open an Office file</strong>
          <span>Review Word, PowerPoint, and Excel beside your DUYA conversation.</span>
          <button type="button" onClick={() => void openFiles()}>
            <FolderOpen size={16} weight="bold" /> Open file
          </button>
        </div>
      </div>
      </PanelFileTreeSplit>
    );
  }

  if (!kind) return <div className="office-panel-state">This file type is not supported.</div>;
  const KindIcon = iconFor(kind);

  return (
    <PanelFileTreeSplit workingDirectory={workingDirectory}>
    <div className={`office-panel office-panel-${kind}`}>
      <div className="office-toolbar">
        <div className="office-toolbar-title">
          <KindIcon size={17} weight="fill" />
          <span>{fileName(filePath)}</span>
          <small>{kind.toUpperCase()}</small>
        </div>
        <div className="office-toolbar-actions">
          <button type="button" onClick={() => setZoom((value) => Math.max(70, value - 10))} aria-label="Zoom out"><MagnifyingGlassMinus size={15} /></button>
          <span>{zoom}%</span>
          <button type="button" onClick={() => setZoom((value) => Math.min(150, value + 10))} aria-label="Zoom in"><MagnifyingGlassPlus size={15} /></button>
          <button type="button" onClick={() => void loadDocument()} aria-label="Reload document"><ArrowsClockwise size={15} className={loading ? "animate-spin" : ""} /></button>
          <button type="button" onClick={() => void window.electronAPI?.shell?.openPath(filePath)} aria-label="Open in default app"><ArrowSquareOut size={15} /></button>
        </div>
      </div>

      <div className="office-canvas" ref={canvasRef} onMouseUp={kind === "xlsx" ? undefined : captureSelection}>
        {loading && <div className="office-panel-state"><ArrowsClockwise size={18} className="animate-spin" /> Parsing document...</div>}
        {!loading && error && <div className="office-panel-state office-panel-error">{error}</div>}
        {!loading && !error && kind === "docx" && (
          <article className="office-word-page" style={{ transform: `scale(${zoom / 100})` }}>
            {paragraphs.map((paragraph, index) => {
              const role = paragraphRole(paragraph, index);
              if (role === "title") return <h1 key={index} data-office-locator={`paragraph ${index + 1}`}>{paragraph}</h1>;
              if (role === "heading") return <h2 key={index} data-office-locator={`paragraph ${index + 1}`}>{paragraph}</h2>;
              return <p key={index} className={role === "meta" ? "office-word-meta" : undefined} data-office-locator={`paragraph ${index + 1}`}>{paragraph}</p>;
            })}
          </article>
        )}
        {!loading && !error && kind === "pptx" && (
          <div className="office-slides" style={{ width: `${zoom}%` }}>
            {slides.map((slide) => (
              <section className="office-slide" key={slide.number} data-office-locator={`slide ${slide.number}`}>
                <span className="office-slide-number">{slide.number}</span>
                {slide.content.split("\n").filter(Boolean).map((line, index) => (
                  index === 0 ? <h2 key={index}>{line}</h2> : <p key={index}>{line}</p>
                ))}
              </section>
            ))}
          </div>
        )}
        {!loading && !error && kind === "xlsx" && (
          <div className="office-sheets" style={{ fontSize: `${zoom}%` }}>
            {sheets.map((sheet) => (
              <section className="office-sheet" key={sheet.name}>
                <div className="office-sheet-name">{sheet.name}</div>
                <div className="office-grid">
                  {sheet.rows.map((row, rowIndex) => (
                    <div className="office-grid-row" key={rowIndex}>
                      <span className="office-row-number">{rowIndex + 1}</span>
                      {row.map((cell) => (
                        <button
                          type="button"
                          className="office-cell"
                          key={cell.ref}
                          data-office-locator={`${sheet.name}!${cell.ref}`}
                          onClick={(event) => selectCell(event, sheet.name, cell)}
                          title={`${sheet.name}!${cell.ref}`}
                        >{cell.value}</button>
                      ))}
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {selection && (
          <button
            type="button"
            className="office-ask-duya"
            style={{ left: selection.x, top: selection.y }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={askDuya}
          ><Sparkle size={14} weight="fill" /> 问问 DUYA</button>
        )}
      </div>
    </div>
    </PanelFileTreeSplit>
  );
}
