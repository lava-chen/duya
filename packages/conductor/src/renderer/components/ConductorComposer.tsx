"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { PaperPlaneTilt, Stop, SpinnerGap, Robot, Wrench, Warning, CheckCircle, XCircle } from "@phosphor-icons/react";
import { useConductorStore } from "..//stores/conductor-store";
import { useConversationStore } from "@/stores/conversation-store";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { executeAction } from "..//ipc/conductor-ipc";
import { useConductorStream, useConductorStreamControl } from "../hooks/useConductorStream";
import type { ConductorEvent } from "@/lib/stream-session-manager";

export function ConductorComposer() {
  const [value, setValue] = useState("");
  const {
    activeCanvasId,
    agentStatus,
    setAgentStatus,
    conductorModels,
    conductorModel,
    conductorModelsLoading,
    fetchConductorModels,
    setConductorModel,
    setUiError,
    conductorVisionModel,
    conductorPermissionMode,
  } = useConductorStore();

  const streamRef = useRef<HTMLDivElement>(null);
  const [showStream, setShowStream] = useState(false);

  // Plan 221 Phase 7: in-canvas composer now forwards to the main chat
  // session. `useConductorStream` and `useConductorStreamControl` are still
  // imported for the legacy port-event routing (canvas state patches, tool
  // results from any pre-existing in-flight conductor workers). The
  // `startStream` path is intentionally not destructured: the conductor
  // worker is no longer spawned from this component.
  // TODO(plan 221 Phase 7): remove useConductorStreamControl once the
  // legacy port-event listeners are migrated to the main stream session.
  const activeThreadId = useConversationStore((state) => state.activeThreadId);
  // Use unified stream session manager
  const { events, phase, error } = useConductorStream(activeCanvasId);
  const { stopStream, handleEvent } = useConductorStreamControl(activeCanvasId);

  // Sync phase with agentStatus
  useEffect(() => {
    if (phase === 'idle') setAgentStatus("idle");
    else if (phase === 'thinking') setAgentStatus("thinking");
    else if (phase === 'streaming' || phase === 'tool_use') setAgentStatus("streaming");
    else if (phase === 'completed') setAgentStatus("completed");
    else if (phase === 'error') setAgentStatus("error");
  }, [phase, setAgentStatus]);

  // Auto-scroll to bottom when events update
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [events]);

  // Execute tool action and handle result
  const executeToolResult = useCallback(async (data: { id: string; name: string; result: string }) => {
    try {
      const parsed = JSON.parse(data.result);
      if (!parsed.success || !parsed.action) return;

      const actionType = parsed.action;

      try {
        await executeAction({
          action: actionType,
          canvasId: parsed.canvasId,
          elementId: parsed.elementId,
          elementKind: parsed.kind || parsed.elementKind,
          widgetId: parsed.widgetId,
          kind: parsed.kind,
          type: parsed.type,
          position: parsed.position,
          data: parsed.data,
          vizSpec: parsed.vizSpec,
          layout: parsed.layout,
          actor: 'agent',
        } as any);
      } catch (err) {
        handleEvent('error', { message: `操作失败: ${err instanceof Error ? err.message : String(err)}` });
      }
    } catch {
      // Not JSON or unexpected format, ignore
    }
  }, [handleEvent]);

  // Subscribe to conductor port events and forward to stream manager
  useEffect(() => {
    if (!activeCanvasId) return;

    // Wait for conductor port to be ready (dispatched from preload after MessageChannel setup)
    const handleConductorPortReady = () => {
      registerConductorHandlers();
    };

    // Check if port already exists (in case event already fired)
    let port = (window as any).electronAPI?.getConductorPort?.();
    if (port) {
      // Port already ready, register handlers directly
      registerConductorHandlers();
    } else {
      // Wait for port to be ready
      window.addEventListener('conductor-port-ready', handleConductorPortReady);
    }

    function registerConductorHandlers() {
      const port = (window as any).electronAPI?.getConductorPort?.();
      if (!port) {
        console.error('[ConductorComposer] ERROR: ConductorPort is null! Events will not be received.');
        return;
      }

    const unsubText = port.onText((data: { content: string }) => {
      handleEvent('text', data);
    });

    const unsubThinking = port.onThinking((data: { content: string }) => {
      handleEvent('thinking', data);
    });

    const unsubToolUse = port.onToolUse((data: { id: string; name: string; input: unknown }) => {
      handleEvent('tool_use', data);
    });

    const unsubToolResult = port.onToolResult((data: { id: string; result: unknown; error?: boolean }) => {
      handleEvent('tool_result', data);
      const resultStr = typeof data.result === "string" ? data.result : JSON.stringify(data.result);
      executeToolResult({ id: data.id, name: "", result: resultStr });
    });

    const unsubStatus = port.onStatus((data: { status: string }) => {
      handleEvent('status', data);
    });

    const unsubError = port.onError((data: { message: string }) => {
      console.error('[ConductorComposer] onError received:', data.message);
      handleEvent('error', data);
    });

    const unsubDone = port.onDone(() => {
      handleEvent('done', {});
    });

      return () => {
        unsubText();
        unsubThinking();
        unsubToolUse();
        unsubToolResult();
        unsubStatus();
        unsubError();
        unsubDone();
      };
    }

    // Cleanup function for event listener case
    return () => {
      window.removeEventListener('conductor-port-ready', handleConductorPortReady);
    };
  }, [activeCanvasId, handleEvent, executeToolResult]);

  // Fetch models on mount
  useEffect(() => {
    fetchConductorModels();
    const handleFocus = () => fetchConductorModels();
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, [fetchConductorModels]);

  const handleSend = useCallback(async () => {
    if (!value.trim() || agentStatus !== "idle" || !activeCanvasId) return;

    const content = value;
    setValue("");
    setShowStream(true);
    setAgentStatus("thinking");

    // Plan 221 Phase 7: forward to the main chat session instead of
    // spawning a separate conductor agent. The main agent (with conductor
    // mode enabled) receives the prompt and uses the canvas tools directly.
    // The legacy `startStream({...})` call is intentionally removed; the
    // composer's stream display will go quiet — agent output now appears in
    // the main chat panel. Canvas state patches still flow back through
    // conductorPort (onStatePatch) for in-canvas updates.
    try {
      if (activeThreadId) {
        await window.electronAPI?.session?.setConductorMode(
          activeThreadId,
          true,
          activeCanvasId,
        );
      }
      window.dispatchEvent(
        new CustomEvent("conductor:forward-message", {
          detail: {
            text: content,
            canvasId: activeCanvasId,
            sessionId: activeThreadId,
            model: conductorModel || undefined,
            visionModel: conductorVisionModel || undefined,
            permissionMode: conductorPermissionMode || undefined,
            source: "conductor-composer",
          },
        }),
      );
    } catch (error) {
      setAgentStatus("error");
      setUiError(
        `Conductor forward failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, [
    activeCanvasId,
    activeThreadId,
    agentStatus,
    conductorModel,
    conductorPermissionMode,
    conductorVisionModel,
    setAgentStatus,
    setUiError,
    value,
  ]);

  const handleStop = useCallback(() => {
    stopStream();
  }, [stopStream]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isStreaming = phase !== 'idle' && phase !== 'completed' && phase !== 'error';

  // Map conductor phase to AgentStreamItem-compatible format for rendering
  const streamItems = events.map((event, index) => mapEventToStreamItem(event, index));

  return (
    <div className="flex-shrink-0 bg-transparent">
      {showStream && streamItems.length > 0 && (
        <div
          ref={streamRef}
          className="max-h-[148px] overflow-y-auto scrollbar-thin px-2.5 py-2 border-b border-[var(--border)]/80 space-y-1.5"
        >
          {streamItems.map((item) => (
            <StreamItem key={item.id} item={item} />
          ))}
          {phase === 'completed' && (
            <div className="flex items-center gap-1.5 text-[10px] text-[var(--muted)]">
              <CheckCircle size={10} className="text-green-500" />
              Complete
            </div>
          )}
          {phase === 'error' && (
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

// Map ConductorEvent to AgentStreamItem-compatible format
function mapEventToStreamItem(event: ConductorEvent, index: number): {
  id: string;
  type: "text" | "thinking" | "tool_use" | "tool_result" | "tool_progress" | "status" | "error";
  content: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  isError?: boolean;
  ts: number;
} {
  switch (event.type) {
    case 'text':
      return { id: `text-${index}`, type: 'text', content: event.content, ts: event.timestamp };
    case 'thinking':
      return { id: `thinking-${index}`, type: 'thinking', content: event.content, ts: event.timestamp };
    case 'tool_use':
      return {
        id: `tool-${index}`,
        type: 'tool_use',
        content: `Calling tool: ${event.toolUse.name}`,
        toolName: event.toolUse.name,
        toolInput: typeof event.toolUse.input === 'string' ? event.toolUse.input : JSON.stringify(event.toolUse.input),
        ts: event.timestamp,
      };
    case 'tool_result':
      return {
        id: `result-${index}`,
        type: 'tool_result',
        content: event.toolResult.is_error ? `❌ Error: ${event.toolResult.content}` : `✅ ${event.toolResult.content}`,
        toolResult: event.toolResult.content,
        isError: event.toolResult.is_error,
        ts: event.timestamp,
      };
    case 'status':
      return { id: `status-${index}`, type: 'status', content: event.status, ts: event.timestamp };
    case 'error':
      return { id: `error-${index}`, type: 'error', content: event.message, isError: true, ts: event.timestamp };
    case 'done':
      return { id: `done-${index}`, type: 'status', content: 'Done', ts: event.timestamp };
  }
}

interface StreamItemProps {
  item: {
    id: string;
    type: "text" | "thinking" | "tool_use" | "tool_result" | "tool_progress" | "status" | "error";
    content: string;
    toolName?: string;
    toolInput?: string;
    toolResult?: string;
    isError?: boolean;
    ts: number;
  };
}

function StreamItem({ item }: StreamItemProps) {
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
