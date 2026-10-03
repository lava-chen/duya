/**
 * T3.2 — the runtime half of the `WorkerEvent` completeness guard.
 *
 * `src/process/worker-event-completeness.ts` fails the COMPILE when a known
 * event interface drops out of the union. It cannot see an interface that does
 * not exist yet, because it lists what it knows by name — and TypeScript has no
 * way to say "every exported interface in that file".
 *
 * So this file parses the source instead. It is the half that catches a NEW
 * `export interface *Event` that nobody added to either the union or the
 * compile-time list, which is the drift T3.1 measured at six interfaces and
 * T3.2 closed.
 *
 * The split is by what each mechanism can do. This one is a run-time failure, so
 * it needs the suite to run; the compile-time one cannot be merged past. Neither
 * alone is enough: a guard that only compiles would miss a new interface, and a
 * guard that only runs would let a known one regress between runs.
 *
 * It lives in `tests/` rather than `src/` for the reason the compile-time guard
 * does NOT: this assertion is about the TEXT of a file, which is a runtime
 * question. `WORKER_EVENT_UNION_IS_COMPLETE` is about TYPES, and a type
 * assertion in a directory no build typechecks would enforce nothing.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_PROTOCOL = resolve(
  fileURLToPath(new URL('..', import.meta.url)),
  'src',
  'process',
  'worker-protocol.ts',
);

/** The union's members, read the way MIGRATION.md documents. */
function unionMembers(): string[] {
  const lines = readFileSync(WORKER_PROTOCOL, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith('export type WorkerEvent'));
  expect(start, 'WorkerEvent is no longer declared in worker-protocol.ts').toBeGreaterThan(-1);
  const members: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*\|\s*([A-Za-z0-9_]+)/.exec(line);
    if (match === null) break;
    members.push(match[1] ?? '');
  }
  return members;
}

/** Every `export interface *Event` the module declares. */
function exportedEventInterfaces(): string[] {
  const source = readFileSync(WORKER_PROTOCOL, 'utf8');
  return [...source.matchAll(/^export interface ([A-Za-z0-9_]+Event)\b/gm)].map((m) => m[1] ?? '');
}

describe('the WorkerEvent union and the exported interfaces agree', () => {
  it('every exported *Event interface is a member of the union', () => {
    const members = new Set(unionMembers());
    const missing = exportedEventInterfaces().filter((name) => !members.has(name));
    // T3.1 measured exactly six: ClipboardWriteEvent, WorkflowRunEvent,
    // ResearchUpdatedEvent, CompactOverThresholdEvent, CompactStepEvent and
    // CompactSummaryOutcomeEvent. Three of them have a `build*Event` factory
    // in the same file, so they were produced on a wire the union denied.
    expect(missing, 'these exported event interfaces are missing from WorkerEvent').toEqual([]);
  });

  it('the union names no interface the module does not declare', () => {
    // The other direction: a member that does not exist would be a typo that
    // compiles, and `Exclude` in the compile-time guard would not see it.
    const declared = new Set(exportedEventInterfaces());
    const phantom = unionMembers().filter((name) => !declared.has(name));
    expect(phantom, 'WorkerEvent names types the module does not export').toEqual([]);
  });

  it('the six T3.1 recorded are present, so the recorded gap stays closed', () => {
    const members = new Set(unionMembers());
    for (const name of [
      'ClipboardWriteEvent',
      'WorkflowRunEvent',
      'ResearchUpdatedEvent',
      'CompactOverThresholdEvent',
      'CompactStepEvent',
      'CompactSummaryOutcomeEvent',
    ]) {
      expect(members.has(name), `${name} was closed by T3.2 and must stay in the union`).toBe(true);
    }
  });

  it('the union is contiguous, so MIGRATION.md\'s reproduction still measures it', () => {
    // The documented repro reads members until the first line that is not
    // `| Name`. A comment inside the union truncates that read and makes the
    // guard's own repro report a gap that is not there.
    const lines = readFileSync(WORKER_PROTOCOL, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => line.startsWith('export type WorkerEvent'));
    expect(start).toBeGreaterThan(-1);
    let memberLines = 0;
    for (const line of lines.slice(start + 1)) {
      if (!/^\s*\|\s*[A-Za-z0-9_]+/.test(line)) break;
      memberLines += 1;
    }
    expect(memberLines).toBe(exportedEventInterfaces().length);
  });
});

describe('the factories T3.1 found still have their event in the union', () => {
  it.each([
    ['buildWorkflowRunEvent', 'WorkflowRunEvent'],
    ['buildResearchUpdatedEvent', 'ResearchUpdatedEvent'],
    ['buildClipboardWriteEvent', 'ClipboardWriteEvent'],
  ])('%s produces a type that a consumer can narrow on', (factory, eventType) => {
    const source = readFileSync(WORKER_PROTOCOL, 'utf8');
    expect(source, `${factory} no longer exists`).toContain(`function ${factory}`);
    const members = new Set(unionMembers());
    // The whole point: a factory whose product is invisible to `WorkerEvent` is
    // a produced event no exhaustive consumer can handle.
    expect(members.has(eventType), `${eventType} is produced by ${factory} but missing from the union`).toBe(true);
  });
});
