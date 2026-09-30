# Plan 439: `canvas_capture` region takes canvas coordinates with auto-framing

> **Goal**: Make `canvas_capture` `scope:'region'` use the SAME coordinate
> system agents draw with (canvas grid units), and let the renderer frame
> any requested area automatically — instead of requiring the agent to pan
> the area into the visible viewport first.

---

## Context

User feedback (2026-08-23): the capture tool should accept parameters so
the agent can screenshot the region it wants, "范围还有尺寸衡量都应该和绘
图的是一样的" — same range, same units as drawing. An element placed at
grid (26, 22) must be capturable by specifying exactly that place.

Plan 239 deliberately redefined `region` as **viewport screen pixels**
("make region explicitly viewport-pixel coordinates") to fix an earlier
contract mismatch without touching the renderer. That decision aged badly:

- The agent still thinks in element coordinates; forcing it to convert to
  viewport px (which depend on live pan/zoom it cannot observe) made the
  tool unusable for off-screen verification.
- Anything outside the current viewport was simply uncapturable.
- html2canvas crops in absolute client coordinates (`ctx.translate(-x,-y)`
  after clone); passing viewport-relative offsets was also a latent offset
  bug whenever `.canvas-area` did not sit at the client origin.

## Design

- **Contract**: `region {x,y,w,h}` is expressed in canvas GRID units by
  default — identical to `canvas_create_element` `position`. Optional
  `unit:'px'` escapes to raw canvas pixels for callers that already
  converted (connector waypoints are documented in px).
- **Auto-framing**: if the projected rect is not fully visible, the
  renderer temporarily applies a fit transform to `.canvas-inner`
  (translate+scale, zoom only shrinks, floor 0.2 mirroring CanvasArea's
  MIN_ZOOM), waits 2 rAFs, captures, restores the previous transform in a
  `finally`.
- **Serialization**: captures run through a module-level promise queue —
  concurrent requests must not photograph each other's intermediate
  framing.
- **element scope** gets the same treatment: its DOM rect is inverse-mapped
  into canvas space through the live `canvasTransformState`, so off-screen
  elements are capturable too.
- **html2canvas options fixed**: explicit `x/y` are absolute client coords
  (`viewportRect.left/top + screen offset`); `windowWidth/windowHeight`
  now mirror the real window so the clone's layout matches what was
  measured (previously sized to the crop, which reflowed percentage-based
  layouts).

## Files

- [packages/conductor/src/renderer/refine/region-fit.ts](../../../packages/conductor/src/renderer/refine/region-fit.ts) **NEW** — pure math: grid→px conversion, affine screen mapping + inverse, visibility check, viewport clipping, fit-transform computation. Unit-tested without DOM.
- [packages/conductor/src/renderer/refine/screenshot.ts](../../../packages/conductor/src/renderer/refine/screenshot.ts) — rewrite of `captureCanvasView`: queued wrapper, per-scope crop planning via `frameOnScreen`, temp-transform apply/restore, absolute client crop coords, real-window clone size.
- [packages/conductor/src/renderer/domain/canvas/transform-state.ts](../../../packages/conductor/src/renderer/domain/canvas/transform-state.ts) **NEW** — `canvasTransformState` moved out of CanvasArea.tsx into the domain layer so renderer utilities can read the live view transform without importing the component tree. CanvasArea re-exports for backward compatibility (ElementChrome / FiniteCanvasArea / NativeConnectorOverlay / WidgetLayer keep importing from `./CanvasArea`).
- [packages/agent/src/tool/CanvasConductor/CanvasCaptureTool.ts](../../../packages/agent/src/tool/CanvasConductor/CanvasCaptureTool.ts) — schema: `region` described as canvas grid coords (+`unit` enum), stale "pan into view first" guidance removed, auto-framing behavior and clamp semantics documented.
- Tests: [region-fit.test.ts](../../../packages/conductor/src/renderer/refine/__tests__/region-fit.test.ts) **NEW** (13 cases).

Out of scope: widget/PDF iframe content still renders blank inside
html2canvas (library limitation, unchanged by this plan).

## Status

- [x] region-fit.ts + unit tests (13)
- [x] screenshot.ts rewrite (queue, framing, restore-on-finally, client-coord fix)
- [x] transform-state extraction (no component-tree import from refine/)
- [x] CanvasCaptureTool schema/description rewrite
- [x] `npm run typecheck:all`
- [x] vitest: conductor renderer suites + electron conductor executor-proxy (156 passed total)
- [ ] Playwright/Electron manual verification: place an element far outside
      the viewport, `canvas_capture({scope:'region', region:{x,y,w,h}})`,
      confirm the returned image shows that exact area and the user's view
      is restored afterwards. Deferred — needs a real Electron renderer
      (same deferral rationale as plan 239 item 8).
