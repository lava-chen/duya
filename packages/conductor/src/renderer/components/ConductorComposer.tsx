"use client";

import { useCallback, useEffect, useState } from "react";
import { PaperPlaneTiltIcon, SpinnerGapIcon } from "@/components/icons";
import { useConversationStore } from "@/stores/conversation-store";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useConductorStore } from "..//stores/conductor-store";

/**
 * Canvas-local composer that forwards requests to the active main chat.
 * The main Agent owns streaming and tool execution; this component only binds
 * the current canvas and emits the shared forward-message event.
 */
export function ConductorComposer() {
  const [value, setValue] = useState("");
  const [isForwarding, setIsForwarding] = useState(false);
  const {
    activeCanvasId,
    conductorModels,
    conductorModel,
    conductorModelsLoading,
    fetchConductorModels,
    setConductorModel,
    setUiError,
    conductorVisionModel,
    conductorPermissionMode,
  } = useConductorStore();
  const activeThreadId = useConversationStore((state) => state.activeThreadId);

  useEffect(() => {
    fetchConductorModels();
    const handleFocus = () => fetchConductorModels();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [fetchConductorModels]);

  const handleSend = useCallback(async () => {
    const content = value.trim();
    if (!content || !activeCanvasId || !activeThreadId || isForwarding) return;

    setValue("");
    setIsForwarding(true);
    try {
      await window.electronAPI?.session?.setConductorMode(
        activeThreadId,
        true,
        activeCanvasId,
      );
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
      setValue(content);
      setUiError(
        `Conductor forward failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setIsForwarding(false);
    }
  }, [
    activeCanvasId,
    activeThreadId,
    conductorModel,
    conductorPermissionMode,
    conductorVisionModel,
    isForwarding,
    setUiError,
    value,
  ]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  };

  const canSend = Boolean(value.trim() && activeCanvasId && activeThreadId && !isForwarding);

  return (
    <div className="flex-shrink-0 bg-transparent">
      <div className="flex items-center gap-2 bg-[var(--main-bg)] rounded-lg px-3 h-10">
        {isForwarding && (
          <SpinnerGapIcon size={14} className="animate-spin text-[var(--muted)] flex-shrink-0" />
        )}
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
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
              disabled={isForwarding}
              loading={conductorModelsLoading}
              variant="compact"
            />
          </div>
        )}
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={!canSend}
          className="flex items-center justify-center w-7 h-7 rounded-full bg-[var(--send-btn)] text-white hover:bg-[var(--send-btn-hover)] transition-colors disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
        >
          <PaperPlaneTiltIcon size={14} />
        </button>
      </div>
    </div>
  );
}
