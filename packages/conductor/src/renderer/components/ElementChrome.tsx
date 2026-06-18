"use client";

import React from "react";
import { X, DotsSixVertical } from "@phosphor-icons/react";

interface ElementChromeProps {
  label: string;
  readOnly: boolean;
  state?: string;
  onDelete?: () => void;
  children: React.ReactNode;
}

export const ElementChrome: React.FC<ElementChromeProps> = ({
  label,
  readOnly,
  state,
  onDelete,
  children,
}) => {
  return (
    <div className="flex flex-col h-full rounded-xl border border-[var(--border)] bg-[var(--main-bg)] overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md group">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex-shrink-0 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2 min-w-0">
          <DotsSixVertical size={12} className="text-[var(--muted)] flex-shrink-0" />
          <span className="text-xs font-medium text-[var(--text)] truncate">
            {label}
          </span>
          {state === "loading" && (
            <span className="w-3 h-3 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)] animate-spin" />
          )}
        </div>
        {!readOnly && onDelete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="flex items-center justify-center w-5 h-5 rounded-md text-[var(--muted)] hover:bg-[var(--error-soft)] hover:text-[var(--error)] transition-colors"
            style={{ opacity: 0 }}
            onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
            onMouseLeave={(e) => (e.currentTarget.style.opacity = "0")}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {children}
      </div>
      {!readOnly && (
        <div
          className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize z-10"
          style={{
            background: "linear-gradient(135deg, transparent 50%, var(--border) 50%, transparent 75%)",
          }}
        />
      )}
    </div>
  );
};