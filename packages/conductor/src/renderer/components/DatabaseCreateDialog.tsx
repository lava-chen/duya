"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Database, Plus, X } from "@phosphor-icons/react";
import type { NativeDatabaseElementConfig } from "../../database/types";
import type { DatabaseSource } from "../../database/types";
import { createDatabaseSource, getDatabaseSource, listDatabaseSources } from "../database/project-database-ipc";

interface DatabaseCreateDialogProps {
  open: boolean;
  projectPath?: string;
  onClose: () => void;
  onConfirm: (config: NativeDatabaseElementConfig & { sourceTitle: string }) => void;
  onError: (message: string) => void;
}

export const DatabaseCreateDialog: React.FC<DatabaseCreateDialogProps> = ({
  open,
  projectPath,
  onClose,
  onConfirm,
  onError,
}) => {
  const [name, setName] = useState("Database");
  const [sources, setSources] = useState<DatabaseSource[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [canvasBounds, setCanvasBounds] = useState<DOMRect | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("Database");
    window.setTimeout(() => nameRef.current?.select(), 50);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateBounds = () => setCanvasBounds(document.querySelector(".canvas-area")?.getBoundingClientRect() ?? null);
    updateBounds();
    window.addEventListener("resize", updateBounds);
    return () => window.removeEventListener("resize", updateBounds);
  }, [open]);

  useEffect(() => {
    if (!open || !projectPath) return;
    let active = true;
    setLoading(true);
    listDatabaseSources(projectPath)
      .then((next) => { if (active) setSources(next); })
      .catch((error) => { if (active) onError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [onError, open, projectPath]);

  const confirmSnapshot = useCallback((sourceTitle: string, sourceId: string, viewId: string) => {
    onConfirm({
      sourceId,
      viewId,
      sourceTitle,
      displayMode: "embedded",
      showTitle: true,
      previewLimit: 50,
      interactionMode: "canvas",
    });
    onClose();
  }, [onClose, onConfirm]);

  const createNew = useCallback(async () => {
    if (!projectPath || !name.trim() || submitting) return;
    setSubmitting(true);
    try {
      const snapshot = await createDatabaseSource(projectPath, name.trim());
      const view = snapshot.views[0];
      if (!view) throw new Error("The database was created without a default view.");
      confirmSnapshot(snapshot.source.name, snapshot.source.id, view.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [confirmSnapshot, name, onError, projectPath, submitting]);

  const linkExisting = useCallback(async (source: DatabaseSource) => {
    if (!projectPath || submitting) return;
    setSubmitting(true);
    try {
      const snapshot = await getDatabaseSource(projectPath, source.id);
      const view = snapshot.views[0];
      if (!view) throw new Error("This database has no available view.");
      confirmSnapshot(source.name, source.id, view.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }, [confirmSnapshot, onError, projectPath, submitting]);

  if (!open) return null;

  return createPortal(
    <div
      className="canvas-link-picker-overlay"
      style={canvasBounds ? { inset: "auto", left: canvasBounds.left, top: canvasBounds.top, width: canvasBounds.width, height: canvasBounds.height } : undefined}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="canvas-document-picker" role="dialog" aria-modal="true" aria-label="Add database" onMouseDown={(event) => event.stopPropagation()}>
        <header className="canvas-document-picker__header">
          <strong>Add database</strong>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <section className="canvas-document-picker__section">
          <h2>New project database</h2>
          <label className="canvas-document-picker__search">
            <Database size={16} />
            <input
              ref={nameRef}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void createNew(); }}
              placeholder="Database name"
              disabled={!projectPath || submitting}
            />
          </label>
          <button type="button" className="canvas-document-picker__action" disabled={!projectPath || !name.trim() || submitting} onClick={() => { void createNew(); }}>
            <span className="canvas-document-picker__glyph"><Plus size={18} weight="bold" /></span>
            <span><strong>{submitting ? "Creating…" : "Create database"}</strong><small>Stored in this project's .duya/database.sqlite</small></span>
          </button>
        </section>

        <section className="canvas-document-picker__workspace">
          <div className="canvas-document-picker__workspace-heading"><h2>Link existing</h2><span>{loading ? "Loading…" : `${sources.length} databases`}</span></div>
          <div className="canvas-document-picker__file-list">
            {!projectPath ? <p>Bind this canvas to a project folder first.</p> : !loading && sources.length === 0 ? <p>No project databases yet.</p> : sources.map((source) => (
              <button key={source.id} type="button" className="canvas-document-picker__file" disabled={submitting} onClick={() => { void linkExisting(source); }}>
                <Database size={17} /><span><strong>{source.name}</strong><small>Project database</small></span>
              </button>
            ))}
          </div>
        </section>
      </section>
    </div>,
    document.body,
  );
};
