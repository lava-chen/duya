/**
 * Perception engine — captures canvas semantic events (drag, element
 * create/update/delete, etc.) and surfaces them as LLM-readable context.
 *
 * The renderer (or any conductor-aware host) calls `pushEvent` whenever
 * the user does something meaningful on the canvas. The agent subprocess
 * (or a CLI harness) reads `formatEventsAsContext()` after each turn
 * to inject the pending events into the next prompt.
 *
 * Singleton lifecycle: `getPerceptionEngine()` returns a process-wide
 * instance. `resetPerceptionEngine()` clears it (used in tests).
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

  /** Format events as LLM-readable text for system prompt injection */
  formatEventsAsContext(): string | null {
    const events = this.recentEvents;
    if (events.length === 0) return null;

    const lines = events.map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      const desc = e.description || `${e.type} on ${e.elementId || e.widgetId || 'canvas'}`;
      return `[${time}] ${desc}`;
    });

    return `## Canvas Changes Since Last Message\n${lines.join('\n')}`;
  }

  /** Return true if there are unread events */
  hasUnreadEvents(): boolean {
    return this.recentEvents.length > 0;
  }

  /** Drain and return all events (mark them as read) */
  drainEvents(): SemanticEvent[] {
    const events = [...this.recentEvents];
    this.recentEvents = [];
    return events;
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
