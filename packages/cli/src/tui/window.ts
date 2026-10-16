/**
 * The modal window manager: F1 help, Ctrl+R history, Ctrl+P usage.
 *
 * ## Why a manager and not three ad-hoc overlays
 *
 * Every window needs the same choreography — a centered box, a viewport, a
 * selection, Esc to leave — and the TUI already learned that choreography
 * once for the permission overlay. Making each new window re-implement it is
 * how the third window ships with a subtly different Esc behaviour from the
 * first. One manager, one behaviour.
 *
 * ## Rendering contract
 *
 * `render(maxRows)` is a pure function of the current spec + navigation state;
 * it paints through the SAME blessed box the permission overlay uses, because
 * the two are mutually exclusive by construction: `TUIApp.showPermission`
 * closes any open window, and a window cannot be opened while an overlay or
 * prompt is active. The manager owns navigation state (`selected`, `scrollTop`,
 * `filter`); the caller owns only where the box goes.
 *
 * ## Keys
 *
 * `handleKey` answers TERMINAL key names (blessed's `key.name`). Printable
 * characters arrive through `feedCharacter`, which only consumes them when the
 * window is filterable — a static window must not swallow typing.
 */

import { fuzzyFilter } from '@duya/input-completion';

import { escapeTags } from './transcript-view.js';

/** One selectable row. */
export interface WindowItem {
  readonly label: string;
  readonly value: string;
}

export interface WindowSpec {
  /** Title line, always visible. */
  readonly title: string;
  /** Static body lines (tagged), used alone when `items` is absent. */
  readonly lines?: readonly string[];
  /** Allow a static body to scroll when it is taller than the window. */
  readonly scrollable?: boolean;
  /** Selectable rows; enables selection + Enter semantics. */
  readonly items?: readonly WindowItem[];
  /** Type-to-filter over `items`. */
  readonly filterable?: boolean;
  /** Optional query already entered by the command that opened the window. */
  readonly initialFilter?: string;
  /** Hint line at the bottom, e.g. `Enter recall · Esc close`. */
  readonly footer?: string;
  /** Enter with a selected row. The window is closed before the callback. */
  readonly onSubmit?: (value: string) => void;
  /** Escape or an explicit close. */
  readonly onCancel?: () => void;
}

/** Rows the list viewport shows before it starts scrolling. */
const VIEWPORT_ROWS = 12;

export class WindowManager {
  private spec: WindowSpec | null = null;
  private selected = 0;
  private scrollTop = 0;
  private scrollViewportRows = 1;
  private filter = '';

  /** Open (or replace) the window. Navigation state resets. */
  open(spec: WindowSpec): void {
    this.spec = spec;
    this.selected = 0;
    this.scrollTop = 0;
    this.filter = spec.initialFilter ?? '';
  }

  /** Close whatever is open. Closing a closed window is fine. */
  close(): void {
    const spec = this.spec;
    this.spec = null;
    spec?.onCancel?.();
  }

  get isActive(): boolean {
    return this.spec !== null;
  }

  /** The current filter text, so tests can assert the typing path. */
  get filterText(): string {
    return this.filter;
  }

  /** Items after the filter, best match first. */
  private visibleItems(): readonly WindowItem[] {
    const spec = this.spec;
    if (spec === null || spec.items === undefined) return [];
    if (this.filter === '') return spec.items;
    // Fuzzy, not substring: `nwp` should find `newest prompt`, and a query
    // typed in the wrong order should still rank the real match first. The
    // matcher is the same one `@`-file completion uses, so the ranking the
    // user learned in the popup is the ranking they get here.
    return fuzzyFilter(spec.items, this.filter, (item) => item.label);
  }

  /**
   * Feed a terminal key name. Returns true when the window consumed it.
   *
   * An Enter on an empty filtered list closes the window — there is nothing
   * to submit, and acknowledging with Enter reads as "done here" — but
   * submits nothing and still reports consumed, so the key cannot fall
   * through into the editor underneath the modal.
   */
  handleKey(name: string): boolean {
    const spec = this.spec;
    if (spec === null) return false;

    switch (name) {
      case 'escape':
        this.close();
        return true;

      case 'return':
      case 'enter': {
        const rows = this.visibleItems();
        const item = rows[this.selected];
        if (item === undefined) {
          this.close();
          return true;
        }
        this.spec = null;
        if (spec.onSubmit !== undefined) spec.onSubmit(item.value);
        return true;
      }

      case 'up':
      case 'down': {
        if (spec.items === undefined && spec.scrollable === true) {
          const maxScroll = Math.max(0, (spec.lines?.length ?? 0) - this.scrollViewportRows);
          const delta = name === 'up' ? -1 : 1;
          this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + delta));
          return true;
        }
        const rows = this.visibleItems();
        if (rows.length === 0) return true;
        const delta = name === 'up' ? -1 : 1;
        this.selected = (this.selected + delta + rows.length) % rows.length;
        return true;
      }

      case 'pageup':
      case 'pagedown': {
        if (spec.items === undefined && spec.scrollable === true) {
          const maxScroll = Math.max(0, (spec.lines?.length ?? 0) - this.scrollViewportRows);
          const delta = Math.max(1, this.scrollViewportRows - 1)
            * (name === 'pageup' ? -1 : 1);
          this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop + delta));
          return true;
        }
        const rows = this.visibleItems();
        if (rows.length === 0) return true;
        const delta = name === 'pageup' ? -VIEWPORT_ROWS : VIEWPORT_ROWS;
        this.selected = Math.max(0, Math.min(rows.length - 1, this.selected + delta));
        return true;
      }

      case 'backspace':
        this.filter = Array.from(this.filter).slice(0, -1).join('');
        this.selected = 0;
        this.scrollTop = 0;
        return true;

      default:
        return false;
    }
  }

  /** Feed a printable character to the filter. Consumed only when filterable. */
  feedCharacter(ch: string): boolean {
    if (this.spec?.filterable !== true) return false;
    const clean = ch.replace(/[\r\n\0]/gu, '');
    if (clean === '') return true;
    this.filter += clean;
    this.selected = 0;
    this.scrollTop = 0;
    return true;
  }

  /**
   * The window body as tagged lines, or `null` when closed.
   *
   * `maxRows` bounds the output; the viewport scrolls to keep the selection
   * inside it. The title, filter line, and footer count against the bound, so
   * the caller's height arithmetic never overflows the terminal.
   */
  render(maxRows: number): string | null {
    const spec = this.spec;
    if (spec === null) return null;

    const lines: string[] = [`{bold}{cyan-fg}${escapeTags(spec.title)}{/cyan-fg}{/bold}`];

    if (spec.items !== undefined) {
      if (spec.filterable === true) {
        lines.push(`{gray-fg}filter: ${escapeTags(this.filter)}{/gray-fg}`);
      }
      lines.push('');

      const rows = this.visibleItems();
      if (rows.length === 0) {
        lines.push('{gray-fg}no matches{/gray-fg}');
      } else {
        this.selected = Math.max(0, Math.min(this.selected, rows.length - 1));
        // Scroll the viewport only when the selection leaves it.
        if (this.selected < this.scrollTop) this.scrollTop = this.selected;
        else if (this.selected >= this.scrollTop + VIEWPORT_ROWS) {
          this.scrollTop = this.selected - VIEWPORT_ROWS + 1;
        }

        const first = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - VIEWPORT_ROWS)));
        const last = Math.min(rows.length, first + VIEWPORT_ROWS);
        if (first > 0) lines.push('{gray-fg}  …{/gray-fg}');
        for (let i = first; i < last; i += 1) {
          const item = rows[i] as WindowItem;
          const text = escapeTags(item.label);
          lines.push(i === this.selected
            ? `{cyan-fg}❯ ${text}{/cyan-fg}`
            : `  ${text}`);
        }
        if (last < rows.length) lines.push('{gray-fg}  …{/gray-fg}');
      }
    } else if (spec.lines !== undefined) {
      if (spec.scrollable === true) {
        const footerRows = spec.footer === undefined || spec.footer === '' ? 0 : 2;
        this.scrollViewportRows = maxRows > 0
          ? Math.max(1, maxRows - lines.length - footerRows)
          : Math.max(1, spec.lines.length);
        const maxScroll = Math.max(0, spec.lines.length - this.scrollViewportRows);
        this.scrollTop = Math.max(0, Math.min(maxScroll, this.scrollTop));
        lines.push(...spec.lines.slice(this.scrollTop, this.scrollTop + this.scrollViewportRows));
        if (spec.footer !== undefined && spec.footer !== '') {
          const first = spec.lines.length === 0 ? 0 : this.scrollTop + 1;
          const last = Math.min(spec.lines.length, this.scrollTop + this.scrollViewportRows);
          const position = maxScroll > 0 ? ` · ${first}-${last}/${spec.lines.length}` : '';
          lines.push('', `{gray-fg}${escapeTags(spec.footer + position)}{/gray-fg}`);
        }
        return lines.join('\n');
      }
      lines.push(...spec.lines);
    }

    if (spec.footer !== undefined && spec.footer !== '') {
      lines.push('', `{gray-fg}${escapeTags(spec.footer)}{/gray-fg}`);
    }

    // The bound is a hard cap: a static window taller than the terminal would
    // push its footer off-screen, and with it the "how do I leave" hint.
    const capped = maxRows > 0 && lines.length > maxRows ? lines.slice(0, maxRows) : lines;
    if (capped.length < lines.length) capped[capped.length - 1] = '…';
    return capped.join('\n');
  }
}
