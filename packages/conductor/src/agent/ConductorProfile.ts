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
