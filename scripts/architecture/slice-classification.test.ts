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
 *   - a recorded file left the bucket it was recorded in
 *                                                      (RECATEGORISED, RENAMED
 *                                                       or DELETED)
 *   - RULES / FILE_OVERRIDES / UNCLASSIFIED_PREFIXES changed
 *                                                      (the MAP was edited)
 *   - a rule is shadowed by a broader rule above it  (the map has a dead rule)
 *   - a category in the closed vocabulary is unused   (the map lost a bucket)
 *
 * That is the E4.2 behaviour-matrix precedent applied to a classification: a
 * declared list, a closed vocabulary, and a verifier that reads the repo rather
 * than the declaration.
 *
 * ## Why this file no longer freezes a count, and what replaced it
 *
 * It used to. `EXPECTED` held a whole-tree `total`, a per-category `count` and a
 * per-category fingerprint, and it was correct that all of them had to be
 * re-recorded — the gate could not tell an honest addition from a silent
 * recategorisation, so it made every slice prove both.
 *
 * That produced a treadmill, and the treadmill was the bug:
 *
 *   1. Slice N adds a file. `total` no longer matches, so the gate is red.
 *   2. Slice N re-records. Re-recording is one paste, and it absorbs EVERY
 *      drift on the branch — including files slice N-1, N-2 and every slice
 *      merged alongside them, none of which slice N read.
 *   3. Slice N+1 lands and drifts the freshly-pasted numbers again.
 *
 * Two re-records of this file in a row (`a97353b3`, `83508431`) each had to
 * itemise in a comment that the moves were not their own — which is the
 * signature of a record that cannot be trusted to mean what it says. The
 * aggregate number was the mechanism: it made every slice responsible for
 * everyone else's drift, and the cheapest way to discharge that
 * responsibility was to paste the number.
 *
 * So the recorded state is no longer a count. It is `slice-census.txt`: the
 * per-file classification, frozen, with the property
 *
 *     every path in the census is STILL in the bucket it was recorded in
 *
 * a subset check rather than an equality check, and that one change separates
 * the two events the equality check could not:
 *
 *   - ADDING a file cannot make it red. `classify()` is a pure function of a
 *     path, so a new file changes no other file's category; it is only checked
 *     for being EXPLAINED, by the orphan assertion above, which is already
 *     treadmill-free. Nothing to re-record, so nothing to absorb.
 *   - REMOVING, RENAMING or MOVING a recorded file makes it red, and the
 *     failure prints the exact path. A recategorisation is a file leaving a
 *     bucket, which is precisely the subset property.
 *
 * The second half of the safety property is the map itself, which the census
 * cannot see: editing a rule reclassifies files without touching a single path.
 * That is `RULE_TABLE_FINGERPRINT` below.
 *
 * ## The residue, and why a recorded hash is irreducible here
 *
 * `RULE_TABLE_FINGERPRINT` is a recorded number, and it is the only one left.
 * It is irreducible because the map is a CLAIM, and a claim cannot be checked
 * against the repo — the repo is what the claim is about. A valid rule change
 * (a new directory that needs a category) must be allowed and must be
 * deliberate, and the only way to make "deliberate" mean something to a
 * reviewer is to make the reviewer's attention a build failure. A hash of the
 * classification-determining inputs is the smallest such tripwire: it changes
 * only when a prefix, a category, a rule's position, an override or an
 * exclusion changes — never when a file is added, and never when somebody
 * edits a rule's `why`, because prose is required to exist by its own
 * assertion and is not part of what `classify` reads.
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

/**
 * The buckets the census is held to: the closed vocabulary, plus the
 * deliberately-excluded one.
 *
 * `unclassified` is a first-class bucket here, NOT a gap. The old gate
 * recorded its size as a bare count, which is why a source file could be
 * moved under a `tests/` prefix and only the total noticed. Held as a set, a
 * file entering or leaving that bucket is a named path.
 */
const BUCKETS = [...CATEGORIES, 'unclassified'] as const;
type Bucket = (typeof BUCKETS)[number];

/** Every classified file, bucketed by category. Unclassified files are `null`. */
function bucket(): Map<Category, string[]> {
  const out = new Map<Category, string[]>();
  for (const category of CATEGORIES) out.set(category, []);
  for (const file of SOURCE_FILES) {
    const category = classify(file);
    if (category !== null) out.get(category)!.push(file);
  }
  return out;
}

/** The current census: the same buckets, read from the real tree. */
function currentCensus(): Map<Bucket, string[]> {
  const out = new Map<Bucket, string[]>();
  for (const b of BUCKETS) out.set(b, []);
  for (const file of SOURCE_FILES) {
    const category = classify(file);
    out.get(category === null ? 'unclassified' : category)!.push(file);
  }
  return out;
}

const CURRENT = currentCensus();

/**
 * The recorded census, parsed.
 *
 * `shape` holds everything the parser could not make sense of. It is asserted
 * on rather than thrown, because a parser that throws turns a malformed
 * baseline into an unrunnable suite, and an unrunnable suite is not a gate.
 */
interface ParsedCensus {
  readonly paths: Map<Bucket, string[]>;
  /** Bucket name -> the count written in its own `[bucket] (n)` header. */
  readonly declaredCounts: Map<string, number>;
  /** Every line that was neither blank, a comment, a header, nor a path. */
  readonly shapeErrors: string[];
  /** Every `[header]` name, in file order. */
  readonly headers: string[];
}

const CENSUS_PATH = path.join(REPO_ROOT, 'scripts/architecture/slice-census.txt');

function parseCensus(): ParsedCensus {
  const paths = new Map<Bucket, string[]>();
  for (const b of BUCKETS) paths.set(b, []);
  const declaredCounts = new Map<string, number>();
  const shapeErrors: string[] = [];
  const headers: string[] = [];

  // A MISSING census must not throw here. This module's top level runs at
  // collection time, so a throw would abort the file before a single test is
  // registered — and a suite that reports "no tests" is GREEN with the
  // protection deleted, which is the one outcome worse than a red run. It is
  // the same trap the encoding footgun records: a file that cannot load
  // reports success. So a missing or unreadable census is reported as a shape
  // error and asserted on, which is red.
  let raw: string;
  try {
    raw = fs.readFileSync(CENSUS_PATH, 'utf8');
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      paths,
      declaredCounts,
      shapeErrors: [`cannot read ${CENSUS_PATH}: ${detail}`],
      headers,
    };
  }

  let current: string | null = null;
  const header = /^\[([^\]]+)\]\s*(?:\((\d+)\))?$/;

  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text.length === 0 || text.startsWith('#')) continue;
    const asHeader = header.exec(text);
    if (asHeader) {
      current = asHeader[1];
      headers.push(current);
      declaredCounts.set(current, asHeader[2] === undefined ? -1 : Number(asHeader[2]));
      // A header for a bucket nothing checks would make its paths vacuous, so
      // the path is filed under the literal name and asserted to be illegal.
      paths.set(current as Bucket, paths.get(current as Bucket) ?? []);
      continue;
    }
    if (current === null) {
      shapeErrors.push(`path before any bucket header: ${text}`);
      continue;
    }
    paths.get(current as Bucket)!.push(text);
  }
  return { paths, declaredCounts, shapeErrors, headers };
}

const CENSUS = parseCensus();

/**
 * Paths retired from the census, one decision per path.
 *
 * This list, and not an edit to the census, is how a recorded file that was
 * genuinely deleted, renamed or moved is accounted for. The distinction
 * matters because the census is frozen: bulk-editing it is indistinguishable
 * from the treadmill this file used to run, whereas an entry here is a
 * reviewable claim about one specific path — and it goes stale on its own,
 * because an entry for a file that is still in its bucket fails the
 * "retires only paths that have actually left" assertion below. So the list
 * cannot accumulate into a blanket permission.
 *
 * Empty, and that is the honest state: the census was frozen from a tree the
 * previous record still described path-for-path, with no departures.
 */
interface RecordedLoss {
  /** The path exactly as the census listed it. */
  readonly path: string;
  /** The bucket it was recorded in. */
  readonly from: Bucket;
  /** Why it left: deleted, renamed, or moved to another bucket. */
  readonly why: string;
}

const RECORDED_LOSSES: readonly RecordedLoss[] = [];

/**
 * A fingerprint of everything `classify()` reads, and nothing else.
 *
 * RULE ORDER IS PART OF THE HASH, deliberately: first match wins, so moving a
 * rule reclassifies files without changing any prefix or category, and a
 * fingerprint that ignored position would not notice.
 *
 * `why` is NOT part of the hash. Prose is required to be non-empty by its own
 * assertion; folding it in would turn every rewording of a comment into a red
 * run, which is the same treadmill in a new place.
 */
function ruleTableFingerprint(): string {
  const parts: string[] = [`categories:${CATEGORIES.join(',')}`];
  for (const r of RULES) parts.push(`rule:${r.prefix}=${r.category}`);
  for (const key of Object.keys(FILE_OVERRIDES).sort()) {
    parts.push(`override:${key}=${FILE_OVERRIDES[key]}`);
  }
  for (const u of UNCLASSIFIED_PREFIXES) parts.push(`exclude:${u.prefix}`);
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16);
}

const RULE_TABLE_FINGERPRINT = 'da1aee7a34878c48';

describe('the classification is a partition of the source tree', () => {
  it('classifies every source file except the deliberately unclassified ones', () => {
    const orphans = SOURCE_FILES.filter((f) => classify(f) === null);
    const explained = orphans.filter(isUnclassifiedPrefix);
    const unexplained = orphans.filter((f) => !isUnclassifiedPrefix(f));
    // A file no rule claims and no exclusion explains is a file the map does not
    // describe. Reported by path so the fix is obvious, not a count. This is
    // the assertion that has to carry the "a file was ADDED" event now that
    // the census no longer trips on additions — and it is the right shape for
    // it, because a new file inside a classified directory is green here with
    // no re-record, while a new directory that nobody classified is red by
    // path.
    expect(unexplained).toEqual([]);
    expect(explained.length).toBeGreaterThan(0);
  });

  it('excludes only through prefixes that are stated and reachable', () => {
    // Replaces the recorded exclusion COUNT. A count could not say WHICH file
    // stopped being excluded, so a source file quietly relocated under a
    // `tests/` prefix only moved a total; the census holds the same bucket as
    // a set, so that file is now a named path. What is left to assert here is
    // the part a count never checked: that no exclusion is dead. An exclusion
    // nested inside a classified directory is unreachable, because the broader
    // rule claims the file first and the exclusion quietly describes nothing.
    const coveredByRule = UNCLASSIFIED_PREFIXES.filter((u) =>
      RULES.some((r) => u.prefix === r.prefix || u.prefix.startsWith(`${r.prefix}/`)),
    );
    expect(coveredByRule.map((u) => u.prefix)).toEqual([]);
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

describe('the map is the one a human agreed to', () => {
  it('still holds the reviewed rule table', () => {
    // The census cannot see this event: editing a rule reclassifies files
    // without changing a path, so the subset property stays green while the
    // map's meaning moves underneath it. This is the tripwire, and it is the
    // one recorded number left in this file. See the header for why it cannot
    // be derived from the repo.
    //
    // A valid map change is ALLOWED — re-record this hash, and say in the
    // commit which prefix moved and why, because the diff of the map is the
    // review and this assertion is only the thing that forces it to be read.
    expect({ fingerprint: ruleTableFingerprint() }).toEqual({
      fingerprint: RULE_TABLE_FINGERPRINT,
    });
  });
});

describe('the recorded census still describes the tree', () => {
  for (const name of BUCKETS) {
    it(`still holds every recorded ${name} file in ${name}`, () => {
      // THE SAFETY PROPERTY, and the reason this file is not a treadmill.
      //
      // Asserted as a subset, not an equality, and that is the whole design:
      //
      //   recorded MINUS current = empty   -> nothing ever left this bucket
      //   current MINUS recorded = ignored  -> new files are free
      //
      // So RECATEGORISE (a file leaves for another bucket), RENAME (the old
      // path leaves) and DELETE (the path leaves) all fail here, naming the
      // exact path, while ADD costs nothing. The previous equality check could
      // not tell those apart, so it made every addition pay for them.
      const retired = new Set(
        RECORDED_LOSSES.filter((l) => l.from === name).map((l) => l.path),
      );
      const nowInBucket = new Set(CURRENT.get(name)!);
      const departed = CENSUS.paths
        .get(name)!
        .filter((p) => !nowInBucket.has(p) && !retired.has(p));
      expect(departed, `${name}: these recorded paths are no longer ${name}`).toEqual([]);
    });
  }
});

describe('the census is a well-formed baseline, not a stale copy', () => {
  it('uses exactly the closed vocabulary plus the excluded bucket', () => {
    // A misspelled `[bucket]` header would file its paths under a name no
    // subset assertion loops over, and the whole section would pass
    // vacuously. A baseline that cannot fail is worse than no baseline.
    expect(CENSUS.headers).toEqual([...BUCKETS]);
  });

  it('lists only paths, never a malformed line', () => {
    expect(CENSUS.shapeErrors).toEqual([]);
  });

  it('records each bucket size in its own header', () => {
    // Catches a truncated or duplicated line, which would otherwise silently
    // shorten the subset check for that bucket.
    const wrong: string[] = [];
    for (const name of BUCKETS) {
      const declared = CENSUS.declaredCounts.get(name);
      const listed = CENSUS.paths.get(name)!.length;
      if (declared !== listed) wrong.push(`${name}: header says ${declared}, lists ${listed}`);
    }
    expect(wrong).toEqual([]);
  });

  it('never lists the same path in two buckets', () => {
    // A path in two buckets is in neither, for the subset check: it would be
    // excused from one by the other. The map is a partition and the baseline
    // has to be one too.
    const seen = new Map<string, Bucket>();
    const dupes: string[] = [];
    for (const name of BUCKETS) {
      for (const p of CENSUS.paths.get(name)!) {
        const first = seen.get(p);
        if (first === undefined) seen.set(p, name);
        else if (first !== name) dupes.push(`${p} is in both ${first} and ${name}`);
      }
    }
    expect(dupes).toEqual([]);
  });
});

describe('retiring a recorded path is a per-path decision with a reason', () => {
  it('gives every retired path a bucket and a reason', () => {
    const bare = RECORDED_LOSSES.filter(
      (l) => l.why.trim().length === 0 || !BUCKETS.includes(l.from),
    );
    expect(bare.map((l) => l.path)).toEqual([]);
  });

  it('never retires the same path twice', () => {
    const counts = new Map<string, number>();
    for (const l of RECORDED_LOSSES) counts.set(l.path, (counts.get(l.path) ?? 0) + 1);
    expect([...counts.entries()].filter(([, n]) => n > 1).map(([p]) => p)).toEqual([]);
  });

  it('retires only paths that have actually left their bucket', () => {
    // What stops RECORDED_LOSSES from decaying into a blanket permission. An
    // entry is only a claim about a file that is GONE from its bucket, so an
    // entry for a file that is still sitting there is a live permission for
    // nothing and fails here. The list therefore has to be pruned as the tree
    // comes back, and cannot be used to excuse a file wholesale.
    const stale = RECORDED_LOSSES.filter((l) =>
      CURRENT.get(l.from)!.includes(l.path),
    ).map((l) => `${l.path} never left ${l.from}`);
    expect(stale).toEqual([]);
  });
});

describe('the rules are ordered and none of them is dead', () => {
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
