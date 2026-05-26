"use client";

import { useState } from "react";
import { useMemoryStore } from "@/stores/memory-store";
import { PaperPlaneRightIcon, LightningIcon } from "@/components/icons";

export function MemoryNodeAgentPanel() {
  const { selectedNode } = useMemoryStore();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<{ role: "user" | "agent"; content: string }[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);

  if (!selectedNode) return null;

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isProcessing) return;

    setMessages((prev) => [...prev, { role: "user", content: trimmed }]);
    setInput("");
    setIsProcessing(true);

    setTimeout(() => {
      setMessages((prev) => [
        ...prev,
        { role: "agent", content: "Agent interaction will be available once the wiki-agent backend is connected." },
      ]);
      setIsProcessing(false);
    }, 800);
  };

  const handleSuggest = () => {
    setInput("Suggest improvements for this node");
  };

  const handleUpdate = () => {
    setInput("Update this node with the following changes:");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="memory-agent-panel">
      <div className="memory-agent-panel-header">
        <LightningIcon size={14} />
        <span>Agent Chat</span>
      </div>

      {messages.length > 0 && (
        <div className="memory-agent-messages">
          {messages.map((msg, i) => (
            <div key={i} className={`memory-agent-message ${msg.role}`}>
              <div className="memory-agent-message-role">
                {msg.role === "user" ? "You" : "Agent"}
              </div>
              <div className="memory-agent-message-content">{msg.content}</div>
            </div>
          ))}
          {isProcessing && (
            <div className="memory-agent-message agent">
              <div className="memory-agent-message-content typing">Thinking...</div>
            </div>
          )}
        </div>
      )}

      <div className="memory-agent-actions">
        <button
          type="button"
          className="memory-agent-action-btn"
          onClick={handleSuggest}
        >
          <LightningIcon size={14} />
          Suggest
        </button>
        <button
          type="button"
          className="memory-agent-action-btn"
          onClick={handleUpdate}
        >
          <LightningIcon size={14} />
          Apply
        </button>
      </div>

      <div className="memory-agent-input-row">
        <textarea
          className="memory-agent-textarea"
          placeholder="Ask agent about this node..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={2}
        />
        <button
          type="button"
          className="memory-agent-send"
          onClick={handleSend}
          disabled={!input.trim() || isProcessing}
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
          gap: 6px;
          font-size: 12px;
          font-weight: 600;
          color: var(--text-secondary);
        }

        .memory-agent-messages {
          display: flex;
          flex-direction: column;
          gap: 8px;
          max-height: 200px;
          overflow-y: auto;
        }

        .memory-agent-message {
          font-size: 12px;
          line-height: 1.5;
        }

        .memory-agent-message-role {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-tertiary);
          margin-bottom: 2px;
        }

        .memory-agent-message.user .memory-agent-message-content {
          background: var(--accent-bg);
          color: var(--text);
          padding: 6px 10px;
          border-radius: 8px;
        }

        .memory-agent-message.agent .memory-agent-message-content {
          background: var(--bg-surface);
          color: var(--text);
          padding: 6px 10px;
          border-radius: 8px;
        }

        .typing {
          opacity: 0.6;
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

        .memory-agent-action-btn:hover {
          background: var(--bg-hover);
          color: var(--text);
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