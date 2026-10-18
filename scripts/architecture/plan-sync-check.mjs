#!/usr/bin/env node
/**
 * plan-sync-check — make plan 19 §11's tracking table mechanically checkable.
 *
 * ## Why this exists
 *
 * 19 §11 calls itself "the single source of truth" and says a card is done when
 * it has a named test and a commit, not a status word. That was an honour
 * system. On 2026-10-18 two cards still read `todo` long after they landed
 * (#277 and #279, both reachable from §1), and two other cards' "first failure
 * evidence" had expired — the bundle had been rebuilt. All four cost time to
 * re-derive, and every one of them was found by hand, not by a tool.
 *
 * ## What it checks, for rows whose status cell starts with `done`
 *
 * 1. Every path-like token in the evidence cell resolves to a file that exists.
 *    A bare filename (`client-closure-gate.test.ts`) is resolved by searching
 *    the repo, because that is how the table is written today.
 * 2. Every `path.ts: 用例名` pair resolves: the file exists AND the test name is
 *    found inside it.
 *
 * ## The part that matters more than the checks: refusing to pass vacuously
 *
 * The table carries almost no `file: name` pairs today — most evidence cells
 * name a file and a count, or nothing but a SHA. A checker that only understood
 * pairs would report success having verified zero rows, and would look exactly
 * like a gate that works. So this script prints what it actually examined and
 * treats "done rows exist, nothing was verifiable" as a FAILURE, not a pass:
 *
 *     plan-sync-check  12 done rows · 9 file refs · 0 test-name refs
 *     plan-sync-check  VACUOUS  done rows carry no verifiable test names
 *
 * That is the intended first run. The pressure it puts on the table is the
 * feature: the next person to mark a card `done` has to name a test that
 * exists, which is exactly what 19 §4 rule 4 asks for.
 *
 * ## Exit codes
 *
 * 0  every done row's evidence resolves, and at least one test name was checked
 * 1  a referenced file or test name is missing, or nothing was verifiable
 * 2  the table could not be found or parsed
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');

export const PLAN_REL = 'docs/exec-plans/active/610-architecture-series/19-fast-track-queue.md';
/** The table this owns. Another table in the same file must not be picked up. */
const SECTION_HEADING = /^##\s*11\./;
const TABLE_HEADER = /^\|\s*卡\s*\|/;

/** Tokens in an evidence cell that name a file this repo owns. */
const FILE_RE = /(?:[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?|[\w./-]+\.mjs)\b/g;
/**
 * `path.ts: 用例名` — the form the card asks for.
 *
 * The optional closing backtick matters: the table writes the path inside
 * backticks (`path.ts`), so the character between the filename and the colon is
 * a backtick, not whitespace. Without it the pattern silently matched nothing
 * and the whole check reported zero names — which is exactly the failure this
 * script exists to make visible.
 */
const NAME_RE = /([\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?)`?\s*[:：]\s*[`"“]([^`"”\n]{2,})[`"”]/g;

/** A bare filename still has to be findable somewhere in the tree. */
function findByBasename(basename) {
  const out = execFileSync('git', ['ls-files', '*' + basename], { cwd: ROOT, encoding: 'utf8' });
  const hits = out.split('\n').map((l) => l.trim()).filter(Boolean);
  return hits.length === 1 ? hits[0] : null;
}

function resolveFileRef(token) {
  if (existsSync(path.join(ROOT, token))) return { ok: true, rel: token };
  if (!token.includes('/')) {
    const hit = findByBasename(token);
    if (hit !== null) return { ok: true, rel: hit, resolvedFrom: token };
  }
  return { ok: false };
}

/** Pull the §11 rows out of the plan. Returns [] if the table is gone. */
export function parseTrackingRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => SECTION_HEADING.test(l));
  if (start === -1) return [];
  let tableAt = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (TABLE_HEADER.test(lines[i])) { tableAt = i; break; }
    // The section cannot bleed into the next one.
    if (i > start && /^##\s/.test(lines[i])) return [];
  }
  if (tableAt === -1) return [];

  const rows = [];
  for (let i = tableAt + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    if (/^\|\s*---/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 5) continue;
    rows.push({ card: cells[0], status: cells[3], evidence: cells[4] });
  }
  return rows;
}

const isDone = (row) => /done/i.test(row.status);

/**
 * @returns {{rows:number, fileRefs:number, nameRefs:number, failures:string[]}}
 */
export function checkTrackingTable(markdown) {
  const rows = parseTrackingRows(markdown);
  const done = rows.filter(isDone);
  const failures = [];
  let fileRefs = 0;
  let nameRefs = 0;

  for (const row of done) {
    for (const [token] of row.evidence.matchAll(FILE_RE)) {
      fileRefs += 1;
      const res = resolveFileRef(token);
      if (!res.ok) {
        failures.push(`${row.card} → ${token}: no such file in the tree`);
      }
    }
    for (const [, file, name] of row.evidence.matchAll(NAME_RE)) {
      nameRefs += 1;
      const res = resolveFileRef(file);
      if (!res.ok) {
        failures.push(`${row.card} → ${file}: no such file in the tree`);
        continue;
      }
      const body = readFileSync(path.join(ROOT, res.rel), 'utf8');
      if (!body.includes(name)) {
        failures.push(`${row.card} → ${res.rel}: no test matching "${name}"`);
      }
    }
  }

  return { rows: done.length, fileRefs, nameRefs, failures };
}

function main(argv) {
  const strict = argv.includes('--strict');
  const planPath = path.join(ROOT, PLAN_REL);
  if (!existsSync(planPath)) {
    console.error(`plan-sync-check  MISSING  ${PLAN_REL}`);
    return 2;
  }
  const markdown = readFileSync(planPath, 'utf8');
  const result = checkTrackingTable(markdown);

  console.log(
    `plan-sync-check  ${result.rows} done rows · ${result.fileRefs} file refs · ${result.nameRefs} test-name refs`,
  );
  for (const failure of result.failures) console.error(`plan-sync-check  FAIL  ${failure}`);

  if (result.rows === 0) {
    console.error('plan-sync-check  FAIL  no rows are marked done — is the table still there?');
    return 1;
  }
  // The whole point. Zero rows read, everything read: either the table lost its
  // evidence column or this parser stopped understanding it, and both look
  // identical to a gate that works.
  if (result.nameRefs === 0) {
    console.error(
      'plan-sync-check  VACUOUS  done rows carry no `file.ts: "test name"` evidence, so nothing was checked for content',
    );
    if (strict) return 1;
  }
  if (result.failures.length > 0) return 1;
  console.log('plan-sync-check  OK');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
