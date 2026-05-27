"use client";

import { useState } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import { CheckIcon, XIcon } from "@/components/icons";
import { ArrowsLeftRight as ArrowLeftRightIcon } from "@phosphor-icons/react";

interface MergePreviewProps {
  sourceNode: {
    id: string;
    title: string;
    content: string;
    originalContext?: string;
  };
  targetNode: {
    id: string;
    title: string;
    content: string;
  };
  confidence: number;
  onMerge: () => void;
  onSkip: () => void;
}

export function MemoryMergePreview({
  sourceNode,
  targetNode,
  confidence,
  onMerge,
  onSkip,
}: MergePreviewProps) {
  const [view, setView] = useState<"side-by-side" | "diff">("side-by-side");

  return (
    <div className="memory-merge-preview">
      <div className="memory-merge-header">
        <ArrowLeftRightIcon size={16} />
        <span>Merge Preview</span>
        <span className="memory-merge-confidence">
          {Math.round(confidence * 100)}% match
        </span>
      </div>

      <div className="memory-merge-tabs">
        <button
          type="button"
          className={`memory-merge-tab${view === "side-by-side" ? " active" : ""}`}
          onClick={() => setView("side-by-side")}
        >
          Side by Side
        </button>
        <button
          type="button"
          className={`memory-merge-tab${view === "diff" ? " active" : ""}`}
          onClick={() => setView("diff")}
        >
          Diff
        </button>
      </div>

      <div className="memory-merge-body">
        <div className="memory-merge-column">
          <div className="memory-merge-column-header">
            Source: {sourceNode.title}
          </div>
          <pre className="memory-merge-content">{sourceNode.content || "(empty)"}</pre>
          {sourceNode.originalContext && (
            <div className="memory-merge-context">
              <div className="memory-merge-context-title">Original Context</div>
              <pre className="memory-merge-context-content">{sourceNode.originalContext}</pre>
            </div>
          )}
        </div>
        <div className="memory-merge-column">
          <div className="memory-merge-column-header">
            Target: {targetNode.title}
          </div>
          <pre className="memory-merge-content">{targetNode.content || "(empty)"}</pre>
        </div>
      </div>

      <div className="memory-merge-actions">
        <button type="button" className="memory-merge-btn skip" onClick={onSkip}>
          <XIcon size={14} />
          Keep Separate
        </button>
        <button type="button" className="memory-merge-btn merge" onClick={onMerge}>
          <CheckIcon size={14} />
          Merge
        </button>
      </div>

      <style>{`
        .memory-merge-preview {
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
        }

        .memory-merge-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 14px;
          background: var(--bg-surface);
          font-size: 13px;
          font-weight: 600;
          color: var(--text);
        }

        .memory-merge-confidence {
          font-size: 11px;
          font-weight: 400;
          color: var(--accent);
          margin-left: auto;
        }

        .memory-merge-tabs {
          display: flex;
          gap: 2px;
          padding: 6px 14px;
        }

        .memory-merge-tab {
          padding: 4px 10px;
          border: none;
          border-radius: 4px;
          background: transparent;
          color: var(--text-tertiary);
          font-size: 12px;
          cursor: pointer;
        }

        .memory-merge-tab.active {
          background: var(--accent-bg);
          color: var(--accent);
        }

        .memory-merge-body {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1px;
          background: var(--border);
        }

        .memory-merge-column {
          background: var(--bg-canvas);
          min-height: 120px;
        }

        .memory-merge-column-header {
          padding: 8px 12px;
          font-size: 12px;
          font-weight: 500;
          color: var(--text-secondary);
          border-bottom: 1px solid var(--border);
        }

        .memory-merge-content {
          margin: 0;
          padding: 10px 12px;
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: inherit;
        }

        .memory-merge-context {
          border-top: 1px solid var(--border);
          padding: 8px 12px;
        }

        .memory-merge-context-title {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          margin-bottom: 4px;
        }

        .memory-merge-context-content {
          margin: 0;
          font-size: 11px;
          line-height: 1.4;
          color: var(--text-tertiary);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: inherit;
        }

        .memory-merge-actions {
          display: flex;
          gap: 8px;
          justify-content: flex-end;
          padding: 10px 14px;
          background: var(--bg-surface);
          border-top: 1px solid var(--border);
        }

        .memory-merge-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 6px 14px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: transparent;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.1s;
        }

        .memory-merge-btn:hover {
          background: var(--bg-hover);
        }

        .memory-merge-btn.merge {
          background: var(--accent);
          color: white;
          border-color: var(--accent);
        }

        .memory-merge-btn.merge:hover {
          opacity: 0.9;
        }

        .memory-merge-btn.skip {
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}