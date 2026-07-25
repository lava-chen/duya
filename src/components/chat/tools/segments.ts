// Segmenter — converts a flat ActionItem list into a list of
// group/single segments. Pure function; no React.
//
// Grouping rule:
//   - Consecutive `tool` actions collapse into a Group (≥2) or a
//     single standalone row (1).
//   - `thinking` joins the run alongside tools (it does NOT break the
//     group) so a [tool, thinking, tool] sequence stays one group with
//     three interleaved entries.
//   - `text` and `widget` (and any future non-tool, non-thinking kind)
//     flush the run.
//
// Inside a group, entries preserve the original action order — the
// Group component dispatches each entry to `ToolActionRow` or
// `ThinkingRow` by `entry.kind`.

import type { ActionItem, Segment, SegmentEntry } from './types';

export function computeSegments(actions: ActionItem[]): Segment[] {
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
    } else {
      // text / widget (and any future kind) flush the run.
      flush();
    }
  }
  flush();
  return segments;
}