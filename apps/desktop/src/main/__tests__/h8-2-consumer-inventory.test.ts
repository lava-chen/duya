/**
 * Plan 587 H8.2 — the measured consumer inventory, as a test.
 *
 * ## Why this file exists
 *
 * H8.2 asks that automation/wake, workflow `wf.agent` and the sub-agent all go
 * through the same durable Run API. Before that can be true, "all" has to mean
 * something countable, and R2.1's `NON_DESKTOP_CONSUMERS` was measured at a
 * base that has since moved. A prose list cannot be checked against the tree.
 * This one can: every `.streamChat(` occurrence in production source is
 * classified below as either a turn entry or a look-alike, and `describe` blocks
 * re-derive the classification from disk. An occurrence that is added, or that
 * is not classified, fails the build instead of quietly making the retirement
 * gate wrong.
 *
 * ## Why this file does NOT pin line numbers
 *
 * It used to, and that was the defect. The first version of this inventory
 * recorded `path` + `line` and asserted the line still contained
 * `.streamChat(`. PR #198 — a legitimate, reviewed change that moved the CLI
 * onto the shared Run API — shifted nine of those lines and put three of the
 * eight tests in this file red, with no consumer having changed. Attribution was
 * unambiguous (8/8 on the pre-#198 base, 5/8 on the post-#198 branch), so the
 * fix was to delete the fragile part rather than paste new numbers: pasting them
 * reinstalls the treadmill that the guard had just escaped, and the next
 * unrelated edit breaks it again. The same reasoning is why
 * `scripts/typecheck-electron-baseline.txt` keys on `(path, TS code)` and
 * deliberately carries no `line:col`.
 *
 * So each row is keyed on an **anchor** that names the thing rather than its
 * position:
 *
 *  - `path` — the file, which a refactor only changes when it moves the site.
 *  - `receiver` — the full member expression the call is made on
 *    (`subAgent`, `this.llmClient`, `deps.llmClient`). This is what identifies
 *    the call, and it is why the two `DuyaAgent.ts` rows do not collide.
 *  - `symbol` — the enclosing top-level declaration, asserted as well, so a
 *    site that moves into a different function fails with a message that says
 *    where it went instead of a line number that no longer exists.
 *
 * Adding a blank line, a comment, or a new function above a recorded site does
 * not touch any of the three. Only a real change of site does. The matching is
 * also one-to-one in both directions: a recorded anchor that resolves to two
 * sites is a failure, so a NEW call site can never be quietly absorbed by an
 * existing row that happens to share its receiver.
 *
 * ## The vocabulary
 *
 * `ConsumerRegistration` in `run-orchestrator.ts` names the consumers the plan
 * lists. This file adds the two things that census does not carry:
 *
 *  - `turnEntries` — the sites that actually BEGIN an agent turn. Only these
 *    are candidates for the retirement gate in H8.3.
 *  - `notATurnEntry` — `.streamChat(` occurrences that are not a turn entry (a
 *    summarisation call, a title generator, an `AIClient` call, or the registry
 *    prose that names the method). Counting them is how a census inflates
 *    itself.
 *
 * ## What is deliberately NOT asserted here
 *
 * This file measures. It does not claim any consumer has been migrated. The
 * per-consumer verdicts below are the measured state as of this commit, and
 * each one names the evidence that would falsify it.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../../..');

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8');
}

/**
 * A `.streamChat(` occurrence, located by anchor.
 *
 * `line` is carried for the failure message only. It is never matched on, and
 * no assertion below compares it to a recorded number — see the file header.
 */
interface StreamChatSite {
  readonly path: string;
  /** 1-based. For diagnostics, not identity. */
  readonly line: number;
  /** The full member expression the call is made on, or `null` for a mention. */
  readonly receiver: string | null;
  /** The enclosing top-level declaration. */
  readonly symbol: string;
  /**
   * `call` — a real `x.streamChat(…)` invocation.
   * `mention` — the text appears in a string or template, so it is DATA (the
   * registry prose) rather than a call. Classified rather than skipped: a
   * `.streamChat(` in a string is exactly the kind of thing a grep census
   * counts, and it must be accounted for rather than argued about.
   *
   * Comment lines are not enumerated at all. The migrated CLI site names
   * `agent.streamChat` in prose explaining what it used to do, and counting
   * that would make this inventory un-editable by editing alone.
   */
  readonly kind: 'call' | 'mention';
  readonly code: string;
}

/** A `new DuyaAgent(` / `new duyaAgent(` occurrence, located by anchor. */
interface ConstructionSite {
  readonly path: string;
  /** 1-based. For diagnostics, not identity. */
  readonly line: number;
  /** The enclosing top-level declaration. */
  readonly symbol: string;
  /** The variable the agent is assigned to, or `''` when unrecognised. */
  readonly binding: string;
  /** A prose mention inside a comment, not a construction. */
  readonly inComment: boolean;
}

const TOP_LEVEL_DECLARATION: readonly RegExp[] = [
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/,
];

function topLevelDeclarationName(line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of TOP_LEVEL_DECLARATION) {
    const match = pattern.exec(trimmed);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * The nearest enclosing TOP-LEVEL declaration, by column rather than by brace
 * counting.
 *
 * Indentation is the cheap and stable signal here: a class method is indented,
 * so a site inside one attributes to its class, and a site inside a nested
 * function attributes to the exported function. Counting braces instead would
 * have to parse string literals and template literals to stay correct, and this
 * anchor is a label — it is asserted because every current value names a real
 * declaration, and it fails loudly rather than silently if that stops holding.
 */
function enclosingTopLevel(lines: readonly string[], index: number): string {
  for (let i = index; i >= 0; i--) {
    const raw = lines[i] ?? '';
    if (raw.trim() === '' || !/^\S/.test(raw)) continue; // indented or blank
    const name = topLevelDeclarationName(raw);
    if (name) return name;
    // A column-0 statement that is not a declaration: keep walking outwards.
  }
  return '<module>';
}

/**
 * The receiver expression immediately before `.streamChat(`.
 *
 * Handles a bare identifier, a member chain (`this.llmClient`, `deps.llmClient`)
 * and a parenthesised expression, so that
 * `(this.compactClient ?? this.llmClient).streamChat(` is identified by its
 * whole receiver rather than by its trailing identifier — which is what stops
 * it colliding with `this.llmClient.streamChat(` in the same class.
 *
 * Returns `null` when the text before the dot is not an expression at all,
 * which is the signature of a mention inside a string.
 */
function receiverBefore(line: string, callAt: number): string | null {
  const before = line.slice(0, callAt);
  const tail = before.trimEnd();
  if (tail.endsWith(')')) {
    let depth = 0;
    for (let i = tail.length - 1; i >= 0; i--) {
      const char = tail[i];
      if (char === ')') depth++;
      else if (char === '(') {
        depth--;
        if (depth === 0) return tail.slice(i).replace(/\s+/g, ' ');
      }
    }
  }
  const match = /((?:[A-Za-z0-9_$]+\s*(?:\.\s*[A-Za-z0-9_$]+|\s*\[\s*[^\]]*\s*\])*))\s*$/.exec(before);
  return match ? (match[1] ?? '').replace(/\s+/g, '') : null;
}

function isCommentLine(trimmed: string): boolean {
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

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
  const abs = resolve(ROOT, dir);
  if (!existsSync(abs)) return acc;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      listProductionTsFiles(rel, acc);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      acc.push(rel);
    }
  }
  return acc;
}

const PRODUCTION_FILES: readonly string[] = Object.freeze(
  TURN_ENTRY_SOURCES.flatMap((dir) => listProductionTsFiles(dir)),
);

function repoLines(path: string): string[] {
  return readRepoFile(path).split('\n');
}

function streamChatSites(): StreamChatSite[] {
  const sites: StreamChatSite[] = [];
  for (const file of PRODUCTION_FILES) {
    repoLines(file).forEach((line, index) => {
      if (!line.includes('.streamChat(')) return;
      const trimmed = line.trim();
      if (isCommentLine(trimmed)) return;
      const callAt = line.indexOf('.streamChat(');
      const receiver = receiverBefore(line, callAt);
      sites.push({
        path: file,
        line: index + 1,
        receiver,
        symbol: enclosingTopLevel(repoLines(file), index),
        kind: receiver ? 'call' : 'mention',
        code: trimmed.slice(0, 100),
      });
    });
  }
  return sites;
}

function constructionSites(): ConstructionSite[] {
  const sites: ConstructionSite[] = [];
  for (const file of PRODUCTION_FILES) {
    const lines = repoLines(file);
    lines.forEach((line, index) => {
      if (!/\bnew (DuyaAgent|duyaAgent)\(/.test(line)) return;
      const trimmed = line.trim();
      const inComment = isCommentLine(trimmed);
      const binding = /(?:const\s+)?([A-Za-z0-9_$]+)\s*=\s*new\s+(?:DuyaAgent|duyaAgent)\(/;
      sites.push({
        path: file,
        line: index + 1,
        symbol: inComment ? '' : enclosingTopLevel(lines, index),
        binding: inComment ? '' : (binding.exec(trimmed)?.[1] ?? ''),
        inComment,
      });
    });
  }
  return sites;
}

/** `path#symbol#receiver`, the identity a recorded row is matched on. */
function siteKey(path: string, symbol: string, receiver: string | null): string {
  return `${path}#${symbol}#${receiver ?? '<mention>'}`;
}

function siteLabel(site: StreamChatSite | ConstructionSite): string {
  return `${site.path}:${site.line} (${site.symbol})`;
}

/**
 * A call site that begins a whole agent turn — the thing H8.3's retirement
 * gate counts down.
 */
interface TurnEntry {
  /** The consumer this entry belongs to. */
  readonly consumer: 'desktop' | 'cli' | 'subagent' | 'workflow';
  readonly path: string;
  /** Anchor: the full receiver expression the call is made on. */
  readonly receiver: string;
  /** Anchor: the enclosing top-level declaration. */
  readonly symbol: string;
  /**
   * Whether the turn is opened through the Control Plane's `openRun` (which
   * also dispatches it) rather than by constructing a run-local agent.
   */
  readonly viaControlPlane: boolean;
  /** What would have to change for this to become CP-driven. */
  readonly note: string;
}

/**
 * `.streamChat(` occurrences that are NOT turn entries, with the reason. These
 * exist so the "did we count everything?" question has an answer that is not
 * "we grepped and it felt right".
 */
interface NotATurnEntry {
  readonly path: string;
  /** `null` when the occurrence is a mention in data rather than a call. */
  readonly receiver: string | null;
  readonly symbol: string;
  readonly reason: string;
}

/** A direct `new duyaAgent(` construction, or a comment mentioning one. */
interface Construction {
  readonly path: string;
  /** Anchor: the enclosing top-level declaration. */
  readonly symbol: string;
  readonly binding: string;
  /** A comment naming the construction, which is documentation, not a caller. */
  readonly inComment: boolean;
}

/**
 * ## The turn entries, RETIRED at plan 610 S4c-d3
 *
 * `DuyaAgent.streamChat` (the agent facade) is the turn entry. `AIClient
 * .streamChat` is a different method on a different class that happens to
 * share the name, and is excluded — see `NOT_TURN_ENTRIES`.
 *
 * Desktop's own turn is opened by the router, not by a `streamChat` call site,
 * which is why the router has never had a row here: `router.ts` calls `openRun`,
 * and the execution channel inside it issues `chat:start` to the worker.
 *
 * This table held three rows, one per production consumer of the legacy turn
 * loop. Measured over `packages/agent/src/process` and
 * `packages/agent/src/tool/SubagentTool`, there is now **no call site for any
 * of them**: the facade generator is deleted, and each consumer drives the
 * engine instead. The three rows and where each consumer's turn went:
 *
 *  - `agent-process-entry.ts` → the worker drives the engine (plan 610 hosts 1).
 *  - `headless-run-host.ts` → the headless host drives the engine (host 2).
 *  - `SubagentTool/runAgent.ts` → `driveSubagentRunWithEngine` (host 3, this
 *    slice).
 *
 * The first two were already stale before S4c-d3 landed — this table was the
 * slice that should have been updated with them and was not, which is why the
 * census had been reporting drift. All three are retired together here, and the
 * headline number below is what the retirement gate was waiting for: it is now
 * **zero**, which is the one state H8.3 needed and could not previously assert.
 *
 * The rows are kept in git history rather than as a comment block, so a
 * re-introduced `agent.streamChat(` shows up in the unclassified check below as
 * a NEW site with no row to explain it.
 */
const TURN_ENTRIES: readonly TurnEntry[] = Object.freeze([]);

/**
 * ## The look-alikes
 *
 * Every one of these matches `.streamChat(` in a grep. None of them begins an
 * agent turn, and counting them is the most likely way the retirement gate ends
 * up chasing a number that can never reach zero.
 *
 * Plan 610 S4c-d3 removed the first two rows of this table. Both were
 * `duyaAgent` look-alikes that lived inside the deleted turn loop -- context
 * compaction's summary call and the side-question helper. With the generator
 * gone the calls are gone, and a row that classifies a call which no longer
 * exists is worse than no row: the census would report it as a drift.
 */
const NOT_TURN_ENTRIES: readonly NotATurnEntry[] = Object.freeze([
  Object.freeze({
    path: 'packages/agent/src/process/run-engine-model.ts',
    receiver: 'client',
    symbol: 'createClientModelPort',
    reason:
      "The engine's own model port: the `AIClient` call the runtime makes " +
      "inside one turn. Same class of call as the turn itself, one layer down.",
  }),
  Object.freeze({
    path: 'packages/agent/src/process/run-engine-model.ts',
    receiver: 'sources.llmClient',
    symbol: 'createLegacyModelPort',
    reason:
      'The model port handed to `composeLegacyRunPorts`, wrapping the ' +
      "host's `AIClient`. One layer down, and the reason the facade generator " +
      'could be deleted without changing what the model is asked.',
  }),
  Object.freeze({
    path: 'packages/agent/src/process/run-engine-model.ts',
    receiver: 'client',
    symbol: 'createOneShotTextPort',
    reason:
      'The single-text port used by one-shot helpers (titles, summaries). ' +
      "Its own `AIClient`; no turn state.",
  }),
  Object.freeze({
    path: 'packages/agent/src/agent/TurnStreamRunner.ts',
    receiver: 'deps.llmClient',
    symbol: 'runTurnStream',
    reason:
      'The model call INSIDE a turn. Same class of call as the turn itself, ' +
      'one layer down.',
  }),
  Object.freeze({
    path: 'packages/agent/src/agent/visual-analysis.ts',
    receiver: 'this.visionClient',
    symbol: 'VisualAnalysisService',
    reason: 'Vision analysis on a separate client.',
  }),
  Object.freeze({
    path: 'packages/agent/src/memory-rollout/extractor.ts',
    receiver: 'this',
    symbol: 'Stage1Extractor',
    reason:
      'Memory extraction. `this.streamChat` here is NOT the agent facade: the ' +
      'class holds `AIClient[\'streamChat\']` bound to an LLM client in its ' +
      'constructor. An `@duya/ai` call wearing the facade\'s name.',
  }),
  Object.freeze({
    path: 'packages/agent/src/session/title-generator.ts',
    receiver: 'llmClient',
    symbol: 'generateSessionTitle',
    reason: 'Session titling, its own `AIClient`.',
  }),
  Object.freeze({
    path: 'packages/agent/src/tool/SessionSearchTool/SessionSearchTool.ts',
    receiver: 'client',
    symbol: 'SessionSearchTool',
    reason: 'Summarising search results, its own `AIClient`.',
  }),
  Object.freeze({
    path: 'apps/desktop/src/main/agents/server/run-orchestrator.ts',
    receiver: null,
    symbol: 'LEGACY_RETIREMENT',
    reason:
      'The retirement registry\'s own prose, in a string literal. Data, not a ' +
      'call — and the reason it is a recorded row rather than a silently ' +
      'skipped line is that H8.3 has to be able to say where the number it ' +
      'retires on comes from.',
  }),
]);

/** Every direct agent construction, anchored like the rows above. */
const CONSTRUCTIONS: readonly Construction[] = Object.freeze([
  Object.freeze({
    path: 'packages/agent/src/cli/index.ts',
    symbol: 'runCLI',
    binding: 'agent',
    inComment: false,
  }),
  Object.freeze({
    path: 'packages/agent/src/cli/index.ts',
    symbol: 'runPrintMode',
    binding: 'agent',
    inComment: false,
  }),
  Object.freeze({
    path: 'packages/agent/src/cli/index.ts',
    symbol: 'runHeadlessMode',
    binding: 'agent',
    inComment: false,
  }),
  Object.freeze({
    path: 'packages/agent/src/process/agent-process-entry.ts',
    symbol: 'initAgent',
    binding: 'agent',
    inComment: false,
  }),
  Object.freeze({
    path: 'packages/agent/src/tool/SubagentTool/runAgent.ts',
    symbol: 'runAgent',
    binding: 'subAgent',
    inComment: false,
  }),
  Object.freeze({
    path: 'apps/desktop/src/main/agents/server/router.ts',
    symbol: '',
    binding: '',
    inComment: true,
  }),
  Object.freeze({
    path: 'packages/agent/src/tool/SubagentTool/runAgent.ts',
    symbol: '',
    binding: '',
    inComment: true,
  }),
]);

describe('H8.2 — measured consumer inventory', () => {
  it('resolves every recorded site to exactly one occurrence', () => {
    // The anchor check, in place of the old line-number check. A recorded row
    // that no longer resolves is drift; a row that resolves to TWO occurrences
    // is also drift, and asserting the count here is what stops a new call site
    // from being absorbed by a stale row.
    const calls = streamChatSites();
    const mentions = calls.filter((site) => site.kind === 'mention');
    const constructions = constructionSites();

    const problems: string[] = [];

    for (const entry of TURN_ENTRIES) {
      const found = calls.filter(
        (site) => site.kind === 'call' && site.path === entry.path && site.receiver === entry.receiver,
      );
      if (found.length !== 1) {
        problems.push(
          `turn entry ${entry.consumer} ${siteKey(entry.path, entry.symbol, entry.receiver)}: ` +
            `resolved to ${found.length} call site(s)` +
            (found.length > 0 ? ` — ${found.map(siteLabel).join(', ')}` : ''),
        );
        continue;
      }
      const site = found[0]!;
      if (site.symbol !== entry.symbol) {
        problems.push(
          `turn entry ${siteLabel(site)}: recorded symbol is "${entry.symbol}", ` +
            `the enclosing top-level declaration is "${site.symbol}"`,
        );
      }
    }

    for (const entry of NOT_TURN_ENTRIES) {
      const pool = entry.receiver === null ? mentions : calls.filter((s) => s.kind === 'call');
      const found = pool.filter(
        (site) =>
          site.path === entry.path &&
          site.receiver === entry.receiver &&
          // Plan 610 S4c-d3: the symbol is part of a row's identity, exactly as
          // `siteKey` already treats it in the unclassified check below. Keying
          // only on (path, receiver) made two rows unrepresentable as soon as
          // one file held two look-alikes on the same receiver --
          // `run-engine-model.ts` calls `client.streamChat(` from both
          // `createClientModelPort` and `createOneShotTextPort`, which then
          // collided and each reported "resolved to 2". A mention row
          // (`receiver: null`) is exempt: its symbol is a label for the row,
          // not the enclosing declaration.
          (entry.receiver === null || site.symbol === entry.symbol),
      );
      if (found.length !== 1) {
        problems.push(
          `look-alike ${siteKey(entry.path, entry.symbol, entry.receiver)}: ` +
            `resolved to ${found.length} occurrence(s)` +
            (found.length > 0 ? ` — ${found.map(siteLabel).join(', ')}` : ''),
        );
        continue;
      }
      const site = found[0]!;
      if (entry.receiver !== null && site.symbol !== entry.symbol) {
        problems.push(
          `look-alike ${siteLabel(site)}: recorded symbol is "${entry.symbol}", ` +
            `the enclosing top-level declaration is "${site.symbol}"`,
        );
      }
    }

    for (const entry of CONSTRUCTIONS) {
      const found = constructions.filter(
        (site) =>
          site.path === entry.path &&
          site.inComment === entry.inComment &&
          site.symbol === entry.symbol,
      );
      if (found.length !== 1) {
        problems.push(
          `construction ${siteKey(entry.path, entry.symbol, entry.binding)}: ` +
            `resolved to ${found.length} occurrence(s)` +
            (found.length > 0 ? ` — ${found.map(siteLabel).join(', ')}` : ''),
        );
        continue;
      }
      const site = found[0]!;
      if (entry.binding !== '' && site.binding !== entry.binding) {
        problems.push(
          `construction ${siteLabel(site)}: recorded binding is "${entry.binding}", ` +
            `the assignment target is "${site.binding}"`,
        );
      }
    }

    expect(problems, 'recorded sites that no longer resolve to exactly one occurrence').toEqual([]);
  });

  it('finds no unclassified turn entry in production source', () => {
    // The point of the inventory: a NEW `.streamChat(` in production source
    // that is not classified here fails. This is the assertion that makes
    // "we counted them all" checkable instead of asserted, and it is the
    // property H8.3's retirement gate rests on.
    expect(PRODUCTION_FILES.length).toBeGreaterThan(0);

    const recorded = new Set<string>([
      ...TURN_ENTRIES.map((e) => siteKey(e.path, e.symbol, e.receiver)),
      ...NOT_TURN_ENTRIES.map((e) => siteKey(e.path, e.symbol, e.receiver)),
    ]);

    const unrecorded = streamChatSites()
      .filter((site) => !recorded.has(siteKey(site.path, site.symbol, site.receiver)))
      .map((site) => `${siteLabel(site)} ${site.receiver ?? '<mention>'} — ${site.code}`);

    expect(
      unrecorded,
      'unclassified .streamChat( occurrence(s) — add a TURN_ENTRIES or NOT_TURN_ENTRIES row',
    ).toEqual([]);
  });

  it('accounts for every direct DuyaAgent construction', () => {
    // The other half of the census. A turn entry needs an agent to drive, so
    // every `new duyaAgent(` in production source is a consumer whether or not
    // it reaches a `streamChat` line — and a construction with no turn entry is
    // the more interesting drift, because it means an agent built for a caller
    // that no longer exists.
    //
    // Desktop's construction is CP-driven; the other four are the non-CP
    // consumers. Counted separately from the turn entries because the axes are
    // 1:1 per consumer but not per site: the CLI now builds one agent per
    // command and hands it to `HeadlessRunHost`, and the worker builds one
    // inside `initAgent`.
    const recorded = new Set<string>(
      CONSTRUCTIONS.map((e) => siteKey(e.path, e.symbol, e.inComment ? null : e.binding)),
    );

    const unaccounted = constructionSites()
      .filter((site) => !recorded.has(siteKey(site.path, site.symbol, site.inComment ? null : site.binding)))
      .map((site) => `${siteLabel(site)} ${site.inComment ? 'comment' : site.binding}`);

    expect(
      unaccounted,
      'unaccounted agent construction(s) — add a CONSTRUCTIONS row',
    ).toEqual([]);
  });

  it('reports the counts the H8.3 retirement gate is measured against', () => {
    const byConsumer = (c: TurnEntry['consumer']): number =>
      TURN_ENTRIES.filter((e) => e.consumer === c).length;
    const cpDriven = TURN_ENTRIES.filter((e) => e.viaControlPlane).length;

    // The headline number: turns that do NOT go through the Control Plane.
    // H8.3 can only delete the shim when this reaches zero.
    //
    // Re-measured after PR #198: the CLI's three direct turn sites were gone and
    // the CLI's turn opened through the shared `RunController`, so 4 became 1.
    // The sub-agent was the whole of what was left, and `runAgent.ts` was a
    // nested loop inside the parent worker with no run row of its own.
    //
    // PLAN 610 S4c-d3 REACHED ZERO. The sub-agent was the last consumer still
    // calling the facade generator, and it now drives the engine. Every consumer
    // of a `DuyaAgent` turn goes through the Control Plane or the engine, so the
    // shim H8.3 wants to delete has no remaining caller to break.
    //
    // Unchanged by the H8.2 automation work, and deliberately so. Automation
    // was never counted here: it does not call `.streamChat(` at all, it POSTs
    // to the same `POST /sessions/:id/chat` the renderer uses. What H8.2 fixed
    // was the half this file cannot see — automation settling on the worker's
    // `done` FRAME instead of reading the `RunResult`. Fixing a read cannot
    // move an entry count, and a number that moved because a read changed
    // would mean the count had been measuring the wrong thing.
    expect(TURN_ENTRIES.length - cpDriven).toBe(0);
    expect(TURN_ENTRIES.length).toBe(0);
    expect(cpDriven).toBe(0);
    expect(byConsumer('cli')).toBe(0);
    expect(byConsumer('subagent')).toBe(0);
    expect(byConsumer('desktop')).toBe(0);
    // The look-alikes are excluded on purpose — documented so the exclusion is
    // a number someone can challenge, not a silent filter. Nine `@duya/ai`
    // calls plus the registry's own prose. Plan 610 S4c-d3 took this from 8 by
    // deleting the two `duyaAgent` look-alikes that lived in the removed loop,
    // and added back three for the engine's own model ports.
    expect(NOT_TURN_ENTRIES.length).toBe(9);
    expect(NOT_TURN_ENTRIES.filter((e) => e.receiver === null).length).toBe(1);
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
    //
    // Plan 610 S4c-d3: this used to assert `runAgent.ts` contains EXACTLY ONE
    // `.streamChat(` call -- the census shape "one nested turn, no second
    // loop". The third and last production driver of `DuyaAgent`'s legacy turn
    // loop was in this file, so the count is now ZERO and the claim is
    // STRONGER, not gone: the sub-agent no longer contains a turn loop of any
    // kind, it delegates to the engine driver the worker entry and the headless
    // host already used. A future second loop fails on the first assertion; a
    // re-introduced generator fails on the second.
    const runAgent = readRepoFile('packages/agent/src/tool/SubagentTool/runAgent.ts');
    const turnSites = runAgent
      .split('\n')
      .filter((line) => !isCommentLine(line.trim()) && line.includes('.streamChat('));
    expect(turnSites).toHaveLength(0);

    // POSITIVELY, not by absence: exactly one engine-driver call, so "zero turn
    // sites" cannot be satisfied by this file having stopped driving anything.
    const engineSites = runAgent
      .split('\n')
      .filter((line) => !isCommentLine(line.trim()) && line.includes('driveSubagentRunWithEngine('));
    expect(engineSites).toHaveLength(1);
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
