/**
 * Resizing uses a half-grid increment. It gives handles a deliberate,
 * predictable cadence without forcing a final jump when the pointer is
 * released.
 */
export const RESIZE_STEP_GRID = 0.5;

export function quantizeResizeDelta(
  delta: number,
  step: number = RESIZE_STEP_GRID,
): number {
  if (!Number.isFinite(delta) || !Number.isFinite(step) || step <= 0) {
    return 0;
  }
  return Math.round(delta / step) * step;
}
