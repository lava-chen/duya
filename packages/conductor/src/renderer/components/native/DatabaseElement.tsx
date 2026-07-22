"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowsOutSimple, Database, Plus, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import type {
  DatabaseProperty,
  DatabaseQueryResult,
  DatabaseRecordSnapshot,
  DatabaseValue,
} from "../../../database/types";
import type { CanvasElement } from "../../types/conductor";
import { useConductorStore } from "../../stores/conductor-store";
import {
  createDatabaseProperty,
  createDatabaseRecord,
  queryDatabase,
  subscribeProjectDatabase,
  updateDatabaseRecord,
} from "../../database/project-database-ipc";

interface DatabaseElementConfig {
  sourceId: string;
  viewId: string;
  sourceTitle?: string;
  showTitle?: boolean;
  previewLimit?: number;
}

function readConfig(element: CanvasElement): DatabaseElementConfig | null {
  const sourceId = typeof element.config.sourceId === "string" ? element.config.sourceId : "";
  const viewId = typeof element.config.viewId === "string" ? element.config.viewId : "";
  if (!sourceId || !viewId) return null;
  return {
    sourceId,
    viewId,
    sourceTitle: typeof element.config.sourceTitle === "string" ? element.config.sourceTitle : undefined,
    showTitle: element.config.showTitle !== false,
    previewLimit: typeof element.config.previewLimit === "number"
      ? Math.max(1, Math.min(200, Math.round(element.config.previewLimit)))
      : 50,
  };
}

function visibleProperties(result: DatabaseQueryResult): DatabaseProperty[] {
  const visibleIds = Array.isArray(result.view?.layout.visiblePropertyIds)
    ? result.view.layout.visiblePropertyIds.filter((value): value is string => typeof value === "string")
    : [];
  if (visibleIds.length === 0) return result.properties;
  const order = new Map(visibleIds.map((id, index) => [id, index]));
  return result.properties
    .filter((property) => order.has(property.id))
    .sort((left, right) => order.get(left.id)! - order.get(right.id)!);
}

function valueFor(record: DatabaseRecordSnapshot, property: DatabaseProperty): DatabaseValue {
  return property.type === "title" ? record.record.title : record.values[property.id] ?? null;
}

function displayValue(value: DatabaseValue, property: DatabaseProperty): string {
  if (value === null || value === "") return "—";
  if (property.type === "select" || property.type === "status") {
    return property.options.find((option) => option.id === value)?.name ?? "—";
  }
  if (property.type === "multi_select" && Array.isArray(value)) {
    return value.map((id) => property.options.find((option) => option.id === id)?.name).filter(Boolean).join(", ") || "—";
  }
  if (property.type === "date" && typeof value === "object" && !Array.isArray(value)) return value.start;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

export const DatabaseElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const config = useMemo(() => readConfig(element), [element]);
  const activeCanvas = useConductorStore((state) => state.canvases.find((canvas) => canvas.id === state.activeCanvasId));
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const setUiError = useConductorStore((state) => state.setUiError);
  const projectPath = activeCanvas?.projectPath ?? null;
  const isDatabaseMode = editingElementId === element.id;
  const [result, setResult] = useState<DatabaseQueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingCell, setSavingCell] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath || !config) {
      setResult(null);
      setLoading(false);
      setError(!projectPath ? "This canvas is not bound to a project folder." : "Database reference is incomplete.");
      return;
    }
    setLoading(true);
    try {
      setResult(await queryDatabase(projectPath, config.sourceId, config.viewId, config.previewLimit ?? 50));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [config, projectPath]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!config) return;
    try {
      return subscribeProjectDatabase((event) => {
        if (!event.sourceId || event.sourceId === config.sourceId) void load();
      });
    } catch {
      return undefined;
    }
  }, [config, load]);

  const columns = useMemo(() => result ? visibleProperties(result) : [], [result]);

  const commit = useCallback(async (
    record: DatabaseRecordSnapshot,
    property: DatabaseProperty,
    nextValue: DatabaseValue,
  ) => {
    if (!projectPath || !config) return;
    const cellKey = `${record.record.id}:${property.id}`;
    setSavingCell(cellKey);
    try {
      const updated = await updateDatabaseRecord(
        projectPath,
        config.sourceId,
        record.record.id,
        record.record.revision,
        property.type === "title"
          ? { title: typeof nextValue === "string" ? nextValue : "" }
          : { values: { [property.id]: nextValue } },
      );
      setResult((current) => current ? {
        ...current,
        records: current.records.map((item) => item.record.id === updated.record.id ? updated : item),
      } : current);
      setError(null);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : String(saveError);
      setError(message);
      setUiError(`Save database record failed: ${message}`);
      await load();
    } finally {
      setSavingCell(null);
    }
  }, [config, load, projectPath, setUiError]);

  const addRecord = useCallback(async () => {
    if (!projectPath || !config) return;
    try {
      await createDatabaseRecord(projectPath, config.sourceId, "Untitled");
      await load();
    } catch (createError) {
      setUiError(`Create database record failed: ${createError instanceof Error ? createError.message : String(createError)}`);
    }
  }, [config, load, projectPath, setUiError]);

  const addProperty = useCallback(async () => {
    if (!projectPath || !config || !result) return;
    try {
      await createDatabaseProperty(projectPath, config.sourceId, `Property ${result.properties.length}`, "text");
      await load();
    } catch (createError) {
      setUiError(`Create database property failed: ${createError instanceof Error ? createError.message : String(createError)}`);
    }
  }, [config, load, projectPath, result, setUiError]);

  return (
    <section
      className={`canvas-database ${isDatabaseMode ? "is-database-mode" : ""}`}
      onMouseDown={(event) => { if (isDatabaseMode) event.stopPropagation(); }}
      aria-label={`${result?.source.name ?? config?.sourceTitle ?? "Database"} database`}
    >
      <header className="canvas-database__header">
        <span className="canvas-database__icon"><Database size={17} weight="fill" /></span>
        <div className="canvas-database__title">
          <strong>{result?.source.name ?? config?.sourceTitle ?? "Database"}</strong>
          <small>{result?.view?.name ?? "Table"}</small>
        </div>
        {loading && <SpinnerGap className="canvas-database__spinner" size={16} />}
        <button
          type="button"
          className="canvas-database__mode"
          onClick={(event) => {
            event.stopPropagation();
            setEditingElementId(isDatabaseMode ? null : element.id);
          }}
          title={isDatabaseMode ? "Return to canvas mode" : "Open database mode"}
        >
          <ArrowsOutSimple size={15} />
          <span>{isDatabaseMode ? "Done" : "Open"}</span>
        </button>
      </header>

      {error && (
        <div className="canvas-database__error"><WarningCircle size={16} /><span>{error}</span></div>
      )}

      {!error && result && (
        <div className="canvas-database__viewport">
          <table>
            <thead>
              <tr>
                {columns.map((property) => <th key={property.id}>{property.name}</th>)}
                {isDatabaseMode && <th className="canvas-database__add-column"><button type="button" onClick={() => { void addProperty(); }} title="Add text property"><Plus size={14} /></button></th>}
              </tr>
            </thead>
            <tbody>
              {result.records.map((record) => (
                <tr key={record.record.id}>
                  {columns.map((property) => (
                    <td key={property.id} data-saving={savingCell === `${record.record.id}:${property.id}` || undefined}>
                      <DatabaseCell
                        editing={isDatabaseMode}
                        property={property}
                        value={valueFor(record, property)}
                        onCommit={(value) => { void commit(record, property, value); }}
                      />
                    </td>
                  ))}
                  {isDatabaseMode && <td />}
                </tr>
              ))}
            </tbody>
          </table>
          {result.records.length === 0 && <div className="canvas-database__empty">No records yet</div>}
        </div>
      )}

      {isDatabaseMode && result && (
        <button type="button" className="canvas-database__new-row" onClick={() => { void addRecord(); }}><Plus size={14} /> New</button>
      )}
    </section>
  );
};

function DatabaseCell({
  editing,
  property,
  value,
  onCommit,
}: {
  editing: boolean;
  property: DatabaseProperty;
  value: DatabaseValue;
  onCommit: (value: DatabaseValue) => void;
}) {
  const [draft, setDraft] = useState(() => displayValue(value, property));

  useEffect(() => setDraft(displayValue(value, property)), [property, value]);

  if (!editing) return <span className={value === null || value === "" ? "is-empty" : ""}>{displayValue(value, property)}</span>;

  if (property.type === "checkbox") {
    return <input type="checkbox" checked={value === true} onChange={(event) => onCommit(event.target.checked)} />;
  }
  if (property.type === "select" || property.type === "status") {
    return (
      <select value={typeof value === "string" ? value : ""} onChange={(event) => onCommit(event.target.value || null)}>
        <option value="">—</option>
        {property.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    );
  }
  if (property.type === "multi_select") return <span>{displayValue(value, property)}</span>;
  if (property.type === "date") {
    const start = typeof value === "object" && value !== null && !Array.isArray(value) ? value.start : "";
    return <input type="date" value={start.slice(0, 10)} onChange={(event) => onCommit(event.target.value ? { start: event.target.value } : null)} />;
  }

  return (
    <input
      type={property.type === "number" ? "number" : property.type === "url" ? "url" : "text"}
      value={draft === "—" ? "" : draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const current = displayValue(value, property);
        const normalizedDraft = draft === "—" ? "" : draft;
        if (normalizedDraft === (current === "—" ? "" : current)) return;
        if (property.type === "number") onCommit(normalizedDraft === "" ? null : Number(normalizedDraft));
        else onCommit(normalizedDraft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(displayValue(value, property));
          event.currentTarget.blur();
        }
      }}
    />
  );
}
