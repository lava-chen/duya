"use client";

import { useEffect, useRef, useState } from "react";
import { X, SpinnerGap, ArrowsClockwise } from "@phosphor-icons/react";
import { useConductorStore } from "@/stores/conductor-store";
import { useRefineStore } from "@/stores/refine-store";
import { executeAction } from "@/lib/conductor-ipc";
import { captureWidgetEl, type CapturedScreenshot } from "./screenshot";
import { runRefineLoop } from "./loopController";
import { mockRefineLlm } from "./mockLlm";
import { realRefineLlm } from "./realLlm";
import { RefineChatInput } from "./RefineChatInput";
import { RefineIterationList } from "./RefineIterationList";
import { DiffPreview } from "./DiffPreview";
import type { RefineSession } from "./types";

export function RefinePanel() {
  const pendingId = useRefineStore((s) => s.pendingOpenWidgetId);
  const consumePending = useRefineStore((s) => s.consumePendingOpenWidgetId);
  const getCaptureTarget = useRefineStore((s) => s.getCaptureTarget);
  const session = useRefineStore((s) => s.activeSession);
  const setSession = useRefineStore((s) => s.setSession);
  const patchSession = useRefineStore((s) => s.patchSession);
  const closePanel = useRefineStore((s) => s.closeRefinePanel);

  const widgets = useConductorStore((s) => s.widgets);
  const activeCanvasId = useConductorStore((s) => s.activeCanvasId);
  const updateWidget = useConductorStore((s) => s.updateWidget);
  const undo = useConductorStore((s) => s.undo);
  const canUndo = useConductorStore((s) => s.canUndo);

  const [initialShot, setInitialShot] = useState<CapturedScreenshot | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [initBusy, setInitBusy] = useState(false);
  const [useRealLlm, setUseRealLlm] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const [openWidgetId, setOpenWidgetId] = useState<string | null>(null);

  // Open panel when user clicks Refine button.
  useEffect(() => {
    if (pendingId) {
      const id = consumePending();
      if (id) {
        setOpenWidgetId(id);
        setSession(null);
      }
    }
  }, [pendingId, consumePending, setSession]);

  // Initial screenshot when widget opens.
  useEffect(() => {
    if (!openWidgetId) return;
    setInitialShot(null);
    setInitError(null);
    setInitBusy(true);
    captureById(openWidgetId)
      .then(setInitialShot)
      .catch((err) =>
        setInitError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setInitBusy(false));
  }, [openWidgetId]);

  const widget = openWidgetId
    ? widgets.find((w) => w.id === openWidgetId)
    : null;

  const running = session?.status === "running";

  const handleSend = async (userRequest: string) => {
    if (!widget || !activeCanvasId) return;

    const newSession: RefineSession = {
      sessionId: crypto.randomUUID(),
      widgetId: widget.id,
      canvasId: activeCanvasId,
      widgetType: widget.type,
      startedAt: Date.now(),
      status: "running",
      iterations: session?.iterations ?? [],
      maxIterations: 8,
    };
    // Append a placeholder iteration that carries the user request.
    newSession.iterations = [
      ...newSession.iterations,
      {
        index: newSession.iterations.length + 1,
        userRequest,
        screenshotBase64: "",
        llmResponse: null,
        appliedAt: null,
        diffSummary: "queued",
      },
    ];
    setSession(newSession);

    const ac = new AbortController();
    abortRef.current = ac;

    await runRefineLoop({
      session: newSession,
      widget,
      getCaptureEl: () => getCaptureTarget(widget.id),
      captureScreenshot: captureWidgetEl,
      applyData: async (data) => {
        await executeAction({
          action: "widget.update_data",
          widgetId: widget.id,
          canvasId: activeCanvasId,
          data,
          clientTs: Date.now(),
        });
        updateWidget(widget.id, { data });
      },
      callLlm: async (args) => {
        if (useRealLlm) {
          return realRefineLlm({ ...args, widgetId: widget.id });
        }
        return mockRefineLlm({ ...args, userRequest });
      },
      patchSession: (patch) => {
        // Read latest session from store to avoid stale closure.
        const latest =
          useRefineStore.getState().activeSession ?? newSession;
        useRefineStore.setState({
          activeSession: { ...latest, ...patch },
        });
      },
      signal: ac.signal,
    });
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleClose = () => {
    abortRef.current?.abort();
    setOpenWidgetId(null);
    closePanel();
  };

  if (!openWidgetId) return null;

  const beforeData = widget?.data ?? null;
  const afterData =
    session?.iterations.at(-1)?.llmResponse?.data ?? null;

  return (
    <div
      data-testid="refine-panel"
      className="fixed top-12 right-4 z-40 w-[420px] max-h-[calc(100vh-6rem)] rounded-xl border border-[var(--border)] bg-[var(--main-bg)] shadow-xl flex flex-col overflow-hidden"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border)] bg-[var(--surface)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium text-[var(--text)]">
            Refine · {widget?.type ?? "widget"}
          </span>
          {widget && (
            <span className="text-[10px] text-[var(--muted)]">
              id={widget.id.slice(0, 6)}
            </span>
          )}
          {session && (
            <span
              data-testid="refine-status"
              className="text-[10px] uppercase tracking-wide"
              style={{
                color:
                  session.status === "error"
                    ? "var(--error)"
                    : session.status === "running"
                      ? "var(--accent)"
                      : "var(--muted)",
              }}
            >
              {session.status}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="refine-panel-close"
          onClick={handleClose}
          className="flex items-center justify-center w-6 h-6 rounded-md text-[var(--muted)] hover:bg-[var(--surface-hover)] transition-colors"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
        <div className="text-[10px] text-[var(--muted)]">
          Canvas: {activeCanvasId?.slice(0, 8) ?? "(none)"}
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">
              Current screenshot
            </span>
            <button
              type="button"
              data-testid="refine-recapture"
              onClick={() => {
                if (!openWidgetId) return;
                setInitialShot(null);
                setInitError(null);
                setInitBusy(true);
                captureById(openWidgetId)
                  .then(setInitialShot)
                  .catch((err) =>
                    setInitError(
                      err instanceof Error ? err.message : String(err),
                    ),
                  )
                  .finally(() => setInitBusy(false));
              }}
              disabled={initBusy}
              className="flex items-center gap-1 text-[10px] text-[var(--muted)] hover:text-[var(--accent)] disabled:opacity-50"
            >
              <ArrowsClockwise size={10} />
              Recapture
            </button>
          </div>

          <div
            data-testid="refine-screenshot-frame"
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 flex items-center justify-center min-h-[120px]"
          >
            {initBusy && !initialShot && (
              <div className="flex items-center gap-2 text-[10px] text-[var(--muted)]">
                <SpinnerGap size={11} className="animate-spin" />
                Capturing…
              </div>
            )}
            {initError && (
              <div
                className="text-[10px] text-[var(--error)]"
                data-testid="refine-screenshot-error"
              >
                {initError}
              </div>
            )}
            {initialShot && (
              <img
                data-testid="refine-screenshot-img"
                src={`data:image/png;base64,${initialShot.pngBase64}`}
                alt="widget screenshot"
                style={{ maxWidth: "100%", height: "auto" }}
              />
            )}
          </div>

          {initialShot && (
            <div
              data-testid="refine-screenshot-meta"
              className="text-[10px] text-[var(--muted)] flex gap-3"
            >
              <span>w={initialShot.width}</span>
              <span>h={initialShot.height}</span>
              <span>dpr={initialShot.pixelRatio}</span>
            </div>
          )}
        </div>

        {session && session.iterations.length > 0 && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">
              Iterations ({session.iterations.length}/{session.maxIterations})
            </span>
            <RefineIterationList iterations={session.iterations} />
          </div>
        )}

        {beforeData && afterData && (
          <div className="space-y-1.5">
            <span className="text-[10px] text-[var(--muted)] uppercase tracking-wide">
              Diff
            </span>
            <DiffPreview before={beforeData} after={afterData} />
          </div>
        )}

        {session?.status === "error" && session.errorMessage && (
          <div
            data-testid="refine-error"
            className="text-[10px] text-[var(--error)] border border-[var(--error)] rounded-md p-2"
          >
            {session.errorMessage}
          </div>
        )}
      </div>

      <div className="border-t border-[var(--border)] px-3 py-1.5 flex items-center justify-between text-[10px] text-[var(--muted)]">
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            data-testid="refine-use-real-llm"
            checked={useRealLlm}
            onChange={(e) => setUseRealLlm(e.target.checked)}
            disabled={running}
            className="accent-[var(--accent)]"
          />
          Use real LLM (conductor-refine profile)
        </label>
        <button
          type="button"
          data-testid="refine-undo-last"
          onClick={() => {
            undo().catch(() => {});
          }}
          disabled={!canUndo || running}
          className="flex items-center gap-1 text-[var(--muted)] hover:text-[var(--accent)] disabled:opacity-30"
          title="Revert last refine iteration"
        >
          <ArrowsClockwise size={10} />
          Undo last iter
        </button>
      </div>

      <RefineChatInput
        disabled={running}
        running={running}
        onSend={handleSend}
        onStop={handleStop}
      />
    </div>
  );

  async function captureById(id: string): Promise<CapturedScreenshot> {
    const el = getCaptureTarget(id);
    if (!el) {
      throw new Error(
        `Widget DOM not registered for capture (id=${id}).`,
      );
    }
    return captureWidgetEl(el);
  }
}