/**
 * Every `file.ext:LINE` citation in this package's comments must resolve.
 *
 * ## Why this exists
 *
 * The PP-1 review found four assertions of fact that the source contradicts.
 * Three were comments, and one of those was a *mapping table* with a test
 * asserting it. The common mechanism was not carelessness — it was that a
 * `file.ts:123` citation is an unverifiable claim. Nothing in the build ever
 * read it, so a line that moved stayed confidently wrong, and a line that was
 * never checked stayed confidently wrong too.
 *
 * One of the four is still worth naming here, because it shows what a stale
 * citation costs. `run.ts` cited `router.ts:1697` for `handleDeleteChat`; the
 * function is at 1670. Twenty-seven lines of drift, and the sentence built on
 * it ("hard-migrates STREAMING -> COMPLETED ... at :1681-1683") was still
 * correct — which is exactly why the error was invisible. A citation can be
 * wrong in the line number while the claim it supports stays true, so
 * reading the code does not reliably catch it. Only a check does.
 *
 * ## What is actually asserted
 *
 * Three tiers, weakest to strongest:
 *
 *  1. the cited file resolves to exactly one file in this repo;
 *  2. the cited line range is inside that file;
 *  3. where the comment backticks a token immediately before the citation,
 *     that token actually appears in the cited range.
 *
 * Tier 3 is the one with teeth. `worker-protocol.ts:304` resolved fine and
 * was in range, and was still wrong: the comment anchored on
 * `chat:tool_result`, which is at line 300. A range check passes that; an
 * anchor check does not.
 *
 * ## What is deliberately NOT asserted
 *
 * Citations into the cloned reference repos under `E:/cloned-projects` cannot
 * be resolved from here, so they are allowlisted by path prefix and required
 * to say `external` in the comment. An allowlist is the honest form of this:
 * the alternative is a gate that silently passes everything it cannot see.
 * The coverage floor below is what stops that from becoming a way to opt out
 * of the whole test.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, extname, join } from 'node:path';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SRC = join(PKG_ROOT, 'src');

/**
 * Reference repos are not vendored, so a citation into one cannot be checked
 * from this checkout. Each entry must be named `external` in its comment.
 */
const EXTERNAL_PREFIXES = ['crates/common/xai-tool-protocol/'];

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'dist-electron', 'release', 'bundle',
  'coverage', '.claude',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.rs', '.py', '.md']);

// ── index every file in the repo by basename ────────────────────────────────
const byBasename = new Map<string, string[]>();
(function index(dir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      index(p);
      continue;
    }
    if (!SOURCE_EXT.has(extname(entry))) continue;
    const key = basename(p);
    if (!byBasename.has(key)) byBasename.set(key, []);
    // Normalised to forward slashes: the comparisons below are all `endsWith`,
    // and on Windows the raw path would never match a forward-slash citation.
    byBasename.get(key)!.push(p.replace(/\\/g, '/'));
  }
})(REPO_ROOT);

function packageSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...packageSources(p));
    else if (extname(p) === '.ts') out.push(p);
  }
  return out;
}

interface Citation {
  readonly from: string;
  readonly line: number;
  readonly ref: string;
  readonly start: number;
  readonly end: number;
  readonly anchor: string | null;
  readonly status: 'ok' | 'external' | 'ambiguous' | 'unresolved';
  readonly candidates: number;
  readonly totalLines: number | null;
  readonly anchorHolds: boolean | null;
  readonly commentLine: string;
}

const CITE = /((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|mts|rs|py|md)):(\d+)(?:-(\d+))?/g;

function normalise(s: string): string {
  return s.replace(/[`\s]/g, '');
}

function collect(): Citation[] {
  const out: Citation[] = [];
  for (const file of packageSources(SRC)) {
    const from = file.replace(/\\/g, '/').slice(REPO_ROOT.replace(/\\/g, '/').length);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      CITE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CITE.exec(text))) {
        const ref = m[1]!;
        const start = Number(m[2]);
        const end = m[3] ? Number(m[3]) : start;

        const ticks = [...text.slice(0, m.index).matchAll(/`([^`]+)`/g)];
        const anchor = ticks.length ? ticks[ticks.length - 1]![1]! : null;

        const candidates = byBasename.get(basename(ref)) ?? [];
        let status: Citation['status'];
        let resolved: string | null = null;
        if (EXTERNAL_PREFIXES.some((p) => ref.startsWith(p))) {
          status = 'external';
        } else if (ref.includes('/')) {
          const hit = candidates.find((c) => c.endsWith(ref));
          if (hit) {
            resolved = hit;
            status = 'ok';
          } else {
            status = 'unresolved';
          }
        } else if (candidates.length === 1) {
          resolved = candidates[0]!;
          status = 'ok';
        } else if (candidates.length === 0) {
          status = 'unresolved';
        } else {
          status = 'ambiguous';
        }

        let totalLines: number | null = null;
        let anchorHolds: boolean | null = null;
        if (resolved) {
          const body = readFileSync(resolved, 'utf8').split(/\r?\n/);
          totalLines = body.length;
          if (anchor) {
            const window = body.slice(start - 1, Math.min(end, body.length)).join('\n');
            const hay = normalise(window);
            const needle = normalise(anchor);
            // An anchor is often a path expression (`data.content`) rather
            // than a literal, so fall back to its last segment.
            const last = needle.split('.').pop() ?? '';
            anchorHolds =
              hay.includes(needle) || (last.length > 2 && hay.includes(last));
          }
        }

        out.push({
          from, line: i + 1, ref, start, end, anchor, status,
          candidates: candidates.length, totalLines, anchorHolds,
          commentLine: text.trim(),
        });
      }
    });
  }
  return out;
}

const citations = collect();
const where = (c: Citation) => `${c.from}:${c.line} -> ${c.ref}:${c.start}-${c.end}`;

describe('citation drift: every file:line claim in this package resolves', () => {
  it('finds a meaningful number of citations to check', () => {
    // Without this, an extractor that silently matches nothing would turn
    // every assertion below into a no-op that always passes.
    expect(citations.length).toBeGreaterThan(20);
    expect(citations.filter((c) => c.anchorHolds !== null).length).toBeGreaterThan(5);
  });

  it('no citation points at a file that does not exist here', () => {
    const bad = citations.filter((c) => c.status === 'unresolved');
    expect(bad.map(where), 'unresolved citation — fix the path or allowlist it').toEqual([]);
  });

  it('no citation is ambiguous', () => {
    // `types.ts` matches 63 files in this repo and `worker-protocol.ts`
    // matches two. A bare basename is a citation that cannot be checked and
    // may name the wrong file entirely.
    const bad = citations.filter((c) => c.status === 'ambiguous');
    expect(
      bad.map((c) => `${where(c)} (${c.candidates} candidates)`),
      'bare basename is not a resolvable citation — qualify the path',
    ).toEqual([]);
  });

  it('every cited line range is inside the file it names', () => {
    const bad = citations.filter((c) => c.status === 'ok' && c.totalLines !== null && c.end > c.totalLines);
    expect(bad.map((c) => `${where(c)} but the file has ${c.totalLines} lines`)).toEqual([]);
  });

  it('every backticked anchor actually appears in the range it cites', () => {
    // The tier with teeth. `worker-protocol.ts:304` was in range and still
    // wrong: the anchor `chat:tool_result` lives at line 300.
    const bad = citations.filter((c) => c.anchorHolds === false);
    expect(
      bad.map((c) => `${where(c)} does not contain ${JSON.stringify(c.anchor)}`),
      'the cited range does not contain the symbol the comment names',
    ).toEqual([]);
  });

  it('every external citation declares itself external', () => {
    // An unverifiable claim must at least be labelled as one.
    const externals = citations.filter((c) => c.status === 'external');
    for (const c of externals) {
      expect(
        c.commentLine.toLowerCase(),
        `${where(c)} cites a reference repo but does not say so`,
      ).toContain('external');
    }
  });
});
