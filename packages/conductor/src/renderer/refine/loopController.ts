/**
 * Iteration loop for the side-panel refine agent.
 *
 * Phase 2 — Mock LLM only. Captures the widget, asks the mock for a new
 * `data` object, applies it via `widget.update_data`, re-screenshots,
 * repeats until `done` or iteration cap.
 *
 * Phase 3 will swap `mockRefineLlm` for a real `ConductorRefineProfile` call
 * via `window.api.refine.start`.
 */

import { executeAction } from "..//ipc/conductor-ipc";
import type { RefineIteration, RefineLlmResponse, RefineSession } from "./types";
import type { ConductorWidget } from "..//types/conductor";

export interface RunLoopOptions {
  session: RefineSession;
  widget: ConductorWidget;
  getCaptureEl: () => HTMLElement | undefined;
  captureScreenshot: (el: HTMLElement) => Promise<{ pngBase64: string; width: number; height: number; pixelRatio: number }>;
  applyData: (data: Record<string, unknown>) => Promise<void>;
  patchSession: (patch: Partial<RefineSession>) => void;
  callLlm: (args: {
    userRequest: string;
    widgetType: string;
    currentData: Record<string, unknown>;
    iteration: number;
    maxIterations: number;
    screenshotBase64: string;
  }) => Promise<RefineLlmResponse>;
  signal?: AbortSignal;
}

export async function runRefineLoop(opts: RunLoopOptions): Promise<void> {
  const { session, widget, getCaptureEl, captureScreenshot, applyData, patchSession, callLlm, signal } = opts;

  let currentData: Record<string, unknown> = { ...widget.data };
  let consecutiveFailures = 0;
  let lastUserRequest = session.iterations.at(-1)?.userRequest ?? "";

  for (let iter = session.iterations.length; iter < session.maxIterations; iter++) {
    if (signal?.aborted) {
      patchSession({ status: "stopped" });
      return;
    }

    const el = getCaptureEl();
    if (!el) {
      patchSession({
        status: "error",
        errorMessage: `Widget DOM not registered for capture (id=${widget.id}).`,
      });
      return;
    }

    let screenshot;
    try {
      screenshot = await captureScreenshot(el);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patchSession({ status: "error", errorMessage: `Capture failed: ${msg}` });
      return;
    }

    patchSession({ status: "running" });

    let response: RefineLlmResponse;
    try {
      response = await callLlm({
        userRequest: lastUserRequest,
        widgetType: widget.type,
        currentData,
        iteration: iter + 1,
        maxIterations: session.maxIterations,
        screenshotBase64: screenshot.pngBase64,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const iteration: RefineIteration = {
        index: iter + 1,
        userRequest: lastUserRequest,
        screenshotBase64: screenshot.pngBase64,
        llmResponse: null,
        appliedAt: null,
        diffSummary: "",
        errorMessage: msg,
      };
      patchSession({
        iterations: [...session.iterations, iteration],
      });
      consecutiveFailures += 1;
      if (consecutiveFailures >= 2) {
        patchSession({ status: "error", errorMessage: `LLM failed twice: ${msg}` });
        return;
      }
      continue;
    }

    consecutiveFailures = 0;

    const iteration: RefineIteration = {
      index: iter + 1,
      userRequest: lastUserRequest,
      screenshotBase64: screenshot.pngBase64,
      llmResponse: response,
      appliedAt: null,
      diffSummary: summarizeDiff(currentData, response.data),
    };

    try {
      await applyData(response.data);
      currentData = { ...response.data };
      iteration.appliedAt = Date.now();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      iteration.errorMessage = `Apply failed: ${msg}`;
      patchSession({
        iterations: [...session.iterations, iteration],
        status: "error",
        errorMessage: msg,
      });
      return;
    }

    patchSession({
      iterations: [...session.iterations, iteration],
    });

    if (response.done) {
      patchSession({ status: "done" });
      return;
    }
  }

  patchSession({ status: "done", errorMessage: "Iteration cap reached." });
}

function summarizeDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      changes.push(k);
    }
  }
  if (changes.length === 0) return "no changes";
  if (changes.length <= 3) return `changed: ${changes.join(", ")}`;
  return `changed ${changes.length} keys (${changes.slice(0, 3).join(", ")}, …)`;
}