/**
 * Stage 1 policy incremental editor (Plan 433).
 *
 * Replaces the "curator emits FULL new policy text, writePolicy replaces
 * the whole file" flow with surgical, deterministic, id-anchored edits.
 *
 * Canonical policy format (v2):
 *
 *   # <title line>                      <- preamble, preserved verbatim
 *   <any prose lines>                   <- preamble, preserved verbatim
 *
 *   ### S1: PROJECT & ENVIRONMENT TOPOLOGY
 *
 *   - [r:paths-verbatim] 保留项目根路径原文 …
 *   - [r:toolchain] …
 *
 *   ### S2: ACTIVE FOCUS
 *   …
 *   ### S9: GENERAL EXTRACTION RULES
 *
 * - Section ids (S1..S9) and titles are FIXED. The curator never renames,
 *   reorders, or re-levels them — that kills the concept churn observed
 *   in the 2026-08-12..17 policy history.
 * - Every rule bullet carries a stable machine id `[r:<kebab-id>]`. The
 *   curator references rules by id, so an edit touches ONE bullet and
 *   everything else stays byte-identical.
 * - Non-bullet lines inside a section are preserved as section notes
 *   (verbatim, no id) so migration is lossless.
 * - `migrateLegacyPolicy` converts free-form / `### 维度 N:` files to the
 *   anchored skeleton (format-only; rule ids derived from content hashes,
 *   stable across runs).
 */

import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { loadPolicy, writePolicy } from './stage1_prompt_loader.js';

/** Hard cap on the serialized policy size (mirrors the old prompt cap). */
export const MAX_POLICY_BYTES = 8192;
/** Max rules the curator may change in one run. */
export const MAX_EDITS_PER_RUN = 3;
/** Max length of one rule text. */
export const MAX_RULE_TEXT = 500;

/**
 * Fixed section skeleton. Section ids are stable forever; titles are
 * stable forever. `id` is what the curator targets in `edits[].section`.
 */
export const POLICY_SECTION_DEFS: ReadonlyArray<{ id: string; title: string }> = [
  { id: 'S1', title: 'PROJECT & ENVIRONMENT TOPOLOGY' },
  { id: 'S2', title: 'ACTIVE FOCUS' },
  { id: 'S3', title: 'COMMUNICATION & INTERACTION STYLE' },
  { id: 'S4', title: 'RECURRING WORKFLOWS & TASK PATTERNS' },
  { id: 'S5', title: 'CONTENT TASTE & INFORMATION DIET' },
  { id: 'S6', title: 'FAILURE MODES & ENVIRONMENT PITFALLS' },
  { id: 'S7', title: 'PEOPLE & RELATIONSHIPS' },
  { id: 'S8', title: 'PREFERENCES & CORRECTIONS' },
  { id: 'S9', title: 'GENERAL EXTRACTION RULES' },
];

export const POLICY_SECTION_IDS: ReadonlySet<string> = new Set(
  POLICY_SECTION_DEFS.map((s) => s.id),
);

/** One rule bullet inside a section. `id` is the `[r:<id>]` anchor. */
export interface PolicyRule {
  id: string;
  text: string;
}

/**
 * One policy section. `notes` are verbatim non-bullet lines kept during
 * migration; `rules` are the editable rule bullets.
 */
export interface PolicySection {
  id: string;
  title: string;
  notes: string[];
  rules: PolicyRule[];
}

/** Parsed policy document: preamble + ordered sections. */
export interface PolicyDocument {
  preamble: string;
  sections: PolicySection[];
}

/** Curator-proposed surgical policy edit (mirrors the curation protocol). */
export interface PolicyEdit {
  op: 'upsert_rule' | 'remove_rule';
  section: string;
  rule_id: string;
  /** Full bullet text WITHOUT the `[r:id]` prefix. Required for upsert_rule. */
  text?: string;
  reason?: string;
}

export interface PolicyEditResult {
  /** True when the on-disk content changed (and version was bumped). */
  changed: boolean;
  /** Version after the write (current version when unchanged). */
  version: number;
  /** sha256 of the final content. */
  hash: string;
  /** Non-fatal rejections (unknown section/rule id, size cap). */
  errors: string[];
}

const RULE_LINE_RE = /^\s*-\s+\[r:([a-z0-9][a-z0-9-]{0,39})\]\s*(.*)$/;
const SECTION_HEADER_RE = /^###\s+(S[1-9]\d*)\s*:\s*(.+)$/;
/** Legacy `### `-level headers are sections; `#`/`##` title lines are preamble. */
const LEGACY_SECTION_HEADER_RE = /^###\s+(.+)$/;
/** Legacy dimension headers like `### 维度 1: PROJECT & ENVIRONMENT TOPOLOGY`. */
const LEGACY_DIMENSION_RE = /^维度\s*(\d+)\s*[:：]?\s*(.*)$/;

function hashId(text: string): string {
  return 'r-' + crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

/**
 * Parse an anchored policy document. Returns null when the content is not
 * in the anchored format (no `### S<n>:` section header anywhere).
 */
export function parsePolicy(content: string): PolicyDocument | null {
  const lines = content.split('\n');
  const doc: PolicyDocument = { preamble: '', sections: [] };
  let current: PolicySection | null = null;
  let sawAnchoredHeader = false;

  const flush = () => {
    if (current !== null) {
      doc.sections.push(current);
      current = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = line.match(SECTION_HEADER_RE);
    if (header) {
      sawAnchoredHeader = true;
      flush();
      current = { id: header[1], title: header[2].trim(), notes: [], rules: [] };
      continue;
    }
    if (current === null) {
      doc.preamble += (doc.preamble.length > 0 ? '\n' : '') + line;
      continue;
    }
    const rule = line.match(RULE_LINE_RE);
    if (rule) {
      current.rules.push({ id: rule[1], text: rule[2] });
    } else if (line.trim().length > 0) {
      current.notes.push(line);
    }
  }
  flush();

  if (!sawAnchoredHeader) return null;
  // Trim trailing blank lines from the preamble.
  doc.preamble = doc.preamble.replace(/\s+$/, '');
  return doc;
}

/**
 * Serialize a policy document to canonical markdown. Sections with no
 * rules AND no notes are omitted; everything else keeps its position.
 */
export function serializePolicy(doc: PolicyDocument): string {
  const parts: string[] = [];
  if (doc.preamble.trim().length > 0) {
    parts.push(doc.preamble.trimEnd());
  }
  for (const section of doc.sections) {
    const body: string[] = [];
    for (const note of section.notes) body.push(note);
    for (const rule of section.rules) {
      body.push(`- [r:${rule.id}] ${rule.text}`);
    }
    if (body.length === 0) continue;
    parts.push(`### ${section.id}: ${section.title}`);
    parts.push(body.join('\n'));
  }
  return parts.join('\n\n') + '\n';
}

/**
 * True when the content is already in the anchored format.
 */
export function isAnchoredPolicy(content: string): boolean {
  return parsePolicy(content) !== null;
}

/**
 * Convert a legacy (pre-Plan-433, free-form or `### 维度 N:` style) policy
 * to the anchored skeleton. Format-only: no rule text is changed or dropped.
 *
 * - `### 维度 N: <title>` headers map to `S<N>` and keep their title.
 * - Any other `###`-level section maps to the catch-all `S9` with its
 *   original title (S9 exists to absorb legacy sections; ids S1..S8 are
 *   the canonical dimension names).
 * - Bullet lines become rules with stable hash-derived ids (deterministic
 *   across runs and machines).
 * - Non-bullet lines become section notes, preserved verbatim.
 * - Content with no section headers at all becomes a single S9 section.
 */
export function migrateLegacyPolicy(content: string): PolicyDocument {
  const lines = content.split('\n');
  const doc: PolicyDocument = { preamble: '', sections: [] };
  let current: PolicySection | null = null;

  const flush = () => {
    if (current !== null) {
      doc.sections.push(current);
      current = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const header = line.match(LEGACY_SECTION_HEADER_RE);
    if (header) {
      const headerText = header[1].trim();
      const dim = headerText.match(LEGACY_DIMENSION_RE);
      if (dim) {
        // `### 维度 3: COMMUNICATION & INTERACTION STYLE` -> S3.
        const n = parseInt(dim[1], 10);
        const title = dim[2].trim() || (POLICY_SECTION_DEFS[n - 1]?.title ?? headerText);
        if (n >= 1 && n <= 8) {
          flush();
          current = { id: `S${n}`, title, notes: [], rules: [] };
          continue;
        }
      }
      // Anything else becomes the catch-all S9 section.
      flush();
      current = { id: 'S9', title: headerText, notes: [], rules: [] };
      continue;
    }
    if (current === null) {
      doc.preamble += (doc.preamble.length > 0 ? '\n' : '') + line;
      continue;
    }
    // A migrated bullet without an id gets a stable hash id.
    const plainBullet = line.match(/^\s*-\s+(.*)$/);
    if (plainBullet && plainBullet[1].trim().length > 0) {
      const text = plainBullet[1].trim();
      current.rules.push({ id: hashId(text), text });
    } else if (line.trim().length > 0) {
      current.notes.push(line);
    }
  }
  flush();

  // Content with no headers at all: fold everything into S9.
  if (doc.sections.length === 0) {
    const all = doc.preamble.trim();
    doc.preamble = '';
    doc.sections.push({ id: 'S9', title: 'GENERAL EXTRACTION RULES', notes: [], rules: [] });
    for (const line of all.split('\n')) {
      const bullet = line.match(/^\s*-\s+(.*)$/);
      if (bullet && bullet[1].trim().length > 0) {
        doc.sections[0].rules.push({ id: hashId(bullet[1].trim()), text: bullet[1].trim() });
      } else if (line.trim().length > 0) {
        doc.sections[0].notes.push(line);
      }
    }
  }

  doc.preamble = doc.preamble.replace(/\s+$/, '');
  return doc;
}

/**
 * Normalize any policy content (legacy or anchored) to the canonical
 * serialized form. Pure function — no I/O.
 */
export function normalizePolicy(content: string): string {
  const parsed = parsePolicy(content);
  const doc = parsed ?? migrateLegacyPolicy(content);
  return serializePolicy(doc);
}

/**
 * Read the policy file for the curator prompt: anchored-normalized content
 * plus the current version. Returns null when the file does not exist.
 */
export async function readPolicyForPrompt(policyPath: string): Promise<{
  version: number;
  content: string;
} | null> {
  const loaded = await loadPolicy(policyPath);
  if (loaded.content.length === 0) return null;
  return { version: loaded.version, content: normalizePolicy(loaded.content) };
}

/**
 * Apply surgical policy edits to the file on disk. Deterministic:
 *
 *   1. Read the current file (auto-migrate legacy format in memory).
 *   2. Apply each edit by section id + rule id. Unknown section or rule id
 *      is recorded in `errors` and skipped — never a full-file write.
 *   3. Serialize; reject the whole batch when the result exceeds
 *      MAX_POLICY_BYTES.
 *   4. Write atomically + bump `.version` ONLY when content changed
 *      (same-hash edits are no-ops).
 *
 * The migration is persisted only when a write happens anyway; a legacy
 * file with `no_change` stays untouched on disk.
 */
export async function applyPolicyEdits(
  policyPath: string,
  edits: ReadonlyArray<PolicyEdit>,
): Promise<PolicyEditResult> {
  const errors: string[] = [];

  let raw = '';
  try {
    raw = await fs.readFile(policyPath, 'utf8');
  } catch {
    // Missing file: start from an empty document (S9 catch-all exists via
    // migration of empty content). Writes will create the file.
  }

  const doc = parsePolicy(raw) ?? migrateLegacyPolicy(raw);

  for (const edit of edits) {
    if (!POLICY_SECTION_IDS.has(edit.section)) {
      errors.push(`unknown section ${edit.section} (rule ${edit.rule_id})`);
      continue;
    }
    let section = doc.sections.find((s) => s.id === edit.section);
    if (edit.op === 'remove_rule') {
      if (!section) {
        errors.push(`section ${edit.section} has no rules; cannot remove ${edit.rule_id}`);
        continue;
      }
      const idx = section.rules.findIndex((r) => r.id === edit.rule_id);
      if (idx < 0) {
        errors.push(`rule ${edit.rule_id} not found in section ${edit.section}`);
        continue;
      }
      section.rules.splice(idx, 1);
      continue;
    }
    // upsert_rule
    const text = (edit.text ?? '').trim();
    if (text.length === 0) {
      errors.push(`upsert_rule ${edit.rule_id} in ${edit.section} has empty text`);
      continue;
    }
    if (text.length > MAX_RULE_TEXT) {
      errors.push(`rule ${edit.rule_id} exceeds ${MAX_RULE_TEXT} chars`);
      continue;
    }
    if (!section) {
      // Empty sections are omitted from serialization; materialize on demand.
      const def = POLICY_SECTION_DEFS.find((s) => s.id === edit.section);
      section = { id: edit.section, title: def?.title ?? edit.section, notes: [], rules: [] };
      doc.sections.push(section);
      doc.sections.sort((a, b) => a.id.localeCompare(b.id));
    }
    const existing = section.rules.find((r) => r.id === edit.rule_id);
    if (existing) {
      existing.text = text;
    } else {
      section.rules.push({ id: edit.rule_id, text });
    }
  }

  const serialized = serializePolicy(doc);

  if (serialized.length > MAX_POLICY_BYTES) {
    errors.push(
      `policy after edits exceeds ${MAX_POLICY_BYTES} bytes (${serialized.length}); batch rejected`,
    );
    const loaded = await loadPolicy(policyPath);
    return {
      changed: false,
      version: loaded.version,
      hash: loaded.hash,
      errors,
    };
  }

  const res = await writePolicy(policyPath, serialized);
  return {
    changed: res.changed,
    version: res.version,
    hash: res.hash,
    errors,
  };
}

/** Validation helpers shared with the curation protocol schema. */
export const POLICY_EDIT_OPTS = ['upsert_rule', 'remove_rule'] as const;
export const POLICY_RULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const POLICY_SECTION_RE = /^S[1-9]\d*$/;
