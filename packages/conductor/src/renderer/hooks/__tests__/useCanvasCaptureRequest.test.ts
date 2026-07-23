// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForCanvasViewport } from "../useCanvasCaptureRequest";

/**
 * Tests for the viewport-ready gate inside useCanvasCaptureRequest.
 *
 * The gate's job is to block canvas_capture until `.canvas-area` and
 * `.canvas-inner` are both present in the DOM AND React has flushed its
 * first paint. Without it, capture fires while the StartupLanding
 * loading overlay is still on top and the resulting PNG is the splash
 * screen, not the canvas — silently invalidating agent visual verification.
 */

function mountCanvasDom(opts: { withCanvasInner?: boolean } = {}): HTMLElement {
  document.body.innerHTML = "";
  const area = document.createElement("div");
  area.className = "canvas-area conductor-canvas-surface";
  if (opts.withCanvasInner !== false) {
    const inner = document.createElement("div");
    inner.className = "canvas-inner";
    area.appendChild(inner);
  }
  document.body.appendChild(area);
  return area;
}

describe("waitForCanvasViewport", () => {
  beforeEach(() => {
    // In jsdom requestAnimationFrame exists but never fires, so the gate
    // would hang forever on its post-ready rAF waits. Substitute a
    // microtask-immediate equivalent so tests finish promptly.
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        queueMicrotask(() => cb(performance.now()));
        return 1;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("resolves once .canvas-area and .canvas-inner are both present", async () => {
    // Defer mounting the DOM until after the first poll so the gate
    // exercises the wait branch, not the immediate-resolve branch.
    const area = document.createElement("div");
    area.className = "canvas-area";

    setTimeout(() => {
      const inner = document.createElement("div");
      inner.className = "canvas-inner";
      area.appendChild(inner);
      document.body.appendChild(area);
    }, 80);

    await expect(waitForCanvasViewport("req-1")).resolves.toBeUndefined();
  });

  it("throws a clear error when the viewport never mounts", async () => {
    // Keep the test snappy by reaching into the implementation's
    // timeout via fake timers.
    vi.useFakeTimers();
    try {
      const promise = waitForCanvasViewport("req-timeout");
      const expectation = expect(promise).rejects.toThrow(
        /Canvas viewport never became ready within \d+ms \(requestId=req-timeout\)/,
      );
      await vi.advanceTimersByTimeAsync(5000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats an empty .canvas-inner as legitimate, not as 'not ready'", async () => {
    // A canvas with no elements is a valid capture target — the gate
    // must not block it just because .canvas-inner has no children.
    mountCanvasDom({ withCanvasInner: true });
    await expect(waitForCanvasViewport()).resolves.toBeUndefined();
  });
});