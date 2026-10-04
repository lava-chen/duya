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
 *
 * DO NOT re-record on a red run without reading WHY it is red first. The test
 * reports the values it measured, and pasting them in turns the gate green in
 * one step whatever produced them — including a map whose own reasoning is
 * wrong, in which case the wrong answer is what gets recorded and the
 * misclassification becomes the verified baseline. Read the failing assertion,
 * decide whether the tree drifted or the MAP is wrong, fix the map if it is, and
 * then record. And itemise: a number that moved is a set of files, and the
 * commit that says so is the only reason a reviewer can tell an honest addition
 * from a silent reclassification.
 */
const EXPECTED = {
  counts: {
    wire: 48,
    pure: 6,
    'runtime-coordination': 293,
    'capability-adapter': 1174,
    'cp-durable': 173,
    'host-ui': 1204,
  } as Record<Category, number>,
  fingerprints: {
    wire: '42dac67979ff83d1',
    pure: '08339d25e58ae23c',
    'runtime-coordination': 'ebfac2679efe2cf4',
    'capability-adapter': '4f223dc18410c009',
    'cp-durable': '45a1db9875f8fab7',
    'host-ui': '5f4fdca6f9f9092c',
  } as Record<Category, string>,
  // 3278 source files walked, 2898 classified, 380 under a stated exclusion.
  //
  // 2894 -> 2898 (+4) and 374 -> 380 (+6): the D7.1 merge (master #177), measured
  // on the MERGED tree rather than on either side of it. Nothing in this delta is
  // H8.1's own work — the four files H8.1 added were already inside the 2894/374
  // reading and the merge does not move them — so the whole delta is D7.1's ten
  // new files.
  //
  // WHICH RULE claimed each one, rather than only which category it landed in,
  // because "it moved" is not an attribution and "a rule already recorded claimed
  // it, so nothing was edited to accommodate it" is:
  //
  //   wire                   47 ->  48 (+1)
  //     packages/agent-protocol/src/checkpoint.ts
  //       claimed by `packages/agent-protocol/src` [wire]
  //
  //   runtime-coordination  290 -> 293 (+3)
  //     packages/agent-runtime/src/checkpoint/branch-plan.ts
  //     packages/agent-runtime/src/checkpoint/checkpoint-store.ts
  //     packages/agent-runtime/src/checkpoint/unsupported.ts
  //       all three claimed by `packages/agent-runtime/src` [runtime-coordination]
  //
  //   unclassified           374 -> 380 (+6)
  //     apps/desktop/src/main/__tests__/headless-retirement.test.ts   (H8.1)
  //     apps/desktop/src/main/__tests__/d71-kill-recovery.test.ts
  //     packages/agent-runtime/test/checkpoint-branch.test.ts
  //     packages/agent-runtime/test/checkpoint-side-effects.test.ts
  //     packages/agent-runtime/test/checkpoint-store.test.ts
  //     packages/agent-runtime/test/checkpoint-unsupported.test.ts
  //
  // The six are unclassified for the SAME reason, and it is a stated exclusion
  // rather than a hole: the four `packages/agent-runtime/test` files sit under the
  // `packages/agent-runtime/test` prefix `UNCLASSIFIED_PREFIXES` already carries
  // with a reason, and the two `apps/desktop/src/main/__tests__` files sit under a
  // `__tests__` exclusion. So the counter moved WITHOUT a rule being added, which
  // is the distinction worth keeping: a reclassify-to-fit would have needed a
  // NEW prefix here, and a new prefix is visible in the diff of the map itself —
  // which is what `RULE_TABLE_FINGERPRINT` below now checks on every run.
  //
  // `capability-adapter` 1174, `cp-durable` 173, `host-ui` 1204, `pure` 6 and
  // their four fingerprints are byte-identical to the previous recording, which is
  // the evidence that the merge touched nothing outside the two categories and the
  // exclusion set named above.
  //
  // 2882 -> 2891 (+9) and 371 -> 373 (+2): plan 587 M5.1's own re-record. FOUR of
  // the moves were not that change: a97353b3 re-recorded this file, and the two
  // commits that landed after it each added one source file and one test file
  // without re-recording.
  //
  //   runtime-coordination  286 -> 287  packages/agent/src/agent/turnShape.ts
  //   capability-adapter  1173 -> 1174  packages/agent/src/tool/orchestration/canonical-path.ts
  //   unclassified          371 -> 373  packages/agent/tests/unit/agent/turn-shape.test.ts
  //                                       packages/agent/tests/unit/tool/orchestration/dependency-graph-serialisation.test.ts
  //
  //   (446721e3 and 86f5fe3e. The two test files sit under the
  //   packages/*/tests exclusion, which is why they move unclassified
  //   rather than a category.)
  //
  // The remaining +7 are this change, all in cp-durable and all classified
  // by the existing rules. No rule was edited to accommodate them.
  //
  //   cp-durable           166 -> 173  apps/desktop/src/main/db/core/workspace-store.ts
  //                                       apps/desktop/src/main/db/core/workspace-identity.ts
  //                                       apps/desktop/src/main/db/core/workspace-resolver.ts
  //                                       apps/desktop/src/main/db/core/__tests__/workspace-store.test.ts
  //                                       apps/desktop/src/main/db/core/__tests__/workspace-identity.test.ts
  //                                       apps/desktop/src/main/db/core/__tests__/workspace-resolver.test.ts
  //                                       apps/desktop/src/main/db/core/__tests__/workspace-rehearsal.test.ts
  //
  // 2891 -> 2894 (+3) and 373 -> 374 (+1): plan 587 H8.1, measured, not asserted.
  // Four files, and the split between the two counters is the record of WHICH
  // of them the existing rules put where:
  //
  //   runtime-coordination  287 -> 290  packages/agent/src/process/headless-run-host.ts
  //                                       packages/agent/src/process/sse-frame-codec.ts
  //                                       packages/agent/src/process/__tests__/headless-run-host.test.ts
  //   unclassified          373 -> 374  apps/desktop/src/main/__tests__/headless-retirement.test.ts
  //
  // No rule was edited to accommodate them, which is the load-bearing half:
  // the three `packages/agent/src/**` files classify as runtime coordination
  // under the rules already recorded, and the Desktop test file falls under
  // the `apps/desktop/src/main/__tests__` exclusion — so it moves the
  // UNCLASSIFIED counter rather than a category, exactly as the two test files
  // in the block above did.
  //
  // `sse-frame-codec.ts` counts here despite being an EXTRACTION rather than an
  // addition: it is a new file, and the classification is over paths, not over
  // lines of novel code.
  total: 2898,
  unclassified: 380,
} as {
  counts: Record<Category, number>;
  fingerprints: Record<Category, string>;
  total: number;
  unclassified: number;
};

/**
 * A fingerprint over the MAP itself, not over the files it classifies.
 *
 * ## Why this exists, given that the counts above already exist
 *
 * The counts and the per-category fingerprints are snapshots of the TREE, so
 * they go red whenever a legitimate file is added — which is most slices, and
 * has now cost three of them a re-record-and-attribute cycle. They are kept
 * anyway, because they catch something the properties do not: a file being
 * RECATEGORISED. But that value is currently entangled with the treadmill: when
 * a slice adds a file AND a rule is quietly edited to match it, both facts
 * arrive as the same red count, and the edit hides in the noise.
 *
 * This fingerprint separates the two. It hashes the rule table — every rule's
 * prefix, category and reason, every stated exclusion prefix and reason, and
 * every file override — so:
 *
 *  - a slice that adds files and edits nothing goes GREEN here, which is the
 *    treadmill removed for the case it is safe to remove it for;
 *  - a slice that edits the map goes RED here, naming the map as the thing that
 *    moved, even when the tree also moved and the counts cannot say which.
 *
 * ## What it deliberately does NOT do
 *
 * It does not replace the counts. Detecting a recategorisation needs something
 * recorded that a legitimate addition does not also change, and the only such
 * thing is a per-file record of which rule claimed it — which is a second copy
 * of the tree inside the test suite, and the header above rejects that on
 * purpose. So the two requirements are in direct tension, this resolves the half
 * that can be resolved safely, and the counts stay for the half that cannot.
 *
 * Re-record with:
 *   npx vite-node scripts/architecture/measure-rule-table.mts
 * Measured 2026-10-04 on the tree carrying plan 587 D7.1 (master #177) and H8.1:
 * 85 rules, 10 stated exclusions, 6 file overrides. The values are a property of
 * the MAP, so unlike the counts they only move when somebody changes the
 * classification itself.
 */
const RULE_TABLE_FINGERPRINT = 'f9af22a1ce0173f2';

/** The map, serialised in a way that is stable across reordering of nothing. */
function ruleTableFingerprint(): string {
  const table = [
    ...RULES.map((r) => `rule\t${r.prefix}\t${r.category}\t${r.why.trim()}`),
    ...UNCLASSIFIED_PREFIXES.map((u) => `unclassified\t${u.prefix}\t${u.why.trim()}`),
    ...Object.keys(FILE_OVERRIDES)
      .sort()
      .map((f) => `override\t${f}\t${FILE_OVERRIDES[f]}`),
  ].join('\n');
  return createHash('sha256').update(table).digest('hex').slice(0, 16);
}

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
  it('has not changed the MAP since it was recorded', () => {
    // The addition-tolerant half of the inventory check. Every assertion in this
    // file that reads the TREE goes red when a file is added, which is why the
    // re-record treadmill exists; this one reads the MAP, so a slice that adds
    // legitimate files and touches no rule is green, and a slice that edits a
    // rule to make a new file fit is red HERE rather than only in a count that
    // may also be red for an unrelated reason.
    //
    // Additive on purpose: the count snapshots above are untouched, because
    // recategorisation detection still needs them and this does not replace it.
    expect({ fingerprint: ruleTableFingerprint() }).toEqual({
      fingerprint: RULE_TABLE_FINGERPRINT,
    });
  });

  it('names the shape it hashed, so a mismatch says which map moved', () => {
    // A fingerprint with no description is a hash a reader has to guess at. These
    // three numbers are the map's size, and they are what makes the failure
    // above legible without opening the file.
    expect({
      rules: RULES.length,
      exclusions: UNCLASSIFIED_PREFIXES.length,
      overrides: Object.keys(FILE_OVERRIDES).length,
    }).toEqual({ rules: 85, exclusions: 10, overrides: 6 });
  });

  it('never lets a broader rule shadow a narrower one', () => {
    // Most-specific-first is what makes "first match wins" correct. A broader
    // rule above a narrower one makes the narrower one unreachable, and an
    // unreachable rule is a claim about code that nothing reads.
    //
    // ADJACENCY IS NOT THE TEST, and treating it as one is how this gate came to
    // pass vacuously. It once reported a dead rule only when the broader rule
    // sat DIRECTLY above the narrower one — which held for none of the six rules
    // this map actually shadowed, because the exceptions to
    // `packages/agent-protocol/src` are 14 slots below it and carry their own
    // category. The gate meant to catch dead rules caught none.
    //
    // So the question asked per rule is the real one: is the NEAREST rule above
    // it that covers its whole prefix also the first rule able to claim it? If
    // nothing between them covers it, the rule is dead no matter how far above
    // the shadower sits — which is why the loop walks upward from `j` rather
    // than testing neighbours.
    const covers = (upper: string, lower: string): boolean =>
      lower === upper || lower.startsWith(`${upper}/`);
    const shadowed: string[] = [];
    for (let j = 0; j < RULES.length; j++) {
      const lower = RULES[j].prefix;
      for (let i = j - 1; i >= 0; i--) {
        if (!covers(RULES[i].prefix, lower)) continue;
        // Nearest covering rule found, so stop: anything further up is shadowed
        // BY this one and could not claim the prefix before it either.
        const intercepted = RULES.slice(i + 1, j).some((k) => covers(k.prefix, lower));
        if (!intercepted) {
          shadowed.push(
            `${lower} [rule ${j}, ${RULES[j].category}] is shadowed by ${RULES[i].prefix} [rule ${i}, ${RULES[i].category}]`,
          );
        }
        break;
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
