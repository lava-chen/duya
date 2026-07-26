/**
 * Raw memories projection builder (Plan 304 Phase D, design v3 D7/D12).
 *
 * Rebuilds the merged `raw_memories.md` projection from ALL
 * `stage1_outputs` rows and enqueues a single outbox write. The
 * document groups sections by thread_id (ordered ASC) and includes both
 * a rendered summary of extracted items (claim / claim_type /
 * canonical_key / evidence source_ids) and the verbatim raw_memory JSON
 * in a fenced block.
 *
 * Single-flight: a module-level guard prevents concurrent rebuilds
 * within the same process; a re-entrant call returns a no-op result
 * with `projectionId: -1`.
 *
 * The DB handle is the first parameter (packages/agent must not import
 * electron's DB singleton; Plan 305 wires a concrete handle).
 */

import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { computeContentHash, enqueueProjectionOutbox } from '../memory-state/outbox.js';
import { type Stage1OutputRow } from '../memory-state/projectionContent.js';
import { redactCredentials } from './writer.js';

export interface RawMemoriesRebuildResult {
  targetPath: string;
  projectionId: number;
  threadCount: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Single-flight guard
// ---------------------------------------------------------------------------

let rebuildInFlight = false;

// ---------------------------------------------------------------------------
// Raw memory item rendering
// ---------------------------------------------------------------------------

interface RawMemoryEvidence {
  source_type?: string;
  source_id?: string;
  verification?: string;
}

interface RawMemoryItem {
  canonical_key?: string;
  claim?: string;
  claim_type?: string;
  evidence?: RawMemoryEvidence[];
}

/** Render the comma-joined list of evidence source_ids for one item. */
function renderEvidenceSourceIds(evidence: RawMemoryEvidence[] | undefined): string {
  const ids = (evidence ?? [])
    .map((e) => e.source_id ?? '')
    .filter((id) => id.length > 0);
  return ids.length > 0 ? ids.join(', ') : '(none)';
}

/**
 * Render a compact one-line-per-item summary of the raw_memory payload:
 * `claim`, `claim_type`, `canonical_key`, and the evidence `source_ids`.
 * Degrades gracefully when the JSON is missing/unparseable/empty.
 */
function renderRawMemoryItems(rawMemoryJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMemoryJson);
  } catch {
    return '(invalid JSON)';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return '(invalid JSON)';
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || items.length === 0) {
    return '(no items)';
  }

  const lines: string[] = [];
  for (const item of items as RawMemoryItem[]) {
    if (typeof item !== 'object' || item === null) continue;
    lines.push(
      `- canonical_key: ${item.canonical_key ?? '(none)'} | ` +
        `claim: ${item.claim ?? '(none)'} | ` +
        `claim_type: ${item.claim_type ?? '(none)'} | ` +
        `evidence source_ids: ${renderEvidenceSourceIds(item.evidence)}`
    );
  }
  return lines.length > 0 ? lines.join('\n') : '(no items)';
}

// ---------------------------------------------------------------------------
// Thread section rendering
// ---------------------------------------------------------------------------

function buildThreadSection(row: Stage1OutputRow): string {
  const header =
    `## Thread: ${row.thread_id}\n` +
    `- rollout_id: ${row.rollout_id}\n` +
    `- slug: ${row.rollout_slug}\n` +
    `- generated_at: ${new Date(row.generated_at).toISOString()}\n` +
    `- job_status: ${row.job_status}\n`;

  if (row.job_status === 'succeeded_no_output') {
    return `${header}\n(no durable knowledge extracted)\n`;
  }

  if (row.job_status === 'succeeded' && row.raw_memory !== null) {
    const itemsSummary = renderRawMemoryItems(row.raw_memory);
    return `${header}\n${itemsSummary}\n\n\`\`\`json\n${row.raw_memory}\n\`\`\`\n`;
  }

  // Other statuses (e.g. failed) — just the header.
  return header;
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild `raw_memories.md` from every `stage1_outputs` row and enqueue
 * a single outbox write. Rows are ordered by `thread_id` ASC then
 * `generated_at` ASC. The whole document is run through
 * `redactCredentials` before enqueuing.
 *
 * Single-flight: a re-entrant call returns a no-op result
 * `{ targetPath, projectionId: -1, threadCount: 0, contentHash: '' }`.
 */
export function rebuildRawMemoriesProjection(
  db: Database,
  opts?: { rootDir?: string; now?: number }
): RawMemoriesRebuildResult {
  const rootDir = opts?.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
  const targetPath = path.join(rootDir, 'raw_memories.md');

  if (rebuildInFlight) {
    return { targetPath, projectionId: -1, threadCount: 0, contentHash: '' };
  }

  rebuildInFlight = true;
  try {
    const rows = db
      .prepare('SELECT * FROM stage1_outputs ORDER BY thread_id ASC, generated_at ASC')
      .all() as Stage1OutputRow[];

    const header = '# Raw Memories\n\n';
    const body = rows.map(buildThreadSection).join('');
    const content = redactCredentials(header + body);

    const { projectionId } = enqueueProjectionOutbox(db, {
      targetPath,
      operation: 'write',
      content,
      now: opts?.now,
    });

    return {
      targetPath,
      projectionId,
      threadCount: rows.length,
      contentHash: computeContentHash(content),
    };
  } finally {
    rebuildInFlight = false;
  }
}
