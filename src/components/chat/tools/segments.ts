// Segmenter — converts a flat ActionItem list into a list of
// group/single segments. Pure function; no React.
//
// Grouping rule:
//   - Consecutive `tool` actions collapse into a Group (≥2) or a
//     single standalone row (1).
//   - `thinking` joins the run alongside tools (it does NOT break the
//     group) so a [tool, thinking, tool] sequence stays one group with
//     three interleaved entries.
//   - `hook` (plan 437) is rendered as its own standalone row — it
//     flushes the surrounding tool run so the user gets a focused hook
//     card instead of hooks being absorbed into a tool group. Hooks
//     are not LLM tool calls; reading them as separate signals keeps
//     the chat flow clean.
//   - `text` and `widget` (and any future non-tool, non-thinking,
//     non-hook kind) flush the run.
//
// Inside a group, entries preserve the original action order — the
// Group component dispatches each entry to `ToolActionRow`,
// `ThinkingRow`, or `HookActionRow` by `entry.kind`.

import type { ActionItem, Segment, SegmentEntry } from './types';

export interface ComputeSegmentsOptions {
  /** Focus mode (per-session toggle): suspend the usual group-breaking
   *  rules so the ENTIRE action list collapses into one big run. Text /
   *  widget actions are skipped entirely (hidden by the renderers — only
   *  the final output shows); hooks join the run instead of flushing it.
   *  The result is a single Group carrying every work entry of the round. */
  focus?: boolean;
}

export function computeSegments(actions: ActionItem[], opts: ComputeSegmentsOptions = {}): Segment[] {
  const segments: Segment[] = [];
  let run: SegmentEntry[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      segments.push({ kind: 'group', entries: [...run] });
    } else {
      segments.push({ kind: 'single', entry: run[0] });
    }
    run = [];
  };

  for (const action of actions) {
    if (action.kind === 'tool') {
      run.push({ kind: 'tool', tool: action.tool });
    } else if (action.kind === 'thinking') {
      // Thinking joins the run — does NOT break consecutive tools.
      run.push({
        kind: 'thinking',
        content: action.content,
        isStreaming: action.isStreaming,
      });
    } else if (action.kind === 'hook') {
      if (opts.focus) {
        // Focus mode: hooks join the single big run instead of flushing
        // it — everything of the round stays in one group.
        run.push({ kind: 'hook', hook: action.hook });
        continue;
      }
      // Plan 437: hooks are their own row. Flush the surrounding run
      // first (so tool groups stay tight), then push a single-entry
      // segment for this hook.
      flush();
      segments.push({ kind: 'single', entry: { kind: 'hook', hook: action.hook } });
    } else if (!opts.focus) {
      // text / widget (and any future kind) flush the run. In focus mode
      // they are skipped entirely — the run stays open so all work
      // merges across text boundaries into one big group.
      flush();
    }
  }
  flush();
  return segments;
}