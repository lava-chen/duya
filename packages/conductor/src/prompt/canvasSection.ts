/**
 * @deprecated Placeholder. Real implementation moved in Phase 3.
 */
import type { ConductorCanvasSnapshot } from '../profile/types.js';

let currentSnapshot: ConductorCanvasSnapshot | null = null;

export function setConductorCanvasState(snapshot: ConductorCanvasSnapshot | null): void {
  currentSnapshot = snapshot;
}

export function buildConductorCanvasSection(): string | null {
  return null;
}

export function _getCurrentSnapshot(): ConductorCanvasSnapshot | null {
  return currentSnapshot;
}
