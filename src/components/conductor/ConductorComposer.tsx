"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { PaperPlaneTilt, Stop, SpinnerGap, Robot, Wrench, Warning, CheckCircle, XCircle, Newspaper } from "@phosphor-icons/react";
import { useConductorStore } from "@/stores/conductor-store";
import type { AgentStreamItem } from "@/stores/conductor-store";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { executeAction } from "@/lib/conductor-ipc";



export function ConductorComposer() {
  const [value, setValue] = useState("");
  const {
    activeCanvasId,
    agentStatus,
    agentStream,
    setAgentStatus,
    addAgentStreamItem,
    clearAgentStream,
    widgets,
    snapshot,
    conductorModels,
    conductorModel,
    conductorModelsLoading,
    fetchConductorModels,
    setConductorModel,
    setUiError,
  } = useConductorStore();

  const streamRef = useRef<HTMLDivElement>(null);
  const [showStream, setShowStream] = useState(false);

  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [agentStream]);

  const executeToolResult = useCallback(async (data: { id: string; name: string; result: string }) => {
    try {
      const parsed = JSON.parse(data.result);
      if (!parsed.success || !parsed.action) return;

      const actionType = parsed.action;
      if (actionType === 'widget.update_data' || actionType === 'widget.create') {
        try {
          await executeAction({
            action: actionType,
            canvasId: parsed.canvasId,
            widgetId: parsed.widgetId,
            kind: parsed.kind,
            type: parsed.type,
            position: parsed.position,
            data: parsed.data,
            actor: 'agent',
          } as any);

          addAgentStreamItem({
            id: crypto.randomUUID(),
            type: "tool_result",
            content: `✅ ${actionType}`,
            toolResult: data.result,
            ts: Date.now(),
          });
        } catch (err) {
          addAgentStreamItem({
            id: crypto.randomUUID(),
            type: "error",
            content: `操作失败: ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
          });
        }
      }
    } catch {
      // Not JSON or unexpected format, ignore
    }
  }, [addAgentStreamItem]);

  // Fetch models on mount & when window regains focus (user may have changed providers)
  useEffect(() => {
    fetchConductorModels();
    const handleFocus = () => fetchConductorModels();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []);

  useEffect(() => {
    const port = (window as any).electronAPI?.getConductorPort?.();
    if (!port) return;

    const unsubText = port.onText((data: { content: string }) => {
      addAgentStreamItem({
        id: crypto.randomUUID(),
        type: "text",
        content: data.content,
        ts: Date.now(),
      });
    });

    const unsubThinking = port.onThinking((data: { content: string }) => {
      addAgentStreamItem({
        id: crypto.randomUUID(),
        type: "thinking",
        content: data.content,
        ts: Date.now(),
      });
    });

    const unsubToolUse = port.onToolUse((data: { id: string; name: string; input: unknown }) => {
      setAgentStatus("tool_use");
      addAgentStreamItem({
        id: crypto.randomUUID(),
        type: "tool_use",
        content: `Calling tool: ${data.name}`,
        toolName: data.name,
        toolInput: typeof data.input === "string" ? data.input : JSON.stringify(data.input),
        ts: Date.now(),
      });
    });

    const unsubToolResult = port.onToolResult((data: { id: string; result: unknown; error?: boolean }) => {
      const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
      executeToolResult({ id: data.id, name: "", result: resultStr });
    });

    const unsubStatus = port.onStatus((data: { status: string }) => {
      if (data.status === "idle") {
        setAgentStatus("idle");
      } else if (data.status === "thinking") {
        setAgentStatus("thinking");
      } else if (data.status === "streaming") {
        setAgentStatus("streaming");
      }
    });

    const unsubError = port.onError((data: { message: string }) => {
      setAgentStatus("error");
      addAgentStreamItem({
        id: crypto.randomUUID(),
        type: "error",
        content: data.message,
        ts: Date.now(),
      });
    });

    const unsubDone = port.onDone(() => {
      setAgentStatus("completed");
    });

    const unsubDisconnected = port.onDisconnected(() => {
      if (agentStatus !== "idle" && agentStatus !== "completed" && agentStatus !== "error") {
        setAgentStatus("error");
        addAgentStreamItem({
          id: crypto.randomUUID(),
          type: "error",
          content: "Agent process disconnected unexpectedly",
          ts: Date.now(),
        });
      }
    });

    return () => {
      unsubText();
      unsubThinking();
      unsubToolUse();
      unsubToolResult();
      unsubStatus();
      unsubError();
      unsubDone();
      unsubDisconnected();
    };
  }, []);

  const handleSend = useCallback(async () => {
    if (!value.trim() || agentStatus !== "idle") return;

    const content = value;
    setValue("");
    clearAgentStream();
    setShowStream(true);
    setAgentStatus("thinking");

    const port = (window as any).electronAPI?.getConductorPort?.();
    if (!port) {
      setUiError("Conductor channel unavailable. Please restart app.");
      setAgentStatus("error");
      addAgentStreamItem({
        id: crypto.randomUUID(),
        type: "error",
        content: "Conductor port not available. Please restart the app.",
        ts: Date.now(),
      });
      return;
    }

    const canvasSnapshot = snapshot || {
      canvasId: activeCanvasId,
      canvasName: "Canvas",
      widgets: widgets.map((w) => ({
        id: w.id,
        type: w.type,
        kind: w.kind,
        position: w.position,
        config: w.config,
        data: w.data,
        dataVersion: w.dataVersion,
      })),
      actionCursor: 0,
    };

    port.startAgent({
      content,
      snapshot: canvasSnapshot,
      canvasId: activeCanvasId || undefined,
      model: conductorModel || undefined,
    });
  }, [value, agentStatus, activeCanvasId, widgets, snapshot, conductorModel]);

  const handleStop = useCallback(() => {
    try {
      const port = (window as any).electronAPI?.getConductorPort?.();
      if (port) {
        port.interruptAgent();
      }
    } catch (error) {
      setUiError(`Interrupt failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    setAgentStatus("completed");
  }, [setAgentStatus, setUiError]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isStreaming = agentStatus !== "idle" && agentStatus !== "completed" && agentStatus !== "error";

  return (
    <div className="flex-shrink-0 bg-transparent">
      {showStream && agentStream.length > 0 && (
        <div
          ref={streamRef}
          className="max-h-[148px] overflow-y-auto scrollbar-thin px-2.5 py-2 border-b border-[var(--border)]/80 space-y-1.5"
        >
          {agentStream.map((item) => (
            <StreamItem key={item.id} item={item} />
          ))}
          {agentStatus === "completed" && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
              <CheckCircle size={10} className="text-green-500" />
              Complete
            </div>
          )}
          {agentStatus === "error" && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--error)]">
              <XCircle size={10} />
              Error
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 bg-[var(--main-bg)] rounded-lg px-3 h-10">
        {isStreaming && (
          <SpinnerGap size={14} className="animate-spin text-[var(--muted)] flex-shrink-0" />
        )}
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe what you want on the canvas..."
          rows={1}
          className="flex-1 bg-transparent border-none outline-none resize-none text-[13px] text-[var(--text)] placeholder:text-[var(--muted)] placeholder:opacity-50 min-h-0 max-h-[92px] py-0"
        />
        {conductorModels.length > 0 && (
          <div className="flex-shrink-0">
            <ModelSelector
              models={conductorModels}
              selectedModelId={conductorModel}
              onSelect={setConductorModel}
              disabled={isStreaming}
              loading={conductorModelsLoading}
              variant="compact"
            />
          </div>
        )}
        {isStreaming ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--error-soft)] text-[var(--error)] hover:bg-[rgba(239,68,68,0.25)] transition-colors flex-shrink-0"
          >
            <Stop size={14} weight="regular" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSend}
            disabled={!value.trim()}
            className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--send-btn)] text-white hover:bg-[var(--send-btn-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
          >
            <PaperPlaneTilt size={14} weight="regular" />
          </button>
        )}
      </div>
    </div>
  );
}

function StreamItem({ item }: { item: AgentStreamItem }) {
  const iconMap = {
    thinking: <Robot size={11} className="text-purple-400 flex-shrink-0 mt-0.5" />,
    text: <Robot size={11} className="text-[var(--accent)] flex-shrink-0 mt-0.5" />,
    tool_use: <Wrench size={11} className="text-yellow-500 flex-shrink-0 mt-0.5" />,
    tool_result: <CheckCircle size={11} className="text-green-500 flex-shrink-0 mt-0.5" />,
    tool_progress: <SpinnerGap size={11} className="animate-spin text-[var(--muted)] flex-shrink-0 mt-0.5" />,
    error: <Warning size={11} className="text-[var(--error)] flex-shrink-0 mt-0.5" />,
    status: <Robot size={11} className="text-[var(--muted)] flex-shrink-0 mt-0.5" />,
  };

  const isError = item.type === "error" || item.isError;

  return (
    <div className={`flex items-start gap-2 ${isError ? "text-[var(--error)]" : ""}`}>
      {iconMap[item.type]}
      <div className="flex-1 min-w-0">
        <div className="text-[11px] leading-relaxed whitespace-pre-wrap break-words">
          {item.content}
        </div>
        {item.toolName && (
          <div className="text-[10px] text-[var(--muted)] opacity-60 mt-0.5">
            Tool: {item.toolName}
          </div>
        )}
        {item.toolResult && (
          <div className="text-[10px] text-[var(--muted)] opacity-60 mt-0.5 truncate max-w-[280px]">
            {item.toolResult}
          </div>
        )}
      </div>
    </div>
  );
}
