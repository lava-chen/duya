/**
 * Plan 610 A8 shim   ?BaseTool moved to `@duya/capabilities/BaseTool`. Re-export
 * pass-through so every existing `../BaseTool.js` import inside the agent
 * keeps resolving to the same classes.
 */

export {
  BaseTool,
  StreamingBaseTool,
  ToolExecutionError,
  ToolValidationError,
  ToolPermissionError,
  PermissionRequiredError,
} from '@duya/capabilities/BaseTool';

export { default } from '@duya/capabilities/BaseTool';
