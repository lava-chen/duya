"use client";

import { Table } from "@phosphor-icons/react";
import type { WidgetComponentProps, WidgetDefinition } from "./registry";

interface DataTableProps {
  headers: string[];
  rows: string[][];
  caption: string;
}

function DataTableWidget({ data }: WidgetComponentProps) {
  const table = (data as unknown as DataTableProps) || { headers: [], rows: [], caption: "" };

  if (!table.headers || table.headers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-[var(--muted)]">
        <Table size={28} weight="duotone" />
        <span className="text-xs">No data to display</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-1 overflow-hidden">
      {table.caption && (
        <span className="text-[10px] text-[var(--muted)] text-center truncate">
          {table.caption}
        </span>
      )}
      <div className="flex-1 overflow-auto rounded-md border border-[var(--border)]">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-[var(--surface)] sticky top-0">
              {table.headers.map((header, i) => (
                <th
                  key={i}
                  className="px-2 py-1.5 text-left font-semibold text-[var(--text)] border-b border-[var(--border)]"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, ri) => (
              <tr key={ri} className="hover:bg-[var(--surface-hover)] transition-colors">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 text-[var(--muted)] border-b border-[var(--border)]/40 truncate max-w-[200px]">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const DataTableDefinition: WidgetDefinition = {
  kind: "builtin",
  type: "data-table",
  label: "Data Table",
  description: "Display tabular data",
  component: DataTableWidget,
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 3, h: 3 },
  defaultData: {
    headers: ["Name", "Value", "Status"],
    rows: [
      ["Item A", "42", "Active"],
      ["Item B", "18", "Pending"],
      ["Item C", "77", "Done"],
    ],
    caption: "",
  },
  defaultConfig: {
    title: "📋 Data Table",
  },
};