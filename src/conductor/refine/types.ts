/**
 * Refine session types — shared by renderer (RefinePanel, loopController)
 * and the IPC + agent payloads.
 *
 * The session is renderer-side state. Persistence happens via a single
 * `conductor_actions` row written when the session ends (Phase 5).
 */

export interface RefineLlmResponse {
  done: boolean;
  rationale: string;
  data: Record<string, unknown>;
  warnings: string[];
}

export interface RefineIteration {
  index: number;
  userRequest: string;
  screenshotBase64: string;
  llmResponse: RefineLlmResponse | null;
  appliedAt: number | null;
  diffSummary: string;
  errorMessage?: string;
}

export type RefineSessionStatus =
  | "idle"
  | "running"
  | "stopped"
  | "done"
  | "error";

export interface RefineSession {
  sessionId: string;
  widgetId: string;
  canvasId: string;
  widgetType: string;
  startedAt: number;
  status: RefineSessionStatus;
  iterations: RefineIteration[];
  errorMessage?: string;
  maxIterations: number;
}