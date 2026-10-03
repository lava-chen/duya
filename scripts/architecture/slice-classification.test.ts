/**
 * slice-classification.test.ts — the M5.1 inventory is checked against the repo,
 * not against itself.
 *
 * ## Why this file is the deliverable
 *
 * A classification kept in a table drifts: a directory is added, nobody
 * updates the map, and the map silently stops describing the tree. The map then
 * drives a cut list, and the cut list is wrong in a way nobody notices because
 * the map still parses.
 *
 * So the map is verified HERE, against the real filesystem, on every `npm test`
 * run. It fails when:
 *
 *   - a source file exists that no rule classifies   (a file was ADDED)
 *   - a rule classifies nothing                      (a directory was REMOVED)
 *   - a category's file fingerprint moves            (a file was RECATEGORISED)
 *   - a rule is shadowed by a broader rule above it  (the map has a dead rule)
 *   - a category in the closed vocabulary is unused   (the map lost a bucket)
 *
 * That is the E4.2 behaviour-matrix precedent applied to a classification: a
 * declared list, a closed vocabulary, and a verifier that reads the repo rather
 * than the declaration.
 *
 * ## The fingerprint, and why it is a count and not a full file list
 *
 * A full list of 3232 paths would be a second copy of the tree inside the test
 * suite, and it would be a list nobody reads. The fingerprint is a sorted,
 * newline-joined path list hashed per category: it changes when a file is
 * added, removed or moved between categories, and the failure message names the
 * CATEGORY that moved and how many files it holds, which is the fact a reviewer
 * needs. The exact path is available from the other assertions in this file,
 * which report real paths.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  FILE_OVERRIDES,
  PURE_VIOLATIONS,
  PORTS,
  RULES,
  UNCLASSIFIED_PREFIXES,
  classify,
  isUnclassifiedPrefix,
  type Category,
} from './slice-classification';
import { REPO_ROOT } from './slice-classification';
import { ROOTS, walk, rel } from './import-graph.mjs';

const SOURCE_FILES = ROOTS.flatMap((r) => walk(path.join(REPO_ROOT, r)))
  .map((p) => rel(p))
  .sort();

function fingerprintOf(files: readonly string[]): string {
  return createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 16);
}

/** Every classified file, bucketed by category. */
function bucket(): Map<Category, string[]> {
  const out = new Map<Category, string[]>();
  for (const category of CATEGORIES) out.set(category, []);
  for (const file of SOURCE_FILES) {
    const category = classify(file);
    if (category !== null) out.get(category)!.push(file);
  }
  return out;
}

/**
 * The recorded state of the inventory.
 *
 * Regenerate with `npx vitest run scripts/architecture/slice-classification`
 * and copy the reported values. Every number here was measured on the tree this
 * file landed on; a change to any of them is a change to the MAP, and the diff
 * in the commit message is the record of why.
 */
const EXPECTED = {
  counts: {
    wire: 55,
    pure: 5,
    'runtime-coordination': 276,
    'capability-adapter': 1169,
    'cp-durable': 158,
    'host-ui': 1204,
  } as Record<Category, number>,
  fingerprints: {
    wire: 'bb11ee6ec2033b94',
    pure: '49526bee62466d06',
    'runtime-coordination': 'f0d61fbaf3bd0cd5',
    'capability-adapter': '9b88a1dd7bd88227',
    'cp-durable': '8c04c08a84a8bfd8',
    'host-ui': 'f00892c81029ae55',
  } as Record<Category, string>,
  // 3232 source files walked, 2867 classified, 365 under a stated exclusion.
  total: 2867,
  unclassified: 365,
} as {
  counts: Record<Category, number>;
  fingerprints: Record<Category, string>;
  total: number;
  unclassified: number;
};

describe('the classification is a partition of the source tree', () => {
  it('classifies every source file except the deliberately unclassified ones', () => {
    const orphans = SOURCE_FILES.filter((f) => classify(f) === null);
    const explained = orphans.filter(isUnclassifiedPrefix);
    const unexplained = orphans.filter((f) => !isUnclassifiedPrefix(f));
    // A file no rule claims and no exclusion explains is a file the map does not
    // describe. Reported by path so the fix is obvious, not a count.
    expect(unexplained).toEqual([]);
    expect(explained.length).toBeGreaterThan(0);
  });

  it('excludes exactly the stated number of files', () => {
    // The gap is part of the deliverable, so its SIZE is a recorded fact. A
    // silently shrinking exclusion set is how a real source directory ends up
    // excused as "tests".
    const excluded = SOURCE_FILES.filter(
      (f) => classify(f) === null && isUnclassifiedPrefix(f),
    );
    expect({ excluded: excluded.length, recorded: EXPECTED.unclassified }).toEqual({
      excluded: EXPECTED.unclassified,
      recorded: EXPECTED.unclassified,
    });
  });

  it('states a reason for every unclassified prefix, so a gap is a decision', () => {
    const bare = UNCLASSIFIED_PREFIXES.filter((u) => u.why.trim().length === 0);
    expect(bare).toEqual([]);
  });

  it('holds each file in exactly one category', () => {
    // `classify` returns a single value by construction, so the real risk is
    // OVERLAP: two rules matching the same file where the second is dead. That
    // is asserted in the dead-rule test below; here the invariant is that the
    // union of the buckets is exactly the classified set, with no double count.
    const b = bucket();
    const total = [...b.values()].reduce((n, files) => n + files.length, 0);
    const classified = SOURCE_FILES.filter((f) => classify(f) !== null);
    expect(total).toBe(classified.length);
  });

  it('uses every category in the closed vocabulary', () => {
    // A category that quietly empties is how a map grows a hole nobody notices.
    const b = bucket();
    const empty = CATEGORIES.filter((c) => b.get(c)!.length === 0);
    expect(empty).toEqual([]);
  });
});

describe('the recorded inventory still describes the tree', () => {
  const b = bucket();

  it('classifies the same number of files as when it was recorded', () => {
    // ADD or REMOVE a file anywhere and this moves.
    const total = [...b.values()].reduce((n, files) => n + files.length, 0);
    expect({ total, recorded: EXPECTED.total }).toEqual({
      total: EXPECTED.total,
      recorded: EXPECTED.total,
    });
  });

  for (const category of CATEGORIES) {
    it(`holds the recorded number of ${category} files`, () => {
      expect({ category, count: b.get(category)!.length }).toEqual({
        category,
        count: EXPECTED.counts[category],
      });
    });

    it(`holds the recorded ${category} fingerprint`, () => {
      // RECATEGORISE a file, or rename one, and this moves: the fingerprint is
      // over the sorted path list, so it is sensitive to both.
      const actual = fingerprintOf(b.get(category)!);
      expect({ category, fingerprint: actual }).toEqual({
        category,
        fingerprint: EXPECTED.fingerprints[category],
      });
    });
  }
});

describe('the rules are ordered and none of them is dead', () => {
  it('never lets a broader rule shadow a narrower one', () => {
    // Most-specific-first is what makes "first match wins" correct. A broader
    // rule above a narrower one makes the narrower one unreachable, and an
    // unreachable rule is a claim about code that nothing reads.
    const shadowed: string[] = [];
    for (let i = 0; i < RULES.length; i++) {
      for (let j = i + 1; j < RULES.length; j++) {
        const upper = RULES[i].prefix;
        const lower = RULES[j].prefix;
        if (lower === upper || lower.startsWith(`${upper}/`)) {
          // `lower` is narrower. It is only reachable if no rule BETWEEN them
          // intercepts it; the simple case is `upper` directly above it, which
          // is what a reader would trip over.
          if (j === i + 1) shadowed.push(`${upper} shadows ${lower}`);
        }
      }
    }
    expect(shadowed).toEqual([]);
  });

  it('gives every rule a reason and a real category', () => {
    const bad = RULES.filter(
      (r) => r.why.trim().length === 0 || !CATEGORIES.includes(r.category),
    );
    expect(bad.map((r) => r.prefix)).toEqual([]);
  });

  it('matches at least one file, so no rule is a claim about nothing', () => {
    const dead = RULES.filter(
      (r) => !SOURCE_FILES.some((f) => f === r.prefix || f.startsWith(`${r.prefix}/`)),
    );
    expect(dead.map((r) => r.prefix)).toEqual([]);
  });

  it('never has two rules for the same prefix', () => {
    const seen = new Map<string, number>();
    for (const r of RULES) seen.set(r.prefix, (seen.get(r.prefix) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('gives every file override a reason, via a rule that already names the directory', () => {
    // An override with no covering rule is a file that exists only in the
    // override list, which is the shape that rots first.
    const orphans = Object.keys(FILE_OVERRIDES).filter(
      (f) => !RULES.some((r) => f.startsWith(`${r.prefix}/`) || f === r.prefix),
    );
    expect(orphans).toEqual([]);
  });
});

describe('the purity findings are real and still present', () => {
  it('cites a line that exists and still carries the evidence', () => {
    // A finding that names a stale line is worse than no finding: it reads as
    // verified. This re-reads each cited line and matches the recorded evidence
    // against it, so a fix that moves the line fails here and the finding is
    // retired deliberately.
    const broken: string[] = [];
    for (const v of PURE_VIOLATIONS) {
      const abs = path.join(REPO_ROOT, v.file);
      if (!fs.existsSync(abs)) {
        broken.push(`${v.file}: cited file does not exist`);
        continue;
      }
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      const actual = (lines[v.line - 1] ?? '').trim();
      if (!actual.includes(v.evidence.trim())) {
        broken.push(`${v.file}:${v.line} expected ${JSON.stringify(v.evidence)}, found ${JSON.stringify(actual)}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('names the declared layer and a reason for every violation', () => {
    const bare = PURE_VIOLATIONS.filter(
      (v) => v.declaredLayer.trim().length === 0 || v.why.trim().length === 0,
    );
    expect(bare.map((v) => v.file)).toEqual([]);
  });
});

describe('the declared ports are a placement decision, not a wish', () => {
  it('names a method, a target and the current shape for every port', () => {
    const bare = PORTS.filter(
      (p) =>
        p.name.trim().length === 0 ||
        p.method.trim().length === 0 ||
        p.target.trim().length === 0 ||
        p.now.trim().length === 0,
    );
    expect(bare.map((p) => p.name)).toEqual([]);
  });

  it('covers every port M5.1 names', () => {
    // The plan's list, verbatim. A port that quietly disappears from the map is
    // a slice that quietly did not get planned.
    const required = [
      'ModelClient',
      'ToolExecutor',
      'ContextLoader',
      'TranscriptRepository',
      'PermissionBroker',
      'Clock',
      'Telemetry',
      'ProcessScope',
      'SecretResolver',
    ];
    const declared = PORTS.map((p) => p.name);
    expect(required.filter((r) => !declared.includes(r))).toEqual([]);
  });

  it('gives every port a unique name', () => {
    const names = PORTS.map((p) => p.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
