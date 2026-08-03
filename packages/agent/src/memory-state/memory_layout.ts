/**
 * memory_layout.json parser + validator (Plan 405, design §6).
 *
 * `memory_layout.json` maps each entity claim_type to a directory under
 * `memory/`. The runtime agent prompt (`memorySection.ts`) renders only
 * validated paths + type names from this file — never arbitrary
 * description text (prompt-injection defense).
 *
 * Validation enforced at parse time (§6):
 *   - schema_version required, must be 1
 *   - each entity key ∈ 12 code-fixed claim types
 *   - dir MUST be relative, no `..`, no leading `/`, no backslash
 *   - dir MUST NOT collide with reserved paths
 *   - key_prefix MUST match `<claim_type>:`
 *   - max_files hard cap 256
 *   - total entity types capped at 12
 *   - directory depth capped at 3
 *   - string length caps on all fields (§6): dir ≤ 256, key_prefix ≤ 64, index ≤ 128
 *
 * Symlink escape check (§6 "Resolved real path MUST stay under memory/"):
 * parseLayout is a pure JSON parser and does NOT touch the filesystem, so
 * it CANNOT resolve symlinks. Symlink escape is enforced at publication
 * time by `curation_validator` (Plan 404)'s `validateSecurity`, which
 * `fs.realpathSync`-resolves each entity dir and rejects any path that
 * escapes `memory/`. parseLayout only performs lexical validation; the
 * two checks are complementary and the split is intentional.
 */

import { CLAIM_TYPES, type ClaimType } from '../memory-rollout/types.js';

const RESERVED_PATHS = new Set([
  'rollout_summaries',
  'extensions',
  '.manifest.json',
  'MEMORY.md',
  'summary.md',
]);

const MAX_FILES_CAP = 256;
const MAX_ENTITY_TYPES = CLAIM_TYPES.length; // 12
const MAX_DIR_DEPTH = 3;
// §6 string length caps on all fields.
const MAX_DIR_LENGTH = 256;
const MAX_KEY_PREFIX_LENGTH = 64;
const MAX_INDEX_LENGTH = 128;

export interface MemoryEntityConfig {
  dir: string;
  key_prefix: string;
  index: string;
  max_files: number;
}

export interface MemoryLayout {
  schema_version: 1;
  entities: Map<ClaimType, MemoryEntityConfig>;
}

export class LayoutValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LayoutValidationError';
  }
}

export const DEFAULT_LAYOUT: MemoryLayout = {
  schema_version: 1,
  entities: new Map<ClaimType, MemoryEntityConfig>([
    ['person', { dir: 'global/people', key_prefix: 'person:', index: 'index.md', max_files: 128 }],
    ['area', { dir: 'global/areas', key_prefix: 'area:', index: 'index.md', max_files: 128 }],
  ]),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new LayoutValidationError(message);
}

/** Narrowing assertion: throws unless `value` is a plain object. */
function requireObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!isObject(value)) throw new LayoutValidationError(message);
}

export function parseLayout(json: unknown): MemoryLayout {
  requireObject(json, 'layout must be an object');
  assert(json.schema_version === 1, `schema_version must be 1, got ${json.schema_version}`);
  requireObject(json.entities, 'entities must be an object');

  const entries = Object.entries(json.entities);
  assert(entries.length <= MAX_ENTITY_TYPES, `entity types exceed cap of ${MAX_ENTITY_TYPES}`);

  const entities = new Map<ClaimType, MemoryEntityConfig>();
  for (const [key, raw] of entries) {
    assert(
      (CLAIM_TYPES as readonly string[]).includes(key),
      `entity key "${key}" is not a valid claim_type (must be one of 12)`,
    );
    const claimType = key as ClaimType;
    requireObject(raw, `entity "${key}" must be an object`);

    const dir = String(raw.dir ?? '');
    const keyPrefix = String(raw.key_prefix ?? '');
    const index = String(raw.index ?? 'index.md');
    const maxFiles = Number(raw.max_files);

    assert(dir.length > 0, `entity "${key}" dir must not be empty`);
    assert(dir.length <= MAX_DIR_LENGTH, `entity "${key}" dir length ${dir.length} exceeds cap of ${MAX_DIR_LENGTH}`);
    assert(!dir.includes('..'), `entity "${key}" dir must not contain ".." (path traversal)`);
    assert(!dir.startsWith('/'), `entity "${key}" dir must not be absolute (leading slash)`);
    assert(!dir.includes('\\'), `entity "${key}" dir must not contain backslash`);
    assert(!RESERVED_PATHS.has(dir), `entity "${key}" dir "${dir}" collides with reserved path`);
    const depth = dir.split('/').filter(Boolean).length;
    assert(depth <= MAX_DIR_DEPTH, `entity "${key}" dir depth ${depth} exceeds cap of ${MAX_DIR_DEPTH}`);

    assert(
      keyPrefix === `${claimType}:`,
      `entity "${key}" key_prefix must be "${claimType}:", got "${keyPrefix}"`,
    );
    assert(
      keyPrefix.length <= MAX_KEY_PREFIX_LENGTH,
      `entity "${key}" key_prefix length ${keyPrefix.length} exceeds cap of ${MAX_KEY_PREFIX_LENGTH}`,
    );
    assert(
      index.length <= MAX_INDEX_LENGTH,
      `entity "${key}" index length ${index.length} exceeds cap of ${MAX_INDEX_LENGTH}`,
    );
    assert(
      Number.isFinite(maxFiles) && maxFiles > 0 && maxFiles <= MAX_FILES_CAP,
      `entity "${key}" max_files must be in [1, ${MAX_FILES_CAP}], got ${maxFiles}`,
    );

    entities.set(claimType, { dir, key_prefix: keyPrefix, index, max_files: maxFiles });
  }

  return { schema_version: 1, entities };
}

import * as fs from 'fs';
import * as path from 'path';

/**
 * Entity types seeded by the default layout — not subject to the evolution
 * budget (§6). New entity-type directories must accumulate ≥ 8 active items
 * in staging before they may be promoted to the live layout.
 */
const BUDGET_EXEMPT_TYPES: ReadonlySet<ClaimType> = new Set<ClaimType>(['person', 'area']);
const EVOLUTION_BUDGET_MIN_ITEMS = 8;

export interface LayoutChangeValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a layout change against the evolution budget (§6).
 *
 * A new entity-type directory (one not in the default `person` / `area` set)
 * may only be created when that claim_type has accumulated ≥ 8 active items
 * in the staging memory root. `person` and `area` are seeded from the
 * migration and are not subject to this budget.
 *
 * @param oldLayout current live layout
 * @param newLayout proposed new layout
 * @param stagingMemoryRoot staging directory holding entity files (staging/memory/)
 */
export function validateLayoutChange(
  oldLayout: MemoryLayout,
  newLayout: MemoryLayout,
  stagingMemoryRoot: string,
): LayoutChangeValidationResult {
  const errors: string[] = [];
  const oldKeys = new Set(oldLayout.entities.keys());

  for (const [claimType] of newLayout.entities) {
    if (oldKeys.has(claimType)) continue;       // existing type — no budget
    if (BUDGET_EXEMPT_TYPES.has(claimType)) continue; // person/area seeded

    const entityDir = path.join(stagingMemoryRoot, 'entities', claimType);
    let activeCount = 0;
    if (fs.existsSync(entityDir)) {
      const files = fs.readdirSync(entityDir).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        try {
          const content = fs.readFileSync(path.join(entityDir, f), 'utf8');
          if (isStatusActive(content)) activeCount++;
        } catch {
          // skip uncountable files
        }
      }
    }

    if (activeCount < EVOLUTION_BUDGET_MIN_ITEMS) {
      errors.push(
        `entity type "${claimType}" has ${activeCount} active items in staging; ` +
        `evolution budget requires ≥ ${EVOLUTION_BUDGET_MIN_ITEMS} (§6)`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Minimal frontmatter status check. Returns true if the file's YAML frontmatter
 * contains `status: "active"` (with or without quotes). Does NOT parse the full
 * frontmatter — just scans the first block between `---` markers.
 */
function isStatusActive(fileContent: string): boolean {
  const match = fileContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return false;
  return /status:\s*["']?active["']?/.test(match[1]);
}

/**
 * Render the layout as a prompt-safe string for the runtime agent's system
 * prompt (§6). Contains ONLY directory paths and claim-type names — never
 * arbitrary description text from the JSON (prompt-injection defense).
 *
 * The output is sorted by claim_type alphabetically so the prompt is stable
 * across runs regardless of JSON key order.
 */
export function renderLayoutForPrompt(layout: MemoryLayout): string {
  const lines: string[] = [];
  const sortedTypes = Array.from(layout.entities.keys()).sort();
  for (const claimType of sortedTypes) {
    const cfg = layout.entities.get(claimType)!;
    // Only the type name + dir are emitted. key_prefix, max_files, index, and
    // any description field are deliberately omitted — they are not needed by
    // the runtime agent and could be a prompt-injection vector if the layout
    // file were tampered with.
    lines.push(`- ${claimType}: ${cfg.dir}/<slug>.md`);
  }
  return lines.join('\n');
}