import type { ToolRegistry, ToolExecutor } from '../registry.js';
import type { Tool } from '../../types.js';
import { getCanvasConductorTools } from '@duya/capabilities/canvas';

export * from '@duya/capabilities/canvas';

/** Compatibility wrapper while registry ownership moves out of Agent. */
export function registerCanvasConductorTools(registry: ToolRegistry): void {
  registry.registerAll(getCanvasConductorTools().map(({ definition, executor }) => ({
    definition: definition as Tool,
    executor: executor as unknown as ToolExecutor,
  })));
}