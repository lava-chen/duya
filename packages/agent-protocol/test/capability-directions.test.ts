/**
 * Capability direction census — every capability name must have ONE direction.
 *
 * ## What this guards
 *
 * The repo speaks three capability vocabularies and none of them is aware of
 * the other two:
 *
 *  - `RUNTIME_CAPABILITIES` (src/capabilities.ts) — what the RUNTIME can do.
 *  - `HOST_CAPABILITIES` (src/host-capabilities.ts) — what a HOST can offer.
 *  - `PROTOCOL_CAPABILITIES` (src/version.ts) — what a consumer must handle,
 *    re-derived at negotiation time as `RequiredCapability`.
 *
 * A name that appears in two vocabularies is the failure this catches. It is
 * the exact mistake `src/capabilities.ts` already names in prose — "the runtime
 * concludes a host can execute something because the host offered to serve it" —
 * except that no code enforces it. Until 20-capability-directions.md exists
 * there is no place where the three vocabularies are reconciled, so nothing can
 * tell a deliberate overlap from a copy-paste.
 *
 * ## Why the document is parsed rather than restated here
 *
 * Restating the directions inside the test would make the test agree with
 * itself. The census has to live in the document — T11 needs it, a human needs
 * it — so the test reads the table out of the document and cross-checks it
 * against the real exported sets. Drift in either direction is then a failure:
 *
 *  - a name exported in code but missing from the table;
 *  - a table row naming a capability no vocabulary exports (a phantom);
 *  - a direction that disagrees with the vocabulary the name comes from;
 *  - a second direction that is not declared `both`.
 *
 * ## Why the evidence column is checked against the source
 *
 * A census whose citations drift is a census nobody re-reads. Every row must
 * cite a `path:line` that resolves, is inside the file, and — for the definition
 * site — actually contains the capability name on that line. That last tier is
 * the one with teeth: `file.ts:123` resolving is not the same as `file.ts:123`
 * being where the name lives.
 *
 * ## What this deliberately does NOT assert
 *
 * It does not assert which direction a name SHOULD have. That is the owner's
 * call, recorded once in the document. The guard is about the document matching
 * the code and about a second direction never arriving unannounced.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { RUNTIME_CAPABILITIES } from '../src/capabilities.js';
import {
  HOST_CAPABILITIES,
  HOST_CAPABILITY_OWNERS,
  type HostCapability,
} from '../src/host-capabilities.js';
import { PROTOCOL_CAPABILITIES } from '../src/version.js';
import { MESSAGE_GATES } from '../src/events/registry.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CENSUS_REL =
  'docs/exec-plans/active/610-architecture-series/20-capability-directions.md';
const CENSUS_PATH = join(REPO_ROOT, ...CENSUS_REL.split('/'));

const START_MARKER = '<!-- census:start -->';
const END_MARKER = '<!-- census:end -->';

/** The four direction tokens a row may carry. `both` is the only multi-side one. */
const DIRECTIONS = ['execute', 'consume', 'provide', 'both'] as const;
type Direction = (typeof DIRECTIONS)[number];

/** The cell that means "this row names no second direction". */
const NONE = '—';

interface CensusRow {
  readonly raw: string;
  readonly name: string;
  readonly direction: string;
  readonly second: string;
  readonly owner: string;
  readonly evidence: string;
  readonly note: string;
}

/**
 * Read the census table out of the document.
 *
 * A missing or marker-less document yields an EMPTY table rather than a throw,
 * so the failures downstream name the capabilities that are unclassified. A
 * thrown "file not found" would hide the same fact behind a stack trace.
 */
function readCensus(): CensusRow[] {
  if (!existsSync(CENSUS_PATH)) return [];
  const body = readFileSync(CENSUS_PATH, 'utf8');
  const start = body.indexOf(START_MARKER);
  const end = body.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) return [];

  const block = body.slice(start + START_MARKER.length, end);
  const rows: CensusRow[] = [];
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
    // Header row and the `---` separator are not data.
    if (cells.length < 6) continue;
    if (cells[0]!.includes('能力名')) continue;
    if (/^:?-{2,}:?$/.test(cells[0]!)) continue;
    rows.push({
      raw: trimmed,
      name: cells[0]!.replace(/`/g, '').trim(),
      direction: cells[1]!.replace(/`/g, '').trim(),
      second: cells[2]!.replace(/`/g, '').trim(),
      owner: cells[3]!.replace(/`/g, '').trim(),
      evidence: cells[4]!.replace(/`/g, '').trim(),
      note: cells[5]!.trim(),
    });
  }
  return rows;
}

const CENSUS = readCensus();
const rowsFor = (name: string): CensusRow[] => CENSUS.filter((r) => r.name === name);
const oneRow = (name: string): CensusRow => {
  const hits = rowsFor(name);
  expect(
    hits.length,
    `expected exactly one census row for \`${name}\`, found ${hits.length}`,
  ).toBe(1);
  return hits[0]!;
};

/** Every `path:line` token anywhere in a row. */
const CITE = /([A-Za-z0-9_./-]+\.[cm]?[jt]s):(\d+)(?:-(\d+))?/g;
const files = new Map<string, string[]>();
function readLines(rel: string): string[] | null {
  const cached = files.get(rel);
  if (cached !== undefined) return cached.length > 0 ? cached : null;
  const abs = join(REPO_ROOT, ...rel.split('/'));
  let lines: string[] = [];
  try {
    lines = readFileSync(abs, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  files.set(rel, lines);
  return lines.length > 0 ? lines : null;
}

/**
 * The consumption vocabulary is DERIVED, not declared twice: `RequiredCapability`
 * is `NonNullable<MessageGate['requiresCapability']>`. Deriving it here from the
 * gate table is what lets a newly gated event show up as doc drift instead of
 * silently inventing a seventh name.
 */
const GATE_CAPABILITIES: ReadonlySet<string> = new Set(
  Object.values(MESSAGE_GATES)
    .map((gate) => gate.requiresCapability)
    .filter((c): c is string => c !== undefined),
);

const CODE_NAMES: ReadonlySet<string> = new Set<string>([
  ...RUNTIME_CAPABILITIES,
  ...HOST_CAPABILITIES,
  ...PROTOCOL_CAPABILITIES,
]);

describe('capability direction census', () => {
  it('parses a census table that covers the exported vocabularies', () => {
    // Anti-vacuity. A census of zero rows, or one that shrank because the
    // vocabularies shrank, must not be able to satisfy the drift checks below.
    expect(
      CENSUS.length,
      `no census rows parsed from ${CENSUS_REL} (markers ${START_MARKER} / ${END_MARKER})`,
    ).toBeGreaterThanOrEqual(31);
    expect(CENSUS.length).toBe(CODE_NAMES.size);
    expect(GATE_CAPABILITIES.size).toBe(PROTOCOL_CAPABILITIES.length);
  });

  it('classifies every capability name the three vocabularies export', () => {
    const documented = new Set(CENSUS.map((r) => r.name));
    const missing = [...CODE_NAMES].filter((n) => !documented.has(n)).sort();
    expect(
      missing,
      `exported by code but absent from the census table: ${missing.join(', ') || 'none'}`,
    ).toEqual([]);
  });

  it('documents no capability that no vocabulary exports', () => {
    const phantoms = CENSUS.filter((r) => !CODE_NAMES.has(r.name)).map((r) => r.name).sort();
    expect(
      phantoms,
      `in the census table but exported by no vocabulary: ${phantoms.join(', ') || 'none'}`,
    ).toEqual([]);
  });

  it('classifies every capability the event gates and control gates can require', () => {
    // The negotiation vocabulary is derived from MESSAGE_GATES. A gate added
    // without a census row is drift; a census row for a gate that no longer
    // exists is drift the other way.
    const documented = new Set(CENSUS.map((r) => r.name));
    const ungated = [...GATE_CAPABILITIES].filter((n) => !documented.has(n)).sort();
    expect(
      ungated,
      `required by a message gate but absent from the census table: ${ungated.join(', ') || 'none'}`,
    ).toEqual([]);
  });

  it('gives each execution-side name the execute direction', () => {
    for (const name of RUNTIME_CAPABILITIES) {
      expect(oneRow(name).direction, `${name} comes from RUNTIME_CAPABILITIES`).toBe('execute');
    }
    // Named, not merely counted: these three are the entire execution vocabulary
    // and each one backs a live `assertCapabilityConsistency` check.
    expect(oneRow('checkpoint_repository').direction).toBe('execute');
    expect(oneRow('permission_coordinator').direction).toBe('execute');
    expect(oneRow('tool_preview').direction).toBe('execute');
  });

  it('gives each consumption-side name the consume direction', () => {
    for (const name of PROTOCOL_CAPABILITIES) {
      expect(oneRow(name).direction, `${name} comes from PROTOCOL_CAPABILITIES`).toBe('consume');
    }
    expect(oneRow('replay').direction).toBe('consume');
    expect(oneRow('usage_accounting').direction).toBe('consume');
    expect(oneRow('tool_call_preview').direction).toBe('consume');
    expect(oneRow('tool_outcome_detail').direction).toBe('consume');
    expect(oneRow('checkpoint_resume').direction).toBe('consume');
    expect(oneRow('permission_expiry').direction).toBe('consume');
  });

  it('gives each provision-side name the provide direction unless it is both', () => {
    for (const name of HOST_CAPABILITIES) {
      const row = oneRow(name);
      const expected = HOST_CAPABILITY_OWNERS[name as HostCapability] === 'both' ? 'both' : 'provide';
      expect(row.direction, `${name} comes from HOST_CAPABILITIES`).toBe(expected);
    }
    // The load-bearing pair: host-capabilities.ts exists to say these two mean
    // different disks, so a census that misplaces them is worse than no census.
    expect(oneRow('workspace_filesystem').direction).toBe('provide');
    expect(oneRow('native_dialog').direction).toBe('provide');
    expect(oneRow('session_persistence').direction).toBe('both');
  });

  it('refuses a second direction on a name that is not declared both', () => {
    const offenders: string[] = [];
    for (const row of CENSUS) {
      const second = row.second === NONE ? '' : row.second;
      if (second === '') continue;
      if (row.direction !== 'both' || !DIRECTIONS.includes(row.second as Direction)) {
        offenders.push(`${row.name}: direction=${row.direction} second=${row.second}`);
      }
    }
    expect(
      offenders,
      `a second direction must be declared \`both\`: ${offenders.join('; ') || 'none'}`,
    ).toEqual([]);
  });

  it('refuses one name carrying two directions in two rows', () => {
    const seen = new Map<string, number>();
    for (const row of CENSUS) seen.set(row.name, (seen.get(row.name) ?? 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([name, n]) => `${name} x${n}`).sort();
    expect(dupes, `duplicate census rows: ${dupes.join(', ') || 'none'}`).toEqual([]);
  });

  it('agrees with the code about which names are both', () => {
    const codeBoth = HOST_CAPABILITIES.filter(
      (c) => HOST_CAPABILITY_OWNERS[c] === 'both',
    ).sort();
    const docBoth = CENSUS.filter((r) => r.direction === 'both').map((r) => r.name).sort();
    expect(docBoth, `owner axis says both: ${codeBoth.join(', ')}`).toEqual([...codeBoth]);

    for (const name of codeBoth) {
      const row = oneRow(name);
      expect(row.second, `${name} must name its second direction`).not.toBe(NONE);
      // A `both` row has to say what satisfies the name on EACH side, or it is
      // the ambiguity it was written to resolve.
      expect(row.note, `${name} note must state the host-local side`).toContain('host-local');
      expect(row.note, `${name} note must state the runtime side`).toContain('runtime');
    }
  });

  it('uses a declared direction token on every row', () => {
    const bad = CENSUS.filter((r) => !DIRECTIONS.includes(r.direction as Direction))
      .map((r) => `${r.name}=${r.direction}`)
      .sort();
    expect(bad, `unknown direction tokens: ${bad.join(', ') || 'none'}`).toEqual([]);
  });

  it('cites a definition site that resolves and defines the name on that line', () => {
    const broken: string[] = [];
    for (const row of CENSUS) {
      const match = /([A-Za-z0-9_./-]+\.[cm]?[jt]s):(\d+)/.exec(row.evidence);
      if (!match) {
        broken.push(`${row.name}: evidence is not path:line (${row.evidence})`);
        continue;
      }
      const rel = match[1]!;
      const line = Number(match[2]);
      const lines = readLines(rel);
      if (lines === null) {
        broken.push(`${row.name}: ${rel} does not resolve`);
        continue;
      }
      if (line < 1 || line > lines.length) {
        broken.push(`${row.name}: ${rel}:${line} is outside the file (1-${lines.length})`);
        continue;
      }
      if (!lines[line - 1]!.includes(row.name)) {
        broken.push(`${row.name}: ${rel}:${line} does not contain the name`);
      }
    }
    expect(broken, `unresolvable or wrong evidence: ${broken.join('; ') || 'none'}`).toEqual([]);
  });

  it('cites nothing unresolvable anywhere in a row', () => {
    const broken: string[] = [];
    for (const row of CENSUS) {
      for (const [, ref, start, end] of row.raw.matchAll(CITE)) {
        const lines = readLines(ref);
        if (lines === null) {
          broken.push(`${row.name}: ${ref} does not resolve`);
          continue;
        }
        const lo = Number(start);
        const hi = end === undefined ? lo : Number(end);
        if (lo < 1 || hi > lines.length) {
          broken.push(`${row.name}: ${ref}:${start}${end ? '-' + end : ''} outside the file`);
        }
      }
    }
    expect(broken, `dangling citations: ${broken.join('; ') || 'none'}`).toEqual([]);
  });
});
