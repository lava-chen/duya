/**
 * Rollout summary projection writer (Plan 304 Phase C, design v3 D11).
 *
 * Owns the write path for `rollout_summaries/<derived-filename>.md`.
 * Enforcement points:
 *   - Sanitization: credentials are redacted and the summary is hard-
 *     capped before anything is persisted.
 *   - Filename/content shape: content is rendered through
 *     `projectionContent.ts` so a file written here is byte-identical
 *     to what `reconcile.ts` (Plan 303) later expects — the write path
 *     and the reconcile path can never drift apart.
 *   - Outbox-only writes: the filesystem is mutated exclusively through
 *     `enqueueProjectionOutbox` (D12). This module only reads the
 *     filesystem for filename collision detection (existsSync).
 *
 * The DB handle is the first parameter of the public entry point
 * (packages/agent must not import electron's DB singleton; Plan 305
 * wires a concrete handle).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { computeContentHash, enqueueProjectionOutbox } from '../memory-state/outbox.js';
import {
  deriveRolloutSummaryFilename,
  renderRolloutSummaryFile,
  rolloutShortId,
  sanitizeRolloutSlug,
  type Stage1OutputRow,
} from '../memory-state/projectionContent.js';

/** Hard cap on the persisted summary body (32 KiB of UTF-16 code units). */
export const MAX_SUMMARY_CHARS = 32 * 1024;

const REDACTED = '[redacted-credential]';

/**
 * Best-effort credential scrub. Replaces every match of the known
 * credential patterns with the literal `[redacted-credential]`.
 * Applied in sequence so later patterns see the redacted output of
 * earlier ones.
 */
export function redactCredentials(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/g, REDACTED)
    .replace(/Authorization:\s*[A-Za-z]+\s+[^\s]+/g, REDACTED)
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, REDACTED)
    .replace(/password\s*[:=]\s*\S+/gi, REDACTED)
    .replace(/token\s*[:=]\s*\S+/gi, REDACTED)
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, REDACTED);
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * UTC timestamp in the Windows-safe D11 shape: `<YYYY-MM-DD>T<HH-MM-SS>`
 * (colons are illegal in Windows filenames). Re-implemented here because
 * projectionContent.ts does not export its own copy.
 */
function formatUtcFilenameTimestamp(ms: number): string {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}-${pad2(d.getUTCMinutes())}-${pad2(d.getUTCSeconds())}`
  );
}

/**
 * Build a filename with a custom shortid length (for collision extension).
 * Shape: `<YYYY-MM-DD>T<HH-MM-SS>-<shortid>-<slug>.md` in UTC.
 */
function buildFilenameWithShortidLen(
  rolloutId: string,
  slug: string,
  generatedAt: number,
  shortidLen: number
): string {
  const shortid = rolloutId.replace(/-/g, '').slice(0, shortidLen).toLowerCase();
  return `${formatUtcFilenameTimestamp(generatedAt)}-${shortid}-${sanitizeRolloutSlug(slug)}.md`;
}

/**
 * Extract the shortid segment from a D11 filename. Returns null when the
 * filename does not match the expected grammar. Non-greedy so it picks
 * the shortest valid shortid (8 hex) before letting the slug pattern
 * consume the rest.
 */
const D11_FILENAME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8,16}?)-[a-z0-9-]{3,80}\.md$/;

function extractShortidFromFilename(filename: string): string | null {
  const match = D11_FILENAME_RE.exec(filename);
  return match ? match[1] : null;
}

/**
 * Resolve the projection filename, handling collisions:
 *   - If no file exists at the derived path, use it.
 *   - If a file exists with the same 8-hex shortid prefix, it's the same
 *     rollout (re-write) — proceed.
 *   - If a file exists with a DIFFERENT shortid (genuine collision),
 *     extend the shortid to 12 then 16 hex chars until a free name is found.
 */
function resolveProjectionFilename(
  summariesDir: string,
  rolloutId: string,
  slug: string,
  generatedAt: number
): string {
  const baseFilename = deriveRolloutSummaryFilename({
    rollout_id: rolloutId,
    rollout_slug: slug,
    generated_at: generatedAt,
  });
  const basePath = path.join(summariesDir, baseFilename);
  if (!fs.existsSync(basePath)) {
    return baseFilename;
  }

  // File exists — same rollout (re-write) or genuine collision?
  const existingShortid = extractShortidFromFilename(baseFilename);
  const ourShortid8 = rolloutShortId(rolloutId);
  if (existingShortid === ourShortid8) {
    return baseFilename;
  }

  // Genuine collision — extend shortid to 12 then 16 hex chars.
  for (const len of [12, 16] as const) {
    const candidate = buildFilenameWithShortidLen(rolloutId, slug, generatedAt, len);
    if (!fs.existsSync(path.join(summariesDir, candidate))) {
      return candidate;
    }
  }
  // All lengths collide — fall back to the 16-char form.
  return buildFilenameWithShortidLen(rolloutId, slug, generatedAt, 16);
}

// ---------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------

export interface WriteProjectionInput {
  rolloutId: string;
  cwd: string;
  threadId: string;
  gitBranch: string | null;
  outcome: 'succeeded' | 'succeeded_no_output';
  contentOutcome: 'success' | 'partial' | 'fail' | 'uncertain' | null;
  summaryMarkdown: string;
  rawMemoryJson: string;
  rolloutSlug: string;
  generatedAt: number;
  sourceUpdatedAt: number;
  sourceContentHash: string;
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
}

export interface WriteProjectionResult {
  projectionPath: string;
  contentHashAtWrite: string;
  filename: string;
}

/**
 * Sanitize and enqueue one rollout summary projection write. Returns
 * the absolute projection path, the sha256 of the exact content
 * enqueued (persist it as `content_hash_at_write` per migration 0003),
 * and the resolved filename.
 *
 * Body rules:
 *   - `outcome === 'succeeded_no_output'` → body is empty string.
 *   - Otherwise: if `summaryMarkdown` exceeds MAX_SUMMARY_CHARS, it is
 *     truncated to MAX_SUMMARY_CHARS with a `\n... [truncated]` suffix
 *     BEFORE credential redaction. The body is then
 *     `redactCredentials(truncated)`.
 *
 * The full file content is rendered through `renderRolloutSummaryFile`
 * so the write path stays byte-identical to what `reconcile.ts` expects.
 */
export function writeRolloutProjection(
  db: Database,
  input: WriteProjectionInput
): WriteProjectionResult {
  // 1. Body: truncate (BEFORE redaction) then redact.
  let body: string;
  if (input.outcome === 'succeeded_no_output') {
    body = '';
  } else {
    const truncated =
      input.summaryMarkdown.length > MAX_SUMMARY_CHARS
        ? input.summaryMarkdown.slice(0, MAX_SUMMARY_CHARS) + '\n... [truncated]'
        : input.summaryMarkdown;
    body = redactCredentials(truncated);
  }

  // 2. Render through the shared Plan 303 module so the write path is
  //    byte-identical to what reconcile.ts expects.
  const row: Stage1OutputRow = {
    rollout_id: input.rolloutId,
    thread_id: input.threadId,
    cwd: input.cwd,
    project_id: 'global',
    git_branch: input.gitBranch,
    job_status: input.outcome,
    content_outcome: input.contentOutcome,
    rollout_summary: body,
    raw_memory: input.rawMemoryJson,
    rollout_slug: input.rolloutSlug,
    generated_at: input.generatedAt,
    source_updated_at: input.sourceUpdatedAt,
    source_content_hash: input.sourceContentHash,
    extracted_through_seq: null,
    output_updated_at: input.generatedAt,
    schema_version: 2,
    content_hash_at_write: null,
  };
  const content = renderRolloutSummaryFile(row);

  // 3. Resolve filename (with collision detection).
  const rootDir = input.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
  const summariesDir = path.join(rootDir, 'rollout_summaries');
  const filename = resolveProjectionFilename(
    summariesDir,
    input.rolloutId,
    input.rolloutSlug,
    input.generatedAt
  );
  const projectionPath = path.join(summariesDir, filename);

  // 4. Enqueue outbox write (NEVER write to the filesystem directly).
  enqueueProjectionOutbox(db, {
    targetPath: projectionPath,
    operation: 'write',
    content,
  });

  // 5. Hash the exact content enqueued.
  const contentHashAtWrite = computeContentHash(content);

  return { projectionPath, contentHashAtWrite, filename };
}
