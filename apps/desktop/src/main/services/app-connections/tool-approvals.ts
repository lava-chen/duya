/**
 * Global connector tool approvals (Plan 449 Phase B).
 *
 * Codex parity: layered approval memory. The session layer lives in the
 * agent worker (`AppConnectionTool/approvals.ts`); this module is the
 * global layer — "Always allow" decisions persisted in ConfigStore under
 * `app_connection_approvals` keyed by `"${provider}:${toolAlias}"`.
 *
 * Storage choice: user security decisions are configuration state (Golden
 * Trident), not business journal — atomic write + hot-reload broadcast come
 * free via ConfigStore, and no core-db migration is needed.
 *
 * Approvals are keyed with the provider prefix so a decision never leaks
 * across connections/providers. When a connection is disconnected the
 * descriptors disappear, so an orphaned key is inert (and disappears from
 * relevance until the same provider+tool is reconnected).
 */

import { getConfigStore } from '../../config/store-instance';
import { getLogger, LogComponent } from '../../logging/logger';

const COMPONENT = 'AppConnectionApprovals' as LogComponent;

const CONFIG_KEY = 'app_connection_approvals';

export function approvalKey(provider: string, toolAlias: string): string {
  return `${provider}:${toolAlias}`;
}

function readApprovals(): Record<string, 'allow'> {
  const value = getConfigStore().getByPath(CONFIG_KEY);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, 'allow'>;
}

/** All globally approved `"provider:toolAlias"` keys. */
export function listGlobalToolApprovals(): string[] {
  return Object.keys(readApprovals());
}

/** Whether a provider+tool pair is globally approved. */
export function isToolGloballyApproved(provider: string, toolAlias: string): boolean {
  return readApprovals()[approvalKey(provider, toolAlias)] === 'allow';
}

/** Persist a global "Always allow" decision for provider+tool. */
export function approveToolGlobally(provider: string, toolAlias: string): boolean {
  const approvals = readApprovals();
  approvals[approvalKey(provider, toolAlias)] = 'allow';
  const ok = getConfigStore().set(CONFIG_KEY, approvals);
  getLogger().info('App Connection: global tool approval saved', { provider, toolAlias }, COMPONENT);
  return ok;
}

/** Remove a previously granted global approval. */
export function revokeToolApprovalGlobally(provider: string, toolAlias: string): boolean {
  const approvals = readApprovals();
  delete approvals[approvalKey(provider, toolAlias)];
  const ok = getConfigStore().set(CONFIG_KEY, approvals);
  getLogger().info('App Connection: global tool approval revoked', { provider, toolAlias }, COMPONENT);
  return ok;
}
