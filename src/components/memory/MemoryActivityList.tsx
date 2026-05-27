"use client";

import { useEffect } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import { ClockCounterClockwiseIcon } from "@/components/icons";

export function MemoryActivityList() {
  const { logEntries, loadActivityLog } = useMemoryStore();

  useEffect(() => {
    loadActivityLog();
  }, [loadActivityLog]);

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

  if (logEntries.length === 0) {
    return (
      <div className="memory-activity-empty">
        <div className="memory-activity-empty-text">
          No activity recorded yet. Actions from the Wiki Agent will appear here.
        </div>
      </div>
    );
  }

  return (
    <div className="memory-activity-list">
      {logEntries.map((entry, i) => (
        <div key={`${entry.timestamp}-${i}`} className="memory-activity-item">
          <ClockCounterClockwiseIcon size={12} />
          <span className="memory-activity-time">{fmtTime(entry.timestamp)}</span>
          <span className="memory-activity-op">{entry.operation}</span>
          {(() => {
            const msg = entry.details?.message;
            if (msg && typeof msg === 'string') {
              return (
                <span className="memory-activity-detail">
                  {msg}
                </span>
              );
            }
            return null;
          })()}
        </div>
      ))}

      <style>{`
        .memory-activity-list {
          height: 100%;
          overflow-y: auto;
          padding: 12px 16px;
        }

        .memory-activity-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
        }

        .memory-activity-empty-text {
          color: var(--text-tertiary);
          font-size: 14px;
          text-align: center;
          max-width: 300px;
        }

        .memory-activity-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 6px;
          font-size: 12px;
          color: var(--text-secondary);
          transition: background 0.1s;
        }

        .memory-activity-item:hover {
          background: var(--bg-hover);
        }

        .memory-activity-time {
          font-family: monospace;
          font-size: 11px;
          color: var(--text-tertiary);
          flex-shrink: 0;
        }

        .memory-activity-op {
          font-weight: 500;
          color: var(--accent);
          text-transform: capitalize;
          flex-shrink: 0;
        }

        .memory-activity-detail {
          color: var(--text-tertiary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      `}</style>
    </div>
  );
}