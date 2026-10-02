/**
 * Plan 481 — memory-tier RPC entry point (main-process side of the
 * update_state bridge).
 *
 * The agent subprocess forwards `memory-tier:rpc` envelopes here
 * (agent-server-lifecycle.ts). This module validates the payload, resolves
 * the duya root and the memory-state DB singleton, and dispatches to the
 * tier writer. All validation failures return structured errors — the
 * bridge never throws for expected conditions, so the tool sees
 * `success: false` with a code instead of an IPC exception.
 */

import * as os from 'os';
import * as path from 'path';
import { bootstrap, getDb } from './db';
import { forgetTierFact, writeTierFact, type TierWriteInput, type TierWriteResult } from './tierWriter';

export interface MemoryTierRpcRequest {
  action: string;
  payload: Record<string, unknown>;
  sessionId?: string;
}

/** Resolve the duya root (~/.duya, test-namespace aware). */
function resolveDuyaRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

const VALID_ACTIONS = new Set(['write', 'forget']);

/** Strip any path separators / control characters from string fields. */
function cleanString(value: unknown, maxLen: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n\0]/g, ' ').trim().slice(0, maxLen) : '';
}

export function parseTierWritePayload(payload: Record<string, unknown>): TierWriteInput | { error: string } {
  const actorAgentId = cleanString(payload.actorAgentId, 64);
  if (!actorAgentId || !/^[a-zA-Z0-9_-]+$/.test(actorAgentId)) {
    return { error: 'actorAgentId is required and must be a plain identifier' };
  }
  const tier = payload.tier;
  if (tier !== 'agent' && tier !== 'user' && tier !== 'project') {
    return { error: 'tier must be agent | user | project' };
  }
  const action = payload.action;
  if (action !== 'write' && action !== 'forget') {
    return { error: 'action must be write | forget' };
  }
  const fact = cleanString(payload.fact, 2000);
  const dedupeKey = cleanString(payload.dedupeKey, 512).toLowerCase();
  if (!dedupeKey) {
    return { error: 'dedupeKey is required' };
  }
  if (action === 'write' && !fact) {
    return { error: 'fact is required for write' };
  }
  let projectId: string | undefined;
  if (tier === 'project') {
    projectId = cleanString(payload.project, 64);
    if (!projectId || !/^[a-zA-Z0-9_-]+$/.test(projectId)) {
      return { error: 'project is required for tier=project' };
    }
  }
  const kindRaw = cleanString(payload.kind, 16);
  const kind = kindRaw === 'profile' || kindRaw === 'log' ? kindRaw : 'note';

  return { actorAgentId, tier, action, fact, dedupeKey, projectId, kind };
}

/**
 * Open the memory-state DB, bootstrapping lazily on first bot write. The
 * normal app boot bootstraps the memory worker; until that fires (or when
 * the memory system is disabled), the writer still works — bootstrap() is
 * idempotent and cheap when already open.
 */
function ensureDb() {
  try {
    return getDb();
  } catch {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- circular-free lazy import
    const { getDatabasePath } = require('../db/connection') as typeof import('../db/connection');
    return bootstrap({ bootJsonDatabaseDir: path.dirname(getDatabasePath()) });
  }
}

/**
 * Handle one memory-tier:rpc envelope. Returns a TierWriteResult-shaped
 * object; never rejects.
 */
export async function handleMemoryTierRpc(request: MemoryTierRpcRequest): Promise<TierWriteResult> {
  if (!VALID_ACTIONS.has(request.action)) {
    return { success: false, error: { code: 'INVALID_ACTION', message: `unknown memory-tier action: ${request.action}` } };
  }
  const parsed = parseTierWritePayload(request.payload);
  if ('error' in parsed) {
    return { success: false, error: { code: 'INVALID_PAYLOAD', message: parsed.error } };
  }

  let db;
  try {
    db = ensureDb();
  } catch (err) {
    return {
      success: false,
      error: {
        code: 'STORE_UNAVAILABLE',
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const duyaRoot = resolveDuyaRoot();
  if (parsed.action === 'forget') {
    return forgetTierFact(db, duyaRoot, parsed);
  }
  return writeTierFact(db, duyaRoot, parsed);
}
