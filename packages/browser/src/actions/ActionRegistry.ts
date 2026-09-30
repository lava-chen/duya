import type { ActionHandler, ActionContext } from './types.js';

export class ActionRegistry {
  private handlers = new Map<string, ActionHandler>();

  register(handler: ActionHandler): void {
    this.handlers.set(handler.operation, handler);
  }

  registerAll(handlers: ActionHandler[]): void {
    for (const h of handlers) {
      this.register(h);
    }
  }

  get(operation: string): ActionHandler | undefined {
    return this.handlers.get(operation);
  }

  get operations(): string[] {
    return Array.from(this.handlers.keys());
  }

  get all(): ActionHandler[] {
    return Array.from(this.handlers.values());
  }

  async execute(
    operation: string,
    input: unknown,
    ctx: ActionContext
  ): Promise<Record<string, unknown>> {
    const handler = this.handlers.get(operation);
    if (!handler) {
      throw new Error(`Unknown operation: ${operation}`);
    }

    const parseResult = handler.schema.safeParse(input);
    if (!parseResult.success) {
      throw new Error(`Invalid input for ${operation}: ${parseResult.error.message}`);
    }

    return handler.execute(parseResult.data, ctx);
  }
}
