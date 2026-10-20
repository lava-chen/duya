/**
 * The live-activity state machine, extracted from `TUIApp`.
 *
 * ## What this owns
 *
 * Which of the run's facts are worth showing on ONE line: the spinner label in
 * inline mode and the status row in full-screen mode. That is a state machine
 * over the frame stream — tool started, tool finished, subagent started, status
 * text pushed by the Host — and it has no opinion about pixels.
 *
 * ## Why it left TUIApp
 *
 * It used to be five fields and a 120-line `switch` sitting in the middle of the
 * class, indistinguishable from the painting code around it. Every `case` is a
 * fact about the RUN, not about the frame, and the only thing the TUI adds is
 * `label()`. Keeping it inside the painter is what made "why does the footer say
 * Working" a question you answered by reading layout code.
 *
 * ## The `apply` return value
 *
 * `true` means "something the CHROME shows changed, repaint". It is deliberately
 * narrower than "the frame was handled": `tool_progress` that reports the same
 * whole second returns false, so a tool that ticks ten times a second does not
 * cost ten repaints. `turn_start` also returns a repaint signal for the effort
 * level, which lives on the composer border — that is chrome too, and it is the
 * one case where this module reports a change it does not display itself.
 */

import { frameRecord, frameString, type LegacyFrame } from '../blocks.js';
import { compactActivity } from '../text.js';
import { resolveStatusLabel } from '../status-label.js';

export type ActivityPhase =
  | 'ready'
  | 'working'
  | 'thinking'
  | 'responding'
  | 'compacting'
  | 'complete'
  | 'failed';

interface ActiveTool {
  readonly name: string;
  readonly elapsedSeconds: number | null;
}

export class ActivityTracker {
  /** The coarse phase the run is in; decides the label when nothing more specific exists. */
  phase: ActivityPhase = 'ready';
  private message = '';
  private group = '';
  private waiting = false;
  readonly tools = new Map<string, ActiveTool>();
  readonly agents = new Map<string, string>();

  /** True while a permission or question modal owns the input. */
  get waitingForPermission(): boolean {
    return this.waiting;
  }

  set waitingForPermission(value: boolean) {
    this.waiting = value;
  }

  /** Drop everything that describes a run in flight. */
  clear(): void {
    this.tools.clear();
    this.agents.clear();
    this.group = '';
    this.message = '';
  }

  /** Set the phase without touching the tool/agent tables. */
  setPhase(phase: ActivityPhase): void {
    this.phase = phase;
  }

  /** Note a Host-pushed status message, e.g. from a `status` frame. */
  setMessage(message: string): void {
    this.message = message;
  }

  /**
   * Show the most useful live fact, in priority order.
   *
   * Tool above agent above group above free text above phase: each is more
   * specific than the one below it, and a tool's name answers "what is happening"
   * better than "Working" does.
   */
  label(busy: boolean): string {
    if (this.waiting) return 'Waiting for approval';

    const tools = [...this.tools.values()];
    const tool = tools[tools.length - 1];
    const agents = [...this.agents.values()];
    const agent = agents[agents.length - 1];
    if (tool !== undefined) {
      const elapsed = tool.elapsedSeconds === null || tool.elapsedSeconds < 1
        ? ''
        : ` (${Math.floor(tool.elapsedSeconds)}s)`;
      const agentLabel = agent === undefined ? '' : ` / ${agent}`;
      return compactActivity(`${tool.name}${elapsed}${agentLabel}`);
    }
    if (agent !== undefined) {
      const count = agents.length > 1 ? `+${agents.length - 1} ` : '';
      return compactActivity(`${count}${agent} working`);
    }
    if (this.group !== '') return compactActivity(this.group);
    if (this.message !== '') return compactActivity(this.message);

    switch (this.phase) {
      case 'thinking': return 'Thinking';
      case 'responding': return 'Writing response';
      case 'compacting': return 'Compacting context';
      case 'complete': return 'Completed';
      case 'failed': return 'Failed';
      case 'working': return 'Working';
      case 'ready': return busy ? 'Working' : 'Ready';
    }
  }

  /**
   * Fold one frame in.
   *
   * `busy` is passed because two transitions (`tool_result`, `compact:done`)
   * return to `working` or `ready` depending on whether a turn is still in
   * flight, and the tracker does not know that — the TUI does.
   *
   * Returns whether the CHROME changed. `effort` is reported through this same
   * boolean by the caller's own field: the only consumer of `turn_start` here is
   * the composer border, so pretending this module tracks it would be a lie.
   */
  apply(frame: LegacyFrame, busy: boolean): boolean {
    const data = frameRecord(frame.data);
    switch (frame.type) {
      case 'text_delta':
        if (this.phase === 'responding' && this.message === '' && this.group === '') return false;
        this.phase = 'responding';
        this.message = '';
        this.group = '';
        return true;
      case 'thinking_delta':
        if (this.phase === 'thinking' && this.message === '' && this.group === '') return false;
        this.phase = 'thinking';
        this.message = '';
        this.group = '';
        return true;
      case 'tool_use_started':
      case 'tool_use': {
        const id = frameString(data, 'id');
        const name = frameString(data, 'name');
        if (id === '' || name === '') return false;
        // Re-inserting moves the tool to the end: the map's order IS recency,
        // which is how the label picks "the tool that started last".
        this.tools.delete(id);
        this.tools.set(id, { name, elapsedSeconds: null });
        this.phase = 'working';
        this.message = '';
        return true;
      }
      case 'tool_progress': {
        // The legacy projector carries the tool call id in `toolName`.
        const id = frameString(data, 'toolName');
        const elapsed = data['elapsedSeconds'];
        const tool = this.tools.get(id);
        if (tool === undefined || typeof elapsed !== 'number' || !Number.isFinite(elapsed)) return false;
        // Whole-second granularity: the label prints `Math.floor`, so a change
        // below it cannot change a pixel and must not buy a repaint.
        if (tool.elapsedSeconds !== null && Math.floor(tool.elapsedSeconds) === Math.floor(elapsed)) return false;
        this.tools.set(id, { ...tool, elapsedSeconds: elapsed });
        return true;
      }
      case 'tool_result': {
        const id = frameString(data, 'id');
        const removed = this.tools.delete(id);
        if (removed) {
          this.phase = busy ? 'working' : 'ready';
          this.message = '';
          if (this.tools.size === 0) this.group = '';
        }
        return removed;
      }
      case 'tool_group_progress': {
        const title = frameString(data, 'title');
        if (title === '' || title === this.group) return false;
        this.group = title;
        return true;
      }
      case 'agent_progress': {
        const eventType = frameString(data, 'agentEventType');
        const id = frameString(data, 'subagentId');
        if (eventType === 'subagent_started' && id !== '') {
          const name = frameString(data, 'agentName') || frameString(data, 'agentType') || 'Agent';
          this.agents.delete(id);
          this.agents.set(id, name);
          this.phase = 'working';
          return true;
        }
        if (eventType === 'subagent_completed' && id !== '') return this.agents.delete(id);
        return false;
      }
      case 'status': {
        // Chrome, not content: `resolveStatusLabel` also resolves the desktop's
        // `@i18n:` keys, so an unresolvable key drops out of the row instead of
        // printing its own name at the user.
        const label = resolveStatusLabel(frameString(data, 'message'));
        if (label === null || label === this.message) return false;
        this.message = label;
        this.phase = 'working';
        return true;
      }
      case 'compact:start':
        this.phase = 'compacting';
        this.message = '';
        this.group = '';
        return true;
      case 'compact:done':
        this.phase = busy ? 'working' : 'ready';
        this.group = '';
        return true;
      case 'compact:error':
        this.phase = 'working';
        this.message = 'Compaction failed';
        this.group = '';
        return true;
      case 'permission':
        this.waiting = true;
        return true;
      case 'done':
        this.phase = 'complete';
        this.clear();
        return true;
      case 'error':
        this.phase = 'failed';
        this.clear();
        return true;
      default:
        return false;
    }
  }
}
