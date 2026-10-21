/**
 * Plan 587 E4.3 — the versioned case format.
 *
 * The load-bearing property here is not "valid cases parse". It is that an
 * INVALID case is REJECTED with a named problem, and that a case whose format
 * version the loader cannot read is REFUSED rather than run under a guessed
 * interpretation. A permissive loader is the failure mode: it turns a case whose
 * meaning changed into a case that still runs, and reports it green.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_FORMAT_VERSION, CaseFormatError, CURRENT_RUN_CONTRACT, migrate, parseCase, PERMISSION_MODES, type EvalCase } from './format';

const CASES_DIR = fileURLToPath(new URL('.', import.meta.url));

const VALID: unknown = {
  formatVersion: 1,
  id: 'a-case',
  title: 'a case',
  pinnedContract: CURRENT_RUN_CONTRACT,
  mode: 'offline',
  input: { prompt: 'hello' },
  scenario: {
    kind: 'offline-anthropic-sse',
    seed: 's',
    turns: [{ blocks: [{ kind: 'text', text: 'hi' }], stopReason: 'end_turn', inputTokens: 1, outputTokens: 1 }],
  },
  policy: { permissionMode: 'bypassPermissions' },
  budget: { maxTurns: 2, timeoutMs: 1000 },
  expect: { invariants: [{ family: 'structure', kind: 'terminalStatus', value: 'completed' }], artefacts: [] },
};

function problemsFor(raw: unknown): string[] {
  try {
    parseCase(raw);
  } catch (error) {
    if (error instanceof CaseFormatError) return [...error.problems];
    throw error;
  }
  throw new Error('expected parseCase to reject this case');
}

describe('E4.3 — the case format', () => {
  it('accepts a well-formed case and echoes it unchanged', () => {
    const parsed = parseCase(VALID);
    expect(parsed.id).toBe('a-case');
    expect(parsed.expect.invariants).toHaveLength(1);
  });

  it('rejects an unknown format version and names the version it wanted', () => {
    const problems = problemsFor({ ...(VALID as Record<string, unknown>), formatVersion: 99 });
    expect(problems.join('\n')).toMatch(/formatVersion: expected 1, got 99/);
  });

  it('rejects a case with no invariants, because a case with no expectations cannot fail', () => {
    const problems = problemsFor({
      ...(VALID as Record<string, unknown>),
      expect: { invariants: [], artefacts: [] },
    });
    expect(problems.join('\n')).toMatch(/must be a non-empty array/);
  });

  it('rejects an absolute or traversing artefact path, so a case cannot depend on the machine it ran on', () => {
    const withAbs = problemsFor({
      ...(VALID as Record<string, unknown>),
      expect: {
        invariants: (VALID as { expect: { invariants: unknown[] } }).expect.invariants,
        artefacts: [{ family: 'task-artefact', kind: 'file', path: 'C:\\Users\\someone\\secret.txt', assertion: { form: 'equals', value: 'x' } }],
      },
    });
    expect(withAbs.join('\n')).toMatch(/must be workspace-relative/);

    const withDotDot = problemsFor({
      ...(VALID as Record<string, unknown>),
      expect: {
        invariants: (VALID as { expect: { invariants: unknown[] } }).expect.invariants,
        artefacts: [{ family: 'task-artefact', kind: 'file', path: '../outside.txt', assertion: { form: 'equals', value: 'x' } }],
      },
    });
    expect(withDotDot.join('\n')).toMatch(/must be workspace-relative/);
  });

  it('rejects a live case that does not pin its live parameters', () => {
    const problems = problemsFor({ ...(VALID as Record<string, unknown>), mode: 'live' });
    expect(problems.join('\n')).toMatch(/a live case must pin its live parameters/);
  });

  it('rejects a live case that asks for a single measurement, since one sample has no spread', () => {
    const problems = problemsFor({
      ...(VALID as Record<string, unknown>),
      mode: 'live',
      live: { model: 'm', temperature: 0, maxTokens: 10, measurements: 1 },
    });
    expect(problems.join('\n')).toMatch(/must be >= 2/);
  });

  it('names EVERY problem rather than the first one', () => {
    const problems = problemsFor({
      formatVersion: 7,
      id: 'Not Kebab',
      title: '',
      pinnedContract: '',
      mode: 'nope',
      input: { prompt: '' },
      scenario: { kind: 'wrong', seed: '', turns: [] },
      policy: { permissionMode: 'nope' },
      budget: { maxTurns: 0, timeoutMs: -1 },
      expect: { invariants: 'not an array', artefacts: 'not an array' },
    });
    // If validation short-circuited, this count would be 1. It is deliberately
    // large: a loader that reports one problem per run turns a fix cycle into a
    // guessing game.
    expect(problems.length).toBeGreaterThanOrEqual(12);
  });

  it('refuses to migrate a case whose version it cannot read, instead of guessing its meaning', () => {
    const outcome = migrate({ ...(VALID as Record<string, unknown>), formatVersion: 0 });
    expect(outcome.migrated).toBeNull();
    expect(outcome.unsupportedFrom).toBe(0);
  });

  it('accepts exactly the permission modes the product really has', () => {
    // The case format names the permission modes in DATA, so it cannot import the
    // protocol's type. This is the guard that stops the copy drifting: the real
    // set is read from the product and compared.
    //
    // It also catches the specific past mistake: the format used to accept
    // `auto`, which is not a permission mode the product has at all.
    const real = new Set<string>([
      'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk',
    ]);
    expect([...PERMISSION_MODES].sort()).toEqual([...real].sort());
    expect(PERMISSION_MODES).not.toContain('auto');
    expect(problemsFor({ ...(VALID as Record<string, unknown>), policy: { permissionMode: 'auto' } }).join('\n'))
      .toMatch(/policy.permissionMode/);
  });

  it('accepts every permission mode it claims, and rejects one it does not', () => {
    for (const mode of PERMISSION_MODES) {
      // A mode the format claims must be accepted — otherwise the format
      // advertises a capability it will not honour.
      expect(() => parseCase({ ...(VALID as Record<string, unknown>), policy: { permissionMode: mode } })).not.toThrow();
    }
    expect(problemsFor({ ...(VALID as Record<string, unknown>), policy: { permissionMode: 'yolo' } }).join('\n'))
      .toMatch(/policy.permissionMode/);
  });

  it('round-trips a current-version case through migrate unchanged', () => {
    const outcome = migrate(VALID);
    expect(outcome.migrated).not.toBeNull();
    expect(outcome.migrated?.id).toBe('a-case');
  });
});

describe('E4.3 — every case on disk is a real case', () => {
  const files = readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort();

  it('finds the case files this suite ships', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)('%s validates, and pins a contract the format knows about', (file) => {
    const raw: unknown = JSON.parse(readFileSync(path.join(CASES_DIR, file), 'utf8'));
    const c: EvalCase = parseCase(raw);
    expect(c.formatVersion).toBe(CASE_FORMAT_VERSION);
    // A pin is a plain string, but it must look like a pin: a case that names no
    // contract cannot be reviewed when the run layer moves.
    expect(c.pinnedContract.length).toBeGreaterThan(0);
    expect(c.id).toBe(path.basename(file, '.json'));
  });

  it('every offline case has at least one task-artefact-free path to prove structure, and the artefact case checks a real file', () => {
    const cases = files.map((f) => parseCase(JSON.parse(readFileSync(path.join(CASES_DIR, f), 'utf8')) as unknown));
    const artefactCase = cases.find((c) => c.id === 'task-artefact-write-file');
    expect(artefactCase).toBeDefined();
    const fileArtefacts = artefactCase?.expect.artefacts.filter((a) => a.kind === 'file') ?? [];
    expect(fileArtefacts.length).toBeGreaterThanOrEqual(1);
    for (const art of fileArtefacts) {
      if (art.kind === 'file') expect(art.assertion.form).toBe('equals');
    }
  });
});
