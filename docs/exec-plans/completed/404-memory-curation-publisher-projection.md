# Memory Phase 2 Curation Publisher & Projection (Plan 404) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add the crash-safe publication state machine (`curation_publisher.ts`), the deterministic projection generators (`curation_projection.ts` → MEMORY.md / summary.md / index.md), the pre-publish snapshot (`curation_snapshot.ts`), the health report appender (`curation_health.ts`), and the end-to-end orchestrator (`curation_publish_orchestrator.ts`) that wires ledger → staging → runner → validate → snapshot → publish → health → cleanup — with crash recovery on startup.

**Architecture:** Five modules that compose at the orchestrator boundary: (1) `curation_projection.ts` (pure, in `packages/agent`) reads canonical files from `memoryRoot/items/` + `memoryRoot/entities/`, parses YAML frontmatter, and renders `MEMORY.md` / `summary.md` / `index.md` with deterministic sorting, filtering, and hard size caps (§10.2); (2) `curation_publisher.ts` (in `electron/memory`) implements the `prepared → publishing → filesystem_committed → cache_pending → succeeded` state machine using a fsync'd journal file — each step is performed, fsync'd, then marked done in the journal before proceeding (§8.2–8.4); (3) `curation_snapshot.ts` copies managed memory files to an external snapshot directory with content-hash deduplication via hardlinks (§11.2); (4) `curation_health.ts` appends a JSONL health record per successful publication (§13); (5) `curation_publish_orchestrator.ts` ties the full cycle together and integrates crash recovery (§8.5) on startup. No live memory writes occur during Phase B shadow — all runs end at staging discard.

**Tech Stack:** TypeScript (strict), better-sqlite3 (prepared statements), Node.js `fs/promises` + `fs` + `crypto`, Vitest (colocated, temp-dir for filesystem tests, `:memory:` / file-based DB for ledger tests), Conventional Commits.

**Design doc:** `docs/design-docs/2026-08-03-memory-phase2-curation-agent-design.md` — §8 (publication protocol + journal + crash recovery), §10 (projection layering), §11.1–11.2 (failure modes + snapshots), §13 (health report).

**Predecessors:** Plan 401 (tool `allowedRoots` + curator entry), Plan 402 (migration 0008 + `curation_ledger` + `curation_staging` + `releaseAndWait`), Plan 403 (`curation_validator` + `curation_prompt` + `curation_agent_runner`).

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `packages/agent/src/memory-state/curation_projection.ts` | Pure projection generators: `generateMemoryMd` / `generateSummaryMd` / `generateIndexMd` + minimal frontmatter parser |
| Create | `packages/agent/src/memory-state/curation_projection.test.ts` | TDD tests: sorting, filtering, truncation, empty dirs |
| Create | `electron/memory/curation_publisher.ts` | `writeJournal` / `readJournal` / `preparePublication` / `executePublication` / `recoverPublication` |
| Create | `electron/memory/__tests__/curation_publisher.test.ts` | TDD tests: journal round-trip, prepare/execute/recover for each journal state |
| Create | `electron/memory/curation_snapshot.ts` | `createSnapshot` — copy managed files, hardlink dedup, retention |
| Create | `electron/memory/__tests__/curation_snapshot.test.ts` | TDD tests: snapshot structure, dedup, retention |
| Create | `packages/agent/src/memory-state/curation_health.ts` | `appendHealthReport` — JSONL append to `health.log.jsonl` |
| Create | `packages/agent/src/memory-state/curation_health.test.ts` | TDD tests: append format, JSONL parseable |
| Create | `electron/memory/curation_publish_orchestrator.ts` | `runCurationCycle` — full flow; `recoverAllPublications` — startup scan |
| Create | `electron/memory/__tests__/curation_publish_orchestrator.test.ts` | TDD tests: success flow, validation failure, agent timeout, crash recovery |

---

## Task 1: curation_projection.ts — frontmatter parser + generateMemoryMd

**Files:**
- Create: `packages/agent/src/memory-state/curation_projection.ts`
- Create: `packages/agent/src/memory-state/curation_projection.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/memory-state/curation_projection.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { generateMemoryMd, parseFrontmatter } from './curation_projection';

interface ProjEnv {
  memoryRoot: string;
  cleanup: () => void;
}

function makeEnv(): ProjEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-memory-'));
  return {
    memoryRoot,
    cleanup: () => {
      try { fs.rmSync(memoryRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function writeItem(memoryRoot: string, claimType: string, slug: string, frontmatter: Record<string, unknown>, body: string): void {
  const dir = path.join(memoryRoot, 'items', claimType);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'boolean' ? v : JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), `---\n${fm}\n---\n\n${body}`);
}

function writeEntity(memoryRoot: string, entityType: string, slug: string, frontmatter: Record<string, unknown>, body: string): void {
  const dir = path.join(memoryRoot, 'entities', entityType);
  fs.mkdirSync(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v === null ? 'null' : typeof v === 'boolean' ? v : JSON.stringify(v)}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, `${slug}.md`), `---\n${fm}\n---\n\n${body}`);
}

describe('parseFrontmatter', () => {
  it('parses simple key: value pairs and separates body', () => {
    const content = '---\ncanonical_key: "preference:style"\nclaim_type: "preference"\nstatus: "active"\nsummary_eligible: true\nimportance: "essential"\n---\n\n# Title\n\nBody paragraph.';
    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter.canonical_key).toBe('preference:style');
    expect(frontmatter.claim_type).toBe('preference');
    expect(frontmatter.status).toBe('active');
    expect(frontmatter.summary_eligible).toBe(true);
    expect(frontmatter.importance).toBe('essential');
    expect(body).toContain('# Title');
    expect(body).toContain('Body paragraph.');
  });

  it('returns empty frontmatter for content without delimiters', () => {
    const { frontmatter, body } = parseFrontmatter('# Just a title\n\nBody.');
    expect(Object.keys(frontmatter)).toHaveLength(0);
    expect(body).toBe('# Just a title\n\nBody.');
  });
});

describe('generateMemoryMd', () => {
  let env: ProjEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. groups by claim_type, sorts by canonical_key within section', () => {
    writeItem(env.memoryRoot, 'preference', 'z-style', {
      canonical_key: 'preference:z-style', claim_type: 'preference', status: 'active',
    }, '# Z Style\n\nZ body.');
    writeItem(env.memoryRoot, 'preference', 'a-style', {
      canonical_key: 'preference:a-style', claim_type: 'preference', status: 'active',
    }, '# A Style\n\nA body.');
    writeItem(env.memoryRoot, 'fact', 'mid-fact', {
      canonical_key: 'fact:mid-fact', claim_type: 'fact', status: 'active',
    }, '# Mid Fact\n\nFact body.');

    const md = generateMemoryMd(env.memoryRoot);

    // Sections appear in alphabetical claim_type order: fact, then preference.
    const factIdx = md.indexOf('## fact');
    const prefIdx = md.indexOf('## preference');
    expect(factIdx).toBeGreaterThan(-1);
    expect(prefIdx).toBeGreaterThan(-1);
    expect(factIdx).toBeLessThan(prefIdx);

    // Within preference section, a-style before z-style.
    const aIdx = md.indexOf('preference:a-style');
    const zIdx = md.indexOf('preference:z-style');
    expect(aIdx).toBeLessThan(zIdx);
  });

  it('2. excludes status=retired files', () => {
    writeItem(env.memoryRoot, 'preference', 'active-one', {
      canonical_key: 'preference:active-one', claim_type: 'preference', status: 'active',
    }, '# Active\n\nActive body.');
    writeItem(env.memoryRoot, 'preference', 'retired-one', {
      canonical_key: 'preference:retired-one', claim_type: 'preference', status: 'retired',
    }, '# Retired\n\nRetired body.');

    const md = generateMemoryMd(env.memoryRoot);
    expect(md).toContain('preference:active-one');
    expect(md).not.toContain('preference:retired-one');
  });

  it('3. includes entity files alongside item files', () => {
    writeItem(env.memoryRoot, 'preference', 'style', {
      canonical_key: 'preference:style', claim_type: 'preference', status: 'active',
    }, '# Style\n\nStyle body.');
    writeEntity(env.memoryRoot, 'people', 'alice', {
      canonical_key: 'person:alice', claim_type: 'person', status: 'active',
    }, '# Alice\n\nAlice bio.');

    const md = generateMemoryMd(env.memoryRoot);
    expect(md).toContain('preference:style');
    expect(md).toContain('person:alice');
  });

  it('4. empty memory root returns empty string', () => {
    const md = generateMemoryMd(env.memoryRoot);
    expect(md).toBe('');
  });

  it('5. truncates at 64KiB and appends truncation marker', () => {
    // Write enough files to exceed 64KiB.
    for (let i = 0; i < 200; i++) {
      const slug = `item-${String(i).padStart(3, '0')}`;
      writeItem(env.memoryRoot, 'fact', slug, {
        canonical_key: `fact:${slug}`, claim_type: 'fact', status: 'active',
      }, `# ${slug}\n\n${'x'.repeat(500)}`);
    }

    const md = generateMemoryMd(env.memoryRoot);
    expect(md.length).toBeLessThanOrEqual(64 * 1024 + 100); // cap + marker
    expect(md.length).toBeGreaterThanOrEqual(64 * 1024 - 1024);  // close to cap
    expect(md).toContain('<!-- truncated -->');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: FAIL — module `./curation_projection` not found.

- [x] **Step 3: Write the implementation**

Create `packages/agent/src/memory-state/curation_projection.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Deterministic projection generators for Memory Phase 2 (design §10.2).
 *
 * The agent maintains normalized canonical files under
 * `memory/items/<claim_type>/<slug>.md` and `memory/entities/<type>/<slug>.md`.
 * This module reads those files and renders the three code-generated
 * projections: MEMORY.md (searchable index), summary.md (bounded routing),
 * and per-entity-type index.md.
 *
 * All functions are pure with respect to the filesystem state at call
 * time — same files on disk always produce byte-identical output.
 */

// ---------------------------------------------------------------------------
// Hard limits (design §10.2)
// ---------------------------------------------------------------------------

export const MEMORY_MD_MAX_BYTES = 64 * 1024;
export const SUMMARY_MD_MAX_CHARS = 6_000;
export const SUMMARY_TOP_N = 12;

const TRUNCATION_MARKER = '\n<!-- truncated -->';

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse a YAML frontmatter block delimited by `---` lines.
 *
 * This is NOT a full YAML parser — it handles only the flat `key: value`
 * shape used by canonical memory files (design §4.1). Values may be:
 *   - double-quoted strings: `key: "value"`
 *   - unquoted scalars: `key: value`
 *   - booleans: `key: true` / `key: false`
 *   - null: `key: null`
 *
 * Returns `{ frontmatter, body }` where `body` is everything after the
 * closing `---`. If no frontmatter delimiters are present, returns an
 * empty frontmatter object and the full content as body.
 */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, string | boolean | null>;
  body: string;
} {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { frontmatter: {}, body: content };
  }

  // Find the closing delimiter.
  const firstDelimEnd = content.indexOf('\n');
  const afterFirst = content.slice(firstDelimEnd + 1);
  const closeIdx = afterFirst.search(/^---\s*$/m);
  if (closeIdx === -1) {
    return { frontmatter: {}, body: content };
  }

  const fmBlock = afterFirst.slice(0, closeIdx);
  const bodyStart = afterFirst.indexOf('\n', closeIdx + 3);
  const body = bodyStart === -1 ? '' : afterFirst.slice(bodyStart + 1);

  const frontmatter: Record<string, string | boolean | null> = {};
  for (const line of fmBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value: string | boolean | null = trimmed.slice(colonIdx + 1).trim();

    // Strip double quotes.
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    } else if (value === 'true') {
      value = true;
    } else if (value === 'false') {
      value = false;
    } else if (value === 'null') {
      value = null;
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

// ---------------------------------------------------------------------------
// File scanning
// ---------------------------------------------------------------------------

interface CanonicalFile {
  relPath: string;       // relative to memoryRoot, posix-style
  canonicalKey: string;
  claimType: string;
  status: string;
  importance: string;
  summaryEligible: boolean;
  updatedAt: string;
  body: string;
}

function readCanonicalFiles(memoryRoot: string): CanonicalFile[] {
  const files: CanonicalFile[] = [];

  for (const sub of ['items', 'entities']) {
    const subDir = path.join(memoryRoot, sub);
    if (!fs.existsSync(subDir)) continue;
    walkMarkdown(subDir, memoryRoot, files);
  }

  return files;
}

function walkMarkdown(dir: string, memoryRoot: string, out: CanonicalFile[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip symlinks (path-escape defense).
    if (entry.isSymbolicLink()) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(fullPath, memoryRoot, out);
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
      const content = fs.readFileSync(fullPath, 'utf8');
      const { frontmatter, body } = parseFrontmatter(content);
      const relPath = path.relative(memoryRoot, fullPath).split(path.sep).join('/');
      out.push({
        relPath,
        canonicalKey: String(frontmatter.canonical_key ?? ''),
        claimType: String(frontmatter.claim_type ?? ''),
        status: String(frontmatter.status ?? 'active'),
        importance: String(frontmatter.importance ?? 'normal'),
        summaryEligible: frontmatter.summary_eligible === true,
        updatedAt: String(frontmatter.updated_at ?? ''),
        body,
      });
    }
  }
}

/**
 * Extract the first paragraph from the markdown body: skip the H1 title
 * and any blank lines, then take text until the next blank line or heading.
 */
function firstParagraph(body: string): string {
  const lines = body.split('\n');
  let started = false;
  const paraLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('# ')) continue; // skip H1 title
    if (line.trim() === '') {
      if (started) break;
      continue;
    }
    if (line.startsWith('#')) break; // any heading after paragraph started
    started = true;
    paraLines.push(line.trim());
  }
  return paraLines.join(' ');
}

// ---------------------------------------------------------------------------
// generateMemoryMd (design §10.2)
// ---------------------------------------------------------------------------

/**
 * Generate the searchable `MEMORY.md` projection.
 *
 * - One line per active canonical file (status != 'retired').
 * - Sectioned by `claim_type` (alphabetical), sorted by `canonical_key` within section.
 * - Line format: `- **<canonical_key>**: <first paragraph> → <relative path>`
 * - Hard cap: 64 KiB. Truncated with `<!-- truncated -->` marker.
 */
export function generateMemoryMd(memoryRoot: string): string {
  const files = readCanonicalFiles(memoryRoot);
  const active = files.filter((f) => f.status !== 'retired' && f.canonicalKey);

  if (active.length === 0) return '';

  // Group by claim_type.
  const byClaimType = new Map<string, CanonicalFile[]>();
  for (const f of active) {
    const arr = byClaimType.get(f.claimType) ?? [];
    arr.push(f);
    byClaimType.set(f.claimType, arr);
  }

  const claimTypes = [...byClaimType.keys()].sort();
  const lines: string[] = [
    '# Durable Memory',
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const ct of claimTypes) {
    const sectionFiles = byClaimType.get(ct)!.sort((a, b) =>
      a.canonicalKey.localeCompare(b.canonicalKey)
    );
    lines.push(`## ${ct}`);
    lines.push('');
    for (const f of sectionFiles) {
      const para = firstParagraph(f.body);
      lines.push(`- **${f.canonicalKey}**: ${para} → ${f.relPath}`);
    }
    lines.push('');
  }

  let result = lines.join('\n');

  // Truncate at 64 KiB.
  if (Buffer.byteLength(result, 'utf8') > MEMORY_MD_MAX_BYTES) {
    // Truncate by character count approximating the byte cap.
    const maxChars = MEMORY_MD_MAX_BYTES;
    result = result.slice(0, maxChars);
    // Cut at last newline to avoid partial lines.
    const lastNl = result.lastIndexOf('\n');
    if (lastNl > 0) result = result.slice(0, lastNl);
    result += TRUNCATION_MARKER;
  }

  return result;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: PASS — all tests in `parseFrontmatter` and `generateMemoryMd` pass.

- [x] **Step 5: Commit**

```bash
git add packages/agent/src/memory-state/curation_projection.ts \
        packages/agent/src/memory-state/curation_projection.test.ts
git commit -m "feat(agent): add curation_projection generateMemoryMd with frontmatter parser"
```

---

## Task 2: curation_projection.ts — generateSummaryMd

**Files:**
- Modify: `packages/agent/src/memory-state/curation_projection.ts`
- Modify: `packages/agent/src/memory-state/curation_projection.test.ts`

- [x] **Step 1: Write the failing tests**

Append the following `describe` block to `packages/agent/src/memory-state/curation_projection.test.ts`. Add `generateSummaryMd` to the import at the top:

```typescript
import { generateMemoryMd, generateSummaryMd, parseFrontmatter } from './curation_projection';
```

Append:

```typescript
describe('generateSummaryMd', () => {
  let env: ProjEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. sorts by importance (essential > high > normal)', () => {
    writeItem(env.memoryRoot, 'fact', 'normal-one', {
      canonical_key: 'fact:normal-one', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Normal\n\nNormal summary.');
    writeItem(env.memoryRoot, 'fact', 'essential-one', {
      canonical_key: 'fact:essential-one', claim_type: 'fact', status: 'active',
      importance: 'essential', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Essential\n\nEssential summary.');
    writeItem(env.memoryRoot, 'fact', 'high-one', {
      canonical_key: 'fact:high-one', claim_type: 'fact', status: 'active',
      importance: 'high', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# High\n\nHigh summary.');

    const md = generateSummaryMd(env.memoryRoot);

    // essential first, then high, then normal.
    const essIdx = md.indexOf('fact:essential-one');
    const highIdx = md.indexOf('fact:high-one');
    const normalIdx = md.indexOf('fact:normal-one');
    expect(essIdx).toBeLessThan(highIdx);
    expect(highIdx).toBeLessThan(normalIdx);
  });

  it('2. within same importance, sorts by updated_at descending', () => {
    writeItem(env.memoryRoot, 'fact', 'older', {
      canonical_key: 'fact:older', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Older\n\nOlder.');
    writeItem(env.memoryRoot, 'fact', 'newer', {
      canonical_key: 'fact:newer', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-03T00:00:00Z',
    }, '# Newer\n\nNewer.');

    const md = generateSummaryMd(env.memoryRoot);
    const olderIdx = md.indexOf('fact:older');
    const newerIdx = md.indexOf('fact:newer');
    // newer (later updated_at) comes first.
    expect(newerIdx).toBeLessThan(olderIdx);
  });

  it('3. stable tie-break by canonical_key ascending when importance + updated_at equal', () => {
    writeItem(env.memoryRoot, 'fact', 'zeta', {
      canonical_key: 'fact:zeta', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Zeta\n\nZeta.');
    writeItem(env.memoryRoot, 'fact', 'alpha', {
      canonical_key: 'fact:alpha', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Alpha\n\nAlpha.');

    const md = generateSummaryMd(env.memoryRoot);
    const alphaIdx = md.indexOf('fact:alpha');
    const zetaIdx = md.indexOf('fact:zeta');
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it('4. excludes summary_eligible=false', () => {
    writeItem(env.memoryRoot, 'fact', 'eligible', {
      canonical_key: 'fact:eligible', claim_type: 'fact', status: 'active',
      importance: 'normal', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Eligible\n\nEligible.');
    writeItem(env.memoryRoot, 'fact', 'ineligible', {
      canonical_key: 'fact:ineligible', claim_type: 'fact', status: 'active',
      importance: 'essential', summary_eligible: false, updated_at: '2026-08-01T00:00:00Z',
    }, '# Ineligible\n\nIneligible.');

    const md = generateSummaryMd(env.memoryRoot);
    expect(md).toContain('fact:eligible');
    expect(md).not.toContain('fact:ineligible');
  });

  it('5. excludes status=retired even if summary_eligible=true', () => {
    writeItem(env.memoryRoot, 'fact', 'retired', {
      canonical_key: 'fact:retired', claim_type: 'fact', status: 'retired',
      importance: 'essential', summary_eligible: true, updated_at: '2026-08-01T00:00:00Z',
    }, '# Retired\n\nRetired.');
    const md = generateSummaryMd(env.memoryRoot);
    expect(md).not.toContain('fact:retired');
  });

  it('6. top 12 limit — only first 12 entries included', () => {
    for (let i = 0; i < 15; i++) {
      writeItem(env.memoryRoot, 'fact', `item-${i}`, {
        canonical_key: `fact:item-${i}`, claim_type: 'fact', status: 'active',
        importance: 'normal', summary_eligible: true,
        updated_at: `2026-08-01T00:0${i % 10}:00Z`,
      }, `# Item ${i}\n\nItem ${i} summary.`);
    }
    const md = generateSummaryMd(env.memoryRoot);
    // Count summary lines (lines starting with "- **").
    const summaryLines = md.split('\n').filter((l) => l.startsWith('- **'));
    expect(summaryLines).toHaveLength(12);
  });

  it('7. character cap at 6000 — truncates with marker', () => {
    for (let i = 0; i < 50; i++) {
      writeItem(env.memoryRoot, 'fact', `long-${i}`, {
        canonical_key: `fact:long-${i}`, claim_type: 'fact', status: 'active',
        importance: 'essential', summary_eligible: true,
        updated_at: `2026-08-01T00:00:00Z`,
      }, `# Long ${i}\n\n${'x'.repeat(200)}`);
    }
    const md = generateSummaryMd(env.memoryRoot);
    expect(md.length).toBeLessThanOrEqual(6_000 + 50); // cap + marker
    expect(md).toContain('<!-- truncated -->');
  });

  it('8. empty memory root returns empty string', () => {
    const md = generateSummaryMd(env.memoryRoot);
    expect(md).toBe('');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: FAIL — `generateSummaryMd` is not exported from `./curation_projection`.

- [x] **Step 3: Write the implementation**

Append the following to `packages/agent/src/memory-state/curation_projection.ts` (after the existing `generateMemoryMd` function):

```typescript
// ---------------------------------------------------------------------------
// generateSummaryMd (design §10.2)
// ---------------------------------------------------------------------------

const IMPORTANCE_RANK: Record<string, number> = {
  essential: 0,
  high: 1,
  normal: 2,
};

/**
 * Generate the bounded `summary.md` routing layer.
 *
 * Ranking (deterministic, code-only):
 *   1. Filter: status='active' AND summary_eligible=true
 *   2. Sort by importance (essential > high > normal)
 *   3. Within same importance, sort by updated_at descending
 *   4. Stable tie-break by canonical_key ascending
 *   5. Take top 12, render each as `- **<canonical_key>**: <summary>`
 *   6. Hard cap: 6000 characters
 */
export function generateSummaryMd(memoryRoot: string): string {
  const files = readCanonicalFiles(memoryRoot);
  const eligible = files.filter(
    (f) => f.status === 'active' && f.summaryEligible && f.canonicalKey
  );

  if (eligible.length === 0) return '';

  const sorted = eligible.sort((a, b) => {
    const rankA = IMPORTANCE_RANK[a.importance] ?? 2;
    const rankB = IMPORTANCE_RANK[b.importance] ?? 2;
    if (rankA !== rankB) return rankA - rankB;
    // updated_at descending.
    const timeCmp = b.updatedAt.localeCompare(a.updatedAt);
    if (timeCmp !== 0) return timeCmp;
    // canonical_key ascending.
    return a.canonicalKey.localeCompare(b.canonicalKey);
  });

  const top = sorted.slice(0, SUMMARY_TOP_N);
  const lines: string[] = [
    '# Memory Summary',
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const f of top) {
    const summary = firstParagraph(f.body);
    lines.push(`- **${f.canonicalKey}**: ${summary}`);
  }

  let result = lines.join('\n');

  if (result.length > SUMMARY_MD_MAX_CHARS) {
    result = result.slice(0, SUMMARY_MD_MAX_CHARS);
    const lastNl = result.lastIndexOf('\n');
    if (lastNl > 0) result = result.slice(0, lastNl);
    result += '\n<!-- truncated -->';
  }

  return result;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: PASS — all tests in all describe blocks pass.

- [x] **Step 5: Commit**

```bash
git add packages/agent/src/memory-state/curation_projection.ts \
        packages/agent/src/memory-state/curation_projection.test.ts
git commit -m "feat(agent): add curation_projection generateSummaryMd with ranking + cap"
```

---

## Task 3: curation_projection.ts — generateIndexMd

**Files:**
- Modify: `packages/agent/src/memory-state/curation_projection.ts`
- Modify: `packages/agent/src/memory-state/curation_projection.test.ts`

- [x] **Step 1: Write the failing tests**

Add `generateIndexMd` to the import at the top of `packages/agent/src/memory-state/curation_projection.test.ts`:

```typescript
import { generateMemoryMd, generateSummaryMd, generateIndexMd, parseFrontmatter } from './curation_projection';
```

Append the following `describe` block:

```typescript
describe('generateIndexMd', () => {
  let env: ProjEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. lists entity files sorted by slug with display name + relative path', () => {
    writeEntity(env.memoryRoot, 'people', 'zoe', {
      canonical_key: 'person:zoe', claim_type: 'person', status: 'active',
    }, '# Zoe\n\nZoe bio.');
    writeEntity(env.memoryRoot, 'people', 'alice', {
      canonical_key: 'person:alice', claim_type: 'person', status: 'active',
    }, '# Alice\n\nAlice bio.');

    const md = generateIndexMd(env.memoryRoot, 'people');

    // Alice (slug: alice) before Zoe (slug: zoe).
    const aliceIdx = md.indexOf('alice');
    const zoeIdx = md.indexOf('zoe');
    expect(aliceIdx).toBeLessThan(zoeIdx);

    // Link format: [display name](relative path)
    expect(md).toContain('[Alice](./alice.md)');
    expect(md).toContain('[Zoe](./zoe.md)');
  });

  it('2. uses slug as display name when no H1 title in body', () => {
    writeEntity(env.memoryRoot, 'areas', 'frontend', {
      canonical_key: 'area:frontend', claim_type: 'area', status: 'active',
    }, 'No heading here.\n\nJust body.');

    const md = generateIndexMd(env.memoryRoot, 'areas');
    // Display name falls back to slug with dashes replaced by spaces.
    expect(md).toContain('[frontend](./frontend.md)');
  });

  it('3. empty entity directory returns empty string', () => {
    const md = generateIndexMd(env.memoryRoot, 'people');
    expect(md).toBe('');
  });

  it('4. excludes index.md itself from the listing', () => {
    writeEntity(env.memoryRoot, 'people', 'alice', {
      canonical_key: 'person:alice', claim_type: 'person', status: 'active',
    }, '# Alice\n\nAlice bio.');
    // Manually write an index.md (should be excluded).
    fs.writeFileSync(
      path.join(env.memoryRoot, 'entities', 'people', 'index.md'),
      '# People Index\n'
    );

    const md = generateIndexMd(env.memoryRoot, 'people');
    expect(md).toContain('[Alice](./alice.md)');
    // The index.md should not appear as a self-referencing entry.
    expect(md).not.toContain('[Index](./index.md)');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: FAIL — `generateIndexMd` is not exported from `./curation_projection`.

- [x] **Step 3: Write the implementation**

Append the following to `packages/agent/src/memory-state/curation_projection.ts` (after the existing `generateSummaryMd` function):

```typescript
// ---------------------------------------------------------------------------
// generateIndexMd (design §10.2)
// ---------------------------------------------------------------------------

/**
 * Generate `entities/<entityType>/index.md` — a list of entity files
 * in the given entity type directory, sorted by slug.
 *
 * Each line: `- [<display name>](<relative path>)`
 *
 * The display name is extracted from the file's H1 title (`# Title`);
 * if no H1 is found, the slug (with dashes replaced by spaces) is used.
 * The relative path is `./<slug>.md` (relative to the index.md location).
 */
export function generateIndexMd(memoryRoot: string, entityType: string): string {
  const entityDir = path.join(memoryRoot, 'entities', entityType);
  if (!fs.existsSync(entityDir)) return '';

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(entityDir, { withFileTypes: true });
  } catch {
    return '';
  }

  interface IndexEntry {
    slug: string;
    displayName: string;
  }

  const indexEntries: IndexEntry[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.md')) continue;
    if (entry.name === 'index.md') continue;

    const slug = entry.name.slice(0, -3); // strip .md
    const fullPath = path.join(entityDir, entry.name);
    const content = fs.readFileSync(fullPath, 'utf8');
    const { body } = parseFrontmatter(content);

    // Extract H1 title.
    let displayName = slug.replace(/-/g, ' ');
    for (const line of body.split('\n')) {
      if (line.startsWith('# ')) {
        displayName = line.slice(2).trim();
        break;
      }
      if (line.trim() !== '' && !line.startsWith('#')) break;
    }

    indexEntries.push({ slug, displayName });
  }

  if (indexEntries.length === 0) return '';

  indexEntries.sort((a, b) => a.slug.localeCompare(b.slug));

  const lines: string[] = [
    `# ${entityType} index`,
    '',
    '<!-- Auto-generated by DUYA Memory Phase 2. Do not edit. -->',
    '',
  ];

  for (const e of indexEntries) {
    lines.push(`- [${e.displayName}](./${e.slug}.md)`);
  }

  return lines.join('\n');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/memory-state/curation_projection.test.ts`
Expected: PASS — all tests in all describe blocks pass.

- [x] **Step 5: Commit**

```bash
git add packages/agent/src/memory-state/curation_projection.ts \
        packages/agent/src/memory-state/curation_projection.test.ts
git commit -m "feat(agent): add curation_projection generateIndexMd"
```

---

## Task 4: curation_publisher.ts — writeJournal + readJournal

**Files:**
- Create: `electron/memory/curation_publisher.ts`
- Create: `electron/memory/__tests__/curation_publisher.test.ts`

- [x] **Step 1: Write the failing test**

Create `electron/memory/__tests__/curation_publisher.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { writeJournal, readJournal, type PublicationJournal } from '../curation_publisher';

interface PubEnv {
  stagingDir: string;
  journalPath: string;
  cleanup: () => void;
}

function makeEnv(): PubEnv {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-staging-'));
  return {
    stagingDir,
    journalPath: path.join(stagingDir, 'publication.journal.json'),
    cleanup: () => {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function makeJournal(overrides?: Partial<PublicationJournal>): PublicationJournal {
  return {
    run_id: 'run-1',
    generation: 1,
    old_manifest_hash: 'old-hash',
    new_manifest_hash: 'new-hash',
    old_policy_version: 3,
    new_policy_version: 4,
    old_layout_version: 2,
    new_layout_version: 2,
    backup_dir: 'memory-staging/run-1/backup/',
    steps: [
      { step: 'backup_old', path: 'memory-staging/run-1/backup/', status: 'done', ts: '2026-08-03T10:00:00Z' },
      { step: 'move_leaf', files: ['items/preference/x.md'], status: 'pending', ts: null },
      { step: 'move_config', files: [], status: 'pending', ts: null },
      { step: 'regenerate_indexes', files: ['entities/people/index.md'], status: 'pending', ts: null },
      { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
      { step: 'regenerate_summary_md', status: 'pending', ts: null },
      { step: 'swap_manifest', status: 'pending', ts: null },
    ],
    ...overrides,
  };
}

describe('writeJournal + readJournal', () => {
  let env: PubEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. write then read — round-trip preserves all fields', () => {
    const journal = makeJournal();
    writeJournal(env.journalPath, journal);

    const read = readJournal(env.journalPath);
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('run-1');
    expect(read!.generation).toBe(1);
    expect(read!.old_manifest_hash).toBe('old-hash');
    expect(read!.new_manifest_hash).toBe('new-hash');
    expect(read!.old_policy_version).toBe(3);
    expect(read!.new_policy_version).toBe(4);
    expect(read!.old_layout_version).toBe(2);
    expect(read!.new_layout_version).toBe(2);
    expect(read!.backup_dir).toBe('memory-staging/run-1/backup/');
    expect(read!.steps).toHaveLength(7);
    expect(read!.steps[0].step).toBe('backup_old');
    expect(read!.steps[0].status).toBe('done');
    expect(read!.steps[1].step).toBe('move_leaf');
    expect(read!.steps[1].files).toEqual(['items/preference/x.md']);
    expect(read!.steps[1].status).toBe('pending');
    expect(read!.steps[1].ts).toBeNull();
  });

  it('2. read on non-existent journal returns null', () => {
    const read = readJournal(path.join(env.stagingDir, 'no-such.journal.json'));
    expect(read).toBeNull();
  });

  it('3. write creates parent directories if needed', () => {
    const deepPath = path.join(env.stagingDir, 'nested', 'dir', 'publication.journal.json');
    writeJournal(deepPath, makeJournal());
    expect(fs.existsSync(deepPath)).toBe(true);
  });

  it('4. write overwrites existing journal (update on each step)', () => {
    const journal = makeJournal();
    writeJournal(env.journalPath, journal);

    // Simulate advancing a step.
    journal.steps[1].status = 'done';
    journal.steps[1].ts = '2026-08-03T10:00:01Z';
    writeJournal(env.journalPath, journal);

    const read = readJournal(env.journalPath);
    expect(read!.steps[1].status).toBe('done');
    expect(read!.steps[1].ts).toBe('2026-08-03T10:00:01Z');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: FAIL — module `../curation_publisher` not found.

- [x] **Step 3: Write the implementation**

Create `electron/memory/curation_publisher.ts`:

```typescript
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

/**
 * Crash-safe publication state machine (design §8.2–§8.5).
 *
 * The publication protocol uses a journal file that is fsync'd after
 * every step. On crash recovery, the journal tells the worker exactly
 * which steps completed and which need to be replayed or rolled back.
 *
 * State machine:
 *   prepared → publishing → filesystem_committed → cache_pending → succeeded
 *
 * The journal is written to `memory-staging/<run_id>/publication.journal.json`
 * and contains one entry per publication step with its status.
 */

// ---------------------------------------------------------------------------
// Types (design §8.3)
// ---------------------------------------------------------------------------

export type PublicationStepName =
  | 'backup_old'
  | 'move_leaf'
  | 'move_config'
  | 'regenerate_indexes'
  | 'regenerate_MEMORY_md'
  | 'regenerate_summary_md'
  | 'swap_manifest';

export type StepStatus = 'pending' | 'done' | 'failed';

export interface PublicationJournalStep {
  step: PublicationStepName;
  files?: string[];
  path?: string;
  status: StepStatus;
  ts: string | null;
}

export interface PublicationJournal {
  run_id: string;
  generation: number;
  old_manifest_hash: string;
  new_manifest_hash: string;
  old_policy_version: number | null;
  new_policy_version: number | null;
  old_layout_version: number | null;
  new_layout_version: number | null;
  steps: PublicationJournalStep[];
  backup_dir: string;
}

// ---------------------------------------------------------------------------
// writeJournal / readJournal
// ---------------------------------------------------------------------------

/**
 * Write the publication journal to disk with fsync.
 *
 * The journal is written atomically: write to a temp file, fsync, then
 * rename over the target. This ensures the journal is never partially
 * written even if the process crashes mid-write.
 */
export function writeJournal(journalPath: string, journal: PublicationJournal): void {
  const dir = path.dirname(journalPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = journalPath + '.tmp';
  const data = JSON.stringify(journal, null, 2);

  // Write to temp file.
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  // Atomic rename.
  fs.renameSync(tmpPath, journalPath);
}

/**
 * Read a publication journal from disk. Returns null if the journal
 * file does not exist (no publication in progress).
 */
export function readJournal(journalPath: string): PublicationJournal | null {
  if (!fs.existsSync(journalPath)) return null;
  try {
    const data = fs.readFileSync(journalPath, 'utf8');
    return JSON.parse(data) as PublicationJournal;
  } catch {
    // Corrupt journal — treat as non-existent so recovery can clean up.
    return null;
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: PASS — all 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publisher.ts \
        electron/memory/__tests__/curation_publisher.test.ts
git commit -m "feat(memory): add curation_publisher journal write/read with fsync"
```

---

## Task 5: curation_publisher.ts — preparePublication

**Files:**
- Modify: `electron/memory/curation_publisher.ts`
- Modify: `electron/memory/__tests__/curation_publisher.test.ts`

- [x] **Step 1: Write the failing tests**

Add `preparePublication` to the import at the top of `electron/memory/__tests__/curation_publisher.test.ts`:

```typescript
import { writeJournal, readJournal, preparePublication, type PublicationJournal } from '../curation_publisher';
```

Append the following `describe` block and helper. Also add the import for `generateMemoryMd` at the top:

```typescript
import { generateMemoryMd } from '../../../packages/agent/src/memory-state/curation_projection';
```

Append:

```typescript
function setupLiveMemory(liveMemoryRoot: string): void {
  fs.mkdirSync(path.join(liveMemoryRoot, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'),
    '---\ncanonical_key: "preference:old-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# Old Pref\n\nOld pref body.'
  );
  fs.mkdirSync(path.join(liveMemoryRoot, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(liveMemoryRoot, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\nclaim_type: "person"\nstatus: "active"\n---\n\n# Alice\n\nAlice bio.'
  );
  fs.writeFileSync(
    path.join(liveMemoryRoot, '.manifest.json'),
    JSON.stringify({ version: 1, generation: 1, files: {} })
  );
}

function setupStagingMemory(stagingDir: string): void {
  // Staging memory contains the candidate (new) canonical files.
  const stagingMemory = path.join(stagingDir, 'memory');
  fs.mkdirSync(path.join(stagingMemory, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(stagingMemory, 'items', 'preference', 'new-pref.md'),
    '---\ncanonical_key: "preference:new-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# New Pref\n\nNew pref body.'
  );
  fs.writeFileSync(
    path.join(stagingMemory, 'items', 'preference', 'old-pref.md'),
    '---\ncanonical_key: "preference:old-pref"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# Old Pref Updated\n\nUpdated body.'
  );
  fs.mkdirSync(path.join(stagingMemory, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(stagingMemory, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\nclaim_type: "person"\nstatus: "active"\n---\n\n# Alice\n\nUpdated Alice bio.'
  );
}

describe('preparePublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-memory-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-config-'));
    setupLiveMemory(liveMemoryRoot);
    setupStagingMemory(env.stagingDir);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. backs up live files that will be replaced', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // backup dir should contain the old preference file.
    const backupDir = path.join(env.stagingDir, 'backup');
    expect(fs.existsSync(path.join(backupDir, 'items', 'preference', 'old-pref.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, 'entities', 'people', 'alice.md'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, '.manifest.json'))).toBe(true);

    expect(journal.backup_dir).toContain('backup');
  });

  it('2. generates candidate projections in staging/candidate/', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const candidateDir = path.join(env.stagingDir, 'candidate');
    expect(fs.existsSync(path.join(candidateDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(candidateDir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(candidateDir, 'entities', 'people', 'index.md'))).toBe(true);

    // MEMORY.md contains the new canonical key.
    const memoryMd = fs.readFileSync(path.join(candidateDir, 'MEMORY.md'), 'utf8');
    expect(memoryMd).toContain('preference:new-pref');
  });

  it('3. writes journal with all steps pending (except backup_old=done)', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    expect(journal.run_id).toBe('run-1');
    expect(journal.generation).toBe(2);
    expect(journal.old_manifest_hash).toBe('old-hash');
    expect(journal.steps).toHaveLength(7);

    // backup_old is done (it was just performed).
    const backupStep = journal.steps.find((s) => s.step === 'backup_old')!;
    expect(backupStep.status).toBe('done');
    expect(backupStep.ts).not.toBeNull();

    // All other steps are pending.
    for (const step of journal.steps) {
      if (step.step !== 'backup_old') {
        expect(step.status).toBe('pending');
        expect(step.ts).toBeNull();
      }
    }

    // Journal file exists on disk.
    expect(fs.existsSync(path.join(env.stagingDir, 'publication.journal.json'))).toBe(true);
    const read = readJournal(path.join(env.stagingDir, 'publication.journal.json'));
    expect(read).not.toBeNull();
    expect(read!.run_id).toBe('run-1');
  });

  it('4. candidate MEMORY.md respects 64KiB cap', async () => {
    // Write many files in staging to test cap.
    const stagingMemory = path.join(env.stagingDir, 'memory');
    for (let i = 0; i < 100; i++) {
      const slug = `big-${i}`;
      fs.writeFileSync(
        path.join(stagingMemory, 'items', 'preference', `${slug}.md`),
        `---\ncanonical_key: "preference:${slug}"\nclaim_type: "preference"\nstatus: "active"\n---\n\n# ${slug}\n\n${'x'.repeat(800)}`
      );
    }

    await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const memoryMd = fs.readFileSync(path.join(env.stagingDir, 'candidate', 'MEMORY.md'), 'utf8');
    expect(Buffer.byteLength(memoryMd, 'utf8')).toBeLessThanOrEqual(64 * 1024 + 100);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: FAIL — `preparePublication` is not exported from `../curation_publisher`.

- [x] **Step 3: Write the implementation**

Append the following to `electron/memory/curation_publisher.ts` (after the existing `readJournal` function). Also add the import for projection generators at the top of the file:

```typescript
import { generateMemoryMd, generateSummaryMd, generateIndexMd } from '../../packages/agent/src/memory-state/curation_projection';
```

Append the implementation:

```typescript
// ---------------------------------------------------------------------------
// preparePublication (design §8.4 step 7)
// ---------------------------------------------------------------------------

export interface PreparePublicationOpts {
  runId: string;
  stagingDir: string;
  liveMemoryRoot: string;
  liveConfigRoot: string;
  oldManifestHash: string;
  generation: number;
  oldPolicyVersion?: number | null;
  newPolicyVersion?: number | null;
  oldLayoutVersion?: number | null;
  newLayoutVersion?: number | null;
}

/**
 * Prepare a publication: back up live files, generate candidate
 * projections, and write the initial journal (state: prepared).
 *
 * No live files are touched. All candidate content is written to
 * `stagingDir/candidate/`. The journal is fsync'd with all steps
 * 'pending' except 'backup_old' which is 'done'.
 */
export async function preparePublication(opts: PreparePublicationOpts): Promise<PublicationJournal> {
  const backupDir = path.join(opts.stagingDir, 'backup');
  const candidateDir = path.join(opts.stagingDir, 'candidate');
  const stagingMemory = path.join(opts.stagingDir, 'memory');

  // 1. Copy live files that will be replaced into backup/.
  await fsp.mkdir(backupDir, { recursive: true });
  await copyManagedFiles(opts.liveMemoryRoot, backupDir);
  // Also back up config (layout may change).
  await copyManagedFiles(opts.liveConfigRoot, path.join(backupDir, '_config'));

  // 2. Generate candidate projections from staging memory.
  await fsp.mkdir(path.join(candidateDir, 'entities'), { recursive: true });

  const memoryMd = generateMemoryMd(stagingMemory);
  const summaryMd = generateSummaryMd(stagingMemory);

  await writeAtomic(path.join(candidateDir, 'MEMORY.md'), memoryMd);
  await writeAtomic(path.join(candidateDir, 'summary.md'), summaryMd);

  // Generate index.md for each entity type directory in staging.
  const entitiesDir = path.join(stagingMemory, 'entities');
  if (fs.existsSync(entitiesDir)) {
    for (const entry of fs.readdirSync(entitiesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const indexMd = generateIndexMd(stagingMemory, entry.name);
        if (indexMd) {
          await writeAtomic(path.join(candidateDir, 'entities', entry.name, 'index.md'), indexMd);
        }
      }
    }
  }

  // 3. Compute new manifest hash (hash of all staging memory files).
  const newManifestHash = await computeDirectoryHash(stagingMemory);

  // 4. Build journal with all steps pending.
  const now = new Date().toISOString();
  const journal: PublicationJournal = {
    run_id: opts.runId,
    generation: opts.generation,
    old_manifest_hash: opts.oldManifestHash,
    new_manifest_hash: newManifestHash,
    old_policy_version: opts.oldPolicyVersion ?? null,
    new_policy_version: opts.newPolicyVersion ?? null,
    old_layout_version: opts.oldLayoutVersion ?? null,
    new_layout_version: opts.newLayoutVersion ?? null,
    backup_dir: backupDir,
    steps: [
      { step: 'backup_old', path: backupDir, status: 'done', ts: now },
      { step: 'move_leaf', files: [], status: 'pending', ts: null },
      { step: 'move_config', files: [], status: 'pending', ts: null },
      { step: 'regenerate_indexes', files: [], status: 'pending', ts: null },
      { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
      { step: 'regenerate_summary_md', status: 'pending', ts: null },
      { step: 'swap_manifest', status: 'pending', ts: null },
    ],
  };

  // 5. Write journal (fsync'd).
  writeJournal(path.join(opts.stagingDir, 'publication.journal.json'), journal);

  return journal;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Write a file atomically: write to temp, fsync, rename.
 */
async function writeAtomic(filePath: string, content: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

/**
 * Copy managed memory files (items/ + entities/ + .manifest.json) from
 * src to dest. Skips symlinks and excluded directories.
 */
async function copyManagedFiles(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      // Only copy managed directories (items, entities). Skip others.
      if (entry.name === 'items' || entry.name === 'entities') {
        await copyDirRecursive(srcPath, destPath);
      }
    } else if (entry.isFile() && entry.name === '.manifest.json') {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Compute a deterministic hash over all files in a directory tree.
 */
async function computeDirectoryHash(dir: string): Promise<string> {
  const crypto = await import('crypto');
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(d: string): Promise<void> {
    const items = await fsp.readdir(d, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(d, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const content = await fsp.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const relPath = path.relative(dir, fullPath).split(path.sep).join('/');
        entries.push({ relPath, fileHash });
      }
    }
  }

  await walk(dir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const payload = entries.map((e) => `${e.relPath}\0${e.fileHash}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: PASS — all tests in all describe blocks pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publisher.ts \
        electron/memory/__tests__/curation_publisher.test.ts
git commit -m "feat(memory): add curation_publisher preparePublication with backup + candidate"
```

---

## Task 6: curation_publisher.ts — executePublication

**Files:**
- Modify: `electron/memory/curation_publisher.ts`
- Modify: `electron/memory/__tests__/curation_publisher.test.ts`

- [x] **Step 1: Write the failing tests**

Add `executePublication` to the import at the top of `electron/memory/__tests__/curation_publisher.test.ts`:

```typescript
import { writeJournal, readJournal, preparePublication, executePublication, type PublicationJournal } from '../curation_publisher';
```

Append the following `describe` block:

```typescript
describe('executePublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-exec-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-exec-'));
    setupLiveMemory(liveMemoryRoot);
    setupStagingMemory(env.stagingDir);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. moves leaf canonical files from staging to live', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    // New file from staging is now in live.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md'))).toBe(true);
    // Updated file content is in live.
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Updated body');
  });

  it('2. regenerates MEMORY.md in live from candidate', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const liveMemoryMd = fs.readFileSync(path.join(liveMemoryRoot, 'MEMORY.md'), 'utf8');
    expect(liveMemoryMd).toContain('preference:new-pref');
  });

  it('3. regenerates summary.md and index.md in live', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    expect(fs.existsSync(path.join(liveMemoryRoot, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(liveMemoryRoot, 'entities', 'people', 'index.md'))).toBe(true);
  });

  it('4. swaps manifest atomically — .manifest.json reflects new generation', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 42,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const manifest = JSON.parse(fs.readFileSync(path.join(liveMemoryRoot, '.manifest.json'), 'utf8'));
    expect(manifest.generation).toBe(42);
  });

  it('5. journal on disk shows all steps done after execution', async () => {
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const read = readJournal(path.join(env.stagingDir, 'publication.journal.json'));
    expect(read).not.toBeNull();
    for (const step of read!.steps) {
      expect(step.status).toBe('done');
      expect(step.ts).not.toBeNull();
    }
  });

  it('6. removes files from live that were deleted in staging', async () => {
    // Live has old-pref.md; remove it from staging to simulate deletion.
    fs.unlinkSync(path.join(env.stagingDir, 'memory', 'items', 'preference', 'old-pref.md'));

    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    // old-pref.md should no longer exist in live.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'))).toBe(false);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: FAIL — `executePublication` is not exported from `../curation_publisher`.

- [x] **Step 3: Write the implementation**

Append the following to `electron/memory/curation_publisher.ts` (after the existing `preparePublication` function and its helpers):

```typescript
// ---------------------------------------------------------------------------
// executePublication (design §8.4 step 8)
// ---------------------------------------------------------------------------

export interface ExecutePublicationOpts {
  stagingDir: string;
  liveMemoryRoot: string;
  liveConfigRoot: string;
}

/**
 * Execute the publication: move canonical files from staging to live,
 * regenerate projections from candidate, and swap the manifest atomically.
 *
 * Each step is performed in journal order:
 *   1. move_leaf      — copy/replace staging memory files into live
 *   2. move_config    — copy staging config files into live (if changed)
 *   3. regenerate_indexes — copy candidate index.md files into live
 *   4. regenerate_MEMORY_md — copy candidate MEMORY.md into live
 *   5. regenerate_summary_md — copy candidate summary.md into live
 *   6. swap_manifest   — write new .manifest.json atomically
 *
 * After each step: fsync written files, update journal step='done', fsync journal.
 * The manifest swap is the commit point (state: filesystem_committed).
 */
export async function executePublication(
  journal: PublicationJournal,
  opts: ExecutePublicationOpts
): Promise<void> {
  const journalPath = path.join(opts.stagingDir, 'publication.journal.json');
  const stagingMemory = path.join(opts.stagingDir, 'memory');
  const candidateDir = path.join(opts.stagingDir, 'candidate');

  for (const step of journal.steps) {
    if (step.status === 'done') continue;

    switch (step.step) {
      case 'backup_old':
        // Already done during preparePublication.
        break;

      case 'move_leaf':
        await syncDirectory(stagingMemory, opts.liveMemoryRoot, ['items', 'entities']);
        break;

      case 'move_config':
        await syncConfig(opts.stagingDir, opts.liveConfigRoot);
        break;

      case 'regenerate_indexes':
        await syncCandidateIndexes(candidateDir, opts.liveMemoryRoot);
        break;

      case 'regenerate_MEMORY_md':
        await writeAtomic(
          path.join(opts.liveMemoryRoot, 'MEMORY.md'),
          fs.readFileSync(path.join(candidateDir, 'MEMORY.md'), 'utf8')
        );
        break;

      case 'regenerate_summary_md':
        await writeAtomic(
          path.join(opts.liveMemoryRoot, 'summary.md'),
          fs.readFileSync(path.join(candidateDir, 'summary.md'), 'utf8')
        );
        break;

      case 'swap_manifest': {
        const manifest = {
          version: 1,
          generation: journal.generation,
          manifest_hash: journal.new_manifest_hash,
          updated_at: new Date().toISOString(),
        };
        await writeAtomic(
          path.join(opts.liveMemoryRoot, '.manifest.json'),
          JSON.stringify(manifest, null, 2)
        );
        break;
      }
    }

    // Update journal step.
    step.status = 'done';
    step.ts = new Date().toISOString();
    writeJournal(journalPath, journal);
  }
}

/**
 * Sync directories from src to dest: copy new/modified files, delete
 * files that exist in dest but not in src. Only syncs the specified
 * subdirectories.
 */
async function syncDirectory(src: string, dest: string, subdirs: string[]): Promise<void> {
  for (const sub of subdirs) {
    const srcSub = path.join(src, sub);
    const destSub = path.join(dest, sub);
    if (fs.existsSync(srcSub)) {
      await syncDirRecursive(srcSub, destSub);
    } else {
      // Subdir deleted in staging — remove from live.
      if (fs.existsSync(destSub)) {
        await fsp.rm(destSub, { recursive: true, force: true });
      }
    }
  }
}

async function syncDirRecursive(src: string, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });

  // Track which dest files should survive (those present in src).
  const srcEntries = new Set<string>();
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    srcEntries.add(entry.name);
    if (entry.isDirectory()) {
      await syncDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      await fsp.copyFile(srcPath, destPath);
    }
  }

  // Delete files in dest that are not in src.
  if (fs.existsSync(dest)) {
    const destEntries = await fsp.readdir(dest, { withFileTypes: true });
    for (const entry of destEntries) {
      if (!srcEntries.has(entry.name)) {
        await fsp.rm(path.join(dest, entry.name), { recursive: true, force: true });
      }
    }
  }
}

/**
 * Sync config files from staging/memory-config/ to live config root.
 */
async function syncConfig(stagingDir: string, liveConfigRoot: string): Promise<void> {
  const stagingConfig = path.join(stagingDir, 'memory-config');
  if (!fs.existsSync(stagingConfig)) return;
  await syncDirRecursive(stagingConfig, liveConfigRoot);
}

/**
 * Copy index.md files from candidate/entities/ to live entities/.
 */
async function syncCandidateIndexes(candidateDir: string, liveMemoryRoot: string): Promise<void> {
  const candidateEntities = path.join(candidateDir, 'entities');
  if (!fs.existsSync(candidateEntities)) return;

  for (const entry of fs.readdirSync(candidateEntities, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexSrc = path.join(candidateEntities, entry.name, 'index.md');
    if (fs.existsSync(indexSrc)) {
      const indexDest = path.join(liveMemoryRoot, 'entities', entry.name, 'index.md');
      await writeAtomic(indexDest, fs.readFileSync(indexSrc, 'utf8'));
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: PASS — all tests in all describe blocks pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publisher.ts \
        electron/memory/__tests__/curation_publisher.test.ts
git commit -m "feat(memory): add curation_publisher executePublication state machine"
```

---

## Task 7: curation_publisher.ts — recoverPublication

**Files:**
- Modify: `electron/memory/curation_publisher.ts`
- Modify: `electron/memory/__tests__/curation_publisher.test.ts`

- [x] **Step 1: Write the failing tests**

Add `recoverPublication` and `type RecoveryResult` to the import at the top of `electron/memory/__tests__/curation_publisher.test.ts`:

```typescript
import {
  writeJournal,
  readJournal,
  preparePublication,
  executePublication,
  recoverPublication,
  type PublicationJournal,
  type RecoveryResult,
} from '../curation_publisher';
```

Append the following `describe` block:

```typescript
describe('recoverPublication', () => {
  let env: PubEnv;
  let liveMemoryRoot: string;
  let liveConfigRoot: string;

  beforeEach(() => {
    env = makeEnv();
    liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-recover-'));
    liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-recover-'));
    setupLiveMemory(liveMemoryRoot);
    fs.mkdirSync(liveConfigRoot, { recursive: true });
    fs.writeFileSync(path.join(liveConfigRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1, entities: {} }));
  });

  afterEach(() => {
    env.cleanup();
    for (const d of [liveMemoryRoot, liveConfigRoot]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  it('1. journal not found — returns noop', async () => {
    const result = await recoverPublication(
      path.join(env.stagingDir, 'no-journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('noop');
  });

  it('2. journal prepared only (backup_old done, all else pending) — discards and marks failed', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('discard');
    expect(result.runId).toBe('run-1');

    // Live memory is untouched (old-pref still has original content).
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Old pref body');
    expect(liveContent).not.toContain('Updated body');
  });

  it('3. journal publishing, manifest not swapped — restores from backup', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // Simulate a crash during move_leaf: partially execute by copying
    // a staging file to live, then leave journal with move_leaf='done'
    // but swap_manifest still 'pending'.
    fs.copyFileSync(
      path.join(env.stagingDir, 'memory', 'items', 'preference', 'new-pref.md'),
      path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md')
    );
    journal.steps[1].status = 'done';
    journal.steps[1].ts = new Date().toISOString();
    writeJournal(path.join(env.stagingDir, 'publication.journal.json'), journal);

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('restore');

    // new-pref.md (which was not in the backup) should be removed.
    expect(fs.existsSync(path.join(liveMemoryRoot, 'items', 'preference', 'new-pref.md'))).toBe(false);
    // old-pref.md should have original content restored.
    const liveContent = fs.readFileSync(
      path.join(liveMemoryRoot, 'items', 'preference', 'old-pref.md'), 'utf8'
    );
    expect(liveContent).toContain('Old pref body');
  });

  it('4. journal filesystem_committed (swap_manifest done) — returns finalize', async () => {
    setupStagingMemory(env.stagingDir);
    const journal = await preparePublication({
      runId: 'run-1',
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
      oldManifestHash: 'old-hash',
      generation: 2,
    });

    // Execute fully so manifest is swapped.
    await executePublication(journal, {
      stagingDir: env.stagingDir,
      liveMemoryRoot,
      liveConfigRoot,
    });

    const result = await recoverPublication(
      path.join(env.stagingDir, 'publication.journal.json'),
      liveMemoryRoot,
    );
    expect(result.action).toBe('finalize');
    expect(result.runId).toBe('run-1');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: FAIL — `recoverPublication` is not exported from `../curation_publisher`.

- [x] **Step 3: Write the implementation**

Append the following to `electron/memory/curation_publisher.ts` (after the existing `executePublication` function and its helpers):

```typescript
// ---------------------------------------------------------------------------
// recoverPublication (design §8.5)
// ---------------------------------------------------------------------------

export type RecoveryAction = 'noop' | 'discard' | 'restore' | 'finalize' | 'retry_cache';

export interface RecoveryResult {
  action: RecoveryAction;
  runId?: string;
  journal?: PublicationJournal;
}

/**
 * Recover from an interrupted publication.
 *
 * Reads the journal and determines the recovery action per the §8.5 table:
 *
 *   journal not found                     → noop
 *   prepared (backup_old done, rest pending) → discard staging, mark failed
 *   publishing (some steps done, manifest not swapped) → restore from backup
 *   filesystem_committed (manifest swapped) → finalize DB (caller calls completeRun)
 *   cache_pending                         → retry cache rebuild (caller handles)
 *
 * For 'restore': copies backup files back to live and removes any files
 * that were added during the partial publish but are not in the backup.
 */
export async function recoverPublication(
  journalPath: string,
  liveMemoryRoot: string,
): Promise<RecoveryResult> {
  const journal = readJournal(journalPath);
  if (!journal) {
    return { action: 'noop' };
  }

  const swapStep = journal.steps.find((s) => s.step === 'swap_manifest');
  const manifestSwapped = swapStep?.status === 'done';

  // If manifest was swapped, the filesystem is already committed.
  if (manifestSwapped) {
    return { action: 'finalize', runId: journal.run_id, journal };
  }

  // Check if any step beyond backup_old is done (state: publishing).
  const publishingStarted = journal.steps.some(
    (s) => s.step !== 'backup_old' && s.status === 'done'
  );

  if (!publishingStarted) {
    // State: prepared — no live files touched. Discard staging.
    return { action: 'discard', runId: journal.run_id, journal };
  }

  // State: publishing, manifest not swapped — restore from backup.
  await restoreFromBackup(journal.backup_dir, liveMemoryRoot);
  return { action: 'restore', runId: journal.run_id, journal };
}

/**
 * Restore live memory files from the backup directory.
 *
 * Copies all backup files back to live, then removes any files in live
 * that are NOT in the backup (these were added during the partial publish
 * and need to be rolled back).
 */
async function restoreFromBackup(backupDir: string, liveMemoryRoot: string): Promise<void> {
  // backup_dir is written by preparePublication as an absolute path
  // (path.join(opts.stagingDir, 'backup')), so it is always absolute
  // when read back from the journal during crash recovery.
  if (!fs.existsSync(backupDir)) {
    // No backup to restore from — nothing we can do.
    return;
  }

  // Restore items/ and entities/ from backup.
  for (const sub of ['items', 'entities']) {
    const backupSub = path.join(backupDir, sub);
    const liveSub = path.join(liveMemoryRoot, sub);
    if (fs.existsSync(backupSub)) {
      // Replace live sub with backup copy.
      if (fs.existsSync(liveSub)) {
        await fsp.rm(liveSub, { recursive: true, force: true });
      }
      await copyDirRecursive(backupSub, liveSub);
    } else {
      // No backup for this sub — it didn't exist before. Remove from live.
      if (fs.existsSync(liveSub)) {
        await fsp.rm(liveSub, { recursive: true, force: true });
      }
    }
  }

  // Restore .manifest.json from backup.
  const backupManifest = path.join(backupDir, '.manifest.json');
  if (fs.existsSync(backupManifest)) {
    await fsp.copyFile(backupManifest, path.join(liveMemoryRoot, '.manifest.json'));
  }

  // Remove candidate projections that may have been written to live.
  for (const proj of ['MEMORY.md', 'summary.md']) {
    const liveProj = path.join(liveMemoryRoot, proj);
    if (fs.existsSync(liveProj)) {
      await fsp.unlink(liveProj);
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publisher.test.ts`
Expected: PASS — all tests in all describe blocks pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publisher.ts \
        electron/memory/__tests__/curation_publisher.test.ts
git commit -m "feat(memory): add curation_publisher recoverPublication crash recovery"
```

---

## Task 8: curation_snapshot.ts — createSnapshot

**Files:**
- Create: `electron/memory/curation_snapshot.ts`
- Create: `electron/memory/__tests__/curation_snapshot.test.ts`

- [x] **Step 1: Write the failing test**

Create `electron/memory/__tests__/curation_snapshot.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createSnapshot } from '../curation_snapshot';

interface SnapEnv {
  liveMemoryRoot: string;
  liveConfigRoot: string;
  snapshotRoot: string;
  cleanup: () => void;
}

function setupLiveMemory(memoryRoot: string): void {
  fs.mkdirSync(path.join(memoryRoot, 'items', 'preference'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'items', 'preference', 'pref.md'),
    '---\ncanonical_key: "preference:pref"\n---\n\n# Pref\n\nPref body.'
  );
  fs.mkdirSync(path.join(memoryRoot, 'entities', 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(memoryRoot, 'entities', 'people', 'alice.md'),
    '---\ncanonical_key: "person:alice"\n---\n\n# Alice\n\nAlice bio.'
  );
  fs.writeFileSync(path.join(memoryRoot, 'MEMORY.md'), '# Memory\n\n- pref');
  fs.writeFileSync(path.join(memoryRoot, 'summary.md'), '# Summary');
  fs.writeFileSync(
    path.join(memoryRoot, '.manifest.json'),
    JSON.stringify({ version: 1, generation: 1 })
  );

  // Excluded dirs (should NOT be in snapshot).
  fs.mkdirSync(path.join(memoryRoot, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'rollout_summaries', 'r1.md'), '# r1');
  fs.mkdirSync(path.join(memoryRoot, 'extensions', 'ad_hoc'), { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, 'extensions', 'ad_hoc', 'notes.md'), '# notes');
}

function setupConfigRoot(configRoot: string): void {
  fs.mkdirSync(configRoot, { recursive: true });
  fs.writeFileSync(path.join(configRoot, 'stage1_policy.md'), '# Policy');
  fs.writeFileSync(path.join(configRoot, 'memory_layout.json'), JSON.stringify({ schema_version: 1 }));
}

function makeEnv(): SnapEnv {
  const liveMemoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-live-'));
  const liveConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-config-'));
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-root-'));
  setupLiveMemory(liveMemoryRoot);
  setupConfigRoot(liveConfigRoot);
  return {
    liveMemoryRoot,
    liveConfigRoot,
    snapshotRoot,
    cleanup: () => {
      for (const d of [liveMemoryRoot, liveConfigRoot, snapshotRoot]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

describe('createSnapshot', () => {
  let env: SnapEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. snapshot contains managed files (items + entities + projections + config + manifest)', async () => {
    const { snapshotDir } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(fs.existsSync(snapshotDir)).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'items', 'preference', 'pref.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'entities', 'people', 'alice.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', '.manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory-config', 'stage1_policy.md'))).toBe(true);
    expect(fs.existsSync(path.join(snapshotDir, 'memory-config', 'memory_layout.json'))).toBe(true);
  });

  it('2. snapshot excludes rollout_summaries, extensions, ad_hoc', async () => {
    const { snapshotDir } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'rollout_summaries'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'memory', 'extensions'))).toBe(false);
  });

  it('3. returns manifest hash matching live content', async () => {
    const { manifestHash } = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    expect(manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('4. identical content across snapshots uses hardlinks (dedup)', async () => {
    const r1 = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    // Second snapshot with identical content.
    const r2 = await createSnapshot({
      liveMemoryRoot: env.liveMemoryRoot,
      liveConfigRoot: env.liveConfigRoot,
      snapshotRoot: env.snapshotRoot,
      maxSnapshots: 5,
    });

    // The same file in both snapshots should share inodes (hardlink).
    const file1 = fs.statSync(path.join(r1.snapshotDir, 'memory', 'items', 'preference', 'pref.md'));
    const file2 = fs.statSync(path.join(r2.snapshotDir, 'memory', 'items', 'preference', 'pref.md'));
    expect(file1.ino).toBe(file2.ino);
  });

  it('5. retention — only last maxSnapshots directories kept', async () => {
    // Create maxSnapshots + 2 snapshots by modifying content each time.
    for (let i = 0; i < 7; i++) {
      fs.writeFileSync(
        path.join(env.liveMemoryRoot, 'items', 'preference', `extra-${i}.md`),
        `# Extra ${i}`
      );
      await createSnapshot({
        liveMemoryRoot: env.liveMemoryRoot,
        liveConfigRoot: env.liveConfigRoot,
        snapshotRoot: env.snapshotRoot,
        maxSnapshots: 5,
      });
    }

    // List snapshot directories (excluding manifests/).
    const entries = fs.readdirSync(env.snapshotRoot, { withFileTypes: true });
    const snapshotDirs = entries.filter((e) => e.isDirectory() && e.name !== 'manifests');
    expect(snapshotDirs.length).toBeLessThanOrEqual(5);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_snapshot.test.ts`
Expected: FAIL — module `../curation_snapshot` not found.

- [x] **Step 3: Write the implementation**

Create `electron/memory/curation_snapshot.ts`:

```typescript
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Pre-publish snapshot manager (design §11.2).
 *
 * Before each successful publication, a full snapshot of managed memory
 * files is taken to `~/.duya/memory-snapshots/<timestamp>/`. Snapshots
 * live OUTSIDE the memory root so they are never recursively scanned
 * by the runtime agent.
 *
 * Content-hash deduplication: identical files across snapshots share
 * storage via hardlinks, so N snapshots of an unchanged file cost only
 * one copy on disk.
 *
 * Retention: the last `maxSnapshots` (default 5) full snapshot
 * directories are kept; older ones are deleted.
 */

const EXCLUDED_MEMORY_DIRS = new Set([
  'rollout_summaries',
  'extensions',
  'archive',
  'snapshots',
]);

export interface CreateSnapshotOpts {
  liveMemoryRoot: string;
  liveConfigRoot: string;
  snapshotRoot: string;
  maxSnapshots?: number;
}

export interface CreateSnapshotResult {
  snapshotDir: string;
  manifestHash: string;
}

/**
 * Create a snapshot of the current live memory + config state.
 *
 * Layout:
 *   snapshotRoot/<timestamp>/
 *   ├── memory/         # items/ + entities/ + MEMORY.md + summary.md + .manifest.json
 *   └── memory-config/  # stage1_policy.md + memory_layout.json
 *
 * Returns the snapshot directory path and a manifest hash of all
 * snapshot content.
 */
export async function createSnapshot(opts: CreateSnapshotOpts): Promise<CreateSnapshotResult> {
  const maxSnapshots = opts.maxSnapshots ?? 5;
  const timestamp = formatSnapshotTimestamp(new Date());
  const snapshotDir = path.join(opts.snapshotRoot, timestamp);

  await fsp.mkdir(path.join(snapshotDir, 'memory'), { recursive: true });
  await fsp.mkdir(path.join(snapshotDir, 'memory-config'), { recursive: true });

  // Content store for hardlink dedup: snapshotRoot/.content/<hash>
  const contentStore = path.join(opts.snapshotRoot, '.content');
  await fsp.mkdir(contentStore, { recursive: true });

  // Copy managed memory files with dedup.
  await snapshotDirWithDedup(
    opts.liveMemoryRoot,
    path.join(snapshotDir, 'memory'),
    contentStore,
    (entryName) => {
      // Include items/, entities/, MEMORY.md, summary.md, .manifest.json.
      // Exclude rollout_summaries/, extensions/, etc.
      if (EXCLUDED_MEMORY_DIRS.has(entryName)) return false;
      if (entryName === 'index.md') return true; // entity index.md files are managed
      return true;
    }
  );

  // Copy config files with dedup.
  await snapshotDirWithDedup(
    opts.liveConfigRoot,
    path.join(snapshotDir, 'memory-config'),
    contentStore,
    () => true
  );

  // Compute manifest hash.
  const manifestHash = await computeSnapshotHash(snapshotDir);

  // Prune old snapshots.
  await pruneOldSnapshots(opts.snapshotRoot, maxSnapshots);

  return { snapshotDir, manifestHash };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSnapshotTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `_${d.getMilliseconds().toString().padStart(3, '0')}`
  );
}

/**
 * Copy a directory tree to dest, using hardlinks from the content store
 * when the file content already exists. This deduplicates identical
 * files across snapshots.
 */
async function snapshotDirWithDedup(
  src: string,
  dest: string,
  contentStore: string,
  shouldInclude: (entryName: string) => boolean,
): Promise<void> {
  if (!fs.existsSync(src)) return;
  await fsp.mkdir(dest, { recursive: true });

  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (!shouldInclude(entry.name)) continue;

    // Skip excluded top-level dirs.
    if (entry.isDirectory() && EXCLUDED_MEMORY_DIRS.has(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await snapshotDirWithDedup(srcPath, destPath, contentStore, shouldInclude);
    } else if (entry.isFile()) {
      const content = await fsp.readFile(srcPath);
      const hash = crypto.createHash('sha256').update(content).digest('hex');
      const storePath = path.join(contentStore, hash);

      if (fs.existsSync(storePath)) {
        // Content already exists — hardlink from store.
        try {
          await fsp.link(storePath, destPath);
          continue;
        } catch {
          // Hardlink failed (cross-device, permissions) — fall through to copy.
        }
      }

      // Write to dest, then copy to store for future dedup.
      await fsp.writeFile(destPath, content);
      try {
        if (!fs.existsSync(storePath)) {
          await fsp.copyFile(destPath, storePath);
        }
      } catch {
        // Best-effort: if store write fails, dedup just won't work next time.
      }
    }
  }
}

/**
 * Compute a deterministic hash over all files in a snapshot directory.
 */
async function computeSnapshotHash(snapshotDir: string): Promise<string> {
  const entries: Array<{ relPath: string; fileHash: string }> = [];

  async function walk(dir: string): Promise<void> {
    const items = await fsp.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.isSymbolicLink()) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        await walk(fullPath);
      } else if (item.isFile()) {
        const content = await fsp.readFile(fullPath);
        const fileHash = crypto.createHash('sha256').update(content).digest('hex');
        const relPath = path.relative(snapshotDir, fullPath).split(path.sep).join('/');
        entries.push({ relPath, fileHash });
      }
    }
  }

  await walk(snapshotDir);
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
  const payload = entries.map((e) => `${e.relPath}\0${e.fileHash}\n`).join('');
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Delete old snapshot directories, keeping only the most recent
 * `maxSnapshots`. Directories are named by timestamp (sortable).
 */
async function pruneOldSnapshots(snapshotRoot: string, maxSnapshots: number): Promise<void> {
  if (!fs.existsSync(snapshotRoot)) return;

  const entries = await fsp.readdir(snapshotRoot, { withFileTypes: true });
  const snapshotDirs = entries
    .filter((e) => e.isDirectory() && e.name !== 'manifests' && e.name !== '.content')
    .map((e) => e.name)
    .sort()
    .reverse(); // newest first

  const toDelete = snapshotDirs.slice(maxSnapshots);
  for (const dirName of toDelete) {
    await fsp.rm(path.join(snapshotRoot, dirName), { recursive: true, force: true });
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_snapshot.test.ts`
Expected: PASS — all 5 tests pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_snapshot.ts \
        electron/memory/__tests__/curation_snapshot.test.ts
git commit -m "feat(memory): add curation_snapshot with hardlink dedup + retention"
```

---

## Task 9: curation_health.ts — appendHealthReport

**Files:**
- Create: `packages/agent/src/memory-state/curation_health.ts`
- Create: `packages/agent/src/memory-state/curation_health.test.ts`

- [x] **Step 1: Write the failing test**

Create `packages/agent/src/memory-state/curation_health.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { appendHealthReport, type HealthReport } from './curation_health';

interface HealthEnv {
  snapshotRoot: string;
  cleanup: () => void;
}

function makeEnv(): HealthEnv {
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'health-snap-'));
  return {
    snapshotRoot,
    cleanup: () => {
      try { fs.rmSync(snapshotRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

function makeReport(overrides?: Partial<HealthReport>): HealthReport {
  return {
    run_id: 'run-1',
    timestamp: '2026-08-03T10:00:00Z',
    duration_ms: 45000,
    inputs: 3,
    added: 2,
    merged: 1,
    retired: 0,
    no_change: 1,
    rejected: 0,
    duplicate_rate: 0.0,
    memory_md_size: 12450,
    summary_md_size: 3200,
    entity_files: 18,
    policy_version: 4,
    layout_version: 2,
    ...overrides,
  };
}

describe('appendHealthReport', () => {
  let env: HealthEnv;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { env.cleanup(); });

  it('1. appends a single report as valid JSONL', () => {
    appendHealthReport(env.snapshotRoot, makeReport());

    const logPath = path.join(env.snapshotRoot, 'manifests', 'health.log.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.run_id).toBe('run-1');
    expect(parsed.duration_ms).toBe(45000);
    expect(parsed.added).toBe(2);
    expect(parsed.merged).toBe(1);
    expect(parsed.memory_md_size).toBe(12450);
    expect(parsed.policy_version).toBe(4);
  });

  it('2. appends multiple reports — each on its own line, all parseable', () => {
    appendHealthReport(env.snapshotRoot, makeReport({ run_id: 'run-1' }));
    appendHealthReport(env.snapshotRoot, makeReport({ run_id: 'run-2', added: 5 }));
    appendHealthReport(env.snapshotRoot, makeReport({ run_id: 'run-3', added: 0 }));

    const logPath = path.join(env.snapshotRoot, 'manifests', 'health.log.jsonl');
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(3);

    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    const r3 = JSON.parse(lines[2]);
    expect(r1.run_id).toBe('run-1');
    expect(r2.run_id).toBe('run-2');
    expect(r2.added).toBe(5);
    expect(r3.run_id).toBe('run-3');
    expect(r3.added).toBe(0);
  });

  it('3. creates manifests/ directory if it does not exist', () => {
    expect(fs.existsSync(path.join(env.snapshotRoot, 'manifests'))).toBe(false);

    appendHealthReport(env.snapshotRoot, makeReport());

    expect(fs.existsSync(path.join(env.snapshotRoot, 'manifests'))).toBe(true);
    expect(fs.existsSync(path.join(env.snapshotRoot, 'manifests', 'health.log.jsonl'))).toBe(true);
  });

  it('4. handles null policy_version and layout_version', () => {
    appendHealthReport(env.snapshotRoot, makeReport({ policy_version: null, layout_version: null }));

    const logPath = path.join(env.snapshotRoot, 'manifests', 'health.log.jsonl');
    const content = fs.readFileSync(logPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.policy_version).toBeNull();
    expect(parsed.layout_version).toBeNull();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/agent/src/memory-state/curation_health.test.ts`
Expected: FAIL — module `./curation_health` not found.

- [x] **Step 3: Write the implementation**

Create `packages/agent/src/memory-state/curation_health.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Curation health report (design §13).
 *
 * Each successful publication appends a JSONL record to
 * `~/.duya/memory-snapshots/manifests/health.log.jsonl`. This feeds
 * future prompt canary metrics and lets the user audit curation
 * behavior over time.
 */

export interface HealthReport {
  run_id: string;
  timestamp: string;
  duration_ms: number;
  inputs: number;
  added: number;
  merged: number;
  retired: number;
  no_change: number;
  rejected: number;
  duplicate_rate: number;
  memory_md_size: number;
  summary_md_size: number;
  entity_files: number;
  policy_version: number | null;
  layout_version: number | null;
}

/**
 * Append a health report as a single JSONL line to
 * `<snapshotRoot>/manifests/health.log.jsonl`.
 *
 * Creates the manifests/ directory if it does not exist. The report
 * is appended (not overwritten) so the log accumulates across runs.
 */
export function appendHealthReport(snapshotRoot: string, report: HealthReport): void {
  const manifestsDir = path.join(snapshotRoot, 'manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });

  const logPath = path.join(manifestsDir, 'health.log.jsonl');
  const line = JSON.stringify(report) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/agent/src/memory-state/curation_health.test.ts`
Expected: PASS — all 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add packages/agent/src/memory-state/curation_health.ts \
        packages/agent/src/memory-state/curation_health.test.ts
git commit -m "feat(agent): add curation_health appendHealthReport JSONL"
```

---

## Task 10: curation_publish_orchestrator.ts — runCurationCycle

**Files:**
- Create: `electron/memory/curation_publish_orchestrator.ts`
- Create: `electron/memory/__tests__/curation_publish_orchestrator.test.ts`

- [x] **Step 1: Write the failing test**

Create `electron/memory/__tests__/curation_publish_orchestrator.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../../agents/process-pool/agent-process-pool';

// Hoisted mock state — shared between vi.mock factories and test bodies.
const mocks = vi.hoisted(() => ({
  // curation_ledger mocks
  queryEligibleInputs: vi.fn(),
  claimRun: vi.fn(),
  completeRun: vi.fn(),
  failRun: vi.fn(),
  computeInputSetHash: vi.fn(),
  // curation_staging mocks
  createStaging: vi.fn(),
  deleteStaging: vi.fn(),
  // curation_agent_runner mock
  runCurationAgent: vi.fn(),
  // curation_validator mock
  validateStaging: vi.fn(),
  // curation_publisher mocks
  preparePublication: vi.fn(),
  executePublication: vi.fn(),
  // curation_snapshot mock
  createSnapshot: vi.fn(),
  // curation_health mock
  appendHealthReport: vi.fn(),
}));

vi.mock('../../../packages/agent/src/memory-state/curation_ledger', () => ({
  queryEligibleInputs: mocks.queryEligibleInputs,
  claimRun: mocks.claimRun,
  completeRun: mocks.completeRun,
  failRun: mocks.failRun,
  computeInputSetHash: mocks.computeInputSetHash,
}));

vi.mock('../curation_staging', () => ({
  createStaging: mocks.createStaging,
  deleteStaging: mocks.deleteStaging,
}));

vi.mock('../curation_agent_runner', () => ({
  runCurationAgent: mocks.runCurationAgent,
}));

vi.mock('../../../packages/agent/src/memory-state/curation_validator', () => ({
  validateStaging: mocks.validateStaging,
}));

vi.mock('../curation_publisher', () => ({
  preparePublication: mocks.preparePublication,
  executePublication: mocks.executePublication,
}));

vi.mock('../curation_snapshot', () => ({
  createSnapshot: mocks.createSnapshot,
}));

vi.mock('../../../packages/agent/src/memory-state/curation_health', () => ({
  appendHealthReport: mocks.appendHealthReport,
}));

import { runCurationCycle, type CycleResult } from '../curation_publish_orchestrator';

interface OrchEnv {
  memoryRoot: string;
  configRoot: string;
  stagingRoot: string;
  snapshotRoot: string;
  cleanup: () => void;
}

function makeEnv(): OrchEnv {
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mem-'));
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cfg-'));
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stg-'));
  const snapshotRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-snap-'));
  return {
    memoryRoot, configRoot, stagingRoot, snapshotRoot,
    cleanup: () => {
      for (const d of [memoryRoot, configRoot, stagingRoot, snapshotRoot]) {
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
    },
  };
}

const T0 = 1_750_000_000_000;

describe('runCurationCycle', () => {
  let env: OrchEnv;
  let db: Database;

  beforeEach(() => {
    env = makeEnv();
    db = { prepare: vi.fn() } as unknown as Database;
    vi.clearAllMocks();
    mocks.computeInputSetHash.mockReturnValue('input-hash-1');
  });

  afterEach(() => { env.cleanup(); });

  it('1. skips when fewer than 3 eligible inputs and no timeout', async () => {
    mocks.queryEligibleInputs.mockReturnValue([
      { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
    ]);

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBe(true);
    expect(mocks.claimRun).not.toHaveBeenCalled();
    expect(mocks.createStaging).not.toHaveBeenCalled();
  });

  it('2. success flow — claims, stages, runs agent, validates, snapshots, publishes, completes, health', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-1', lockToken: 'tok-1' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-1'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: {
        inputs: [
          { inputKind: 'rollout', inputKey: 'r1', contentHash: 'h1', disposition: 'absorbed' },
          { inputKind: 'rollout', inputKey: 'r2', contentHash: 'h2', disposition: 'no_change' },
          { inputKind: 'rollout', inputKey: 'r3', contentHash: 'h3', disposition: 'absorbed' },
        ],
        health: { added: 2, merged: 0, retired: 0, no_change: 1, rejected: 0 },
      },
    });
    mocks.validateStaging.mockReturnValue({
      valid: true,
      errors: [],
      warnings: [],
    });
    mocks.createSnapshot.mockResolvedValue({ snapshotDir: path.join(env.snapshotRoot, 'snap-1'), manifestHash: 'snap-hash' });
    mocks.preparePublication.mockResolvedValue({
      run_id: 'run-1', generation: 2, old_manifest_hash: 'old', new_manifest_hash: 'new',
      old_policy_version: null, new_policy_version: null, old_layout_version: null, new_layout_version: null,
      backup_dir: path.join(env.stagingRoot, 'run-1', 'backup'),
      steps: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.skipped).toBeFalsy();
    expect(result.success).toBe(true);
    expect(result.runId).toBe('run-1');

    // Verify call order.
    expect(mocks.queryEligibleInputs).toHaveBeenCalled();
    expect(mocks.claimRun).toHaveBeenCalled();
    expect(mocks.createStaging).toHaveBeenCalled();
    expect(mocks.runCurationAgent).toHaveBeenCalled();
    expect(mocks.validateStaging).toHaveBeenCalled();
    expect(mocks.createSnapshot).toHaveBeenCalled();
    expect(mocks.preparePublication).toHaveBeenCalled();
    expect(mocks.executePublication).toHaveBeenCalled();
    expect(mocks.completeRun).toHaveBeenCalled();
    expect(mocks.appendHealthReport).toHaveBeenCalled();
    expect(mocks.deleteStaging).toHaveBeenCalled();
  });

  it('3. validation failure — calls failRun, deletes staging, no publish', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-2', lockToken: 'tok-2' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-2'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockResolvedValue({
      timedOut: false,
      receipt: {
        inputs: [],
        health: { added: 0, merged: 0, retired: 0, no_change: 0, rejected: 0 },
      },
    });
    mocks.validateStaging.mockReturnValue({
      valid: false,
      errors: ['invalid frontmatter in items/preference/bad.md'],
      warnings: [],
    });

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-2');
    expect(result.error).toContain('invalid frontmatter');

    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-2', expect.stringContaining('invalid frontmatter'), expect.any(Number));
    expect(mocks.deleteStaging).toHaveBeenCalled();
    expect(mocks.preparePublication).not.toHaveBeenCalled();
    expect(mocks.executePublication).not.toHaveBeenCalled();
    expect(mocks.completeRun).not.toHaveBeenCalled();
  });

  it('4. agent timeout — calls failRun, deletes staging, no publish', async () => {
    const inputs = [
      { inputKind: 'rollout' as const, inputKey: 'r1', contentHash: 'h1', outputUpdatedAt: T0, rolloutSlug: 's1', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r2', contentHash: 'h2', outputUpdatedAt: T0, rolloutSlug: 's2', bytes: 100 },
      { inputKind: 'rollout' as const, inputKey: 'r3', contentHash: 'h3', outputUpdatedAt: T0, rolloutSlug: 's3', bytes: 100 },
    ];
    mocks.queryEligibleInputs.mockReturnValue(inputs);
    mocks.claimRun.mockReturnValue({ runId: 'run-3', lockToken: 'tok-3' });
    mocks.createStaging.mockResolvedValue({ stagingDir: path.join(env.stagingRoot, 'run-3'), manifestHash: 'stg-hash' });
    mocks.runCurationAgent.mockRejectedValue(new Error('agent timeout'));

    const result = await runCurationCycle(db, {
      memoryRoot: env.memoryRoot,
      configRoot: env.configRoot,
      stagingRoot: env.stagingRoot,
      snapshotRoot: env.snapshotRoot,
      providerConfig: { apiKey: 'k', model: 'm', baseUrl: 'u', provider: 'anthropic' },
      systemLocation: 'global',
      workerId: 'w1',
      pool: {} as unknown as AgentProcessPool,
      sessionId: 'session-1',
      now: T0,
    });

    expect(result.success).toBe(false);
    expect(result.runId).toBe('run-3');
    expect(result.error).toContain('timeout');

    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), 'run-3', expect.stringContaining('timeout'), expect.any(Number));
    expect(mocks.deleteStaging).toHaveBeenCalled();
    expect(mocks.validateStaging).not.toHaveBeenCalled();
    expect(mocks.preparePublication).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publish_orchestrator.test.ts`
Expected: FAIL — module `../curation_publish_orchestrator` not found.

- [x] **Step 3: Write the implementation**

Create `electron/memory/curation_publish_orchestrator.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Database } from 'better-sqlite3';
import type { AgentProcessPool } from '../agents/process-pool/agent-process-pool';

import {
  queryEligibleInputs,
  claimRun,
  completeRun,
  failRun,
  computeInputSetHash,
  type CurationInput,
  type EligibleInput,
  type InputDisposition,
} from '../../packages/agent/src/memory-state/curation_ledger';
import { createStaging, deleteStaging } from './curation_staging';
import { runCurationAgent, type RunCurationAgentResult } from './curation_agent_runner';
import { validateStaging } from '../../packages/agent/src/memory-state/curation_validator';
import { preparePublication, executePublication } from './curation_publisher';
import { createSnapshot } from './curation_snapshot';
import { appendHealthReport, type HealthReport } from '../../packages/agent/src/memory-state/curation_health';

/**
 * End-to-end curation cycle orchestrator (design §8.4 + §9.1).
 *
 * Wires the full flow:
 *   queryEligibleInputs → claimRun → createStaging → runCurationAgent →
 *   validateStaging → createSnapshot → preparePublication →
 *   executePublication → completeRun → appendHealthReport → deleteStaging
 *
 * During Phase B shadow, the caller sets `shadowMode=true` which skips
 * the snapshot/publish/complete steps and discards staging after
 * validation — no live memory writes occur.
 */

const MIN_INPUTS_FOR_RUN = 3;
const MAX_INPUTS = 8;
const MAX_INPUT_BYTES = 512 * 1024;
const AGENT_TIMEOUT_MS = 600_000; // 10 minutes

export interface ProviderConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
}

export interface RunCurationCycleOpts {
  memoryRoot: string;
  configRoot: string;
  stagingRoot: string;
  snapshotRoot: string;
  providerConfig: ProviderConfig;
  systemLocation: string;
  workerId: string;
  pool: AgentProcessPool;
  sessionId: string;
  now?: number;
  shadowMode?: boolean;
}

export interface CycleResult {
  skipped: boolean;
  success: boolean;
  runId?: string;
  error?: string;
  durationMs?: number;
}

/**
 * Run a single curation cycle. Returns the result of the cycle.
 *
 * The cycle is single-flight: if no eligible inputs meet the minimum
 * threshold (and no timeout), it returns `{ skipped: true }` without
 * claiming a run.
 */
export async function runCurationCycle(
  db: Database,
  opts: RunCurationCycleOpts,
): Promise<CycleResult> {
  const startTime = Date.now();
  const now = opts.now ?? Date.now();

  // 1. Query eligible inputs.
  const eligible = queryEligibleInputs(db, {
    maxInputs: MAX_INPUTS,
    maxInputBytes: MAX_INPUT_BYTES,
    now,
  });

  // 2. Skip if not enough inputs.
  if (eligible.length < MIN_INPUTS_FOR_RUN) {
    return { skipped: true, success: false };
  }

  // 3. Claim the run.
  const inputSetHash = computeInputSetHash(eligible);
  const baseManifestHash = computeLiveManifestHash(opts.memoryRoot);
  const inputs: CurationInput[] = eligible.map((e) => ({
    inputKind: e.inputKind,
    inputKey: e.inputKey,
    contentHash: e.contentHash,
    outputUpdatedAt: e.outputUpdatedAt,
  }));

  let runId: string;
  let lockToken: string;
  try {
    const claim = claimRun(db, {
      inputSetHash,
      baseManifestHash,
      claimedBy: opts.workerId,
      leaseTtlMs: AGENT_TIMEOUT_MS + 60_000,
      inputs,
      now,
    });
    runId = claim.runId;
    lockToken = claim.lockToken;
  } catch (err) {
    // Single-flight: another run is in flight.
    return {
      skipped: true,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let stagingDir: string | null = null;

  try {
    // 4. Create staging workspace.
    const stagingResult = await createStaging(opts.stagingRoot, runId, {
      memoryRoot: opts.memoryRoot,
      configRoot: opts.configRoot,
      inputs: eligible.map((e) => ({
        inputKind: e.inputKind,
        inputKey: e.inputKey,
        contentHash: e.contentHash,
        sourcePath: path.join(opts.memoryRoot, 'rollout_summaries', `${e.inputKey}.md`),
      })),
    });
    stagingDir = stagingResult.stagingDir;

    // 5. Run the curation agent.
    let agentResult: RunCurationAgentResult;
    try {
      agentResult = await runCurationAgent({
        pool: opts.pool,
        sessionId: opts.sessionId,
        stagingDir,
        runId,
        inputs,
        providerConfig: opts.providerConfig,
        systemLocation: opts.systemLocation,
        timeoutMs: AGENT_TIMEOUT_MS,
      });
    } catch (err) {
      await failRun(db, runId, `agent failed: ${err instanceof Error ? err.message : String(err)}`, Date.now());
      await deleteStaging(stagingDir);
      return {
        skipped: false,
        success: false,
        runId,
        error: `agent failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 6. Validate staging.
    const validation = validateStaging(stagingDir, inputs);

    if (!validation.valid) {
      const errorMsg = validation.errors.join('; ');
      failRun(db, runId, `validation failed: ${errorMsg}`, now + AGENT_TIMEOUT_MS);
      return {
        skipped: false,
        success: false,
        runId,
        error: `validation failed: ${errorMsg}`,
        durationMs: Date.now() - startTime,
      };
    }

    // 7. Shadow mode: stop here, discard staging.
    if (opts.shadowMode) {
      await deleteStaging(stagingDir);
      return {
        skipped: false,
        success: true,
        runId,
        durationMs: Date.now() - startTime,
      };
    }

    // 8. Create pre-publish snapshot.
    const snapshotResult = await createSnapshot({
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
      snapshotRoot: opts.snapshotRoot,
    });

    // 9. Prepare publication.
    const journal = await preparePublication({
      runId,
      stagingDir,
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
      oldManifestHash: baseManifestHash,
      generation: extractCurrentGeneration(opts.memoryRoot) + 1,
    });

    // 10. Execute publication.
    await executePublication(journal, {
      stagingDir,
      liveMemoryRoot: opts.memoryRoot,
      liveConfigRoot: opts.configRoot,
    });

    // 11. Complete the run in the ledger.
    const dispositions: InputDisposition[] = agentResult.receipt?.inputs.map((i: { inputKind: 'rollout' | 'ad_hoc'; inputKey: string; contentHash: string; disposition: 'absorbed' | 'no_change' | 'rejected' | 'deferred'; note?: string }) => ({
      inputKind: i.inputKind,
      inputKey: i.inputKey,
      contentHash: i.contentHash,
      disposition: i.disposition,
      note: i.note,
    })) ?? [];

    completeRun(db, runId, {
      dispositions,
      publicationStatus: 'succeeded',
      cacheStatus: 'ok',
      now: Date.now(),
    });

    // 12. Append health report.
    const health: HealthReport = {
      run_id: runId,
      timestamp: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      inputs: inputs.length,
      added: agentResult.receipt?.health?.added ?? 0,
      merged: agentResult.receipt?.health?.merged ?? 0,
      retired: agentResult.receipt?.health?.retired ?? 0,
      no_change: agentResult.receipt?.health?.no_change ?? 0,
      rejected: agentResult.receipt?.health?.rejected ?? 0,
      duplicate_rate: inputs.length > 0
        ? (agentResult.receipt?.health?.rejected ?? 0) / inputs.length
        : 0,
      memory_md_size: fs.existsSync(path.join(opts.memoryRoot, 'MEMORY.md'))
        ? fs.statSync(path.join(opts.memoryRoot, 'MEMORY.md')).size
        : 0,
      summary_md_size: fs.existsSync(path.join(opts.memoryRoot, 'summary.md'))
        ? fs.statSync(path.join(opts.memoryRoot, 'summary.md')).size
        : 0,
      entity_files: countEntityFiles(opts.memoryRoot),
      policy_version: null,
      layout_version: null,
    };
    appendHealthReport(opts.snapshotRoot, health);

    return {
      skipped: false,
      success: true,
      runId,
      durationMs: Date.now() - startTime,
    };
  } finally {
    // 13. Clean up staging.
    if (stagingDir) {
      await deleteStaging(stagingDir);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeLiveManifestHash(memoryRoot: string): string {
  const manifestPath = path.join(memoryRoot, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    const content = fs.readFileSync(manifestPath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  }
  return 'empty';
}

function extractCurrentGeneration(memoryRoot: string): number {
  const manifestPath = path.join(memoryRoot, '.manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return manifest.generation ?? 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

function countEntityFiles(memoryRoot: string): number {
  const entitiesDir = path.join(memoryRoot, 'entities');
  if (!fs.existsSync(entitiesDir)) return 0;
  let count = 0;
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
        count++;
      }
    }
  }
  walk(entitiesDir);
  return count;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publish_orchestrator.test.ts`
Expected: PASS — all 4 tests pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publish_orchestrator.ts \
        electron/memory/__tests__/curation_publish_orchestrator.test.ts
git commit -m "feat(memory): add curation_publish_orchestrator runCurationCycle"
```

---

## Task 11: curation_publish_orchestrator.ts — crash recovery integration

**Files:**
- Modify: `electron/memory/curation_publish_orchestrator.ts`
- Modify: `electron/memory/__tests__/curation_publish_orchestrator.test.ts`

- [x] **Step 1: Write the failing tests**

Add `recoverAllPublications` and `type RecoveryScanResult` to the import at the top of `electron/memory/__tests__/curation_publish_orchestrator.test.ts`:

```typescript
import { runCurationCycle, recoverAllPublications, type CycleResult, type RecoveryScanResult } from '../curation_publish_orchestrator';
```

Also add `readJournal` and `writeJournal` to the curation_publisher mock import, and `recoverPublication` to the mock. Update the mock block:

```typescript
vi.mock('../curation_publisher', () => ({
  preparePublication: mocks.preparePublication,
  executePublication: mocks.executePublication,
  recoverPublication: mocks.recoverPublication,
  readJournal: mocks.readJournal,
}));

// Add to hoisted mocks:
recoverPublication: vi.fn(),
readJournal: vi.fn(),
```

Append the following `describe` block:

```typescript
describe('recoverAllPublications', () => {
  let env: OrchEnv;

  beforeEach(() => {
    env = makeEnv();
    vi.clearAllMocks();
  });

  afterEach(() => { env.cleanup(); });

  it('1. no staging directories — returns empty results, noop', async () => {
    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(0);
    expect(mocks.recoverPublication).not.toHaveBeenCalled();
  });

  it('2. journal not found in staging dir — skipped, not recovered', async () => {
    // Create a staging dir without a journal.
    fs.mkdirSync(path.join(env.stagingRoot, 'stale-run'), { recursive: true });
    fs.writeFileSync(path.join(env.stagingRoot, 'stale-run', 'some-file.md'), '# stale');
    mocks.readJournal.mockReturnValue(null);

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(0);
  });

  it('3. journal found with prepared state — recovers and returns discard result', async () => {
    const stagingDir = path.join(env.stagingRoot, 'run-1');
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(
      path.join(stagingDir, 'publication.journal.json'),
      JSON.stringify({
        run_id: 'run-1',
        generation: 2,
        old_manifest_hash: 'old',
        new_manifest_hash: 'new',
        old_policy_version: null,
        new_policy_version: null,
        old_layout_version: null,
        new_layout_version: null,
        backup_dir: path.join(stagingDir, 'backup'),
        steps: [
          { step: 'backup_old', status: 'done', ts: '2026-08-03T10:00:00Z' },
          { step: 'move_leaf', status: 'pending', ts: null },
          { step: 'move_config', status: 'pending', ts: null },
          { step: 'regenerate_indexes', status: 'pending', ts: null },
          { step: 'regenerate_MEMORY_md', status: 'pending', ts: null },
          { step: 'regenerate_summary_md', status: 'pending', ts: null },
          { step: 'swap_manifest', status: 'pending', ts: null },
        ],
      })
    );

    mocks.recoverPublication.mockResolvedValue({
      action: 'discard',
      runId: 'run-1',
    });

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('discard');
    expect(results[0].runId).toBe('run-1');
  });

  it('4. multiple staging dirs with journals — recovers all', async () => {
    for (const runId of ['run-a', 'run-b']) {
      const stagingDir = path.join(env.stagingRoot, runId);
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(
        path.join(stagingDir, 'publication.journal.json'),
        JSON.stringify({
          run_id: runId,
          generation: 1,
          old_manifest_hash: 'old',
          new_manifest_hash: 'new',
          old_policy_version: null,
          new_policy_version: null,
          old_layout_version: null,
          new_layout_version: null,
          backup_dir: path.join(stagingDir, 'backup'),
          steps: [],
        })
      );
    }

    mocks.recoverPublication
      .mockResolvedValueOnce({ action: 'discard', runId: 'run-a' })
      .mockResolvedValueOnce({ action: 'finalize', runId: 'run-b' });

    const results = await recoverAllPublications({
      stagingRoot: env.stagingRoot,
      liveMemoryRoot: env.memoryRoot,
    });

    expect(results).toHaveLength(2);
    expect(results[0].runId).toBe('run-a');
    expect(results[1].runId).toBe('run-b');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run electron/memory/__tests__/curation_publish_orchestrator.test.ts`
Expected: FAIL — `recoverAllPublications` is not exported from `../curation_publish_orchestrator`.

- [x] **Step 3: Write the implementation**

Add the import for `recoverPublication` and `readJournal` to the existing import from `./curation_publisher` at the top of `electron/memory/curation_publish_orchestrator.ts`:

```typescript
import { preparePublication, executePublication, recoverPublication, readJournal } from './curation_publisher';
```

Append the following to `electron/memory/curation_publish_orchestrator.ts` (after the existing `runCurationCycle` function and its helpers):

```typescript
// ---------------------------------------------------------------------------
// recoverAllPublications (design §8.5)
// ---------------------------------------------------------------------------

export interface RecoveryScanResult {
  runId: string;
  action: RecoveryAction;
}

export interface RecoverAllOpts {
  stagingRoot: string;
  liveMemoryRoot: string;
}

/**
 * Scan all staging directories for unfinished publication journals and
 * recover them. Called on memory-worker startup (design §8.5).
 *
 * For each `stagingRoot/<run_id>/publication.journal.json` found:
 *   1. Call `recoverPublication` to determine + perform the recovery action
 *   2. Record the result
 *
 * Returns a list of recovery results, one per journal found.
 */
export async function recoverAllPublications(opts: RecoverAllOpts): Promise<RecoveryScanResult[]> {
  if (!fs.existsSync(opts.stagingRoot)) return [];

  const results: RecoveryScanResult[] = [];

  const entries = fs.readdirSync(opts.stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const stagingDir = path.join(opts.stagingRoot, entry.name);
    const journalPath = path.join(stagingDir, 'publication.journal.json');

    if (!fs.existsSync(journalPath)) continue;

    const recovery = await recoverPublication(journalPath, opts.liveMemoryRoot);

    results.push({
      runId: recovery.runId ?? entry.name,
      action: recovery.action,
    });
  }

  return results;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run electron/memory/__tests__/curation_publish_orchestrator.test.ts`
Expected: PASS — all tests in both `runCurationCycle` and `recoverAllPublications` pass.

- [x] **Step 5: Commit**

```bash
git add electron/memory/curation_publish_orchestrator.ts \
        electron/memory/__tests__/curation_publish_orchestrator.test.ts
git commit -m "feat(memory): add curation_publish_orchestrator recoverAllPublications"
```

---

## Final Verification

- [x] **Step 1: Run the complete test suite for all new modules**

```bash
npx vitest run packages/agent/src/memory-state/curation_projection.test.ts \
             packages/agent/src/memory-state/curation_health.test.ts \
             electron/memory/__tests__/curation_publisher.test.ts \
             electron/memory/__tests__/curation_snapshot.test.ts \
             electron/memory/__tests__/curation_publish_orchestrator.test.ts
```

Expected: ALL PASS.

- [x] **Step 2: Run typecheck**

```bash
npm run typecheck:all
```

Expected: 0 errors.

- [x] **Step 3: Run full memory-state test suite for regressions**

```bash
npx vitest run packages/agent/src/memory-state/__tests__/
```

Expected: ALL PASS — no regression from new modules.

- [x] **Step 4: Verify no behavior change when Phase 2 is not enabled**

No worker code calls `runCurationCycle` or `recoverAllPublications` yet. The old consolidator and `phase2_runs` table are untouched. Verify:

```bash
npx vitest run electron/memory/
```

Expected: ALL PASS — no regression in existing memory tests.

---

## Notes

### What this plan does NOT do (out of scope, deferred to later plans)

- **No worker integration**: `memory-worker.ts` is not modified. The Hybrid trigger (§9.1) and the call site for `runCurationCycle` / `recoverAllPublications` are in a future plan (405+).
- **No `DUYA_MEMORY_PHASE2_ENABLED` gate**: Since no worker code calls these functions yet, the gate is implicit (dead code). The gate will be added when the worker integration plan wires the first caller.
- **No `curation_publications` table writes**: The table was created by migration 0008 (Plan 402) but no function writes to it yet. A future plan can add audit-query helpers that read from it.
- **No `memory_entries` cache rebuild**: The `cache_pending` state (§8.2) is defined but the `rebuildMemoryEntriesFromFiles` job is deferred to Phase C.
- **No projection outbox integration**: Phase 2 publication writes projections directly to disk via `executePublication`; the outbox (`drainOutbox`) remains for Stage 1 rollout summaries only.
- **No old `projectionContent.ts` Phase 2 renderer removal**: The old `renderUnifiedMemoryFile` / `renderMemorySummaryFile` functions are still present but superseded. They will be deleted in Phase D.

### Design decisions

1. **Minimal YAML frontmatter parser** (`parseFrontmatter`): handles only flat `key: value` pairs (quoted strings, booleans, null). This is sufficient for the canonical file format (§4.1) and avoids adding a YAML dependency. The validator (Plan 403) performs full schema validation; the projection generator only needs to read a few fields.

2. **`generateMemoryMd` groups by `claim_type` alphabetically**: the design says "sectioned by claim_type" without specifying order. Alphabetical is the most deterministic choice and makes diffs stable.

3. **`firstParagraph` skips H1 title**: the body format is `# Title\n\n<paragraph>\n## Details`. The projection line uses the first paragraph after the H1, not the title, because the title is derived from the slug and would be redundant with `canonical_key`.

4. **`writeJournal` uses temp + fsync + rename**: the journal itself must be crash-safe. Writing directly to the target could leave a partial JSON if the process crashes mid-write. The temp+rename pattern ensures the journal is either fully present or absent.

5. **`preparePublication` computes `new_manifest_hash` from staging content**: this hash is written to the journal and later to `.manifest.json` during `swap_manifest`. It lets crash recovery verify that the published content matches what was prepared.

6. **`executePublication` syncs directories, not individual files**: `syncDirRecursive` copies all files from staging to live and deletes files that exist in live but not staging. This handles additions, modifications, and deletions in one pass. The journal still records the step as `move_leaf` for auditability.

7. **`recoverPublication` uses `backup_dir` from the journal**: the backup directory path is