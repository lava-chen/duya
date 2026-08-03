/**
 * Curation staging validator (Memory Phase 2 redesign, design §8.4 step 6).
 *
 * Pure filesystem validator — no DB, no Electron. Runs over a staging
 * workspace after the curator agent has finished editing, before the
 * publisher touches live memory.
 *
 * Layers:
 *   validateReceipt        — curation_receipt.json exists, parses, every
 *                            claimed input has a disposition, files_changed
 *                            only lists agent-authored paths.
 *   validateCanonicalFiles — every .md under items/ + entities/ has valid
 *                            YAML frontmatter (claim_type, scope, status,
 *                            importance, scope_id/project_id rules).
 *   validateSecurity       — secret scan, symlink escape, path traversal.
 *   validateStaging        — aggregate of the above + layout check.
 *
 * Design: docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md
 *   §8.4 step 6, §10.3, §12, §4.1.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { CLAIM_TYPES, SCOPES } from '../memory-rollout/types.js';
import type { RunInput } from './curation_prompt.js';

// Re-export so callers can import everything from the validator.
export type { RunInput } from './curation_prompt.js';

// ---------------------------------------------------------------------------
// Receipt types + constants
// ---------------------------------------------------------------------------

export type Disposition = 'absorbed' | 'no_change' | 'rejected' | 'deferred';

const VALID_DISPOSITIONS: ReadonlySet<Disposition> = new Set([
  'absorbed',
  'no_change',
  'rejected',
  'deferred',
]);

export interface ReceiptInput {
  input_kind: string;
  input_key: string;
  content_hash: string;
  disposition: string;
  note?: string;
}

export interface CurationReceipt {
  run_id: string;
  inputs: ReceiptInput[];
  files_changed: string[];
  policy_proposal?: string | null;
  layout_changed: boolean;
  health: {
    added: number;
    merged: number;
    retired: number;
    no_change: number;
    rejected: number;
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// Projection files the agent must NOT author (design §10.3).
const PROJECTION_FILE_NAMES = new Set(['MEMORY.md', 'summary.md', 'index.md']);

// Prefixes that are valid agent-authored paths in files_changed
// (design §12: "only agent-authored canonical files under items/ or
// entities/ and any changed config files").
const VALID_FILES_CHANGED_PREFIXES = ['items/', 'entities/', 'memory-config/'];

// ---------------------------------------------------------------------------
// validateReceipt
// ---------------------------------------------------------------------------

/**
 * Validate curation_receipt.json against the inputs claimed by the run.
 *
 * Checks (design §8.4 step 6 + §12):
 *   - curation_receipt.json exists and parses as JSON
 *   - the parsed object has the receipt shape (inputs[], files_changed[])
 *   - every RunInput has a matching receipt.inputs[] entry with a
 *     valid disposition
 *   - files_changed only lists paths starting with items/, entities/,
 *     or memory-config/; never absolute paths, never projection files
 *     (MEMORY.md, summary.md, index.md)
 *
 * `stagingDir` is the run-specific staging directory that contains
 * curation_receipt.json. `runInputs` is the array the worker claimed
 * for this run (from curation_ledger.claimRun).
 */
export function validateReceipt(
  stagingDir: string,
  runInputs: RunInput[],
): ValidationResult {
  const errors: string[] = [];
  const receiptPath = path.join(stagingDir, 'curation_receipt.json');

  if (!fs.existsSync(receiptPath)) {
    errors.push(`curation_receipt.json not found at ${receiptPath}`);
    return { valid: false, errors };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(receiptPath, 'utf-8');
  } catch (e) {
    errors.push(`curation_receipt.json could not be read: ${(e as Error).message}`);
    return { valid: false, errors };
  }

  let receipt: unknown;
  try {
    receipt = JSON.parse(raw);
  } catch (e) {
    errors.push(`curation_receipt.json is not valid JSON: ${(e as Error).message}`);
    return { valid: false, errors };
  }

  const r = receipt as Partial<CurationReceipt>;
  if (!r || typeof r !== 'object') {
    errors.push('curation_receipt.json: expected a JSON object');
    return { valid: false, errors };
  }
  if (!Array.isArray(r.inputs)) {
    errors.push('curation_receipt.json: inputs[] is missing or not an array');
    return { valid: false, errors };
  }
  if (!Array.isArray(r.files_changed)) {
    errors.push('curation_receipt.json: files_changed[] is missing or not an array');
    return { valid: false, errors };
  }

  // Index receipt inputs by (input_kind, input_key, content_hash).
  const receiptIndex = new Map<string, ReceiptInput>();
  for (const ri of r.inputs) {
    const key = `${ri.input_kind}\0${ri.input_key}\0${ri.content_hash}`;
    receiptIndex.set(key, ri);
  }

  // Every claimed runInput must have a disposition in the receipt.
  for (const inp of runInputs) {
    const key = `${inp.inputKind}\0${inp.inputKey}\0${inp.contentHash}`;
    const ri = receiptIndex.get(key);
    if (!ri) {
      errors.push(
        `missing disposition in receipt for input (kind=${inp.inputKind}, key=${inp.inputKey}, hash=${inp.contentHash})`,
      );
      continue;
    }
    if (!VALID_DISPOSITIONS.has(ri.disposition as Disposition)) {
      errors.push(
        `invalid disposition '${ri.disposition}' for input key=${inp.inputKey} (expected absorbed | no_change | rejected | deferred)`,
      );
    }
  }

  // files_changed only lists agent-authored paths; no projections,
  // no absolute paths, no traversal.
  for (const relPath of r.files_changed) {
    if (typeof relPath !== 'string') {
      errors.push(`files_changed contains a non-string entry: ${JSON.stringify(relPath)}`);
      continue;
    }
    if (path.isAbsolute(relPath)) {
      errors.push(`files_changed contains an absolute path: ${relPath}`);
      continue;
    }
    if (relPath.includes('..')) {
      errors.push(`files_changed contains a path with '..': ${relPath}`);
      continue;
    }
    const base = path.basename(relPath);
    if (PROJECTION_FILE_NAMES.has(base)) {
      errors.push(
        `files_changed lists a projection file '${relPath}' — ${base} is code-generated, not agent-authored`,
      );
      continue;
    }
    const ok = VALID_FILES_CHANGED_PREFIXES.some((p) => relPath === p || relPath.startsWith(p));
    if (!ok) {
      errors.push(
        `files_changed entry '${relPath}' is not under items/, entities/, or memory-config/`,
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Canonical file frontmatter validation
// ---------------------------------------------------------------------------

const VALID_CANONICAL_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'superseded',
  'retired',
]);

const VALID_IMPORTANCE: ReadonlySet<string> = new Set([
  'essential',
  'high',
  'normal',
]);

const CLAIM_TYPE_SET: ReadonlySet<string> = new Set(CLAIM_TYPES as readonly string[]);
const SCOPE_SET: ReadonlySet<string> = new Set(SCOPES as readonly string[]);

const SCOPES_REQUIRING_PROJECT_ID: ReadonlySet<string> = new Set([
  'project',
  'repository',
  'app',
]);

const SCOPES_WITH_NULL_SCOPE_ID: ReadonlySet<string> = new Set([
  'personal',
  'global',
]);

const REQUIRED_FRONTMATTER_FIELDS = [
  'canonical_key',
  'claim_type',
  'scope',
  'status',
  'importance',
] as const;

// Files under memory/ that the agent must NEVER author (design §10.3).
const PROJECTION_BASENAMES = new Set(['MEMORY.md', 'summary.md', 'index.md']);

/**
 * Parse `---\n<yaml>\n---\n<body>` frontmatter from a Markdown file.
 * Returns `{ frontmatter, body }` or `null` when no frontmatter block
 * is present.
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } | null {
  // Match leading `---` on the first line.
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  const [, yamlBlock, body] = match;
  let parsed: unknown;
  try {
    parsed = yaml.parse(yamlBlock);
  } catch {
    throw new Error('frontmatter is not valid YAML');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('frontmatter is not a YAML object');
  }
  return { frontmatter: parsed as Record<string, unknown>, body };
}

function validateFrontmatter(filePath: string): string[] {
  const errors: string[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    errors.push(`could not read ${filePath}: ${(e as Error).message}`);
    return errors;
  }

  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(content) ?? { frontmatter: {}, body: content };
    if (Object.keys(parsed.frontmatter).length === 0) {
      errors.push(`${filePath}: no YAML frontmatter found`);
      return errors;
    }
  } catch (e) {
    errors.push(`${filePath}: ${(e as Error).message}`);
    return errors;
  }

  const fm = parsed.frontmatter;

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (fm[field] === undefined || fm[field] === null) {
      errors.push(`${filePath}: missing frontmatter field '${field}'`);
    }
  }

  const claimType = fm.claim_type;
  if (typeof claimType === 'string' && !CLAIM_TYPE_SET.has(claimType)) {
    errors.push(`${filePath}: invalid claim_type '${claimType}' (must be one of ${CLAIM_TYPES.join(', ')})`);
  }

  const scope = fm.scope;
  if (typeof scope === 'string' && !SCOPE_SET.has(scope)) {
    errors.push(`${filePath}: invalid scope '${scope}' (must be one of ${SCOPES.join(', ')})`);
  }

  const status = fm.status;
  if (typeof status === 'string' && !VALID_CANONICAL_STATUSES.has(status)) {
    errors.push(`${filePath}: invalid status '${status}' (must be active | superseded | retired)`);
  }

  const importance = fm.importance;
  if (typeof importance === 'string' && !VALID_IMPORTANCE.has(importance)) {
    errors.push(`${filePath}: invalid importance '${importance}' (must be essential | high | normal)`);
  }

  // scope_id / project_id rules (design §4.1).
  if (typeof scope === 'string') {
    if (SCOPES_WITH_NULL_SCOPE_ID.has(scope)) {
      if (fm.scope_id !== null && fm.scope_id !== undefined) {
        errors.push(`${filePath}: scope=${scope} requires scope_id=null (got ${JSON.stringify(fm.scope_id)})`);
      }
    }
    if (SCOPES_REQUIRING_PROJECT_ID.has(scope)) {
      if (fm.project_id === null || fm.project_id === undefined || fm.project_id === '') {
        errors.push(`${filePath}: scope=${scope} requires a non-null project_id (project_id is required for this scope)`);
      }
    }
  }

  return errors;
}

function walkMarkdownFiles(dir: string, onFile: (absPath: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // directory does not exist — nothing to walk
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, onFile);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      onFile(full);
    }
  }
}

/**
 * Validate every .md file under <stagingMemoryDir>/items/ and
 * <stagingMemoryDir>/entities/ for correct YAML frontmatter (design §4.1
 * + §8.4 step 6). Also rejects projection files (MEMORY.md, summary.md,
 * index.md) that the agent must NOT author (design §10.3).
 *
 * `stagingMemoryDir` is the staging/<run_id>/memory/ directory.
 */
export async function validateCanonicalFiles(stagingMemoryDir: string): Promise<ValidationResult> {
  const errors: string[] = [];

  // Reject projection files anywhere under stagingMemoryDir.
  walkMarkdownFiles(stagingMemoryDir, (absPath) => {
    const base = path.basename(absPath);
    if (PROJECTION_BASENAMES.has(base)) {
      errors.push(
        `${absPath}: agent-authored projection file '${base}' is not allowed — ${base} is code-generated (design §10.3)`,
      );
    }
  });

  // Validate frontmatter on every .md under items/ and entities/.
  for (const sub of ['items', 'entities']) {
    const subDir = path.join(stagingMemoryDir, sub);
    walkMarkdownFiles(subDir, (absPath) => {
      // Skip index.md (already flagged above as a projection file).
      const base = path.basename(absPath);
      if (PROJECTION_BASENAMES.has(base)) return;
      const fileErrors = validateFrontmatter(absPath);
      errors.push(...fileErrors);
    });
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Security validation
// ---------------------------------------------------------------------------

/**
 * Regex patterns for common credential leaks. The scan is intentionally
 * conservative: a false positive is better than shipping a secret to
 * live memory. Patterns cover AWS, GitHub, Google, private key blocks,
 * and a generic `api_key=...` form.
 *
 * NOT a complete secret scanner — a dedicated DLP tool would do better.
 * This is the pre-publication backstop for the curator agent's output.
 */
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'AWS Access Key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub Token', pattern: /\bghp_[0-9A-Za-z]{36,}\b/ },
  { name: 'GitHub OAuth Token', pattern: /\bgho_[0-9A-Za-z]{36,}\b/ },
  { name: 'Google API Key', pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'Private Key Block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/ },
  { name: 'Generic api_key assignment', pattern: /\bapi[_-]?key[_-]?\s*[=:]\s*['"]?[0-9A-Za-z]{32,}['"]?/i },
  { name: 'Generic secret assignment', pattern: /\bsecret[_-]?\s*[=:]\s*['"]?[0-9A-Za-z]{32,}['"]?/i },
];

function scanForSecrets(content: string): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      hits.push(name);
    }
  }
  return hits;
}

/**
 * Walk every file under `dir` (recursively). For each file:
 *   - reject if it is a symlink (design §8.4 step 6: "no symlink escape")
 *   - reject if its realpath escapes `root` (path traversal)
 *   - scan content for credential patterns
 *
 * Returns the list of error messages. Empty list = clean.
 */
function walkAndScan(dir: string, root: string, errors: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const realRoot = fs.realpathSync(root);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${full}: symlink is not allowed inside staging (design §8.4 step 6)`);
      continue;
    }
    if (entry.isDirectory()) {
      walkAndScan(full, root, errors);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    // Realpath escape check: the resolved file must stay under realRoot.
    let realFull: string;
    try {
      realFull = fs.realpathSync(full);
    } catch (e) {
      errors.push(`${full}: could not resolve realpath (${(e as Error).message})`);
      continue;
    }
    const rel = path.relative(realRoot, realFull);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      errors.push(`${full}: path escapes staging root (realpath → ${realFull})`);
      continue;
    }
    // Secret scan.
    let content: string;
    try {
      content = fs.readFileSync(full, 'utf-8');
    } catch {
      // Binary or unreadable file — skip content scan.
      continue;
    }
    const hits = scanForSecrets(content);
    if (hits.length > 0) {
      errors.push(`${full}: possible secret detected (${hits.join(', ')})`);
    }
  }
}

/**
 * Validate the security invariants of a staging workspace (design §8.4
 * step 6):
 *   - no symlink anywhere under staging (agent must not create symlinks)
 *   - no path traversal (every file's realpath stays inside stagingDir)
 *   - no secret patterns in any file content
 *
 * `stagingDir` is the run-specific staging directory (contains memory/,
 * memory-config/, inputs/, curation_receipt.json).
 */
export async function validateSecurity(stagingDir: string): Promise<ValidationResult> {
  const errors: string[] = [];
  if (!fs.existsSync(stagingDir)) {
    errors.push(`staging directory does not exist: ${stagingDir}`);
    return { valid: false, errors };
  }
  walkAndScan(stagingDir, stagingDir, errors);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Aggregate validation
// ---------------------------------------------------------------------------

export interface AggregateValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Run all pre-publication checks against a staging workspace (design
 * §8.4 step 6 + §10.3):
 *
 *   1. validateReceipt(stagingDir, runInputs)
 *   2. validateCanonicalFiles(stagingDir/memory)
 *   3. validateSecurity(stagingDir)
 *   4. layout sanity check — if the receipt claims layout_changed=true
 *      but memory-config/memory_layout.json is missing, emit a soft
 *      warning (the publisher still needs the file to render indexes).
 *
 * `valid` is true iff every check returns valid=true. `warnings`
 * carries soft observations that do NOT block publication.
 */
export async function validateStaging(
  stagingDir: string,
  runInputs: RunInput[],
): Promise<AggregateValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Receipt.
  const receiptResult = validateReceipt(stagingDir, runInputs);
  errors.push(...receiptResult.errors);

  // Read the receipt back for the layout_changed warning (best-effort;
  // if the receipt is missing/unparseable, validateReceipt already
  // recorded the error and we skip the layout warning).
  let layoutChanged = false;
  if (receiptResult.valid) {
    try {
      const raw = fs.readFileSync(path.join(stagingDir, 'curation_receipt.json'), 'utf-8');
      const parsed = JSON.parse(raw) as CurationReceipt;
      layoutChanged = !!parsed.layout_changed;
    } catch {
      // validateReceipt already flagged this; do not double-report.
    }
  }

  // 2. Canonical files + projection-file rejection.
  const memoryDir = path.join(stagingDir, 'memory');
  if (fs.existsSync(memoryDir)) {
    const canonicalResult = await validateCanonicalFiles(memoryDir);
    errors.push(...canonicalResult.errors);
  }

  // 3. Security (secrets, symlinks, traversal).
  const securityResult = await validateSecurity(stagingDir);
  errors.push(...securityResult.errors);

  // 4. Layout sanity (soft warning only).
  if (layoutChanged) {
    const layoutPath = path.join(stagingDir, 'memory-config', 'memory_layout.json');
    if (!fs.existsSync(layoutPath)) {
      warnings.push(
        'receipt claims layout_changed=true but memory-config/memory_layout.json is missing — publisher cannot render entity indexes without it',
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}