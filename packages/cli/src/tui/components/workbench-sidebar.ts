import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';
import { truncateToWidth } from '../width.js';
import { escapeTags, type Styles } from '../transcript-view.js';
import { formatTaskDuration, taskStatusGlyph, type BackgroundTaskView } from '../background-tasks.js';
import { prStateLabel, prTone, type PrBadge } from '../pr-badge.js';
import type { ProjectWorkbenchSummary } from '../project-workbench.js';
import type { WorkbenchWorkspaceSummary } from '../workbench-workspace.js';

export interface SidebarTarget {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly action: { readonly command: string } | { readonly task: BackgroundTaskView };
}
export interface WorkbenchSidebarProps {
  readonly styles: Styles;
  readonly sessionTitle: string;
  readonly activity: string;
  readonly activityActive: boolean;
  readonly tasks: readonly BackgroundTaskView[];
  readonly workspace: WorkbenchWorkspaceSummary;
  readonly project?: ProjectWorkbenchSummary | undefined;
  readonly pullRequest: PrBadge | null;
  readonly contextTokens: number | null;
  readonly contextBudget: number | null;
}

/** A bounded projection of existing Host/session and display state. No IO. */
export class WorkbenchSidebar implements UIComponent<WorkbenchSidebarProps> {
  readonly id = 'workbench-sidebar';
  revision = 0;
  private scrollTop = 0;
  private targets: SidebarTarget[] = [];
  private viewportRows = 1;
  private documentRows = 0;

  constructor(public props: WorkbenchSidebarProps) {}

  measure(): number { return 1; }
  pointerTargets(): readonly SidebarTarget[] { return this.targets; }
  scroll(delta: number): void {
    this.scrollTop = Math.max(0, Math.min(Math.max(0, this.documentRows - this.viewportRows), this.scrollTop + delta));
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    this.targets = [];
    const { styles } = this.props;
    const width = Math.max(0, viewport.width - 2);
    for (let row = 0; row < viewport.height; row++) {
      scene.writeTagged(viewport.row + row, viewport.column, styles.muted('│'));
    }
    if (viewport.height < 4 || width < 16) return;
    scene.writeTagged(viewport.row, viewport.column + 2, styles.accent(this.props.project === undefined ? 'WORKBENCH' : 'PROJECT'));
    const lines: Array<{ text: string; command?: string; task?: BackgroundTaskView }> = [];
    const text = (value: string): void => { lines.push({ text: styles.muted(escapeTags(truncateToWidth(value.replace(/[\r\n\t]/gu, ' '), width))) }); };
    const action = (label: string, command: string, selected = false): void => {
      const clipped = escapeTags(truncateToWidth(`${selected ? '●' : '›'} ${label.replace(/[\r\n\t]/gu, ' ')}`, width));
      lines.push({ text: selected ? styles.accent(clipped) : clipped, command });
    };
    const taskAction = (task: BackgroundTaskView): void => {
      const duration = formatTaskDuration((task.endedAtMs ?? Date.now()) - task.startedAtMs);
      const clipped = escapeTags(truncateToWidth(`› ${taskStatusGlyph(task.status, true)} ${task.title} · ${duration}`, width));
      const tone = task.status === 'running' ? styles.accent
        : task.status === 'failed' || task.status === 'error' ? styles.error : styles.muted;
      lines.push({ text: tone(clipped), task });
    };
    const number = (value: number | null): string => value === null ? '—' : value.toLocaleString('en-US');
    const project = this.props.project;
    if (project !== undefined) {
      text(project.name);
      action('Overview', '/status');
      if (project.status === 'loading') text('Loading project status…');
      else if (project.status === 'unavailable') text('Status unavailable · last known');
      if (project.taskCounts.length > 0) {
        text('TASKS');
        for (const { label, count } of project.taskCounts) text(`${count} ${label}`);
      }
      text('');
      action('Work sessions', '/sessions');
      if (project.status === 'current' && project.sessions.length === 0) text('No work sessions yet');
      for (const session of project.sessions.slice(0, 8)) {
        action(`${session.state} · ${session.title}`, `/sessions ${session.id}`);
      }
      if (project.sessions.length > 8) text(`+ ${project.sessions.length - 8} more in /sessions`);
    } else {
      const workspace = this.props.workspace;
      text(this.props.sessionTitle);
      action('New session', '/new');
      action('All sessions', '/sessions');
      text('');
      text('WORKTREE');
      text(`${workspace.branch ?? 'detached'} · ${workspace.linkedWorktree ? 'linked worktree' : 'repository'}`);
      text(workspace.root);
      if (!workspace.observed) {
        text('Git status unavailable');
      } else if (workspace.changedFiles === 0) {
        text('Working tree clean');
      } else {
        action(`${number(workspace.changedFiles)} changed files`, '/diff');
      }
      if (this.props.pullRequest !== null) {
        const badge = this.props.pullRequest;
        const label = `${badge.label} · ${prStateLabel(badge.state)}`;
        const clipped = escapeTags(truncateToWidth(`› ${label}`, width));
        lines.push({ text: styles[prTone(badge.state)](clipped), command: '/pr' });
      }
    }
    if (this.props.activityActive) {
      text('');
      const activity = escapeTags(truncateToWidth(this.props.activity.replace(/[\r\n\t]/gu, ' '), width));
      lines.push({ text: styles.accent(activity) });
    }
    if (this.props.tasks.length > 0) {
      text('');
      text('BACKGROUND');
      for (const task of this.props.tasks.slice(0, 6)) taskAction(task);
    }
    const used = this.props.contextTokens;
    const budget = this.props.contextBudget;
    if (used !== null && budget !== null && budget > 0) {
      text('');
      action(`Context ${Math.min(100, Math.round((used / budget) * 100))}%`, '/context');
    }
    this.viewportRows = Math.max(0, viewport.height - 1);
    this.documentRows = lines.length;
    const first = Math.min(this.scrollTop, Math.max(0, lines.length - this.viewportRows));
    this.scrollTop = first;
    lines.slice(first, first + this.viewportRows).forEach((line, index) => {
      const row = index + 1;
      scene.writeTagged(viewport.row + row, viewport.column + 2, line.text);
      if (line.command) this.targets.push({ id: line.command, row, column: 2, width, action: { command: line.command } });
      if (line.task) this.targets.push({ id: `task:${line.task.id}`, row, column: 2, width, action: { task: line.task } });
    });
  }
}
