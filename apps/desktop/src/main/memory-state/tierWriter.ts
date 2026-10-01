/**
 * Memory tier writer (Plan 481 P2.1 — write side of the update_state tool).
 *
 * Owns the canonical-memory WRITE path for bot memory writes on behalf of
 * the Plan 479 tier store:
 *   1. Write the canonical file (frontmatter + body) into the writer's own
 *      shard directory — files stay the source of truth (479 P1.0 D1).
 *   2. Maintain the rebuildable `memory_tier_index` via `upsertTierEntry` /
 *      `removeTierEntryByPath` — write-path-maintained rows, the Phase 1
 *      rebuild scan only covers the legacy user-tier roots.
 *
 * Shard layout (single-writer rule enforced at the directory level, 479 §3.3
 * — the file system naturally separates by writer):
 *   tier 'agent'   → <duyaRoot>/agents/<agentId>/memory/<slug>.md
 *   tier 'user'    → <duyaRoot>/agents/<agentId>/user/<slug>.md
 *   tier 'project' → <duyaRoot>/projects/<projectId>/agents/<agentId>/<slug>.md
 *
 * All directories live outside REBUILD_SCAN_ROOTS (memory/items|entities|
 * global), so a legacy backfill can never clobber write-path-maintained rows.
 *
 * Forget is soft: the frontmatter status flips to 'retired' (parseCanonicalFile
 * consumers skip it) and the index row is removed. The file stays on disk for
 * auditability, matching the file-truth principle.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { getLogger, LogComponent } from '../logging/logger';
import {
  listTierEntries,
  removeTierEntryByPath,
  upsertTierEntry,
  type UpsertOutcome,
} from './tierIndex';

const logger = getLogger();

export type TierWriteTier = 'agent' | 'user' | 'project';

export interface TierWriteInput {
  /** Bot identity performing the write (own-shard owner). */
  actorAgentId: string;
  tier: TierWriteTier;
  action: 'write' | 'forget';
  fact: string;
  /** Pre-normalized dedupe key (trim + lowercase, mirrors 479). */
  dedupeKey: string;
  projectId?: string;
  kind?: 'profile' | 'log' | 'note';
}

export interface TierWriteOk {
  success: true;
  outcome: UpsertOutcome | 'removed' | 'not_found';
  /** Duya-root-relative canonical file path (forward slashes). */
  filePath?: string;
}

export interface TierWriteErr {
  success: false;
  error: { code: string; message: string };
}

export type TierWriteResult = TierWriteOk | TierWriteErr;

const KINDS: readonly string[] = ['profile', 'log', 'note'];

/**
 * Slug for the canonical filename: [a-z0-9] run joined by hyphens,
 * truncated, with a 10-char content hash suffix so distinct facts that
 * slugify identically still get distinct files.
 */
function factSlug(dedupeKey: string): string {
  const base = dedupeKey
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'fact';
  const hash = crypto.createHash('sha256').update(dedupeKey).digest('hex').slice(0, 10);
  return `${base}-${hash}.md`;
}

/** Validate identifiers that become path segments (no traversal, no dots). */
function safeSegment(value: string, field: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error(`${field} contains invalid characters for a shard path segment`);
  }
  return value;
}

function shardRelativePath(input: TierWriteInput, slug: string): string {
  const agentId = safeSegment(input.actorAgentId, 'actorAgentId');
  if (input.tier === 'project') {
    const projectId = safeSegment(input.projectId ?? '', 'projectId');
    return `projects/${projectId}/agents/${agentId}/${slug}`;
  }
  if (input.tier === 'user') {
    return `agents/${agentId}/user/${slug}`;
  }
  return `agents/${agentId}/memory/${slug}`;
}

/**
 * Serialize the canonical frontmatter (flat key:value subset the shared
 * parseCanonicalFile parser reads — packages/agent/src/memory-state).
 */
function canonicalFileContent(input: TierWriteInput, memoryId: string, updatedAtIso: string): string {
  const kind = input.kind && KINDS.includes(input.kind) ? input.kind : 'note';
  const scope = input.tier;
  const scopeId = input.actorAgentId;
  const projectId = input.tier === 'project' ? (input.projectId ?? '') : 'null';
  const frontmatter = [
    '---',
    `memory_id: ${memoryId}`,
    `canonical_key: ${input.dedupeKey}`,
    `claim_type: ${kind}`,
    `scope: ${scope}`,
    `scope_id: ${scopeId}`,
    `project_id: ${projectId}`,
    `status: active`,
    `importance: normal`,
    `updated_at: ${updatedAtIso}`,
    '---',
    '',
    input.fact,
    '',
  ];
  return frontmatter.join('\n');
}

/** Flip an existing canonical file's status to 'retired' (soft delete). */
function retireFile(absPath: string): void {
  const content = fs.readFileSync(absPath, 'utf8');
  const updated = content.replace(/^status: active$/m, 'status: retired');
  if (updated !== content) {
    fs.writeFileSync(absPath, updated, 'utf8');
  }
}

/**
 * Write a fact: upsert the canonical file into the writer's shard and
 * maintain the tier index row (newest-wins on the dedupe key).
 */
export function writeTierFact(
  db: Database,
  duyaRoot: string,
  input: TierWriteInput,
): TierWriteResult {
  try {
    if (input.tier === 'project' && !input.projectId) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'projectId is required for tier=project' } };
    }
    if (!input.dedupeKey) {
      return { success: false, error: { code: 'INVALID_INPUT', message: 'dedupeKey is required' } };
    }

    const slug = factSlug(input.dedupeKey);
    const relPath = shardRelativePath(input, slug);
    const absPath = path.join(duyaRoot, relPath);

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const existing = fs.existsSync(absPath);
    // Upsert semantics: keep the original memory_id when the file already
    // exists so the identity is stable across newest-wins rewrites.
    const memoryId = existing ? extractMemoryId(absPath) ?? crypto.randomUUID() : crypto.randomUUID();

    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, canonicalFileContent(input, memoryId, nowIso), 'utf8');

    const contentHash = crypto.createHash('sha256').update(fs.readFileSync(absPath, 'utf8')).digest('hex');
    const outcome = upsertTierEntry(db, {
      tier: input.tier,
      agentProfileId: input.actorAgentId,
      ...(input.tier === 'project' ? { projectId: input.projectId } : {}),
      kind: input.kind && KINDS.includes(input.kind) ? input.kind : 'note',
      dedupeKey: input.dedupeKey,
      filePath: relPath,
      contentHash,
      updatedAt: nowMs,
    });

    logger.info('Memory tier fact written', {
      tier: input.tier,
      outcome,
      filePath: relPath,
    }, LogComponent.Main);

    return { success: true, outcome, filePath: relPath };
  } catch (err) {
    logger.error('Memory tier write failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
    return {
      success: false,
      error: { code: 'WRITE_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function extractMemoryId(absPath: string): string | null {
  try {
    const match = /^memory_id:\s*(.+)$/m.exec(fs.readFileSync(absPath, 'utf8'));
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Forget a fact: locate the writer's index row by dedupe key, retire the
 * canonical file, and drop the index row. Returns not_found when the
 * writer has no matching entry (its own shard only — single-writer rule).
 */
export function forgetTierFact(
  db: Database,
  duyaRoot: string,
  input: TierWriteInput,
): TierWriteResult {
  try {
    const rows = listTierEntries(db, {
      tier: input.tier,
      agentProfileId: input.actorAgentId,
      ...(input.tier === 'project' ? { projectId: input.projectId } : {}),
    });

    const normalized = input.dedupeKey.trim().toLowerCase();
    const target =
      rows.find((r) => r.dedupe_key === normalized) ??
      rows.find((r) => r.dedupe_key.startsWith(normalized) && normalized.length >= 8);
    if (!target) {
      return { success: true, outcome: 'not_found' };
    }

    const absPath = path.join(duyaRoot, target.file_path);
    if (fs.existsSync(absPath)) {
      retireFile(absPath);
    }
    removeTierEntryByPath(db, target.file_path);

    logger.info('Memory tier fact forgotten', {
      tier: input.tier,
      filePath: target.file_path,
    }, LogComponent.Main);

    return { success: true, outcome: 'removed', filePath: target.file_path };
  } catch (err) {
    logger.error('Memory tier forget failed', err instanceof Error ? err : new Error(String(err)), undefined, LogComponent.Main);
    return {
      success: false,
      error: { code: 'FORGET_FAILED', message: err instanceof Error ? err.message : String(err) },
    };
  }
}
