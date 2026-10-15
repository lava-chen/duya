/**
 * Compatibility re-export for callers of the pre-migration contract path.
 *
 * The canonical catalog types and behavior live in
 * `@duya/agent-runtime/tools/catalog`. Agent specializes the generic executor
 * and registry contracts while its remaining product adapters still use them.
 *
 * Keep this path type-only so existing mode and tool consumers do not gain a
 * runtime edge through this legacy module.
 */

export type {
  ToolExecutor,
  ToolMetaInput,
  ToolMeta,
  ToolHintMeta,
  ToolOwner,
  ReplaceableOwner,
  ToolExposure,
} from './registry.js';
