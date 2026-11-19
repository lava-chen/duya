/**
 * read-roots.ts — the trusted read scope for one tool call.
 *
 * The Project Coordinator may read the workspace of the project it is bound
 * to, and nothing else. The scope is resolved per call from the durable
 * binding the Host owns, so a re-bound Coordinator never keeps reading the
 * previous project. The worker never names a path: it asks the Host what
 * the Host trusts, and the Host answers from its own project store.
 *
 * Two owners, one decision:
 *
 *   - "is this session the Coordinator?" — the session's own profile id,
 *     set by the Host when the session was created;
 *   - "which root is trusted?" — the Coordinator binding in the Host's
 *     database.
 *
 * Neither answer comes from the model. When no root can be established the
 * scope is empty, which the read tools treat as "nothing is trusted" and
 * refuse every access — a failed lookup closes the scope instead of
 * silently widening it.
 */

import { isProjectCoordinatorProfile } from './identity.js';
import { projectDb } from '../worker-db-client.js';
import type { ToolUseContext } from '../worker-run-contracts.js';

/**
 * The tools that can read the workspace.
 *
 * This is a compile-time fixed allow-list, not session state: it holds no
 * request data, no counters and nothing that varies per session, so it must
 * not be moved into a session scope. It is frozen instead, so the list can
 * never grow at runtime.
 */
const READ_TOOLS: readonly string[] = Object.freeze(['read', 'glob', 'grep']);

export function isWorkspaceReadTool(toolName: string): boolean {
  return READ_TOOLS.includes(toolName.toLowerCase());
}

/**
 * Bind the caller's trusted roots to one call.
 *
 * A session that is not the Coordinator keeps the unrestricted behaviour it
 * has today, and a tool that cannot read the workspace is left alone.
 */
export async function bindCoordinatorReadRoots(
  toolName: string,
  context: ToolUseContext | undefined,
): Promise<ToolUseContext | undefined> {
  if (!context || !isWorkspaceReadTool(toolName)) return context;
  if (!isProjectCoordinatorProfile(context.options.agentProfileId)) return context;
  const roots = await resolveCoordinatorRoots();
  return { ...context, options: { ...context.options, allowedRoots: roots } };
}

async function resolveCoordinatorRoots(): Promise<readonly string[]> {
  try {
    const result = await projectDb.bindingRoot();
    const root = result?.canonicalRoot;
    return typeof root === 'string' && root.length > 0 ? [root] : [];
  } catch {
    // The Host could not be asked, so no root is trusted.
    return [];
  }
}
