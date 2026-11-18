import type { BackgroundTaskView } from '../background-tasks.js';
import type { ProjectSessionSummary } from '../project-workbench.js';
import { escapeTags } from '../markdown/escape.js';
import { taggedWith, type ThemeTags } from '../theme.js';
import { truncateToWidth, visibleWidth } from '../width.js';

export type AgentSwitchTarget =
  | { kind: 'main'; title: string }
  | { kind: 'subagent'; title: string; task: BackgroundTaskView }
  | { kind: 'session'; title: string; id: string };

export function agentSwitchTargets(
  mainTitle: string,
  tasks: readonly BackgroundTaskView[],
  sessions: readonly ProjectSessionSummary[],
): readonly AgentSwitchTarget[] {
  return [
    { kind: 'main', title: mainTitle },
    ...tasks.filter((task) => task.kind === 'subagent')
      .map((task) => ({ kind: 'subagent' as const, title: task.title, task })),
    ...sessions.map((session) => ({ kind: 'session' as const, title: session.title, id: session.id })),
  ];
}

export function agentSwitchKey(target: AgentSwitchTarget): string {
  if (target.kind === 'main') return 'main';
  return target.kind === 'session' ? `session:${target.id}` : `subagent:${target.task.id}`;
}

/** One terminal row; coordinates are measured on plain text before styling. */
export function renderAgentSwitcher(
  targets: readonly AgentSwitchTarget[],
  selected: string,
  columns: number,
  theme: ThemeTags,
): { text: string; hits: readonly { target: AgentSwitchTarget; column: number; width: number }[] } {
  const hits: { target: AgentSwitchTarget; column: number; width: number }[] = [];
  const total = columns - 4;
  if (targets.length < 2 || total < 12) return { text: '', hits };
  const count = Math.min(targets.length, Math.max(2, Math.floor(total / 16)));
  const active = Math.max(0, targets.findIndex((item) => agentSwitchKey(item) === selected));
  const offset = Math.max(1, active - count + 2);
  const visible = [targets[0]!, ...targets.slice(offset, offset + count - 1)];
  const budget = Math.max(3, Math.floor((total - (visible.length - 1) * 2) / visible.length));
  let column = 4;
  const rows = visible.map((target) => {
    const current = agentSwitchKey(target) === selected;
    const safe = target.title.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ');
    const label = truncateToWidth(current ? `[${safe}]` : safe, budget);
    const width = visibleWidth(label);
    hits.push({ target, column, width });
    column += width + 2;
    return taggedWith(theme, current ? 'accent' : 'muted', escapeTags(label));
  });
  return { text: taggedWith(theme, 'muted', 'F7  ') + rows.join('  '), hits };
}
