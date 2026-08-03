/**
 * Rebuild the `memory_entries` cache from live memory files (Plan 406 Phase C).
 *
 * Design doc §3.7: `memory_entries` is downgraded to a rebuildable cache.
 * After each successful curation publication, `rebuildMemoryEntriesFromFiles` wipes the
 * table and reinserts one row per canonical file under `memory/items/` and
 * `memory/entities/`. The two real consumers (Stage 1 `queryExistingKeys`
 * and Settings `memory:list`) keep working off the cache during the Phase C
 * shadow window, then switch to file manifests in Phase D (Task 6 / Task 7).
 *
 * This module is deliberately self-contained: it owns the YAML frontmatter
 * parser for canonical files so it does not depend on `curation_projection`
 * (which is renderer-side and lives in `electron/memory`).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from 'better-sqlite3';

export interface ParsedCanonicalFile {
  memory_id: string;
  canonical_key: string;
  claim_type: string;
  scope: string;
  scope_id: string | null;
  project_id: string | null;
  status: string;
  importance: string;
  file_path: string;
  updated_at: string;
}

const REQUIRED_FIELDS: ReadonlyArray<keyof ParsedCanonicalFile> = [
  'memory_id',
  'canonical_key',
  'claim_type',
  'scope',
  'status',
  'importance',
  'updated_at',
];

/**
 * Parse a single canonical memory file (YAML frontmatter + markdown body).
 * Returns `null` when the file is missing, has no frontmatter, or is missing
 * a required field. The `file_path` field is set to the absolute path passed
 * in so callers can INSERT it into `memory_entries`.
 *
 * The parser is intentionally narrow: it handles only the flat key-value
 * subset of YAML used by canonical memory files (§4.1). Nested structures
 * like `evidence:` arrays are ignored — they live in frontmatter for the
 * agent, not for the cache.
 */
export function parseCanonicalFile(filePath: string): ParsedCanonicalFile | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return null;

  const frontmatter = match[1];
  const fields: Partial<ParsedCanonicalFile> = { file_path: filePath };
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    const value = rawValue.trim();
    switch (key) {
      case 'memory_id':
      case 'canonical_key':
      case 'claim_type':
      case 'scope':
      case 'status':
      case 'importance':
      case 'updated_at':
        fields[key] = value;
        break;
      case 'scope_id':
      case 'project_id':
        fields[key] = value === 'null' || value === '' ? null : value;
        break;
      default:
        // Ignore unknown keys (evidence, summary_eligible, retrieval_cues, etc.)
        break;
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (fields[field] === undefined || fields[field] === '') return null;
  }

  return fields as ParsedCanonicalFile;
}

export interface RebuildResult {
  processed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Walk `memoryRoot/items` and `memoryRoot/entities` recursively for `.md`
 * files, parse each file, and repopulate `memory_entries` from scratch.
 *
 * Algorithm:
 *   1. BEGIN IMMEDIATE
 *   2. DELETE FROM memory_entries   (full wipe — cache is rebuildable)
 *   3. For each .md file under items/ + entities/:
 *      - parseCanonicalFile → on null, increment `skipped` and continue
 *      - INSERT one row (kind = claim_type, content = file body)
 *   4. COMMIT
 *
 * Design doc §3.7 step 1 + §8.4 step 9: invoked after a successful
 * curation publication. If this function throws, the caller (publish
 * orchestrator) MUST set `cache_status='cache_pending'` but MUST NOT
 * roll back the filesystem — live memory is already committed.
 *
 * The `memory_entries` schema is owned by migration 0005 (and amended by
 * 0006/0007). This function only writes columns that exist in all three
 * migrations; later columns added by 0006/0007 are left to default.
 */
export async function rebuildMemoryEntriesFromFiles(db: Database, memoryRoot: string): Promise<RebuildResult> {
  const start = Date.now();
  const files: string[] = [];
  for (const sub of ['items', 'entities']) {
    const subRoot = path.join(memoryRoot, sub);
    if (!fs.existsSync(subRoot)) continue;
    walkMd(subRoot, files);
  }

  const insert = db.prepare(
    `INSERT INTO memory_entries
       (memory_id, scope, project_id, kind, canonical_key, content, version, status, created_at, updated_at)
     VALUES (@memory_id, @scope, @project_id, @kind, @canonical_key, @content, 1, @status, @now, @now)`
  );

  let processed = 0;
  let skipped = 0;
  const now = Date.now();

  const txn = db.transaction(() => {
    db.exec('DELETE FROM memory_entries');
    for (const file of files) {
      const parsed = parseCanonicalFile(file);
      if (!parsed) {
        skipped += 1;
        continue;
      }
      insert.run({
        memory_id: parsed.memory_id,
        scope: parsed.scope,
        project_id: parsed.project_id,
        kind: parsed.claim_type,
        canonical_key: parsed.canonical_key,
        content: parsed.canonical_key, // cache content is the key; full body lives in the file
        status: parsed.status,
        now,
      });
      processed += 1;
    }
  });
  txn.immediate();

  return { processed, skipped, durationMs: Date.now() - start };
}

function walkMd(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walkMd(full, out);
    } else if (stat.isFile() && entry.endsWith('.md')) {
      out.push(full);
    }
  }
}