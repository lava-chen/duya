"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GridFour, Minus, PaintBucket, Plus, TextAlignCenter, TextAlignLeft, TextAlignRight, TextB, TextItalic, TextT, Trash } from "@phosphor-icons/react";
import type { CanvasElement } from "../..//types/conductor";
import { updateElementContent } from "../..//ipc/conductor-ipc";
import { useConductorStore } from "../..//stores/conductor-store";
import { CapsuleMoreMenu, CapsuleToolbar, CAPSULE_BTN_ACTIVE, CAPSULE_BTN_BASE, CAPSULE_DIVIDER } from "../toolbar/CapsuleToolbar";
import { useElementLock } from "../toolbar/useElementLock";

type Align = "left" | "center" | "right";
type CellStyle = { bold?: boolean; italic?: boolean; align?: Align; fontSize?: number; color?: string; background?: string };
type TableData = { title: string; headers: string[]; rows: string[][]; cellStyles: Record<string, CellStyle>; headerFill: string; headerTextColor: string; borderColor: string };
type SelectedCell = { row: number; column: number } | null;

const DEFAULT_COLUMNS = 2;
const DEFAULT_ROWS = 2;
const MAX_COLUMNS = 12;
const MAX_ROWS = 50;
const DEFAULT_HEADER_FILL = "#3289d1";
const DEFAULT_HEADER_TEXT = "#ffffff";
const DEFAULT_BORDER_COLOR = "#d5deea";
const TABLE_COLORS = ["#3289d1", "#6d5ce8", "#8618d4", "#bd35ca", "#12a99b", "#2f8f83", "#a28e6f", "#be6d6d", "#df455a", "#f28a37", "#f5bf28"];

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((cell) => typeof cell === "string" ? cell : "") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hexColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function readStyles(value: unknown): Record<string, CellStyle> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, style]) => {
    if (!style || typeof style !== "object" || Array.isArray(style)) return [];
    const raw = style as Record<string, unknown>;
    const align = raw.align === "left" || raw.align === "center" || raw.align === "right" ? raw.align : undefined;
    const fontSize = typeof raw.fontSize === "number" && raw.fontSize >= 10 && raw.fontSize <= 30 ? raw.fontSize : undefined;
    const color = typeof raw.color === "string" && /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : undefined;
    const background = typeof raw.background === "string" && /^#[0-9a-f]{6}$/i.test(raw.background) ? raw.background : undefined;
    const normalized: CellStyle = {};
    if (raw.bold === true) normalized.bold = true;
    if (raw.italic === true) normalized.italic = true;
    if (align) normalized.align = align;
    if (fontSize) normalized.fontSize = fontSize;
    if (color) normalized.color = color;
    if (background) normalized.background = background;
    return [[key, normalized]];
  }));
}

function tableDataFromConfig(config: unknown): TableData {
  const source = isRecord(config) ? config : {};
  const requestedHeaders = stringArray(source.headers).slice(0, MAX_COLUMNS);
  const requestedRows = Array.isArray(source.rows) ? source.rows.slice(0, MAX_ROWS) : [];
  const columns = Math.max(1, requestedHeaders.length || DEFAULT_COLUMNS);
  const headers = requestedHeaders.length ? requestedHeaders : Array.from({ length: columns }, (_, index) => `Column ${index + 1}`);
  const rows = (requestedRows.length ? requestedRows : Array.from({ length: DEFAULT_ROWS }, () => []))
    .map((row) => {
      const cells = stringArray(row).slice(0, columns);
      return Array.from({ length: columns }, (_, index) => cells[index] ?? "");
    });
  return {
    title: typeof source.title === "string" ? source.title : "Table",
    headers,
    rows,
    cellStyles: readStyles(source.cellStyles),
    headerFill: hexColor(source.headerFill, DEFAULT_HEADER_FILL),
    headerTextColor: hexColor(source.headerTextColor, DEFAULT_HEADER_TEXT),
    borderColor: hexColor(source.borderColor, DEFAULT_BORDER_COLOR),
  };
}

function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

export const TableElement: React.FC<{ element: CanvasElement }> = ({ element }) => {
  const { locked, toggleLocked } = useElementLock(element);
  const activeCanvasId = useConductorStore((state) => state.activeCanvasId);
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const selectedElementId = useConductorStore((state) => state.selectedElementId);
  const selectedElementIds = useConductorStore((state) => state.selectedElementIds);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const updateElement = useConductorStore((state) => state.updateElement);
  const setUiError = useConductorStore((state) => state.setUiError);
  const [storedData, setStoredData] = useState<TableData>(() => tableDataFromConfig(element.config));
  // A canvas can contain tables made by an earlier build. Normalize state on
  // every render so missing headers/rows never take down the whole canvas.
  const data = tableDataFromConfig(storedData);
  const [selectedCell, setSelectedCell] = useState<SelectedCell>(null);
  const dragRowRef = useRef<number | null>(null);
  const dataRef = useRef(data);
  const isEditing = editingElementId === element.id;
  const isSelected = selectedElementId === element.id || selectedElementIds.includes(element.id);

  useEffect(() => {
    const next = tableDataFromConfig(element.config);
    dataRef.current = next;
    setStoredData(next);
  }, [element.config, element.id]);

  const stage = useCallback((next: TableData) => {
    const normalized = tableDataFromConfig(next);
    dataRef.current = normalized;
    setStoredData(normalized);
  }, []);

  const persist = useCallback((next: TableData = dataRef.current) => {
    // This is an IPC boundary, so only send the normalized plain-data shape.
    // In particular, never let a React event object reach Electron through an
    // input event handler.
    const normalized = tableDataFromConfig(next);
    stage(normalized);
    const config = { ...element.config, ...normalized };
    updateElement(element.id, { config });
    if (activeCanvasId) {
      void updateElementContent(element.id, activeCanvasId, normalized).catch((error) => {
        setUiError(`Save table failed: ${error instanceof Error ? error.message : error}`);
      });
    }
  }, [activeCanvasId, element.config, element.id, setUiError, stage, updateElement]);

  const updateCell = useCallback((row: number, column: number, value: string) => {
    const next = dataRef.current;
    stage({ ...next, rows: next.rows.map((cells, index) => index === row ? cells.map((cell, cellIndex) => cellIndex === column ? value : cell) : cells) });
  }, [stage]);

  const updateHeader = useCallback((column: number, value: string) => {
    const next = dataRef.current;
    stage({ ...next, headers: next.headers.map((header, index) => index === column ? value : header) });
  }, [stage]);

  const addRow = useCallback(() => {
    const next = dataRef.current;
    if (next.rows.length >= MAX_ROWS) return;
    persist({ ...next, rows: [...next.rows, Array.from({ length: next.headers.length }, () => "")] });
  }, [persist]);

  const addColumn = useCallback(() => {
    const next = dataRef.current;
    if (next.headers.length >= MAX_COLUMNS) return;
    persist({ ...next, headers: [...next.headers, `Column ${next.headers.length + 1}`], rows: next.rows.map((row) => [...row, ""]) });
  }, [persist]);

  const deleteSelection = useCallback(() => {
    if (!selectedCell) return;
    const next = dataRef.current;
    if (selectedCell.row === -1 && next.headers.length > 1) {
      const column = selectedCell.column;
      persist({ ...next, headers: next.headers.filter((_, index) => index !== column), rows: next.rows.map((row) => row.filter((_, index) => index !== column)) });
      setSelectedCell(null);
      return;
    }
    if (selectedCell.row >= 0 && next.rows.length > 1) {
      persist({ ...next, rows: next.rows.filter((_, index) => index !== selectedCell.row) });
      setSelectedCell(null);
    }
  }, [persist, selectedCell]);

  const toggleStyle = useCallback((key: "bold" | "italic" | "align", value?: Align) => {
    if (!selectedCell) return;
    const next = dataRef.current;
    const id = cellKey(selectedCell.row, selectedCell.column);
    const current = next.cellStyles[id] ?? {};
    const style = key === "align" ? { ...current, align: value } : { ...current, [key]: !current[key] };
    persist({ ...next, cellStyles: { ...next.cellStyles, [id]: style } });
  }, [persist, selectedCell]);

  const adjustFontSize = useCallback((delta: number) => {
    if (!selectedCell) return;
    const next = dataRef.current;
    const id = cellKey(selectedCell.row, selectedCell.column);
    const current = next.cellStyles[id] ?? {};
    const currentSize = current.fontSize ?? 12;
    persist({ ...next, cellStyles: { ...next.cellStyles, [id]: { ...current, fontSize: Math.min(30, Math.max(10, currentSize + delta)) } } });
  }, [persist, selectedCell]);

  const applyColor = useCallback((target: "text" | "fill" | "border", color: string) => {
    const next = dataRef.current;
    if (target === "border") {
      persist({ ...next, borderColor: color });
      return;
    }
    if (!selectedCell) return;
    if (selectedCell.row === -1) {
      persist(target === "fill" ? { ...next, headerFill: color } : { ...next, headerTextColor: color });
      return;
    }
    const id = cellKey(selectedCell.row, selectedCell.column);
    const current = next.cellStyles[id] ?? {};
    persist({ ...next, cellStyles: { ...next.cellStyles, [id]: { ...current, [target === "fill" ? "background" : "color"]: color } } });
  }, [persist, selectedCell]);

  const moveRow = useCallback((target: number) => {
    const from = dragRowRef.current;
    dragRowRef.current = null;
    if (from === null || from === target || from < 0 || target < 0) return;
    const next = dataRef.current;
    const rows = [...next.rows];
    const [moved] = rows.splice(from, 1);
    rows.splice(target, 0, moved);
    persist({ ...next, rows });
  }, [persist]);

  const columns = useMemo(() => `repeat(${data.headers.length}, minmax(78px, 1fr))`, [data.headers.length]);
  const selectedStyle = selectedCell ? data.cellStyles[cellKey(selectedCell.row, selectedCell.column)] ?? {} : {};

  return (
    <div className="canvas-table-shell" style={{ position: "relative", width: "100%", height: "fit-content", boxSizing: "border-box" }}>
      {isEditing && <TableToolbar selected={selectedCell} style={selectedStyle} headerFill={data.headerFill} headerTextColor={data.headerTextColor} borderColor={data.borderColor} onStyle={toggleStyle} onFontSize={adjustFontSize} onColor={applyColor} onDelete={deleteSelection} onFinish={() => setEditingElementId(null)} locked={locked} onToggleLock={toggleLocked} />}
      {isEditing && <div className="canvas-table__column-rail" title="Column controls. Select a header to edit or delete it."><span>⋮⋮</span><span>⋮⋮</span></div>}
      <section
        aria-label={`${data.title || "Table"} table`}
        onDoubleClick={() => setEditingElementId(element.id)}
        onMouseDown={(event) => { if (isEditing) event.stopPropagation(); }}
        style={{ position: "relative", width: "100%", height: "fit-content", overflow: "hidden", border: isEditing || isSelected ? "2px solid #9c42f5" : `1px solid ${data.borderColor}`, borderRadius: 4, background: "var(--bg-canvas)", boxShadow: isEditing || isSelected ? "0 0 0 2px color-mix(in srgb, #9c42f5 14%, transparent)" : "0 3px 12px color-mix(in srgb, var(--text) 7%, transparent)" }}
      >
        <div role="table" style={{ display: "grid", gridTemplateColumns: columns, alignContent: "start", minWidth: "100%" }}>
          {data.headers.map((header, column) => <TableCell key={`header-${column}`} value={header} header editing={isEditing} selected={selectedCell?.row === -1 && selectedCell.column === column} style={data.cellStyles[cellKey(-1, column)]} headerFill={data.headerFill} headerTextColor={data.headerTextColor} borderColor={data.borderColor} onSelect={() => setSelectedCell({ row: -1, column })} onChange={(value) => updateHeader(column, value)} onCommit={persist} />)}
          {data.rows.flatMap((row, rowIndex) => row.map((value, column) => <TableCell key={`${rowIndex}-${column}`} value={value} editing={isEditing} selected={selectedCell?.row === rowIndex && selectedCell.column === column} style={data.cellStyles[cellKey(rowIndex, column)]} borderColor={data.borderColor} onSelect={() => setSelectedCell({ row: rowIndex, column })} onChange={(next) => updateCell(rowIndex, column, next)} onCommit={persist} />))}
        </div>
      </section>
      {isEditing && <>
        <div className="canvas-table__row-rail" aria-label="Row handles">
          {data.rows.map((_, index) => <button key={index} type="button" draggable title="Drag to reorder rows" onDragStart={() => { dragRowRef.current = index; }} onDragOver={(event) => event.preventDefault()} onDrop={() => moveRow(index)} style={railHandleStyle}>⋮</button>)}
        </div>
        <button type="button" onClick={addColumn} className="canvas-table__add-column" aria-label="Add column" title="Add column">+</button>
        <button type="button" onClick={addRow} className="canvas-table__add-row" aria-label="Add row" title="Add row">+</button>
      </>}
    </div>
  );
};

function TableCell({ value, header = false, editing, selected, style, headerFill = DEFAULT_HEADER_FILL, headerTextColor = DEFAULT_HEADER_TEXT, borderColor = DEFAULT_BORDER_COLOR, onSelect, onChange, onCommit }: { value: string; header?: boolean; editing: boolean; selected: boolean; style?: CellStyle; headerFill?: string; headerTextColor?: string; borderColor?: string; onSelect: () => void; onChange: (value: string) => void; onCommit: () => void }) {
  const activeStyle: React.CSSProperties = { textAlign: style?.align ?? "left", fontWeight: style?.bold ? 700 : header ? 700 : 400, fontStyle: style?.italic ? "italic" : "normal", fontSize: style?.fontSize ?? 12 };
  return <div role={header ? "columnheader" : "cell"} onClick={onSelect} style={{ minWidth: 78, minHeight: header ? 31 : 29, padding: "5px 8px", boxSizing: "border-box", borderRight: `1px solid ${borderColor}`, borderBottom: `1px solid ${borderColor}`, background: style?.background ?? (header ? headerFill : "var(--bg-canvas)"), color: style?.color ?? (header ? headerTextColor : "var(--text)"), outline: selected ? "2px solid #a541f4" : "none", outlineOffset: -2, ...activeStyle }}>
    {editing && selected ? <input autoFocus value={value} onChange={(event) => onChange(event.target.value)} onBlur={() => onCommit()} onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }} aria-label={header ? "Column heading" : "Table cell"} style={{ width: "100%", border: 0, outline: 0, padding: 0, background: "transparent", color: "inherit", font: "inherit", textAlign: activeStyle.textAlign }} /> : value || <span style={{ opacity: 0.35 }}>—</span>}
  </div>;
}

function TableToolbar({ selected, style, headerFill, headerTextColor, borderColor, onStyle, onFontSize, onColor, onDelete, onFinish, locked, onToggleLock }: { selected: SelectedCell; style: CellStyle; headerFill: string; headerTextColor: string; borderColor: string; onStyle: (key: "bold" | "italic" | "align", value?: Align) => void; onFontSize: (delta: number) => void; onColor: (target: "text" | "fill" | "border", color: string) => void; onDelete: () => void; onFinish: () => void; locked: boolean; onToggleLock: () => void }) {
  const [picker, setPicker] = useState<"text" | "fill" | "border" | null>(null);
  const isHeader = selected?.row === -1;
  const valueFor = (target: "text" | "fill" | "border") => target === "border" ? borderColor : target === "text" ? (isHeader ? headerTextColor : style.color ?? "#27313f") : (isHeader ? headerFill : style.background ?? "#ffffff");
  const colorButton = (target: "text" | "fill" | "border", Icon: typeof TextT, label: string) => <button type="button" title={label} disabled={target !== "border" && !selected} onClick={() => setPicker((current) => current === target ? null : target)} style={{ ...CAPSULE_BTN_BASE, ...(picker === target ? CAPSULE_BTN_ACTIVE : {}), opacity: target === "border" || selected ? 1 : 0.45 }}><Icon size={17} weight="bold" /><span aria-hidden style={{ position: "absolute", width: 12, height: 3, borderRadius: 3, background: valueFor(target), transform: "translateY(10px)" }} /></button>;
  return <>
    <CapsuleToolbar top={-54} onMouseDown={(event) => event.preventDefault()}>
      <button type="button" title="Bold" disabled={!selected} onClick={() => onStyle("bold")} style={{ ...CAPSULE_BTN_BASE, ...(style.bold ? CAPSULE_BTN_ACTIVE : {}), opacity: selected ? 1 : 0.45 }}><TextB size={17} weight="bold" /></button>
      <button type="button" title="Italic" disabled={!selected} onClick={() => onStyle("italic")} style={{ ...CAPSULE_BTN_BASE, ...(style.italic ? CAPSULE_BTN_ACTIVE : {}), opacity: selected ? 1 : 0.45 }}><TextItalic size={17} weight="bold" /></button>
      <div style={CAPSULE_DIVIDER} />
      <button type="button" title="Decrease font size" disabled={!selected} onClick={() => onFontSize(-1)} style={{ ...CAPSULE_BTN_BASE, opacity: selected ? 1 : 0.45 }}><Minus size={15} weight="bold" /></button>
      <button type="button" title="Font size" disabled={!selected} style={{ ...CAPSULE_BTN_BASE, width: 24, fontSize: 13, fontWeight: 700, opacity: selected ? 1 : 0.45 }}>M</button>
      <button type="button" title="Increase font size" disabled={!selected} onClick={() => onFontSize(1)} style={{ ...CAPSULE_BTN_BASE, opacity: selected ? 1 : 0.45 }}><Plus size={15} weight="bold" /></button>
      <div style={CAPSULE_DIVIDER} />
      {colorButton("text", TextT, isHeader ? "Header text color" : "Text color")}
      {colorButton("fill", PaintBucket, isHeader ? "Header color" : "Cell fill color")}
      {colorButton("border", GridFour, "Table border color")}
      <div style={CAPSULE_DIVIDER} />
      {([ ["left", TextAlignLeft], ["center", TextAlignCenter], ["right", TextAlignRight] ] as const).map(([align, Icon]) => <button key={align} type="button" title={`Align ${align}`} disabled={!selected} onClick={() => onStyle("align", align)} style={{ ...CAPSULE_BTN_BASE, ...(style.align === align ? CAPSULE_BTN_ACTIVE : {}), opacity: selected ? 1 : 0.45 }}><Icon size={17} weight="bold" /></button>)}
      <div style={CAPSULE_DIVIDER} />
      <button type="button" title="Delete selected row or column" disabled={!selected} onClick={onDelete} style={{ ...CAPSULE_BTN_BASE, color: "#ff9d9d", opacity: selected ? 1 : 0.45 }}><Trash size={16} weight="bold" /></button>
      <CapsuleMoreMenu
        items={[
          { label: locked ? "Unlock position" : "Lock position", onSelect: onToggleLock },
          { label: "Finish editing", onSelect: onFinish },
          { label: "Delete selected row or column", onSelect: onDelete, disabled: !selected, tone: "danger" },
        ]}
      />
    </CapsuleToolbar>
    {picker && <div className="canvas-table__palette" role="menu" aria-label={`${picker} color palette`}>
      {TABLE_COLORS.map((color) => <button key={color} type="button" title={color} onMouseDown={(event) => event.preventDefault()} onClick={() => { onColor(picker, color); setPicker(null); }} style={{ background: color, outline: valueFor(picker) === color ? "2px solid #fff" : "none", outlineOffset: 2 }} />)}
    </div>}
  </>;
}

const railHandleStyle: React.CSSProperties = { display: "block", width: 22, height: 29, border: 0, background: "transparent", color: "#923df0", cursor: "grab", fontWeight: 800, lineHeight: 1 };
