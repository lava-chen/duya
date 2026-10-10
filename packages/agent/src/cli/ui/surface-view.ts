/**
 * Blessed rendering for the surface model: turn lifecycle and tool call phases.
 *
 * ## Why this sits on the surface model and not on `blocks.ts`
 *
 * `blocks.ts` consumes `LegacyFrame`, which is the output of a projection that
 * drops eleven protocol events. Two of the things this file draws are among
 * them:
 *
 *  - there is no `turn.completed` frame, so a turn row built on frames can only
 *    ever say "started" or nothing;
 *  - `tool.timed_out` reaches `null`, so a tool row cannot show that a call ran
 *    out of time as distinct from one that failed.
 *
 * Both are drawn below from `TurnSurface` / `ToolCallSurface`, which carry them.
 *
 * ## Scope of this pass
 *
 * Turn lifecycle and tool call phases only, as a skeleton. The rest of the TUI
 * still renders from `TranscriptModel`; migrating it is a later pass and is
 * deliberately not attempted here. What this proves is that a SECOND renderer
 * can be pointed at the same model and get correct output — which is the claim
 * the conformance suite exists to protect.
 *
 * ## No blessed import
 *
 * The output is blessed TAG MARKUP, produced by pure string functions. Nothing
 * here constructs a screen, so the whole file is reachable from a test with no
 * TTY — the same property `transcript-view.ts` keeps for the block renderer.
 */

import type { RunEventEnvelope } from '@duya/agent-protocol';
import type {
  SurfaceEffect,
  ToolCallSurface,
  ToolPhase,
  TurnPhase,
  TurnSurface,
} from '@duya/agent-runtime';
import { SurfaceModel } from '@duya/agent-runtime';
import { escapeTags } from './transcript-view.js';

/** Blessed tag for a colour, matching `transcript-view.ts` so one screen reads as one screen. */
const c = {
  bold: (s: string) => `{bold}${s}{/bold}`,
  brightGreen: (s: string) => `{brightGreen-fg}${s}{/brightGreen-fg}`,
  red: (s: string) => `{red-fg}${s}{/red-fg}`,
  brightRed: (s: string) => `{brightRed-fg}${s}{/brightRed-fg}`,
  yellow: (s: string) => `{yellow-fg}${s}{/yellow-fg}`,
  cyan: (s: string) => `{cyan-fg}${s}{/cyan-fg}`,
  gray: (s: string) => `{gray-fg}${s}{/gray-fg}`,
} as const;

/** Marker per turn phase. */
const TURN_MARKER: Record<TurnPhase, string> = {
  running: '⏺',
  retrying: '↻',
  completed: '✔',
  failed: '✖',
};

/** Marker per tool phase. */
const TOOL_MARKER: Record<ToolPhase, string> = {
  preview: '·',
  streaming_arguments: '·',
  started: '⏺',
  progress: '⏺',
  completed: '✔',
  timed_out: '⏱',
};

/**
 * Render one turn row.
 *
 * The phase is spelled out rather than encoded in the marker alone: a `✔` next
 * to "turn 2" does not say whether the turn SUCCEEDED or merely stopped, and
 * `retrying` in particular looks identical to `running` under any marker.
 */
export function renderTurnRow(turn: TurnSurface): string {
  const marker = TURN_MARKER[turn.phase];

  // The model is part of the identity of a turn, not decoration: two turns with
  // the same index can have been run by different providers, and a reader
  // debugging a run needs to see which.
  const head = turn.model === '' ? `turn ${turn.index}` : `turn ${turn.index} · ${turn.model}`;

  let label: string;
  switch (turn.phase) {
    case 'running':
      label = head;
      break;
    case 'retrying':
      // The retry's own facts, not a generic "retrying": attempt N of M after
      // a stated delay, which is what tells a reader whether to wait.
      label = `${head} · retry ${turn.retry?.attempt ?? 0}/${turn.retry?.maxAttempts ?? 0} in ${turn.retry?.delayMs ?? 0}ms`;
      break;
    case 'completed':
      label = `${head} · ${turn.stopReason ?? 'completed'}`;
      break;
    case 'failed':
      label = `${head} · failed`;
      break;
  }

  const detail = turn.phase === 'completed' && turn.usage !== null
    ? c.gray(` (${turn.usage.totalTokens} tokens, ${turn.durationMs ?? 0}ms)`)
    : '';

  const tint =
    turn.phase === 'completed'
      ? c.brightGreen
      : turn.phase === 'failed'
        ? c.red
        : turn.phase === 'retrying'
          ? c.yellow
          : c.cyan;

  return `${tint(marker)} ${escapeTags(label)}${detail}`;
}

/**
 * Render one tool call row.
 *
 * The phase suffix is what the legacy `ToolBlock` could not carry: a call that
 * timed out reads differently from one that failed, and a call still generating
 * its arguments reads differently from one that has been dispatched.
 */
export function renderToolRow(tool: ToolCallSurface): string {
  const marker = TOOL_MARKER[tool.phase];
  const label = tool.name;

  let suffix: string;
  switch (tool.phase) {
    case 'preview':
      suffix = c.gray(' · proposing');
      break;
    case 'streaming_arguments':
      suffix = c.gray(' · generating arguments');
      break;
    case 'started':
      suffix = '';
      break;
    case 'progress': {
      const percent = tool.progress?.percent;
      const elapsed = tool.progress?.elapsedMs ?? 0;
      const title = tool.progress?.title;
      const elapsedText = `${Math.round(elapsed / 100) / 10}s`;
      suffix = c.gray(` · ${percent === null || percent === undefined ? elapsedText : `${percent}%`}`);
      if (title !== null && title !== undefined && title !== '') suffix += c.gray(` ${title}`);
      break;
    }
    case 'timed_out':
      suffix = c.brightRed(' · timed out');
      break;
    case 'completed':
      suffix = tool.outcome?.outcome === 'success' ? '' : c.red(` · ${tool.outcome?.outcome ?? 'unknown'}`);
      break;
  }

  const tint = tool.phase === 'completed' ? c.brightGreen : tool.phase === 'timed_out' ? c.brightRed : c.cyan;
  return `${tint(marker)} ${escapeTags(label)}${suffix}`;
}

/**
 * What pushing one envelope changed for the blessed side.
 *
 * `redraw` is the part the shell cares about: the surface model reports an
 * effect for every event, and `blessed`'s `screen.render()` re-walks every
 * attached element, so a firehose of ephemeral deltas must not each cost a
 * repaint. `RenderScheduler` still throttles whatever this returns `true` for.
 */
export interface SurfacePushResult {
  readonly redraw: boolean;
  readonly effect: SurfaceEffect;
}

/**
 * Effects this tape can actually draw.
 *
 * The surface model reports "something changed" for every event, including ones
 * it deliberately retains nothing for (`diagnostic.trace`). A renderer that
 * treated every non-`none` effect as a repaint would repaint per span across a
 * whole run — and `blessed`'s `screen.render()` re-walks every attached element,
 * so that cost is paid in screen area, not in constant time.
 *
 * So the split is: the MODEL says what happened, the RENDERER says whether it
 * can show it. This tape draws turn rows and tool rows, so those are the effects
 * worth a repaint — plus `run_failed`, which mutates turn rows without being a
 * turn of its own.
 */
const DRAWABLE_EFFECTS: ReadonlySet<SurfaceEffect['kind']> = new Set<SurfaceEffect['kind']>([
  'turn',
  'run_failed',
  'tool',
]);

/**
 * The blessed-side tape: envelopes in, blessed rows out.
 *
 * Owns a `SurfaceModel` rather than reaching into one, because the shell needs a
 * single place that answers "did this stream change anything I can draw". The
 * rows are ordered by the run's own sequence — turns, then the tool calls each
 * turn issued — so a reader sees a turn line followed by the work it did.
 */
export class SurfaceTape {
  private readonly model = new SurfaceModel();

  /** The underlying surface, for a host that needs state this file does not draw. */
  get surface(): SurfaceModel {
    return this.model;
  }

  /** Feed one protocol envelope. */
  push(envelope: RunEventEnvelope): SurfacePushResult {
    const effect = this.model.apply(envelope);
    return { redraw: DRAWABLE_EFFECTS.has(effect.kind), effect };
  }

  /** Feed a run's events in order. */
  pushAll(envelopes: Iterable<RunEventEnvelope>): readonly SurfacePushResult[] {
    const results: SurfacePushResult[] = [];
    for (const envelope of envelopes) results.push(this.push(envelope));
    return results;
  }

  /** Every turn row, in order. */
  renderTurns(): readonly string[] {
    return this.model.turns.map((turn) => renderTurnRow(turn));
  }

  /** Every tool row, in first-seen order. */
  renderTools(): readonly string[] {
    return this.model.toolCalls.map((tool) => renderToolRow(tool));
  }

  /**
   * The whole tape as one tagged string: turn rows, then tool rows.
   *
   * Returns `''` for an empty tape so the first render after startup does not
   * have to special-case itself — the same rule `renderTranscript` follows.
   */
  render(): string {
    return [...this.renderTurns(), ...this.renderTools()].join('\n');
  }

  /** Drop everything, for `/clear` or a new run. */
  clear(): void {
    this.model.reset();
  }
}
