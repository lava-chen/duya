"use client";

import { useMemo, useState } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import { PaperPlaneRightIcon, LightningIcon } from "@/components/icons";

export function MemoryNodeAgentPanel() {
  const { selectedNode, runtimeStatus, isLoadingRuntimeStatus, runtimeStatusError } = useMemoryStore();
  const [input, setInput] = useState("");

  if (!selectedNode) return null;

  const runtimeLabel =
    runtimeStatus.state === "processing"
      ? "Processing"
      : runtimeStatus.state === "queued"
        ? "Queued"
        : runtimeStatus.state === "error"
          ? "Error"
          : "Idle";

  const panelState = useMemo(() => {
    if (isLoadingRuntimeStatus) return "loading";
    if (runtimeStatusError || runtimeStatus.state === "error") return "error";
    if (!runtimeStatus.supportsNodeAgentChat) return "unsupported";
    return "ready";
  }, [isLoadingRuntimeStatus, runtimeStatus.supportsNodeAgentChat, runtimeStatus.state, runtimeStatusError]);

  const disabled = panelState !== "ready";

  const statusMessage =
    panelState === "loading"
      ? "Checking wiki-agent backend..."
      : panelState === "error"
        ? runtimeStatusError || runtimeStatus.errorMessage || "Wiki-agent runtime reported an error."
        : panelState === "unsupported"
          ? "Node chat-to-edit is not exposed by the current backend APIs."
          : "Agent is ready for node edit chat.";

  const handleSuggest = () => {
    if (disabled) return;
    setInput("Suggest improvements for this node.");
  };

  const handleApply = () => {
    if (disabled) return;
    setInput("Apply these edits to the current node:");
  };

  const handleSend = () => {
    // Intentionally no-op until a concrete node chat/edit API is available.
  };

  return (
    <div className="memory-agent-panel">
      <div className="memory-agent-panel-header">
        <div className="memory-agent-panel-title">
          <LightningIcon size={14} />
          <span>Agent Chat</span>
        </div>
        <span className={`memory-agent-runtime ${runtimeStatus.state}`}>{runtimeLabel}</span>
      </div>

      <div className={`memory-agent-status ${panelState === "error" ? "error" : ""}`}>
        {statusMessage}
      </div>

      <div className="memory-agent-actions">
        <button
          type="button"
          className="memory-agent-action-btn"
          onClick={handleSuggest}
          disabled={disabled}
        >
          <LightningIcon size={14} />
          Suggest
        </button>
        <button
          type="button"
          className="memory-agent-action-btn"
          onClick={handleApply}
          disabled={disabled}
        >
          <LightningIcon size={14} />
          Apply
        </button>
      </div>

      <div className="memory-agent-input-row">
        <textarea
          className="memory-agent-textarea"
          placeholder={disabled ? "Node edit chat unavailable in this build." : "Ask agent about this node..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          disabled={disabled}
        />
        <button
          type="button"
          className="memory-agent-send"
          onClick={handleSend}
          disabled={disabled || !input.trim()}
        >
          <PaperPlaneRightIcon size={16} />
        </button>
      </div>

      <style>{`
        .memory-agent-panel {
          border-top: 1px solid var(--border);
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .memory-agent-panel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .memory-agent-panel-title {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .memory-agent-runtime {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 999px;
          border: 1px solid var(--border);
          color: var(--text-tertiary);
          background: var(--bg-surface);
        }

        .memory-agent-runtime.processing {
          color: var(--accent);
          background: var(--accent-bg);
          border-color: transparent;
        }

        .memory-agent-runtime.error {
          color: var(--error);
          background: var(--error-soft);
          border-color: var(--error);
        }

        .memory-agent-status {
          font-size: 12px;
          color: var(--text-tertiary);
          line-height: 1.4;
        }

        .memory-agent-status.error {
          color: var(--error);
        }

        .memory-agent-actions {
          display: flex;
          gap: 6px;
        }

        .memory-agent-action-btn {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 4px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: transparent;
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.1s;
        }

        .memory-agent-action-btn:hover:not(:disabled) {
          background: var(--bg-hover);
          color: var(--text);
        }

        .memory-agent-action-btn:disabled {
          opacity: 0.5;
          cursor: default;
        }

        .memory-agent-input-row {
          display: flex;
          gap: 6px;
          align-items: flex-end;
        }

        .memory-agent-textarea {
          flex: 1;
          padding: 6px 10px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--bg-surface);
          color: var(--text);
          font-size: 12px;
          font-family: inherit;
          resize: none;
          outline: none;
        }

        .memory-agent-textarea:focus {
          border-color: var(--accent);
        }

        .memory-agent-textarea:disabled {
          opacity: 0.6;
          cursor: default;
        }

        .memory-agent-textarea::placeholder {
          color: var(--text-tertiary);
        }

        .memory-agent-send {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 6px 10px;
          border: none;
          border-radius: 6px;
          background: var(--accent);
          color: white;
          cursor: pointer;
          transition: opacity 0.1s;
          flex-shrink: 0;
        }

        .memory-agent-send:disabled {
          opacity: 0.4;
          cursor: default;
        }

        .memory-agent-send:not(:disabled):hover {
          opacity: 0.85;
        }
      `}</style>
    </div>
  );
}
