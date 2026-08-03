/**
 * Phase 2 consolidator (Plan 306 Phase B).
 *
 * Promotes Stage 1 extraction outputs into canonical memory entries:
 *   - acquires a global lock (phase2_runs row)
 *   - computes an input-set hash for CAS-skip idempotency
 *   - parses raw_memory JSON from eligible stage1_outputs
 *   - re-enforces the D8 guard (external-only evidence cannot form
 *     preference/procedure)
 *   - digests ad-hoc `.md` files from `extensions/ad_hoc/`
 *   - groups items by (canonical_key, scope, scope_id), picks a winner
 *     per group (highest evidence.verification, tiebreak by
 *     generated_at DESC; ad-hoc entries always win)
 *   - UPSERTs memory_entries (including the v2 lifecycle columns from
 *     migration 0007) + inserts memory_evidence rows
 *   - renders + enqueues 5 projection files via the outbox
 *   - releases the lock
 *
 * All DB writes in steps 6-10 run inside ONE `BEGIN IMMEDIATE`
 * transaction; a crash rolls back and the catch block releases the
 * lock as 'failed'.
 *
 * Shadow mode: the only production caller is `consolidatorTick` in
 * `electron/memory/memory-worker.ts`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Database } from 'better-sqlite3';
import { enqueueProjectionOutbox } from './outbox.js';
import {
  renderUnifiedMemoryFile,
  renderMemorySummaryFile,
  renderPhase2WorkspaceDiff,
  renderPersonFile,
  renderAreaFile,
  renderPeopleIndexFile,
  renderAreasIndexFile,
  personAreaSlug,
  type MemoryEntryRow,
  type Phase2Diff,
  type Phase2DiffEntry,
} from './projectionContent.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default lock timeout: 5 minutes. */
const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Maximum number of `phase2_runs` rows to retain. Older rows are
 * pruned after each successful consolidator run to prevent unbounded
 * growth (the table is an operational log, not a permanent audit trail).
 */
const PHASE2_RUNS_RETENTION_COUNT = 50;
const ACTIVE_MEMORY_LIMIT_PER_SCOPE = 64;
// Bump whenever normalization, scope, or retention semantics change so an
// unchanged Stage 1 input set is re-consolidated exactly once.
const CONSOLIDATOR_INPUT_VERSION = 4;

const AD_HOC_DIR_NAME = 'extensions/ad_hoc';
const DIGESTED_SUBDIR = '.digested';

/**
 * D8 guard: external source types cannot form preference/procedure.
 * Duplicated from `extractor.ts` (not exported there); keep in sync.
 */
const EXTERNAL_SOURCE_TYPES = new Set(['browser_page', 'mcp_response']);

/** Verification level ranking (higher = stronger). */
const VERIFICATION_RANK: Record<string, number> = {
  none: 1,
  inferred: 2,
  observed: 3,
  verified_code: 4,
  verified_user: 5,
};

/** Ad-hoc entries always win (rank above any evidence verification). */
const AD_HOC_RANK = 100;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ConsolidatorInput {
  db: Database;
  now?: number;
  lockTimeoutMs?: number;
  /** Projection root; default `~/.duya/memory`. */
  rootDir?: string;
}

export interface ConsolidatorResult {
  skipped: boolean;
  runId?: number;
  added: number;
  merged: number;
  superseded: number;
  retired: number;
  adHocDigested: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedEvidence {
  source_type: string;
  source_id: string;
  verification?: string;
}

interface ParsedItem {
  rolloutId: string;
  itemIndex: number;
  claim: string;
  claimType: string;
  scopeHint?: string; // was 'global', now any scope string
  scopeId?: string | null;
  canonicalKey: string;
  evidence: ParsedEvidence[];
  generatedAt: number;
  isAdHoc: boolean;
  content: string;
  // New lifecycle fields from v2:
  confidence?: string;
  status?: string;
  validFrom?: string | null;
  validUntil?: string | null;
  relationToExisting?: string | null;
  supersedesKeys?: string[];
  whyFutureAgentNeedsThis?: string;
  retrievalCues?: string[];
}

interface ItemGroup {
  canonicalKey: string;
  scope: string;
  scopeId: string | null;
  items: ParsedItem[];
}

interface AdHocFile {
  filename: string;
  filePath: string;
  content: string;
  canonicalKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxVerificationRank(evidence: ParsedEvidence[]): number {
  let max = 0;
  for (const ev of evidence) {
    const rank = VERIFICATION_RANK[ev.verification ?? 'none'] ?? 0;
    if (rank > max) max = rank;
  }
  return max;
}

function itemRank(item: ParsedItem): number {
  if (item.isAdHoc) return AD_HOC_RANK;
  return maxVerificationRank(item.evidence);
}

function pickWinner(items: ParsedItem[]): ParsedItem {
  return items.reduce((best, item) => {
    const itemScore = itemRank(item);
    const bestScore = itemRank(best);
    if (itemScore > bestScore) return item;
    if (itemScore < bestScore) return best;
    return item.generatedAt > best.generatedAt ? item : best;
  });
}

function hasExternalSourceOnly(item: ParsedItem): boolean {
  if (item.evidence.length === 0) return false;
  return item.evidence.every((ev) => EXTERNAL_SOURCE_TYPES.has(ev.source_type));
}

/** D8: external-only evidence cannot form preference or procedure. */
function d8AllowsKind(item: ParsedItem): boolean {
  if (
    hasExternalSourceOnly(item) &&
    (item.claimType === 'preference' || item.claimType === 'procedure')
  ) {
    return false;
  }
  return true;
}

/**
 * True when the canonical_key belongs to a person or area entry
 * (prefix `person:` or `area:`).
 */
function isPersonAreaKey(canonicalKey: string): boolean {
  return canonicalKey.startsWith('person:') || canonicalKey.startsWith('area:');
}

/** Normalize historical free-form keys into the controlled v2 taxonomy. */
export function normalizeCanonicalKey(
  claimType: string,
  canonicalKey: string,
  claim: string
): string {
  const raw = canonicalKey.trim().toLowerCase().replace(/_/g, '-');
  if (
    claimType === 'preference' &&
    (/(^|[-:])(language|lang)([-:]|$)/.test(raw) || /response-language/.test(raw)) &&
    !/(utf|file|structured|brief|markdown|canvas|widget|brand)/.test(raw) &&
    /(chinese|zh-cn|zh\b|中文|汉语)/i.test(`${raw} ${claim}`)
  ) {
    return 'preference:response-language';
  }
  if (
    claimType === 'preference' &&
    /(visual.*(verify|verification|self-check)|verify.*visual)/.test(raw)
  ) {
    return 'preference:visual-verification';
  }

  const prefixAliases: Record<string, string> = {
    pref: 'preference',
    preference: 'preference',
    decision: 'decision',
    invariant: 'invariant',
    proc: 'procedure',
    procedure: 'procedure',
    workflow: 'procedure',
    goal: 'goal',
    commitment: 'commitment',
    fact: 'fact',
    ref: 'reference',
    reference: 'reference',
    person: 'person',
    relationship: 'relationship',
    area: 'area',
    capability: 'capability',
  };
  const type = prefixAliases[claimType] ?? claimType;
  let topic = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : raw;
  topic = topic
    .replace(/^user[-:]+/, '')
    .replace(/^(pref(erence)?|proc(edure)?|workflow|fact|ref(erence)?)[-:]+/, '')
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${type}:${topic || 'unspecified'}`;
}

function isExplicitlyGlobal(item: ParsedItem, normalizedKey: string): boolean {
  return (
    item.scopeHint === 'global' ||
    item.scopeHint === 'personal' ||
    isPersonAreaKey(normalizedKey) ||
    normalizedKey === 'preference:response-language' ||
    normalizedKey === 'preference:visual-verification'
  );
}

/**
 * Map a v2 scope onto the legacy `project_id` column for backward
 * compatibility: project-like scopes carry their scope_id there, every
 * other scope leaves it NULL. The authoritative scope target lives in
 * the `scope_id` column added by migration 0007.
 */
function legacyProjectId(scope: string, scopeId: string | null): string | null {
  if (scopeId === null) return null;
  return scope === 'project' || scope === 'repository' ? scopeId : null;
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
  return row !== undefined;
}

function columnExists(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === columnName);
}

/**
 * Merge all claims for a person/area group into a single content body
 * in the `## Summary` + `## Details` format.
 *
 * The most recent claim (by generatedAt DESC) becomes the summary;
 * all unique claims (including the summary) become the details list.
 * This ensures every session that mentioned this person/area
 * contributes to the details, not just the winner.
 */
function mergePersonAreaContent(items: ParsedItem[]): string {
  const sorted = [...items].sort((a, b) => b.generatedAt - a.generatedAt);
  const seen = new Set<string>();
  const details: string[] = [];
  for (const item of sorted) {
    const claim = item.claim.trim();
    if (claim.length === 0) continue;
    if (seen.has(claim)) continue;
    seen.add(claim);
    details.push(claim);
  }
  const summary = details[0] ?? '';
  const lines: string[] = ['## Summary', '', summary, '', '## Details', ''];
  for (const d of details) {
    lines.push(`- ${d}`);
  }
  return lines.join('\n');
}

function computeInputSetHash(db: Database): string {
  const rows = db
    .prepare(
      `SELECT rollout_id, source_content_hash
       FROM stage1_outputs
       WHERE job_status = 'succeeded'
       ORDER BY rollout_id ASC`
    )
    .all() as Array<{ rollout_id: string; source_content_hash: string }>;

  const payload = [`consolidator:${CONSOLIDATOR_INPUT_VERSION}`, ...rows
    .map((r) => `${r.rollout_id}:${r.source_content_hash}`)
  ].join('\n');
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Lock management
// ---------------------------------------------------------------------------

interface LockAcquired {
  skipped: false;
  runId: number;
  token: string;
}

interface LockSkipped {
  skipped: true;
}

function acquireLock(
  db: Database,
  now: number,
  lockTimeoutMs: number
): LockAcquired | LockSkipped {
  const token = crypto.randomUUID();

  const txn = db.transaction((): LockAcquired | LockSkipped => {
    const running = db
      .prepare('SELECT id, started_at, lock_holder FROM phase2_runs WHERE status = ?')
      .get('running') as
      | { id: number; started_at: number; lock_holder: string | null }
      | undefined;

    if (running) {
      if (running.started_at > now - lockTimeoutMs) {
        // Fresh lock held by another run — skip.
        return { skipped: true };
      }
      // Stale lock — steal the row in place.
      db.prepare(
        'UPDATE phase2_runs SET lock_holder = ?, started_at = ?, input_set_hash = ? WHERE id = ?'
      ).run(token, now, '', running.id);
      return { skipped: false, runId: running.id, token };
    }

    // No running row — insert a new one.
    const result = db
      .prepare(
        'INSERT INTO phase2_runs (started_at, input_set_hash, lock_holder, status) VALUES (?, ?, ?, ?)'
      )
      .run(now, '', token, 'running');
    return { skipped: false, runId: Number(result.lastInsertRowid), token };
  });

  return txn.immediate();
}

function isCasSkip(db: Database, inputSetHash: string): boolean {
  const last = db
    .prepare(
      'SELECT input_set_hash FROM phase2_runs WHERE status = ? ORDER BY id DESC LIMIT 1'
    )
    .get('succeeded') as { input_set_hash: string } | undefined;
  return last?.input_set_hash === inputSetHash;
}

function releaseLock(
  db: Database,
  runId: number,
  token: string,
  now: number,
  status: 'succeeded' | 'failed',
  inputSetHash: string,
  outputDiffSummary: string
): void {
  db.prepare(
    `UPDATE phase2_runs
       SET finished_at = ?, status = ?, input_set_hash = ?,
           output_diff_summary = ?, lock_holder = NULL
     WHERE id = ? AND lock_holder = ?`
  ).run(now, status, inputSetHash, outputDiffSummary, runId, token);
}

/**
 * Delete old `phase2_runs` rows, keeping only the most recent
 * `PHASE2_RUNS_RETENTION_COUNT`. Best-effort: if the table has fewer
 * rows than the retention count, this is a no-op.
 */
function prunePhase2Runs(db: Database): number {
  const result = db
    .prepare(
      `DELETE FROM phase2_runs
       WHERE id NOT IN (
         SELECT id FROM phase2_runs
         ORDER BY id DESC
         LIMIT ?
       )`
    )
    .run(PHASE2_RUNS_RETENTION_COUNT);
  return result.changes;
}

// ---------------------------------------------------------------------------
// Stage 1 item parsing
// ---------------------------------------------------------------------------

interface RawMemoryItem {
  claim?: string;
  claim_type?: string;
  scope?: string;
  scope_id?: string | null;
  evidence?: Array<{
    source_type?: string;
    source_id?: string;
    verification?: string;
  }>;
  canonical_key?: string;
  confidence?: string;
  status?: string;
  valid_from?: string | null;
  valid_until?: string | null;
  relation_to_existing?: string | null;
  supersedes?: string[];
  why_future_agent_needs_this?: string;
  retrieval_cues?: string[];
}

function parseStage1Items(db: Database): ParsedItem[] {
  const rows = db
    .prepare(
      `SELECT rollout_id, raw_memory, generated_at
       FROM stage1_outputs
       WHERE job_status = 'succeeded'`
    )
    .all() as Array<{
    rollout_id: string;
    raw_memory: string | null;
    generated_at: number;
  }>;

  const items: ParsedItem[] = [];
  for (const row of rows) {
    if (!row.raw_memory) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.raw_memory);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const parsedObj = parsed as { items?: unknown };
    if (!Array.isArray(parsedObj.items)) continue;

    for (let i = 0; i < parsedObj.items.length; i++) {
      const item = parsedObj.items[i] as RawMemoryItem;
      if (typeof item !== 'object' || item === null) continue;
      if (typeof item.claim !== 'string' || item.claim.length === 0) continue;
      if (typeof item.claim_type !== 'string') continue;
      if (typeof item.canonical_key !== 'string' || item.canonical_key.length === 0) continue;
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) continue;

      const evidence: ParsedEvidence[] = item.evidence
        .filter(
          (ev) =>
            ev !== null &&
            typeof ev === 'object' &&
            typeof ev.source_type === 'string' &&
            typeof ev.source_id === 'string'
        )
        .map((ev) => ({
          source_type: ev.source_type as string,
          source_id: ev.source_id as string,
          verification: ev.verification,
        }));
      if (evidence.length === 0) continue;

      items.push({
        rolloutId: row.rollout_id,
        itemIndex: i,
        claim: item.claim,
        claimType: item.claim_type,
        scopeHint: typeof item.scope === 'string' ? item.scope : undefined,
        scopeId: typeof item.scope_id === 'string' ? item.scope_id : null,
        // `ad-hoc:*` is a reserved historical namespace. Keeping it intact
        // lets an explicitly authored note remain authoritative when an old
        // Stage 1 row happens to reference the same key.
        canonicalKey: item.canonical_key.startsWith('ad-hoc:')
          ? item.canonical_key
          : normalizeCanonicalKey(item.claim_type, item.canonical_key, item.claim),
        evidence,
        generatedAt: row.generated_at,
        isAdHoc: false,
        content: item.claim,
        confidence: typeof item.confidence === 'string' ? item.confidence : undefined,
        status: typeof item.status === 'string' ? item.status : undefined,
        validFrom: typeof item.valid_from === 'string' ? item.valid_from : null,
        validUntil: typeof item.valid_until === 'string' ? item.valid_until : null,
        relationToExisting:
          typeof item.relation_to_existing === 'string' ? item.relation_to_existing : null,
        supersedesKeys: Array.isArray(item.supersedes)
          ? item.supersedes.filter((k): k is string => typeof k === 'string')
          : undefined,
        whyFutureAgentNeedsThis:
          typeof item.why_future_agent_needs_this === 'string'
            ? item.why_future_agent_needs_this
            : undefined,
        retrievalCues: Array.isArray(item.retrieval_cues)
          ? item.retrieval_cues.filter((c): c is string => typeof c === 'string')
          : undefined,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Ad-hoc digestion
// ---------------------------------------------------------------------------

/**
 * Ad-hoc notes are global-only. Legacy `project__<uuid>__<name>.md`
 * filenames are digested as-is but treated as global entries.
 */
function scanAdHocFiles(rootDir: string): AdHocFile[] {
  const adHocDir = path.join(rootDir, AD_HOC_DIR_NAME);
  if (!fs.existsSync(adHocDir)) return [];

  const files: AdHocFile[] = [];
  for (const entry of fs.readdirSync(adHocDir)) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = path.join(adHocDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    files.push({
      filename: entry,
      filePath: fullPath,
      content,
      canonicalKey: `ad-hoc:${entry}`,
    });
  }
  return files;
}

function moveAdHocToDigested(file: AdHocFile, rootDir: string): void {
  const digestedDir = path.join(rootDir, AD_HOC_DIR_NAME, DIGESTED_SUBDIR);
  fs.mkdirSync(digestedDir, { recursive: true });
  const dest = path.join(digestedDir, file.filename);
  try {
    fs.renameSync(file.filePath, dest);
  } catch {
    // Best-effort move; if it fails the file stays and will be
    // re-processed next run (idempotent because canonical_key is
    // unique).
  }
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function groupItems(items: ParsedItem[]): ItemGroup[] {
  const groups = new Map<string, ItemGroup>();
  for (const item of items) {
    if (!d8AllowsKind(item)) continue;
    // Explicitly-global items (personal scope, person/area keys, and a
    // handful of well-known preference keys) always land in the global
    // bucket; every other item keeps the v2 scope emitted by Stage 1, so
    // the same canonical_key in different scopes forms separate entries.
    const scope = isExplicitlyGlobal(item, item.canonicalKey)
      ? 'global'
      : item.scopeHint ?? 'global';
    const scopeId = scope === 'global' ? null : item.scopeId ?? null;
    const groupKey = `${item.canonicalKey}::${scope}::${scopeId ?? ''}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = { canonicalKey: item.canonicalKey, scope, scopeId, items: [] };
      groups.set(groupKey, group);
    }
    group.items.push(item);
  }
  return Array.from(groups.values());
}

function stage1ItemId(item: ParsedItem): string {
  if (item.isAdHoc) return `ad-hoc#${item.canonicalKey}`;
  return `${item.rolloutId}#${item.itemIndex}`;
}

function retireCanonicalAliases(
  db: Database,
  targetMemoryId: string,
  group: ItemGroup,
  kind: MemoryEntryRow['kind'],
  now: number,
  retiredDiff: Phase2DiffEntry[]
): number {
  const candidates = db
    .prepare(
      `SELECT * FROM memory_entries
       WHERE status = 'active' AND kind = ? AND scope = ?
         AND COALESCE(scope_id, '') = COALESCE(?, '')`
    )
    .all(kind, group.scope, group.scopeId) as MemoryEntryRow[];
  let retired = 0;
  for (const candidate of candidates) {
    if (candidate.memory_id === targetMemoryId) continue;
    if (normalizeCanonicalKey(candidate.kind, candidate.canonical_key, candidate.content) !== group.canonicalKey) {
      continue;
    }

    db.prepare(
      `INSERT OR IGNORE INTO memory_evidence (memory_id, rollout_id, stage1_item_id, relation)
       SELECT ?, rollout_id, stage1_item_id, 'supporting'
       FROM memory_evidence WHERE memory_id = ?`
    ).run(targetMemoryId, candidate.memory_id);
    db.prepare(
      "UPDATE memory_entries SET status = 'retired', updated_at = ? WHERE memory_id = ?"
    ).run(now, candidate.memory_id);
    retiredDiff.push({
      memory_id: candidate.memory_id,
      canonical_key: candidate.canonical_key,
      content: candidate.content,
      kind: candidate.kind,
      scope: candidate.scope,
      project_id: candidate.project_id,
    });
    retired++;
  }
  return retired;
}

function enforceActiveMemoryBudgets(
  db: Database,
  now: number,
  retiredDiff: Phase2DiffEntry[]
): number {
  const active = db
    .prepare("SELECT * FROM memory_entries WHERE status = 'active'")
    .all() as MemoryEntryRow[];
  const candidates: MemoryEntryRow[] = [];
  for (const entry of active) {
    if (entry.kind === 'person' || entry.kind === 'area') continue;
    candidates.push(entry);
  }

  candidates.sort((a, b) => {
    const protectedA = a.canonical_key.startsWith('ad-hoc:') ? 1 : 0;
    const protectedB = b.canonical_key.startsWith('ad-hoc:') ? 1 : 0;
    return protectedB - protectedA || summaryEntryRank(b) - summaryEntryRank(a) || b.updated_at - a.updated_at;
  });

  let retired = 0;
  for (const entry of candidates.slice(ACTIVE_MEMORY_LIMIT_PER_SCOPE)) {
    db.prepare(
      "UPDATE memory_entries SET status = 'retired', updated_at = ? WHERE memory_id = ?"
    ).run(now, entry.memory_id);
    retiredDiff.push({
      memory_id: entry.memory_id,
      canonical_key: entry.canonical_key,
      content: entry.content,
      kind: entry.kind,
      scope: entry.scope,
      project_id: entry.project_id,
    });
    retired++;
  }
  return retired;
}

function retireUnsupportedGlobalEntries(
  db: Database,
  supportedKeys: Set<string>,
  now: number,
  retiredDiff: Phase2DiffEntry[]
): number {
  const active = db
    .prepare("SELECT * FROM memory_entries WHERE status = 'active'")
    .all() as MemoryEntryRow[];
  let retired = 0;
  for (const entry of active) {
    const entryKey = `${entry.canonical_key}::${entry.scope}::${entry.scope_id ?? ''}`;
    if (
      entry.canonical_key.startsWith('ad-hoc:') ||
      entry.kind === 'person' ||
      entry.kind === 'area' ||
      supportedKeys.has(entryKey)
    ) {
      continue;
    }
    db.prepare(
      "UPDATE memory_entries SET status = 'retired', updated_at = ? WHERE memory_id = ?"
    ).run(now, entry.memory_id);
    retiredDiff.push({
      memory_id: entry.memory_id,
      canonical_key: entry.canonical_key,
      content: entry.content,
      kind: entry.kind,
      scope: entry.scope,
      project_id: entry.project_id,
    });
    retired += 1;
  }
  return retired;
}

function summaryEntryRank(entry: MemoryEntryRow): number {
  switch (entry.kind) {
    case 'preference': return 5;
    case 'decision': case 'invariant': return 4.5;
    case 'goal': case 'commitment': return 4.2;
    case 'procedure': return 4;
    case 'fact': return 3;
    case 'capability': return 2.8;
    case 'reference': return 2;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function runConsolidator(input: ConsolidatorInput): ConsolidatorResult {
  const start = input.now ?? Date.now();
  const lockTimeoutMs = input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const rootDir = input.rootDir ?? path.join(os.homedir(), '.duya', 'memory');
  const now = (): number => input.now ?? Date.now();

  // Step 1: Acquire global lock.
  const lockResult = acquireLock(input.db, start, lockTimeoutMs);
  if (lockResult.skipped) {
    return {
      skipped: true,
      added: 0,
      merged: 0,
      superseded: 0,
      retired: 0,
      adHocDigested: 0,
      durationMs: now() - start,
    };
  }
  const runId = lockResult.runId;
  const token = lockResult.token;

  // Step 2: Compute input_set_hash.
  const inputSetHash = computeInputSetHash(input.db);

  // Step 3: CAS-skip.
  if (isCasSkip(input.db, inputSetHash)) {
    releaseLock(
      input.db,
      runId,
      token,
      now(),
      'succeeded',
      inputSetHash,
      JSON.stringify({ skipped: true, reason: 'cas-skip' })
    );
    return {
      skipped: true,
      runId,
      added: 0,
      merged: 0,
      superseded: 0,
      retired: 0,
      adHocDigested: 0,
      durationMs: now() - start,
    };
  }

  // Step 4: Parse stage1 items.
  const stage1Items = parseStage1Items(input.db);

  // Step 4b: Scan ad-hoc files.
  const adHocFiles = scanAdHocFiles(rootDir);
  const adHocItems: ParsedItem[] = adHocFiles.map((f) => ({
    rolloutId: 'ad-hoc',
    itemIndex: 0,
    claim: f.content,
    claimType: 'fact',
    canonicalKey: f.canonicalKey,
    evidence: [
      {
        source_type: 'user_message',
        source_id: f.filename,
        verification: 'verified_user',
      },
    ],
    generatedAt: start,
    isAdHoc: true,
    content: f.content,
  }));

  // Step 5: Group items.
  const allItems = [...stage1Items, ...adHocItems];
  const groups = groupItems(allItems);

  // Steps 6-10: single BEGIN IMMEDIATE transaction.
  let transactionCommitted = false;
  let txnResult: {
    added: number;
    merged: number;
    superseded: number;
    retired: number;
  };

  try {
    txnResult = input.db.transaction((): {
      added: number;
      merged: number;
      superseded: number;
      retired: number;
    } => {
      let added = 0;
      let merged = 0;
      let superseded = 0;
      let retired = 0;
      const diffAdded: Phase2DiffEntry[] = [];
      const diffSuperseded: Phase2DiffEntry[] = [];
      const diffRetired: Phase2DiffEntry[] = [];

      // Steps 6-8: per-group UPSERT + evidence.
      for (const group of groups) {
        const winner = pickWinner(group.items);

        // Person/area entries merge all claims into a summary+details
        // body; other kinds use the winner's claim as-is.
        const isPersonArea = isPersonAreaKey(group.canonicalKey);
        const groupContent = isPersonArea
          ? mergePersonAreaContent(group.items)
          : winner.content;

        // Query existing entry for this (canonical_key, scope, scope_id)
        // bucket — the same key in a different scope is a different entry.
        const existing = input.db
          .prepare(
            `SELECT * FROM memory_entries
             WHERE canonical_key = ? AND scope = ?
               AND COALESCE(scope_id, '') = COALESCE(?, '')`
          )
          .get(group.canonicalKey, group.scope, group.scopeId) as MemoryEntryRow | undefined;

        let memoryId: string;
        if (!existing) {
          // Step 7: INSERT new entry, including the v2 lifecycle columns
          // added by migration 0007.
          memoryId = crypto.randomUUID();
          input.db
            .prepare(
              `INSERT INTO memory_entries
                 (memory_id, scope, project_id, kind, canonical_key, content,
                  version, status, created_at, updated_at,
                  confidence, valid_from, valid_until, relation_to_existing,
                  supersedes, why_future_agent_needs_this, retrieval_cues,
                  scope_id)
               VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              memoryId,
              group.scope,
              legacyProjectId(group.scope, group.scopeId),
              winner.claimType,
              group.canonicalKey,
              groupContent,
              winner.status ?? 'active',
              start,
              start,
              winner.confidence ?? null,
              winner.validFrom ?? null,
              winner.validUntil ?? null,
              winner.relationToExisting ?? null,
              winner.supersedesKeys && winner.supersedesKeys.length > 0
                ? JSON.stringify(winner.supersedesKeys)
                : null,
              winner.whyFutureAgentNeedsThis ?? null,
              winner.retrievalCues && winner.retrievalCues.length > 0
                ? JSON.stringify(winner.retrievalCues)
                : null,
              group.scopeId
            );
          added++;
          diffAdded.push({
            memory_id: memoryId,
            canonical_key: group.canonicalKey,
            content: groupContent,
            kind: winner.claimType,
            scope: group.scope,
            project_id: legacyProjectId(group.scope, group.scopeId),
          });
        } else {
          memoryId = existing.memory_id;
          if (existing.content !== groupContent || existing.status !== 'active') {
            // Merge: version bump + new content (winner preferred), and
            // refresh the v2 lifecycle fields from the winning item.
            input.db
              .prepare(
                `UPDATE memory_entries
                   SET content = ?, version = version + 1, updated_at = ?, kind = ?,
                       status = ?, confidence = ?, valid_from = ?, valid_until = ?,
                       relation_to_existing = ?, supersedes = ?,
                       why_future_agent_needs_this = ?, retrieval_cues = ?,
                       scope_id = ?
                 WHERE memory_id = ?`
              )
              .run(
                groupContent,
                start,
                winner.claimType,
                winner.status ?? 'active',
                winner.confidence ?? null,
                winner.validFrom ?? null,
                winner.validUntil ?? null,
                winner.relationToExisting ?? null,
                winner.supersedesKeys && winner.supersedesKeys.length > 0
                  ? JSON.stringify(winner.supersedesKeys)
                  : null,
                winner.whyFutureAgentNeedsThis ?? null,
                winner.retrievalCues && winner.retrievalCues.length > 0
                  ? JSON.stringify(winner.retrievalCues)
                  : null,
                group.scopeId,
                memoryId
              );
            merged++;
            diffSuperseded.push({
              memory_id: memoryId,
              canonical_key: group.canonicalKey,
              content: groupContent,
              kind: winner.claimType,
              scope: group.scope,
              project_id: existing.project_id,
            });
          }
        }

        // Step 8: INSERT evidence rows.
        for (const item of group.items) {
          const itemId = stage1ItemId(item);
          const relation = item === winner ? 'source' : 'supporting';
          input.db
            .prepare(
              `INSERT OR IGNORE INTO memory_evidence
                 (memory_id, rollout_id, stage1_item_id, relation)
               VALUES (?, ?, ?, ?)`
            )
            .run(memoryId, item.rolloutId, itemId, relation);
        }

        retired += retireCanonicalAliases(
          input.db,
          memoryId,
          group,
          winner.claimType,
          start,
          diffRetired
        );
      }

      const supportedKeys = new Set(
        groups.map((group) => `${group.canonicalKey}::${group.scope}::${group.scopeId ?? ''}`)
      );
      retired += retireUnsupportedGlobalEntries(
        input.db,
        supportedKeys,
        start,
        diffRetired
      );
      retired += enforceActiveMemoryBudgets(input.db, start, diffRetired);

      // Step 9: Render + enqueue 5 projection files.
      const entries = input.db
        .prepare('SELECT * FROM memory_entries')
        .all() as MemoryEntryRow[];

      // Single searchable projections. The memory system is global-only;
      // no per-project files or sections are maintained.
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'MEMORY.md'),
        operation: 'write',
        content: renderUnifiedMemoryFile(entries),
        now: start,
      });
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'summary.md'),
        operation: 'write',
        content: renderMemorySummaryFile(entries),
        now: start,
      });

      // global/people/<slug>.md — one file per active person entry.
      // global/areas/<slug>.md  — one file per active area entry.
      const personSlugs = new Set<string>();
      const areaSlugs = new Set<string>();
      for (const entry of entries) {
        if (entry.status !== 'active') continue;
        const slug = personAreaSlug(entry.canonical_key);
        if (slug === null) continue;
        if (entry.kind === 'person') personSlugs.add(slug);
        else if (entry.kind === 'area') areaSlugs.add(slug);
      }
      for (const slug of personSlugs) {
        enqueueProjectionOutbox(input.db, {
          targetPath: path.join(rootDir, 'global', 'people', `${slug}.md`),
          operation: 'write',
          content: renderPersonFile(entries, slug),
          now: start,
        });
      }
      for (const slug of areaSlugs) {
        enqueueProjectionOutbox(input.db, {
          targetPath: path.join(rootDir, 'global', 'areas', `${slug}.md`),
          operation: 'write',
          content: renderAreaFile(entries, slug),
          now: start,
        });
      }
      // People/areas index files.
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'global', 'people', 'index.md'),
        operation: 'write',
        content: renderPeopleIndexFile(entries),
        now: start,
      });
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'global', 'areas', 'index.md'),
        operation: 'write',
        content: renderAreasIndexFile(entries),
        now: start,
      });

      // phase2_workspace_diff.md
      const diff: Phase2Diff = {
        added: diffAdded,
        superseded: diffSuperseded,
        retired: diffRetired,
        runId,
        inputHash: inputSetHash,
        timestamp: start,
      };
      enqueueProjectionOutbox(input.db, {
        targetPath: path.join(rootDir, 'phase2_workspace_diff.md'),
        operation: 'write',
        content: renderPhase2WorkspaceDiff(diff),
        now: start,
      });

      // Step 10: UPDATE phase2_runs + release lock.
      const outputDiffSummary = JSON.stringify(diff);
      input.db
        .prepare(
          `UPDATE phase2_runs
             SET finished_at = ?, status = 'succeeded',
                 input_set_hash = ?, output_diff_summary = ?,
                 lock_holder = NULL
           WHERE id = ? AND lock_holder = ?`
        )
        .run(start, inputSetHash, outputDiffSummary, runId, token);

      return { added, merged, superseded, retired };
    }).immediate();

    transactionCommitted = true;
  } finally {
    if (!transactionCommitted) {
      // Transaction failed/rolled back — release the lock as 'failed'.
      try {
        releaseLock(
          input.db,
          runId,
          token,
          now(),
          'failed',
          inputSetHash,
          JSON.stringify({ error: 'transaction-failed' })
        );
      } catch {
        // Best-effort release; the lock will eventually go stale and
        // be stolen by the next run.
      }
    }
  }

  // Move ad-hoc files to .digested/ after successful transaction.
  for (const file of adHocFiles) {
    moveAdHocToDigested(file, rootDir);
  }

  // Prune old phase2_runs rows (best-effort; outside the main
  // transaction so a failure here does not roll back the run).
  try {
    prunePhase2Runs(input.db);
  } catch {
    // Non-critical: the table just grows until next successful run.
  }

  return {
    skipped: false,
    runId,
    added: txnResult.added,
    merged: txnResult.merged,
    superseded: txnResult.superseded,
    retired: txnResult.retired,
    adHocDigested: adHocFiles.length,
    durationMs: now() - start,
  };
}
