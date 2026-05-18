/**
 * Conductor - DUYA agent profile for canvas workspace management.
 *
 * Conductor is NOT a separate agent. It is a PROFILE of duyaAgent:
 *   - Uses the existing agent loop (duyaAgent.streamChat)
 *   - Custom system prompt that describes the canvas operations
 *   - <action> tag execution handled on the renderer side via conductor:action IPC
 *
 * The agent-process-entry creates a standard duyaAgent with this profile
 * when the conductor session starts. No custom agent loop.
 */

export interface ConductorSnapshot {
  canvasId: string;
  canvasName: string;
  elements: Array<{
    id: string;
    kind: string;
    position: { x: number; y: number; w: number; h: number };
    vizSpec: Record<string, unknown> | null;
    config: Record<string, unknown>;
  }>;
  actionCursor: number;
}