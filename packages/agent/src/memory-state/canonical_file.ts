/**
 * Canonical memory file parser.
 *
 * Owns the YAML frontmatter parser for canonical memory files (the flat
 * key-value subset of YAML used by `memory/items/`, `memory/entities/`,
 * and `memory/global/` records). Extracted from the retired
 * `memory_entries_rebuild.ts` (Plan 479 §6.4 dead-code cleanup): the
 * parser is still alive — `electron/ipc/memory-handlers.ts` (Settings
 * `memory:list`) and the Plan 479 tier-index backfill both consume it —
 * while the rebuild function it once served was deleted together with
 * the `memory_entries` table (migration 0009).
 */

import * as fs from 'fs';

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
 * in so callers can key rows by it.
 *
 * The parser is intentionally narrow: it handles only the flat key-value
 * subset of YAML used by canonical memory files (§4.1). Nested structures
 * like `evidence:` arrays are ignored — they live in frontmatter for the
 * agent, not for index rows.
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
