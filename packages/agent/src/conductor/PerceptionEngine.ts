export type SemanticEventType =
  | 'widget_added'
  | 'widget_removed'
  | 'layout_changed'
  | 'data_updated'
  | 'timer_completed'
  | 'task_completed';

export interface SemanticEvent {
  type: SemanticEventType;
  canvasId: string;
  widgetId?: string;
  data?: Record<string, unknown>;
  ts: number;
}

export interface PerceptionConfig {
  debounceMs: number;
  maxEventsPerLoop: number;
  ignoreDuringDrag: boolean;
}

const DEFAULT_CONFIG: PerceptionConfig = {
  debounceMs: 800,
  maxEventsPerLoop: 20,
  ignoreDuringDrag: true,
};

export class PerceptionEngine {
  private recentEvents: SemanticEvent[] = [];
  private pendingEvent: SemanticEvent | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private isDragging = false;
  private config: PerceptionConfig;

  constructor(config: Partial<PerceptionConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setDragging(dragging: boolean): void {
    this.isDragging = dragging;
  }

  pushEvent(event: SemanticEvent): void {
    if (this.config.ignoreDuringDrag && this.isDragging) {
      return;
    }

    this.pendingEvent = event;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      if (this.pendingEvent) {
        this.recentEvents.push(this.pendingEvent);
        this.pendingEvent = null;

        if (this.recentEvents.length > this.config.maxEventsPerLoop) {
          this.recentEvents = this.recentEvents.slice(-this.config.maxEventsPerLoop);
        }
      }
    }, this.config.debounceMs);
  }

  getRecentEvents(since?: number): SemanticEvent[] {
    if (since === undefined) {
      return [...this.recentEvents];
    }
    return this.recentEvents.filter((e) => e.ts > since);
  }

  clear(): void {
    this.recentEvents = [];
    this.pendingEvent = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}

let perceptionInstance: PerceptionEngine | null = null;

export function getPerceptionEngine(): PerceptionEngine {
  if (!perceptionInstance) {
    perceptionInstance = new PerceptionEngine();
  }
  return perceptionInstance;
}

export function resetPerceptionEngine(): void {
  perceptionInstance?.clear();
  perceptionInstance = null;
}
