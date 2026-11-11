import type { SceneCanvas, UIComponent, Viewport } from '../core/component.js';
import { truncateToWidth, visibleWidth } from '../width.js';
import { escapeTags, type Styles } from '../transcript-view.js';
import { DISPLAY_PROFILES, type DisplayProfileId } from '../display-profiles.js';

export type WorkbenchTab = 'sessions' | 'context' | 'view';
export interface SidebarTarget {
  readonly id: string;
  readonly row: number;
  readonly column: number;
  readonly width: number;
  readonly action: { readonly tab: WorkbenchTab } | { readonly command: string };
}
export interface WorkbenchSidebarProps {
  readonly styles: Styles;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly sessions: readonly { readonly id: string; readonly label: string }[];
  readonly model: string;
  readonly provider: string;
  readonly effort: string;
  readonly cwd: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly sessionTokens: number;
  readonly contextTokens: number | null;
  readonly contextBudget: number | null;
  readonly tokensPerSecond: number | null;
  readonly profile: DisplayProfileId | 'custom';
  readonly tools: { readonly total: number; readonly running: number; readonly errors: number };
}

/** A bounded projection of existing Host/session and display state. No IO. */
export class WorkbenchSidebar implements UIComponent<WorkbenchSidebarProps> {
  readonly id = 'workbench-sidebar';
  revision = 0;
  tab: WorkbenchTab = 'sessions';
  private readonly scrollTop = new Map<WorkbenchTab, number>();
  private targets: SidebarTarget[] = [];
  private viewportRows = 1;
  private documentRows = 0;

  constructor(public props: WorkbenchSidebarProps) {}

  measure(): number { return 1; }
  pointerTargets(): readonly SidebarTarget[] { return this.targets; }
  selectTab(tab: WorkbenchTab): void { this.tab = tab; }
  scroll(delta: number): void {
    const current = this.scrollTop.get(this.tab) ?? 0;
    this.scrollTop.set(this.tab, Math.max(0, Math.min(Math.max(0, this.documentRows - this.viewportRows), current + delta)));
  }

  paint(scene: SceneCanvas, viewport: Viewport): void {
    this.targets = [];
    const { styles } = this.props;
    const width = Math.max(0, viewport.width - 2);
    for (let row = 0; row < viewport.height; row++) {
      scene.writeTagged(viewport.row + row, viewport.column, styles.muted('│'));
    }
    if (viewport.height < 4 || width < 16) return;
    let column = 2;
    const tabs: readonly [WorkbenchTab, string][] = [['sessions', 'Sess'], ['context', 'CTX'], ['view', 'View']];
    for (const [tab, label] of tabs) {
      const text = this.tab === tab ? styles.accent(label) : styles.muted(label);
      scene.writeTagged(viewport.row, viewport.column + column, text);
      this.targets.push({ id: `tab:${tab}`, row: 0, column, width: visibleWidth(label), action: { tab } });
      column += visibleWidth(label) + 1;
    }
    const lines: Array<{ text: string; command?: string }> = [];
    const text = (value: string): void => { lines.push({ text: styles.muted(escapeTags(truncateToWidth(value.replace(/[\r\n\t]/gu, ' '), width))) }); };
    const action = (label: string, command: string, selected = false): void => {
      const clipped = escapeTags(truncateToWidth(`${selected ? '●' : '›'} ${label.replace(/[\r\n\t]/gu, ' ')}`, width));
      lines.push({ text: selected ? styles.accent(clipped) : clipped, command });
    };
    if (this.tab === 'sessions') {
      text(this.props.sessionTitle);
      action('New session', '/new');
      action('All sessions', '/sessions');
      text('');
      for (const session of this.props.sessions) {
        action(session.label, `/resume ${session.id}`, session.id === this.props.sessionId);
      }
      text('');
      action('Rename session', '/rename');
      action('Fork session', '/fork');
      text('');
      action('Skills', '/skills');
      action('Plugins', '/plugin');
      action('MCP', '/mcp');
    } else if (this.tab === 'context') {
      text(this.props.model);
      text(this.props.provider);
      text(`Effort: ${this.props.effort}`);
      text('');
      const number = (value: number | null): string => value === null ? 'unknown' : value.toLocaleString('en-US');
      text(`Context: ${number(this.props.contextTokens)}`);
      text(`Window: ${number(this.props.contextBudget)}`);
      text('Context is estimated');
      text(`Last input: ${number(this.props.inputTokens)}`);
      text(`Last output: ${number(this.props.outputTokens)}`);
      text(`Billed total: ${number(this.props.sessionTokens)}`);
      text(`tok/s: ${this.props.tokensPerSecond === null ? 'unknown' : this.props.tokensPerSecond.toFixed(1)}`);
      text('');
      action('Context details', '/context');
      action('Usage details', '/usage');
    } else {
      for (const profile of DISPLAY_PROFILES) {
        action(profile.label, `/display ${profile.id}`, profile.id === this.props.profile);
      }
      if (this.props.profile === 'custom') text('Current: Custom');
      text('');
      text(`Recorded calls: ${this.props.tools.total}`);
      text(`Running: ${this.props.tools.running}`);
      text(`Errors: ${this.props.tools.errors}`);
      action('Display settings', '/display');
    }
    this.viewportRows = Math.max(0, viewport.height - 3);
    this.documentRows = lines.length;
    const first = Math.min(this.scrollTop.get(this.tab) ?? 0, Math.max(0, lines.length - this.viewportRows));
    this.scrollTop.set(this.tab, first);
    lines.slice(first, first + this.viewportRows).forEach((line, index) => {
      const row = index + 2;
      scene.writeTagged(viewport.row + row, viewport.column + 2, line.text);
      if (line.command) this.targets.push({ id: line.command, row, column: 2, width, action: { command: line.command } });
    });
    if (viewport.height > 1) {
      const footer = truncateToWidth(this.props.cwd.replace(/[\r\n\t]/gu, ' '), width);
      scene.writeTagged(viewport.row + viewport.height - 1, viewport.column + 2, styles.muted(escapeTags(footer)));
    }
  }
}
