"use client";

import { useMemoryStore } from "@/stores/memory-store";
import { XIcon, ClockIcon } from "@/components/icons";
import { MemoryNodeAgentPanel } from "./MemoryNodeAgentPanel";

export function MemoryNodeDetail() {
  const { selectedNode, selectedNodePath, isLoadingDetail, selectNode } = useMemoryStore();

  if (!selectedNodePath) return null;

  if (isLoadingDetail || !selectedNode) {
    return (
      <div className="memory-detail">
        <div className="memory-detail-loading">Loading...</div>
      </div>
    );
  }

  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <div className="memory-detail">
      <div className="memory-detail-header">
        <div className="memory-detail-title-row">
          <h3 className="memory-detail-title">{selectedNode.title}</h3>
          <button
            type="button"
            className="memory-detail-close"
            onClick={() => selectNode(null)}
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="memory-detail-meta">
          <span className="memory-detail-type-badge">{selectedNode.type}</span>
          {selectedNode.aliases.length > 0 && (
            <span className="memory-detail-aliases">
              {selectedNode.aliases.join(", ")}
            </span>
          )}
        </div>
        <div className="memory-detail-dates">
          <ClockIcon size={12} />
          <span>Created {fmtDate(selectedNode.createdAt)}</span>
          <span>Updated {fmtDate(selectedNode.updatedAt)}</span>
        </div>
      </div>

      <div className="memory-detail-tags">
        {selectedNode.tags.map((tag) => (
          <span key={tag} className="memory-detail-tag">
            {tag}
          </span>
        ))}
      </div>

      {selectedNode.backlinks.length > 0 && (
        <div className="memory-detail-section">
          <div className="memory-detail-section-title">Backlinks</div>
          <div className="memory-detail-backlinks">
            {selectedNode.backlinks.map((link) => (
              <span key={link} className="memory-detail-backlink">
                {link}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="memory-detail-content">
        <div className="memory-detail-section-title">Content</div>
        <div className="memory-detail-markdown">
          {selectedNode.content || "(empty)"}
        </div>
      </div>

      {selectedNode.sourceSessions && selectedNode.sourceSessions.length > 0 && (
        <div className="memory-detail-section">
          <div className="memory-detail-section-title">Source Sessions</div>
          <div className="memory-detail-sessions">
            {selectedNode.sourceSessions.map((sess) => (
              <span key={sess} className="memory-detail-session">
                {sess.slice(0, 8)}
              </span>
            ))}
          </div>
        </div>
      )}

      <MemoryNodeAgentPanel />

      <style>{`
        .memory-detail {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .memory-detail-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-tertiary);
          font-size: 14px;
        }

        .memory-detail-header {
          padding: 16px;
          border-bottom: 1px solid var(--border);
        }

        .memory-detail-title-row {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }

        .memory-detail-title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text);
          margin: 0;
          line-height: 1.3;
        }

        .memory-detail-close {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          cursor: pointer;
          border-radius: 4px;
          flex-shrink: 0;
        }

        .memory-detail-close:hover {
          color: var(--text);
          background: var(--bg-hover);
        }

        .memory-detail-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-top: 8px;
        }

        .memory-detail-type-badge {
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
          border-radius: 4px;
          background: var(--accent-bg);
          color: var(--accent);
          text-transform: capitalize;
        }

        .memory-detail-aliases {
          font-size: 12px;
          color: var(--text-tertiary);
        }

        .memory-detail-dates {
          display: flex;
          align-items: center;
          gap: 4px;
          margin-top: 6px;
          font-size: 11px;
          color: var(--text-tertiary);
        }

        .memory-detail-dates span:last-child {
          margin-left: 8px;
          padding-left: 8px;
          border-left: 1px solid var(--border);
        }

        .memory-detail-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
        }

        .memory-detail-tag {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 4px;
          background: var(--bg-surface);
          color: var(--text-secondary);
        }

        .memory-detail-section {
          padding: 12px 16px;
          border-bottom: 1px solid var(--border);
        }

        .memory-detail-section-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }

        .memory-detail-backlinks {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .memory-detail-backlink {
          font-size: 12px;
          color: var(--accent);
          cursor: pointer;
        }

        .memory-detail-backlink:hover {
          text-decoration: underline;
        }

        .memory-detail-content {
          flex: 1;
          padding: 16px;
          overflow-y: auto;
        }

        .memory-detail-markdown {
          font-size: 13px;
          line-height: 1.6;
          color: var(--text);
          white-space: pre-wrap;
          word-break: break-word;
        }

        .memory-detail-sessions {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
        }

        .memory-detail-session {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--bg-surface);
          color: var(--text-tertiary);
          font-family: monospace;
        }
      `}</style>
    </div>
  );
}