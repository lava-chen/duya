"use client";

import { useEffect } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import { FileTextIcon, TrashIcon, ArrowUpRightIcon, PlusIcon } from "@/components/icons";

export function MemoryInboxList() {
  const { inboxFiles, inboxItems, loadInboxFiles, loadInboxItem, removeInboxItem, selectNode } =
    useMemoryStore();

  useEffect(() => {
    loadInboxFiles();
  }, [loadInboxFiles]);

  const getItemContent = (filename: string) => {
    const item = inboxItems.find((i) => i.filename === filename);
    if (!item) {
      loadInboxItem(filename);
      return null;
    }
    if (item.loading) return "Loading...";
    return item.content;
  };

  if (inboxFiles.length === 0) {
    return (
      <div className="memory-inbox-empty">
        <div className="memory-inbox-empty-text">
          No drafts in inbox. Low-confidence memories will appear here for review.
        </div>
      </div>
    );
  }

  const handlePromote = (filename: string) => {
    const path = `inbox/${filename}`;
    selectNode(path);
  };

  return (
    <div className="memory-inbox-list">
      {inboxFiles.map((filename) => {
        const content = getItemContent(filename);
        const displayName = filename.replace(".md", "");

        return (
          <div key={filename} className="memory-inbox-item">
            <div className="memory-inbox-item-header">
              <FileTextIcon size={14} />
              <span className="memory-inbox-item-name">{displayName}</span>
              <div className="memory-inbox-item-actions">
                <button
                  type="button"
                  className="memory-inbox-item-btn"
                  onClick={() => handlePromote(filename)}
                  title="Promote to Node"
                >
                  <ArrowUpRightIcon size={14} />
                </button>
                <button
                  type="button"
                  className="memory-inbox-item-btn danger"
                  onClick={() => removeInboxItem(filename)}
                  title="Discard"
                >
                  <TrashIcon size={13} />
                </button>
              </div>
            </div>
            {content && (
              <div className="memory-inbox-item-content">
                {content === "Loading..." ? (
                  <span className="memory-inbox-loading">Loading...</span>
                ) : (
                  <pre className="memory-inbox-item-preview">{content}</pre>
                )}
              </div>
            )}
          </div>
        );
      })}

      <style>{`
        .memory-inbox-list {
          height: 100%;
          overflow-y: auto;
          padding: 12px 16px;
        }

        .memory-inbox-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
        }

        .memory-inbox-empty-text {
          color: var(--text-tertiary);
          font-size: 14px;
          text-align: center;
          max-width: 300px;
        }

        .memory-inbox-item {
          border: 1px solid var(--border);
          border-radius: 8px;
          margin-bottom: 10px;
          overflow: hidden;
        }

        .memory-inbox-item-header {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 10px 12px;
          background: var(--bg-surface);
        }

        .memory-inbox-item-name {
          flex: 1;
          font-size: 13px;
          font-weight: 500;
          color: var(--text);
        }

        .memory-inbox-item-actions {
          display: flex;
          gap: 4px;
        }

        .memory-inbox-item-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 4px 8px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: transparent;
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.1s;
        }

        .memory-inbox-item-btn:hover {
          background: var(--bg-hover);
        }

        .memory-inbox-item-btn.danger:hover {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border-color: rgba(239, 68, 68, 0.3);
        }

        .memory-inbox-item-content {
          padding: 10px 12px;
          border-top: 1px solid var(--border);
        }

        .memory-inbox-item-preview {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
          color: var(--text-secondary);
          white-space: pre-wrap;
          word-break: break-word;
          font-family: inherit;
        }

        .memory-inbox-loading {
          font-size: 12px;
          color: var(--text-tertiary);
        }
      `}</style>
    </div>
  );
}