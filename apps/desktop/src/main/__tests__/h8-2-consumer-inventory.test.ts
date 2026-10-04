/**
 * Plan 587 H8.2 — the measured consumer inventory, as a test.
 *
 * ## Why this file exists
 *
 * H8.2 asks that automation/wake, workflow `wf.agent` and the sub-agent all go
 * through the same durable Run API. Before that can be true, "all" has to mean
 * something countable, and R2.1's `NON_DESKTOP_CONSUMERS` was measured at a
 * base that has since moved (PR #178 is still OPEN, so the headless CLI was
 * never taken over and still constructs `DuyaAgent` directly).
 *
 * A prose list cannot be checked against the tree. This one can: every
 * `streamChat` call site in production source is enumerated below, and
 * `describe` blocks re-derive the count from disk. A site that is added,
 * moved, or deleted without updating this file fails the build instead of
 * quietly making the retirement gate wrong.
 *
 * ## The vocabulary
 *
 * `ConsumerRegistration` in `run-orchestrator.ts` names the three consumers the
 * plan lists. This file adds the two things that census does not carry:
 *
 *  - `turnEntries` — the sites that actually BEGIN an agent turn. Only these
 *    are candidates for the retirement gate in H8.3.
 *  - `notATurnEntry` — `streamChat` calls that look identical in a grep but are
 *    not a turn entry (a summarisation call, a title generator, an LLM client
 *    wrapper). Counting them is how a census inflates itself.
 *
 * ## What is deliberately NOT asserted here
 *
 * This file measures. It does not claim any consumer has been migrated. The
 * per-consumer verdicts below are the measured state as of this commit, and
 * each one names the evidence that would falsify it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

/**
 * A call site that begins a whole agent turn — the thing H8.3's retirement
 * gate counts down.
 */
interface TurnEntry {
  /** The consumer this entry belongs to. */
  readonly consumer: 'desktop' | 'cli' | 'subagent' | 'workflow';
  readonly path: string;
  readonly line: number;
  /**
   * Whether the turn is opened through the Control Plane's `openRun` (which
   * also dispatches it) rather than by constructing a run-local agent.
   */
  readonly viaControlPlane: boolean;
  /** What would have to change for this to become CP-driven. */
  readonly note: string;
}

/**
 * `streamChat` call sites that are NOT turn entries, with the reason. These
 * exist so the "did we count everything?" question has an answer that is not
 * "we grepped and it felt right".
 */
interface NotATurnEntry {
  readonly path: string;
  readonly line: number;
  readonly reason: string;
}

/**
 * ## The turn entries, measured
 *
 * `DuyaAgent.streamChat` (the agent facade) is the turn entry. `AIClient
 * .streamChat` is a different method on a different class that happens to
 * share the name, and is excluded — see `NOT_TURN_ENTRIES`.
 *
 * Desktop's own turn is opened by the router, not by a `streamChat` call site,
 * which is why it has no row here: `router.ts:1256` calls `openRun`, and the
 * execution channel inside it issues `chat:start` to the worker.
 */
const TURN_ENTRIES: readonly TurnEntry[] = Object.freeze([
  Object.freeze({
    consumer: 'desktop',
    path: 'packages/agent/src/process/agent-process-entry.ts',
    line: 3127,
    viaControlPlane: true,
    note:
      'The worker `chat:start` command. Reached only through `openRun`, which ' +
      'awaits `run.started` before dispatching and carries the canonical runId.',
  }),
  Object.freeze({
    consumer: 'cli',
    path: 'packages/agent/src/cli/index.ts',
    line: 509,
    viaControlPlane: false,
    note:
      'Interactive REPL. Constructs `duyaAgent` directly (index.ts:621); no ' +
      'run row is opened and no runId exists.',
  }),
  Object.freeze({
    consumer: 'cli',
    path: 'packages/agent/src/cli/index.ts',
    line: 549,
    viaControlPlane: false,
    note:
      'Non-interactive `--task`. Same direct construction. This is the path ' +
      'H8.2\'s approval-safety requirement is about.',
  }),
  Object.freeze({
    consumer: 'cli',
    path: 'packages/agent/src/cli/index.ts',
    line: 749,
    viaControlPlane: false,
    note:
      '`--print` / `--headless` single query. Same direct construction.',
  }),
  Object.freeze({
    consumer: 'subagent',
    path: 'packages/agent/src/tool/SubagentTool/runAgent.ts',
    line: 499,
    viaControlPlane: false,
    note:
      'The sub-agent turn. Runs INSIDE the parent worker on a `DuyaAgent` ' +
      'built for the child, so it is a nested loop rather than a child run. ' +
      'Identity is `taskId` / `subAgentSessionId`, neither of which is a runId.',
  }),
]);

/**
 * ## The look-alikes
 *
 * Every one of these matches `.streamChat(` in a grep. None of them begins an
 * agent turn, and counting them is the most likely way the retirement gate
 * ends up chasing a number that can never reach zero.
 */
const NOT_TURN_ENTRIES: readonly NotATurnEntry[] = Object.freeze([
  Object.freeze({
    path: 'packages/agent/src/agent/DuyaAgent.ts',
    line: 780,
    reason: 'Context compaction summary — an `AIClient` call, no turn.',
  }),
  Object.freeze({
    path: 'packages/agent/src/agent/DuyaAgent.ts',
    line: 4426,
    reason: 'Side-question helper — no tools, no turn state.',
  }),
  Object.freeze({
    path: 'packages/agent/src/agent/TurnStreamRunner.ts',
    line: 153,
    reason:
      'The model call INSIDE a turn. Same class of call as the turn itself, ' +
      'one layer down.',
  }),
  Object.freeze({
    path: 'packages/agent/src/agent/visual-analysis.ts',
    line: 93,
    reason: 'Vision analysis on a separate client.',
  }),
  Object.freeze({
    path: 'packages/agent/src/memory-rollout/extractor.ts',
    line: 813,
    reason: 'Memory extraction, its own `AIClient`.',
  }),
  Object.freeze({
    path: 'packages/agent/src/session/title-generator.ts',
    line: 685,
    reason: 'Session titling, its own `AIClient`.',
  }),
  Object.freeze({
    path: 'packages/agent/src/tool/SessionSearchTool/SessionSearchTool.ts',
    line: 755,
    reason: 'Summarising search results, its own `AIClient`.',
  }),
]);

/**
 * Production sources that may begin a turn. Test files are excluded on
 * purpose: a test that calls `streamChat` is exercising the API, not
 * registering a consumer.
 */
const TURN_ENTRY_SOURCES: readonly string[] = Object.freeze([
  'packages/agent/src',
  'apps/desktop/src/main',
  'conductor/src',
  'gateway/src',
]);

function listProductionTsFiles(dir: string, acc: string[] = []): string[] {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const abs = resolve(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listProductionTsFiles(rel, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(rel);
    }
  }
  void path;
  return acc;
}

describe('H8.2 — measured consumer inventory', () => {
  it('every recorded turn entry is still at the line it was measured at', () => {
    for (const entry of TURN_ENTRIES) {
      const lines = readRepoFile(entry.path).split('\n');
      const actual = lines[entry.line - 1] ?? '';
      expect(actual, `${entry.path}:${entry.line} (${entry.consumer})`).toContain(
        '.streamChat(',
      );
    }
  });

  it('every recorded not-a-turn-entry is still at its line and still not one', () => {
    for (const entry of NOT_TURN_ENTRIES) {
      const lines = readRepoFile(entry.path).split('\n');
      const actual = lines[entry.line - 1] ?? '';
      expect(actual, `${entry.path}:${entry.line}`).toContain('.streamChat');
    }
  });

  it('finds no unrecorded turn entry in production source', () => {
    // The point of the inventory: a NEW `.streamChat(` in production source
    // that is not classified here fails. This is the assertion that makes
    // "we counted them all" checkable instead of asserted.
    const files = TURN_ENTRY_SOURCES.flatMap((dir) => listProductionTsFiles(dir));
    expect(files.length).toBeGreaterThan(0);

    const recorded = new Set(
      [...TURN_ENTRIES, ...NOT_TURN_ENTRIES].map((e) => `${e.path}:${e.line}`),
    );
    const unrecorded: string[] = [];
    for (const file of files) {
      const lines = readRepoFile(file).split('\n');
      lines.forEach((line, index) => {
        if (!line.includes('.streamChat(')) return;
        if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return;
        const key = `${file}:${index + 1}`;
        if (!recorded.has(key)) unrecorded.push(key);
      });
    }
    expect(
      unrecorded,
      'unrecorded .streamChat( site(s) — classify as a turn entry or as a look-alike',
    ).toEqual([]);
  });

  it('accounts for every direct DuyaAgent construction', () => {
    // The other half of the census. A turn entry needs an agent to drive, so
    // every `new duyaAgent(` in production source is a consumer whether or not
    // it reaches a `streamChat` line — and a construction with no turn entry is
    // the more interesting drift, because it means an agent built for a caller
    // that no longer exists.
    //
    // Desktop's single construction is CP-driven; the other four are the
    // non-CP consumers. Counted separately from the turn entries because the
    // CLI builds one agent for two of its three turn entries (`runCLI` owns
    // both the REPL and `--task`), so the two axes are 1:1 per consumer but not
    // per site.
    const files = TURN_ENTRY_SOURCES.flatMap((dir) => listProductionTsFiles(dir));
    const constructions: string[] = [];
    for (const file of files) {
      readRepoFile(file)
        .split('\n')
        .forEach((line, index) => {
          if (/\bnew (DuyaAgent|duyaAgent)\(/.test(line)) {
            constructions.push(`${file}:${index + 1}`);
          }
        });
    }

    expect(constructions.sort()).toEqual(
      [
        'apps/desktop/src/main/agents/server/router.ts:2331', // comment only
        'packages/agent/src/cli/index.ts:621',
        'packages/agent/src/cli/index.ts:814',
        'packages/agent/src/cli/index.ts:867',
        'packages/agent/src/process/agent-process-entry.ts:1910',
        'packages/agent/src/tool/SubagentTool/runAgent.ts:391',
        'packages/agent/src/tool/SubagentTool/runAgent.ts:446', // comment only
      ].sort(),
    );
  });

  it('reports the counts the H8.3 retirement gate is measured against', () => {    const byConsumer = (c: TurnEntry['consumer']): number =>
      TURN_ENTRIES.filter((e) => e.consumer === c).length;
    const cpDriven = TURN_ENTRIES.filter((e) => e.viaControlPlane).length;

    // The headline number: turns that do NOT go through the Control Plane.
    // H8.3 can only delete the shim when this reaches zero.
    expect(TURN_ENTRIES.length - cpDriven).toBe(4);
    expect(byConsumer('cli')).toBe(3);
    expect(byConsumer('subagent')).toBe(1);
    expect(byConsumer('desktop')).toBe(1);
    // The look-alikes are excluded on purpose — documented so the exclusion is
    // a number someone can challenge, not a silent filter.
    expect(NOT_TURN_ENTRIES.length).toBe(7);
  });
});

describe('H8.2 — per-consumer verdicts', () => {
  it('automation/wake already enters through the Control Plane', () => {
    // agent-run.ts POSTs to the same `/sessions/:id/chat` the renderer uses,
    // and the router routes that through `openRun`. This asserts the wiring
    // still exists rather than trusting the census note, which predates it.
    const router = readRepoFile('apps/desktop/src/main/agents/server/router.ts');
    expect(router).toContain('deps.runOrchestrator.openRun(sessionId');

    const agentRun = readRepoFile('apps/desktop/src/main/automation/agent-run.ts');
    expect(agentRun).toContain('/sessions/${encodeURIComponent(opts.sessionId)}/chat');
  });

  it('the workflow agent node shares the sub-agent path rather than a second loop', () => {
    // Plan 560's Go/No-Go went Go (option A): `wf.agent` is bound to the
    // SubagentTool executor. One path, not two — which is the outcome H8.2
    // wants, and is asserted so a future second loop fails here.
    const workflowRunner = readRepoFile('packages/agent/src/process/workflow-runner.ts');
    expect(workflowRunner).toContain('SUBAGENT_TOOL_NAME');
    expect(workflowRunner).not.toContain('new DuyaAgent');

    // The sub-agent entry itself is the single nested turn.
    const runAgent = readRepoFile('packages/agent/src/tool/SubagentTool/runAgent.ts');
    const turnSites = runAgent
      .split('\n')
      .map((line, index) => ({ line, lineNumber: index + 1 }))
      .filter((e) => e.line.includes('.streamChat('));
    expect(turnSites).toHaveLength(1);
  });

  it('worktree isolation is plan 496 implementation, consumed not reimplemented', () => {
    // Asserted on the SYMBOL rather than on an `import ... from` string: the
    // architecture audit parses import specifiers out of source text, so a
    // literal specifier in an assertion registers as a real (and unresolvable)
    // edge and inflates the dependency census.
    const subagentTool = readRepoFile(
      'packages/agent/src/tool/SubagentTool/SubagentTool.ts',
    );
    expect(subagentTool).toContain('createIsolatedWorktree');
    expect(existsSync(resolve(ROOT, 'packages/agent/src/tool/SubagentTool/worktree.ts'))).toBe(
      true,
    );
  });
});
