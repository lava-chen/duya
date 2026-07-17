"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
} from "@phosphor-icons/react";
import type { CanvasElement } from "../../types/conductor";
import { executeAction } from "../../ipc/conductor-ipc";
import { useConductorStore } from "../../stores/conductor-store";

const MIN_ZOOM = 60;
const MAX_ZOOM = 220;
const ZOOM_STEP = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function formatBytes(bytes: unknown): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Chromium still renders the PDF, but its page and zoom become durable canvas
 * state instead of disappearing inside an opaque iframe.
 */
export const PdfElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const setUiError = useConductorStore((state) => state.setUiError);
  const url = (element.config.url as string) || "";
  const fileName = (element.config.fileName as string) || "Untitled PDF";
  const page = Math.max(1, Number(element.config.pdfPage) || 1);
  const zoom = clamp(Number(element.config.pdfZoom) || 100, MIN_ZOOM, MAX_ZOOM);
  const [pageDraft, setPageDraft] = useState(String(page));

  useEffect(() => {
    setPageDraft(String(page));
  }, [page]);

  const persist = useCallback((patch: Record<string, unknown>) => {
    if (!activeCanvasId) return;
    const config = { ...element.config, ...patch };
    updateElement(element.id, { config });
    void executeAction({ action: "element.update", canvasId: activeCanvasId, elementId: element.id, config })
      .catch((error) => setUiError(`Save PDF reading position failed: ${error instanceof Error ? error.message : String(error)}`));
  }, [activeCanvasId, element.config, element.id, setUiError, updateElement]);

  const setPage = useCallback((next: number) => {
    const safePage = Math.max(1, Math.round(next) || 1);
    setPageDraft(String(safePage));
    persist({ pdfPage: safePage });
  }, [persist]);

  const setZoom = useCallback((next: number) => {
    persist({ pdfZoom: clamp(Math.round(next / ZOOM_STEP) * ZOOM_STEP, MIN_ZOOM, MAX_ZOOM) });
  }, [persist]);

  const src = useMemo(() => `${url}#page=${page}&zoom=${zoom}&toolbar=0&navpanes=0&scrollbar=1`, [page, url, zoom]);
  const stopCanvasEvent = (event: React.MouseEvent | React.KeyboardEvent) => event.stopPropagation();

  return (
    <section className="canvas-pdf" aria-label={`${fileName}, page ${page}`}>
      <header className="canvas-pdf__header" onMouseDown={stopCanvasEvent}>
        <div className="canvas-pdf__identity">
          <span className="canvas-pdf__type">PDF</span>
          <span className="canvas-pdf__name" title={fileName}>{fileName}</span>
          {formatBytes(element.config.size) && <span className="canvas-pdf__size">{formatBytes(element.config.size)}</span>}
        </div>
        <div className="canvas-pdf__controls" aria-label="PDF controls">
          <button type="button" aria-label="Previous page" title="Previous page" onClick={(event) => { stopCanvasEvent(event); setPage(page - 1); }}><CaretLeft size={15} weight="bold" /></button>
          <label className="canvas-pdf__page-label">
            <span className="sr-only">Page</span>
            <input value={pageDraft} inputMode="numeric" aria-label="Page number" onClick={stopCanvasEvent} onChange={(event) => setPageDraft(event.target.value.replace(/[^0-9]/g, ""))} onBlur={() => setPage(Number(pageDraft))} onKeyDown={(event) => { stopCanvasEvent(event); if (event.key === "Enter") (event.currentTarget as HTMLInputElement).blur(); }} />
          </label>
          <button type="button" aria-label="Next page" title="Next page" onClick={(event) => { stopCanvasEvent(event); setPage(page + 1); }}><CaretRight size={15} weight="bold" /></button>
          <span className="canvas-pdf__divider" />
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={(event) => { stopCanvasEvent(event); setZoom(zoom - ZOOM_STEP); }}><MagnifyingGlassMinus size={15} /></button>
          <span className="canvas-pdf__zoom">{zoom}%</span>
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={(event) => { stopCanvasEvent(event); setZoom(zoom + ZOOM_STEP); }}><MagnifyingGlassPlus size={15} /></button>
          <button type="button" aria-label="Open PDF in a separate window" title="Open PDF" onClick={(event) => { stopCanvasEvent(event); if (url) window.open(`${url}#page=${page}&zoom=${zoom}`, "_blank", "noopener,noreferrer"); }}><ArrowSquareOut size={15} /></button>
        </div>
      </header>
      <div className="canvas-pdf__viewport" onMouseDown={stopCanvasEvent}>
        <iframe src={src} title={`${fileName}, page ${page}`} />
      </div>
      <footer className="canvas-pdf__footer">Reading position: page {page} · {zoom}%</footer>
    </section>
  );
};
