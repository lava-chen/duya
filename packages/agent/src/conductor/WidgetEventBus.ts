export type WidgetEventHandler = (payload: Record<string, unknown>) => void;

export interface WidgetEvent {
  sourceWidgetId: string;
  targetWidgetId: string;
  eventType: string;
  data: Record<string, unknown>;
  ts: number;
}

export class WidgetEventBus {
  private handlers = new Map<string, Set<WidgetEventHandler>>();
  private eventLog: WidgetEvent[] = [];
  private maxLogSize: number;

  constructor(maxLogSize = 100) {
    this.maxLogSize = maxLogSize;
  }

  subscribe(eventPattern: string, handler: WidgetEventHandler): () => void {
    let handlers = this.handlers.get(eventPattern);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventPattern, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  emit(event: WidgetEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }

    for (const [pattern, handlers] of this.handlers) {
      if (this.matchPattern(pattern, event)) {
        for (const handler of handlers) {
          try {
            handler({
              sourceWidgetId: event.sourceWidgetId,
              targetWidgetId: event.targetWidgetId,
              eventType: event.eventType,
              data: event.data,
              ts: event.ts,
            });
          } catch {}
        }
      }
    }
  }

  private matchPattern(pattern: string, event: WidgetEvent): boolean {
    const parts = pattern.split(':');
    if (parts.length < 2) return false;

    const [srcPattern, eventPattern] = parts;

    const srcMatch = srcPattern === '*' || srcPattern === event.sourceWidgetId;
    const eventMatch = eventPattern === '*' || eventPattern === event.eventType;

    return srcMatch && eventMatch;
  }

  notifyTaskCompleted(taskListWidgetId: string, pomodoroWidgetId: string, taskData: Record<string, unknown>): void {
    this.emit({
      sourceWidgetId: taskListWidgetId,
      targetWidgetId: pomodoroWidgetId,
      eventType: 'task_completed',
      data: taskData,
      ts: Date.now(),
    });
  }

  notifyPomodoroComplete(pomodoroWidgetId: string, taskListWidgetId: string, sessionData: Record<string, unknown>): void {
    this.emit({
      sourceWidgetId: pomodoroWidgetId,
      targetWidgetId: taskListWidgetId,
      eventType: 'session_completed',
      data: sessionData,
      ts: Date.now(),
    });
  }

  getRecentEvents(count = 20): WidgetEvent[] {
    return this.eventLog.slice(-count);
  }

  clear(): void {
    this.eventLog = [];
    this.handlers.clear();
  }
}

let eventBusInstance: WidgetEventBus | null = null;

export function getWidgetEventBus(): WidgetEventBus {
  if (!eventBusInstance) {
    eventBusInstance = new WidgetEventBus();
  }
  return eventBusInstance;
}

export function resetWidgetEventBus(): void {
  eventBusInstance?.clear();
  eventBusInstance = null;
}
