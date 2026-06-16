/**
 * Conductor profile types — shared between the host, the IPC payloads, and
 * the agent subprocess.
 *
 * Keep this file purely declarative. No runtime imports from `@duya/agent`
 * should leak in here.
 */

export interface ConductorSnapshot {
  canvasId: string;
  canvasName: string;
  elements: ConductorElement[];
  widgets?: ConductorWidget[];
  meta?: Record<string, unknown>;
}

export interface ConductorElement {
  id: string;
  kind: string;
  position: { x: number; y: number; w: number; h: number };
  config: Record<string, unknown>;
  vizSpec?: Record<string, unknown> | null;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface ConductorWidget {
  id: string;
  kind: string;
  position: { x: number; y: number };
  size?: { w: number; h: number };
  config?: Record<string, unknown>;
  permissions?: ConductorWidgetPermissions;
}

export interface ConductorWidgetPermissions {
  canEdit?: boolean;
  canDelete?: boolean;
  canResize?: boolean;
  canMove?: boolean;
}

/**
 * Snapshot pushed into the prompt via {@link setConductorCanvasState}.
 *
 * This is a smaller view of {@link ConductorSnapshot} that only carries
 * the fields the canvas prompt section needs to render. The conductor
 * tool executors fetch the full snapshot via the IPC bridge when they
 * need more.
 */
export interface ConductorCanvasSnapshot {
  canvasId: string;
  canvasName: string;
  elements: Array<{
    id: string;
    kind: string;
    vizSpec: Record<string, unknown> | null;
    position: { x: number; y: number; w: number; h: number };
    config: Record<string, unknown>;
  }>;
}
