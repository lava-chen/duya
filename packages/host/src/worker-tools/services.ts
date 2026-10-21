import type { Tool } from '../worker-run-contracts.js';
import type { ToolExecutor } from '../worker-tool-registry.js';
/** The outer composition supplies CLI command dispatch without a Host-to-CLI edge. */
export interface BuiltinRegistryServices {
  duyaCliTool: ToolExecutor & { toTool(): Tool };
}
