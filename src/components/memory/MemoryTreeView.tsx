"use client";

import type { WikiIndexEntry } from "@/types/memory";
import { FolderIcon, FileTextIcon, CaretDownIcon, CaretRightIcon } from "@/components/icons";
import { useState, useMemo } from "react";

interface MemoryTreeViewProps {
  nodes: WikiIndexEntry[];
  onSelectNode: (nodePath: string) => void;
}

const TYPE_LABELS: Record<string, string> = {
  concept: "Concepts",
  module: "Modules",
  class: "Classes",
  function: "Functions",
  workflow: "Workflows",
  devops: "DevOps",
  inbox: "Inbox",
};

const TYPE_ORDER = ["concept", "module", "class", "function", "workflow", "devops", "inbox"];

export function MemoryTreeView({ nodes, onSelectNode }: MemoryTreeViewProps) {
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(TYPE_ORDER));

  const groupedNodes = useMemo(() => {
    const groups: Record<string, WikiIndexEntry[]> = {};
    for (const node of nodes) {
      if (!groups[node.type]) {
        groups[node.type] = [];
      }
      groups[node.type].push(node);
    }
    for (const key of Object.keys(groups)) {
      groups[key].sort((a, b) => a.title.localeCompare(b.title));
    }
    return groups;
  }, [nodes]);

  const toggleDir = (dir: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
      }
      return next;
    });
  };

  if (nodes.length === 0) {
    return (
      <div className="memory-tree-empty">
        <div className="memory-tree-empty-text">
          No nodes to display. Memory nodes will appear here as the Wiki Agent captures knowledge.
        </div>
      </div>
    );
  }

  return (
    <div className="memory-tree-view">
      {TYPE_ORDER.map((type) => {
        const typeNodes = groupedNodes[type];
        if (!typeNodes || typeNodes.length === 0) return null;

        const isExpanded = expandedDirs.has(type);
        const NodeCount = typeNodes.length;

        return (
          <div key={type} className="memory-tree-group">
            <button
              type="button"
              className="memory-tree-group-header"
              onClick={() => toggleDir(type)}
            >
              <span className="memory-tree-group-caret">
                {isExpanded ? <CaretDownIcon size={12} /> : <CaretRightIcon size={12} />}
              </span>
              <FolderIcon size={14} />
              <span className="memory-tree-group-label">{TYPE_LABELS[type] || type}</span>
              <span className="memory-tree-group-count">{NodeCount}</span>
            </button>

            {isExpanded && (
              <div className="memory-tree-group-children">
                {typeNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    className="memory-tree-item"
                    onClick={() => onSelectNode(node.path)}
                  >
                    <FileTextIcon size={13} />
                    <span className="memory-tree-item-title">{node.title}</span>
                    {node.summary && (
                      <span className="memory-tree-item-summary">{node.summary}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <style>{`
        .memory-tree-view {
          height: 100%;
          overflow-y: auto;
          padding: 12px 16px;
        }

        .memory-tree-group {
          margin-bottom: 2px;
        }

        .memory-tree-group-header {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 6px 8px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text);
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.1s;
        }

        .memory-tree-group-header:hover {
          background: var(--bg-hover);
        }

        .memory-tree-group-caret {
          display: flex;
          align-items: center;
          color: var(--text-tertiary);
          width: 16px;
        }

        .memory-tree-group-label {
          flex: 1;
          text-align: left;
        }

        .memory-tree-group-count {
          font-size: 11px;
          color: var(--text-tertiary);
          background: var(--bg-surface);
          padding: 1px 6px;
          border-radius: 10px;
        }

        .memory-tree-group-children {
          padding-left: 24px;
        }

        .memory-tree-item {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          padding: 5px 10px;
          border: none;
          border-radius: 5px;
          background: transparent;
          color: var(--text-secondary);
          font-size: 13px;
          cursor: pointer;
          transition: all 0.1s;
        }

        .memory-tree-item:hover {
          background: var(--bg-hover);
          color: var(--text);
        }

        .memory-tree-item-title {
          flex-shrink: 0;
        }

        .memory-tree-item-summary {
          font-size: 11px;
          color: var(--text-tertiary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .memory-tree-empty {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
        }

        .memory-tree-empty-text {
          color: var(--text-tertiary);
          font-size: 14px;
          text-align: center;
          max-width: 300px;
        }
      `}</style>
    </div>
  );
}