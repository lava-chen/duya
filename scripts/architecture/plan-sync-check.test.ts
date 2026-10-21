/**
 * plan-sync-check.test.ts — what the plan↔code gate must actually catch.
 *
 * ## The failure this file is shaped around
 *
 * A gate that reads the tracking table and finds nothing to complain about has
 * two indistinguishable causes: the table is consistent, or the gate stopped
 * understanding the table. On 2026-10-18 the table carried **zero** `file: name`
 * pairs — most evidence cells name a file and a count, or nothing but a SHA —
 * so the first version of this checker would have reported success having
 * verified nothing at all, and would have looked exactly like a gate that works.
 *
 * Every case below therefore checks a COUNT, not just a verdict, and the
 * degenerate table gets its own case asserting it is refused rather than passed.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT, PLAN_REL, checkTrackingTable, parseTrackingRows } from './plan-sync-check.mjs';

/** A table shaped like the real one, so the parser is exercised for real. */
const table = (rows) => [
  '## 11. 追踪表（唯一状态源）',
  '',
  '| 卡 | 车道 | 前置 | 状态 | 证据（测试文件:用例 / commit） |',
  '| --- | --- | --- | --- | --- |',
  ...rows,
  '',
].join('\n');

const doneRow = (card, evidence) => `| ${card} | L-GATE | — | **done** | ${evidence} |`;
const todoRow = (card, evidence) => `| ${card} | L-GATE | — | todo | ${evidence} |`;

const CLIENT_GATE = 'scripts/architecture/client-closure-gate.test.ts';
const REAL_NAME = 'reports the CLI entry CLEAN';

describe('the plan parser finds the §11 table and nothing else', () => {
  it('reads rows from the §11 table', () => {
    const rows = parseTrackingRows(table([doneRow('T00', 'x'), todoRow('T01', 'y')]));
    expect(rows.map((r) => r.card)).toEqual(['T00', 'T01']);
    expect(rows[0].status).toBe('**done**');
  });

  it('does not stop at the first section heading it meets', () => {
    // The plan has §12 after §11. A parser that treated the next `##` as the
    // end of the document would be fine; one that treated the FIRST `##` as the
    // start would read nothing and report zero rows, which is the vacuous pass.
    const markdown = table([doneRow('T00', 'x')]) + '\n## 12. next\n\n| a | b |\n';
    expect(parseTrackingRows(markdown).length).toBe(1);
  });

  it('reports zero rows rather than throwing when the table is gone', () => {
    // Absent must not read as "nothing wrong".
    const result = checkTrackingTable('# 19 — no table here\n');
    expect(result.rows).toBe(0);
  });
});

describe('a done row must name evidence that exists', () => {
  it('passes when the cited test file and test name both exist', () => {
    const result = checkTrackingTable(
      table([doneRow('T16', `\`${CLIENT_GATE}\`: "${REAL_NAME}"`)]),
    );
    expect(result.failures).toEqual([]);
    expect(result.nameRefs).toBe(1);
  });

  it('fails, and says which test name is missing, when it does not', () => {
    const result = checkTrackingTable(
      table([doneRow('T16', `\`${CLIENT_GATE}\`: "a test that was never written"`)]),
    );
    expect(result.failures).toEqual([
      `T16 → ${CLIENT_GATE}: no test matching "a test that was never written"`,
    ]);
  });

  it('fails, and says so, when the file itself is gone', () => {
    const result = checkTrackingTable(
      table([doneRow('T16', '`packages/gone/never-existed.test.ts`: "anything"')]),
    );
    expect(result.failures[0]).toContain('no such file in the tree');
  });

  it('resolves a bare filename the way the table writes it today', () => {
    // §11 says `client-closure-gate.test.ts`, not the full path. A checker that
    // only understood full paths would report this row's file as missing, and
    // the first person to run it would "fix" the table instead of the checker.
    const result = checkTrackingTable(
      table([doneRow('T14', '`client-closure-gate.test.ts`: "' + REAL_NAME + '"')]),
    );
    expect(result.failures).toEqual([]);
  });
});

describe('only `done` rows are checked', () => {
  it('ignores a todo row whose evidence is already broken', () => {
    const result = checkTrackingTable(
      table([doneRow('T16', `\`${CLIENT_GATE}\`: "${REAL_NAME}"`), todoRow('T20', '`nope.test.ts`: "nope"')]),
    );
    expect(result.failures).toEqual([]);
    expect(result.rows).toBe(1);
  });
});

describe('the gate refuses to pass vacuously', () => {
  // This is the case that would have been missing on day one. Without it the
  // checker could read an evidence-free table and report OK, which is the same
  // silent state the card was written to end.
  it('reports zero names when no done row carries one', () => {
    const result = checkTrackingTable(
      table([doneRow('T00', '`44123662` · 8 files green'), todoRow('T01', '—')]),
    );
    expect(result.rows).toBe(1);
    expect(result.nameRefs).toBe(0);
  });

  it('still reports the file refs it DID examine, so the count is never zero-on-zero', () => {
    const result = checkTrackingTable(
      table([doneRow('T03', '`scripts/architecture/bundle-verify.test.ts` 16/16')]),
    );
    expect(result.fileRefs).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('does not treat a lone `todo` table as a pass either', () => {
    const result = checkTrackingTable(table([todoRow('T01', '—')]));
    expect(result.rows).toBe(0);
  });
});

describe('the real plan file', () => {
  it('exists, and has done rows that name verifiable tests', () => {
    expect(existsSync(path.join(ROOT, PLAN_REL))).toBe(true);
    const result = checkTrackingTable(readFileSync(path.join(ROOT, PLAN_REL), 'utf8'));
    // The counts are the assertion. A verdict alone here would pass on an
    // evidence-free table, which is the whole thing this gate prevents.
    expect(result.rows).toBeGreaterThan(0);
    expect(result.fileRefs).toBeGreaterThan(0);
    expect(result.nameRefs).toBeGreaterThan(0);
    expect(result.failures).toEqual([]);
  });
});
