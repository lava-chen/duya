import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';
import { truncateToWidth } from '../width.js';
import { escapeTags, type Styles } from '../transcript-view.js';
import { DISPLAY_PROFILES, type DisplayProfileId } from '../display-profiles.js';
import { formatTaskDuration, taskStatusGlyph, type BackgroundTaskView } from '../background-tasks.js';
import { capacityBar } from '../capacity-bar.js';

export interface WorkbenchSidebarContextPart {
  readonly label: string;
  readonly tokens: number;
}

/** Plain text only: plugin status contributions cannot inject terminal markup. */
export interface WorkbenchSidebarStatusItem {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly tone?: 'default' | 'success' | 'warning' | 'error';
}

export interface SidebarTarget {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly action:
    | { readonly command: string }
    | { readonly task: BackgroundTaskView }
    | { readonly agent: BackgroundTaskView | null };
}
export interface WorkbenchSidebarProps {
  readonly styles: Styles;
  readonly sessionTitle: string;
  readonly activity: string;
  readonly activityActive: boolean;
  readonly tasks: readonly BackgroundTaskView[];
  readonly selectedAgentId: string | null;
  readonly contextTokens: number | null;
  readonly contextEstimated: boolean;
  readonly contextBudget: number | null;
  readonly contextParts: readonly WorkbenchSidebarContextPart[];
  readonly statusItems: readonly WorkbenchSidebarStatusItem[];
  readonly profile: DisplayProfileId | 'custom';
  readonly tools: { readonly total: number; readonly running: number; readonly errors: number };
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
    scene.writeTagged(viewport.row, viewport.column + 2, styles.accent('WORKBENCH'));
    const lines: Array<{
      text: string;
      command?: string;
      task?: BackgroundTaskView;
      agent?: BackgroundTaskView | null;
    }> = [];
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
    const agentAction = (task: BackgroundTaskView | null, label: string, status: string, active: boolean, selected: boolean): void => {
      const state = task === null ? status : task.status;
      const clipped = escapeTags(truncateToWidth(`${selected ? '●' : '›'} ${label} · ${status}`, width));
      const tone = state === 'failed' || state === 'error' ? styles.error
        : active || selected ? styles.accent : styles.muted;
      lines.push({ text: tone(clipped), agent: task });
    };
    const number = (value: number | null): string => value === null ? '—' : value.toLocaleString('en-US');
    text(this.props.sessionTitle);
    text('');
    text('AGENTS');
    agentAction(
      null,
      'Main',
      this.props.activity.trim() || 'Ready',
      this.props.activityActive,
      this.props.selectedAgentId === null,
    );
    const subagents = this.props.tasks.filter((task) => task.kind === 'subagent');
    for (const task of subagents.slice(0, 6)) {
      agentAction(
        task,
        task.title,
        task.status,
        task.status === 'running',
        task.id === this.props.selectedAgentId,
      );
    }
    const background = this.props.tasks.filter((task) => task.kind === 'bash');
    if (background.length > 0) {
      text('BACKGROUND TASKS');
      for (const task of background.slice(0, 6)) taskAction(task);
    }
    text('');
    text('CONTEXT');
    const used = this.props.contextTokens;
    const budget = this.props.contextBudget;
    const percent = used !== null && budget !== null && budget > 0
      ? Math.min(100, Math.round((used / budget) * 100))
      : null;
    const ratio = used !== null && budget !== null && budget > 0 ? used / budget : null;
    text(`Context  ${this.props.contextEstimated && used !== null ? '≈ ' : ''}${number(used)} / ${number(budget)}${percent === null ? '' : ` · ${percent}%`}`);
    lines.push({ text: styles.accent(escapeTags(capacityBar(ratio, 12))) });
    for (const part of this.props.contextParts.slice(0, 3)) {
      text(`≈ ${part.label}  ${number(part.tokens)}`);
    }
    if (this.props.statusItems.length > 0) {
      text('PLUGINS');
      for (const item of this.props.statusItems.slice(0, 4)) {
        const value = `${item.label} · ${item.value}`;
        const clipped = escapeTags(truncateToWidth(value.replace(/[\r\n\t]/gu, ' '), width));
        const tone = item.tone === 'error' ? styles.error
          : item.tone === 'warning' ? styles.warning
          : item.tone === 'success' ? styles.success
          : styles.muted;
        lines.push({ text: tone(clipped) });
      }
    }
    text('');
    text('DISPLAY');
    for (const profile of DISPLAY_PROFILES) {
      action(profile.label, `/display ${profile.id}`, profile.id === this.props.profile);
    }
    if (this.props.profile === 'custom') text('Custom settings');
    text('');
    text(`Tools ${this.props.tools.total} · ${this.props.tools.running} running · ${this.props.tools.errors} errors`);
    action('Context details', '/context');
    this.viewportRows = Math.max(0, viewport.height - 1);
    this.documentRows = lines.length;
    const first = Math.min(this.scrollTop, Math.max(0, lines.length - this.viewportRows));
    this.scrollTop = first;
    lines.slice(first, first + this.viewportRows).forEach((line, index) => {
      const row = index + 1;
      scene.writeTagged(viewport.row + row, viewport.column + 2, line.text);
      if (line.command) this.targets.push({ id: line.command, row, column: 2, width, action: { command: line.command } });
      if (line.task) this.targets.push({ id: `task:${line.task.id}`, row, column: 2, width, action: { task: line.task } });
      if (line.agent !== undefined) this.targets.push({
        id: line.agent === null ? 'agent:main' : `agent:${line.agent.id}`,
        row,
        column: 2,
        width,
        action: { agent: line.agent },
      });
    });
  }
}
