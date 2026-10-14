import type { ToolPermissionDecision } from '../execution/contracts.js';
import type { PermissionRequestEvent } from '@duya/agent-protocol/transcript';

/** Request-scoped identity and approval effects needed by discovery meta tools. */
export interface DiscoveryToolContext {
  options?: object | undefined;
  toolUseId?: string | undefined;
  getAppState?: () => Record<string, unknown>;
  setAppState?: (update: (previous: Record<string, unknown>) => Record<string, unknown>) => void;
  requestPermission?: (request: Omit<PermissionRequestEvent, 'mode'> & { mode: 'generic' }) => Promise<ToolPermissionDecision>;
}
