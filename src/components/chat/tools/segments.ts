// Segmenter — converts a flat ActionItem list into a list of
// group/single segments. Pure function; no React.
//
// The grouping rule is intentionally simple: consecutive tool calls
// collapse into one Group (≥2) or a single row (1), and any non-tool
// action (thinking / text / widget) **breaks the run**. This matches
// what the user expects visually — a stretch of 6 tool calls followed
// by an explanatory text block, followed by 3 more tool calls, should
// render as [Group(6), TextRow, Group(3)] rather than [Group(9), TextRow].

import type { ActionItem, Segment, ToolAction } from './types';

export function computeSegments(actions: ActionItem[]): Segment[] {
  const segments: Segment[] = [];
  let run: ToolAction[] = [];

  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= 2) {
      segments.push({ kind: 'group', tools: run });
    } else {
      segments.push({ kind: 'single', tool: run[0] });
    }
    run = [];
  };

  for (const action of actions) {
    if (action.kind === 'tool') {
      run.push(action.tool);
    } else {
      flush();
    }
  }
  flush();
  return segments;
}
