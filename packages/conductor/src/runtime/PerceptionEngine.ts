/**
 * @deprecated Placeholder. Real implementation moved in Phase 5.
 */
export type SemanticEventType =
  | 'widget_added'
  | 'widget_removed'
  | 'layout_changed'
  | 'data_updated'
  | 'timer_completed'
  | 'task_completed'
  | 'element_created'
  | 'element_updated'
  | 'element_deleted'
  | 'element_moved'
  | 'canvas_renamed';

export interface SemanticEvent {
  type: SemanticEventType;
  canvasId: string;
  widgetId?: string;
  elementId?: string;
  data?: Record<string, unknown>;
  description?: string;
  ts: number;
}

export interface PerceptionConfig {
  debounceMs: number;
  maxEventsPerLoop: number;
  ignoreDuringDrag: boolean;
}

export class PerceptionEngine {
  formatEventsAsContext(): string | null {
    return null;
  }
  drainEvents(): void {
    /* noop */
  }
}

let engine: PerceptionEngine | null = null;
export function getPerceptionEngine(): PerceptionEngine {
  if (!engine) engine = new PerceptionEngine();
  return engine;
}
export function resetPerceptionEngine(): void {
  engine = null;
}
