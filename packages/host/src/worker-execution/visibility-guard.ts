import { recordUndeclaredCall as recordRuntimeCall } from '@duya/agent-runtime/tools/discovery/visibility-guard';
import { logger } from '@duya/host/worker-logger';
export { evaluateVisibilityGuard, VISIBILITY_DENIAL_MESSAGE, readUndeclaredCallStats, resetUndeclaredCallStats } from '@duya/agent-runtime/tools/discovery/visibility-guard';
export type { VisibilityGuardInput, VisibilityGuardResult } from '@duya/agent-runtime/tools/discovery/visibility-guard';
export const recordUndeclaredCall = (toolName: string) => recordRuntimeCall(toolName, logger);
