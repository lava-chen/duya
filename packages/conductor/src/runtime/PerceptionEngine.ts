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
  | 'canvas_renamed'
  | 'undo'
  | 'redo'
  | 'capture_requested';

export interface SemanticEvent {
  type: SemanticEventType;
  canvasId: string;
  widgetId?: string;
  elementId?: string;
  elementKind?: string;
  data?: Record<string, unknown>;
  description?: string;
  /** Before-state for update/move events (enables delta descriptions). */
  before?: Record<string, unknown>;
  /** After-state for update/move events. */
  after?: Record<string, unknown>;
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
  private lastReadTs = 0;

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

  /**
   * Format events as LLM-readable text for system prompt injection.
   *
   * Produces rich, context-aware descriptions:
   * - For element_created: includes kind and position
   * - For element_moved: includes position delta (dx, dy)
   * - For element_updated: includes changed fields
   * - For element_deleted: includes kind
   */
  formatEventsAsContext(): string | null {
    const events = this.recentEvents.filter((e) => e.ts > this.lastReadTs);
    if (events.length === 0) return null;

    const lines = events.map((e) => {
      const time = new Date(e.ts).toLocaleTimeString();
      const desc = e.description || this.formatEventDescription(e);
      return `[${time}] ${desc}`;
    });

    this.lastReadTs = events[events.length - 1].ts;

    return `## Canvas Changes Since Last Message\n${lines.join('\n')}`;
  }

  private formatEventDescription(e: SemanticEvent): string {
    const target = e.elementId || e.widgetId || 'canvas';
    const kind = e.elementKind ? ` (${e.elementKind})` : '';

    switch (e.type) {
      case 'element_created':
        return `Created ${target}${kind}`;
      case 'element_deleted':
        return `Deleted ${target}${kind}`;
      case 'element_moved': {
        const before = e.before as { x?: number; y?: number } | undefined;
        const after = e.after as { x?: number; y?: number } | undefined;
        if (before && after && before.x !== undefined && after.x !== undefined &&
            before.y !== undefined && after.y !== undefined) {
          const dx = Math.round((after.x as number) - (before.x as number));
          const dy = Math.round((after.y as number) - (before.y as number));
          return `Moved ${target}${kind} by (${dx}, ${dy})`;
        }
        return `Moved ${target}${kind}`;
      }
      case 'element_updated': {
        const before = e.before ?? {};
        const after = e.after ?? {};
        const changedKeys = Object.keys(after).filter(
          (k) => !Object.keys(before).includes(k) || before[k] !== after[k],
        );
        if (changedKeys.length > 0) {
          return `Updated ${target}${kind}: ${changedKeys.join(', ')}`;
        }
        return `Updated ${target}${kind}`;
      }
      case 'undo':
        return `Undo on ${target}`;
      case 'redo':
        return `Redo on ${target}`;
      case 'capture_requested':
        return `Screenshot captured for ${target}`;
      default:
        return `${e.type} on ${target}`;
    }
  }

  /** Return true if there are unread events */
  hasUnreadEvents(): boolean {
    return this.recentEvents.some((e) => e.ts > this.lastReadTs);
  }

  /** Drain and return all events (mark them as read) */
  drainEvents(): SemanticEvent[] {
    const events = [...this.recentEvents];
    this.recentEvents = [];
    this.lastReadTs = 0;
    return events;
  }

  clear(): void {
    this.recentEvents = [];
    this.pendingEvent = null;
    this.lastReadTs = 0;
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
