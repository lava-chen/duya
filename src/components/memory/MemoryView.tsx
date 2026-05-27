"use client";

import { useEffect, useMemo } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import type { MemoryViewTab, WikiNodeType } from "@/types/memory";
import { subscribeWikiActivityIPC } from "@/lib/memory-ipc";
import { MemoryGraphView } from "./MemoryGraphView";
import { MemoryTreeView } from "./MemoryTreeView";
import { MemoryInboxList } from "./MemoryInboxList";
import { MemoryActivityList } from "./MemoryActivityList";
import { MemoryNodeDetail } from "./MemoryNodeDetail";
import { ChartBarIcon, GitBranchIcon, ArchiveIcon, ClockCounterClockwiseIcon, MagnifyingGlassIcon, XIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";

const NODE_TYPES: { value: WikiNodeType; label: string }[] = [
  { value: "person", label: "People" },
  { value: "project", label: "Projects" },
  { value: "knowledge", label: "Knowledge" },
  { value: "event", label: "Events" },
  { value: "file", label: "Files" },
  { value: "self", label: "Self" },
  { value: "todo", label: "Todos" },
  { value: "concept", label: "Concepts" },
  { value: "module", label: "Modules" },
  { value: "class", label: "Classes" },
  { value: "function", label: "Functions" },
  { value: "workflow", label: "Workflows" },
  { value: "devops", label: "DevOps" },
  { value: "inbox", label: "Inbox" },
];

const TAB_ICONS: Record<MemoryViewTab, React.ComponentType<{ size?: number }>> = {
  graph: ChartBarIcon as React.ComponentType<{ size?: number }>,
  tree: GitBranchIcon as React.ComponentType<{ size?: number }>,
  inbox: ArchiveIcon as React.ComponentType<{ size?: number }>,
  activity: ClockCounterClockwiseIcon as React.ComponentType<{ size?: number }>,
};

export function MemoryView() {
  const { t } = useTranslation();
  const {
    viewTab,
    setViewTab,
    searchQuery,
    setSearchQuery,
    typeFilter,
    setTypeFilter,
    selectedNode,
    selectedNodePath,
    selectNode,
    loadNodes,
    searchNodes,
    nodes,
    isLoadingNodes,
    runtimeStatus,
    isLoadingRuntimeStatus,
    runtimeStatusError,
    loadRuntimeStatus,
    applyRuntimeActivity,
  } = useMemoryStore();

  useEffect(() => {
    loadNodes();
  }, [loadNodes]);

  useEffect(() => {
    const debounce = setTimeout(() => {
      if (searchQuery.trim()) {
        searchNodes(searchQuery);
      } else {
        loadNodes();
      }
    }, 300);
    return () => clearTimeout(debounce);
  }, [searchQuery, searchNodes, loadNodes]);

  useEffect(() => {
    void loadRuntimeStatus();
    const unsubscribe = subscribeWikiActivityIPC((activity) => {
      applyRuntimeActivity(activity);
    });
    return unsubscribe;
  }, [applyRuntimeActivity, loadRuntimeStatus]);

  const filteredNodes = useMemo(() => {
    if (!typeFilter) return nodes;
    return nodes.filter((n) => n.type === typeFilter);
  }, [nodes, typeFilter]);

  const tabs: { id: MemoryViewTab; label: string }[] = [
    { id: "graph", label: t("nav.memory") },
    { id: "tree", label: "Tree" },
    { id: "inbox", label: "Inbox" },
    { id: "activity", label: "Activity" },
  ];

  const runtimeLabel =
    runtimeStatus.state === "processing"
      ? "Processing"
      : runtimeStatus.state === "queued"
        ? "Queued"
        : runtimeStatus.state === "error"
          ? "Error"
          : "Idle";

  const runtimeMeta = isLoadingRuntimeStatus
    ? "Checking runtime status..."
    : runtimeStatusError
      ? runtimeStatusError
      : runtimeStatus.summary
        ? runtimeStatus.updatedAt
          ? `${runtimeStatus.summary} · ${new Date(runtimeStatus.updatedAt).toLocaleTimeString()}`
          : runtimeStatus.summary
        : runtimeStatus.supportsRuntimeStatus || runtimeStatus.supportsActivitySubscription
          ? "No recent activity."
          : "Runtime status API is not available in this build.";

  const renderTabContent = () => {
    switch (viewTab) {
      case "graph":
        return <MemoryGraphView nodes={filteredNodes} onSelectNode={selectNode} />;
      case "tree":
        return <MemoryTreeView nodes={filteredNodes} onSelectNode={selectNode} />;
      case "inbox":
        return <MemoryInboxList />;
      case "activity":
        return <MemoryActivityList />;
    }
  };

  return (
    <div className="memory-view">
      <div className="memory-top-bar">
        <div className="memory-tabs">
          {tabs.map((tab) => {
            const Icon = TAB_ICONS[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                className={`memory-tab${viewTab === tab.id ? " active" : ""}`}
                onClick={() => setViewTab(tab.id)}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
        <div className="memory-search">
          <MagnifyingGlassIcon size={14} />
          <input
            type="text"
            className="memory-search-input"
            placeholder="Search nodes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button
              type="button"
              className="memory-search-clear"
              onClick={() => setSearchQuery("")}
            >
              <XIcon size={12} />
            </button>
          )}
        </div>
        <div className="memory-runtime" aria-live="polite">
          <span className={`memory-runtime-badge ${runtimeStatus.state}`}>
            {runtimeLabel}
          </span>
          <span className={`memory-runtime-meta${runtimeStatusError ? " error" : ""}`}>
            {runtimeMeta}
          </span>
        </div>
      </div>

      <div className="memory-body">
        <div className="memory-left-rail">
          <div className="memory-filter-section">
            <div className="memory-filter-title">Type</div>
            <button
              type="button"
              className={`memory-filter-chip${typeFilter === null ? " active" : ""}`}
              onClick={() => setTypeFilter(null)}
            >
              All
            </button>
            {NODE_TYPES.map((nt) => (
              <button
                key={nt.value}
                type="button"
                className={`memory-filter-chip${typeFilter === nt.value ? " active" : ""}`}
                onClick={() => setTypeFilter(typeFilter === nt.value ? null : nt.value)}
              >
                {nt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="memory-center">
          {isLoadingNodes ? (
            <div className="memory-loading">Loading...</div>
          ) : (
            renderTabContent()
          )}
        </div>

        {selectedNodePath && (
          <div className="memory-right-panel">
            <MemoryNodeDetail />
          </div>
        )}
      </div>

      <style>{`
        .memory-view {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-canvas);
        }

        .memory-top-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border);
          gap: 16px;
          flex-shrink: 0;
        }

        .memory-tabs {
          display: flex;
          gap: 4px;
        }

        .memory-tab {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: var(--text-secondary);
          font-size: 13px;
          cursor: pointer;
          transition: all 0.15s;
        }

        .memory-tab:hover {
          background: var(--bg-hover);
          color: var(--text);
        }

        .memory-tab.active {
          background: var(--accent-bg);
          color: var(--accent);
        }

        .memory-search {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          background: var(--bg-surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          flex: 0 0 240px;
        }

        .memory-runtime {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 260px;
          justify-content: flex-end;
        }

        .memory-runtime-badge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 3px 8px;
          border-radius: 999px;
          border: 1px solid var(--border);
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          background: var(--bg-surface);
          flex-shrink: 0;
        }

        .memory-runtime-badge.processing {
          color: var(--accent);
          background: var(--accent-bg);
          border-color: transparent;
        }

        .memory-runtime-badge.queued {
          color: var(--text);
          background: var(--bg-hover);
        }

        .memory-runtime-badge.error {
          color: var(--error);
          background: var(--error-soft);
          border-color: var(--error);
        }

        .memory-runtime-meta {
          font-size: 12px;
          color: var(--text-tertiary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          max-width: 420px;
        }

        .memory-runtime-meta.error {
          color: var(--error);
        }

        .memory-search svg {
          color: var(--text-tertiary);
          flex-shrink: 0;
        }

        .memory-search-input {
          border: none;
          background: transparent;
          color: var(--text);
          font-size: 13px;
          outline: none;
          flex: 1;
          min-width: 0;
        }

        .memory-search-input::placeholder {
          color: var(--text-tertiary);
        }

        .memory-search-clear {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2px;
          border: none;
          background: transparent;
          color: var(--text-tertiary);
          cursor: pointer;
          border-radius: 4px;
        }

        .memory-search-clear:hover {
          color: var(--text);
          background: var(--bg-hover);
        }

        .memory-body {
          display: flex;
          flex: 1;
          min-height: 0;
        }

        .memory-left-rail {
          width: 180px;
          flex-shrink: 0;
          border-right: 1px solid var(--border);
          padding: 12px;
          overflow-y: auto;
        }

        .memory-filter-section {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .memory-filter-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-tertiary);
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 4px;
        }

        .memory-filter-chip {
          display: block;
          width: 100%;
          text-align: left;
          padding: 5px 10px;
          border: none;
          border-radius: 5px;
          background: transparent;
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.1s;
        }

        .memory-filter-chip:hover {
          background: var(--bg-hover);
          color: var(--text);
        }

        .memory-filter-chip.active {
          background: var(--accent-bg);
          color: var(--accent);
          font-weight: 500;
        }

        .memory-center {
          flex: 1;
          min-width: 0;
          overflow: hidden;
        }

        .memory-right-panel {
          width: 400px;
          flex-shrink: 0;
          border-left: 1px solid var(--border);
          overflow-y: auto;
        }

        .memory-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-tertiary);
          font-size: 14px;
        }
      `}</style>
    </div>
  );
}
