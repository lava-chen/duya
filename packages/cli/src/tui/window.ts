/**
 * The window manager: F1 help, Ctrl+R history, Ctrl+P usage, and the
 * selectable lists slash commands raise.
 *
 * ## Why a manager and not three ad-hoc overlays
 *
 * Every window needs the same choreography — a viewport, a selection, a
 * filter, Esc to leave — and the TUI already learned that choreography once
 * for the permission overlay. Making each new window re-implement it is how
 * the third window ships with a subtly different Esc behaviour from the first.
 * One manager, one behaviour.
 *
 * ## Two presentations, one state machine
 *
 * `render(maxRows)` is the centred modal the permission overlay shares;
 * `renderDocked(maxRows)` is the bottom-docked panel that occupies the
 * composer's slot, which is how slash secondary pages are shown (`/model`,
 * `/settings`, `/resume`, F1/Ctrl+R/Ctrl+P). The difference is height budget
 * and framing, not behaviour: which row is selected, how filtering ranks, and
 * what Enter does are the same answers in both, because they are answered here
 * once. The docked form exists because a centred box covers the conversation
 * the user is reading and jumps the whole app into the alternate screen; pi
 * puts these lists where the input box is, and that is the shape this follows.
 *
 * ## Rendering contract
 *
 * `render` is a pure function of the current spec + navigation state; it paints
 * through the SAME blessed box the permission overlay uses, because the two are
 * mutually exclusive by construction: a permission ask closes any open window.
 * The manager owns navigation state (`selected`, `scrollTop`, `filter`); the
 * caller owns where the box goes and what frame it gets.
 *
 * ## Keys
 *
 * `handleKey` answers TERMINAL key names (blessed's `key.name`). Printable
 * characters arrive through `feedCharacter`, which only consumes them when the
 * window is filterable — a static window must not swallow typing.
 */

import { fuzzyFilter } from '@duya/input-completion';

import { escapeTags } from './transcript-view.js';
import { truncateToWidth, visibleWidth } from './width.js';

/** One selectable row. */
export interface WindowItem {
  readonly label: string;
  /**
   * Dim text after the label — a model's context window and flags, a session's
   * age, a fork's message snippet.
   *
   * Room is made for it by clipping the LABEL first: the label is what the user
   * is choosing between, and a long label that pushes its own qualifier off the
   * row would hide the reason two rows differ.
   */
  readonly description?: string;
  /**
   * The row's current value, rendered as a right-hand column.
   *
   * Settings rows have one (`Dark`, `8 rows`); a model picker does not, because
   * there the label IS the value. A right column is what makes the list
   * readable as settings: pi aligns its values the same way, and a value that
   * floats after the label instead of lining up turns the column into noise.
   */
  readonly valueLabel?: string;
  /**
   * Long-form explanation for the SELECTED row, shown under the list.
   *
   * Separate from `description` because that one is a per-row qualifier that
   * rides the row itself; this is the "what does this switch actually do" text,
   * and only one row's is ever on screen.
   */
  readonly detail?: string;
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
  /**
   * Space/Enter on a row, invoked WITHOUT closing the window.
   *
   * The settings list uses this to cycle a value in place; `onSubmit` remains
   * the "choose and leave" path a picker wants. Exactly one of the two fires,
   * so a list can be either a picker or a control panel without growing a mode.
   */
  readonly onActivate?: (value: string) => void;
}

/** Rows the list viewport shows before it starts scrolling. */
const VIEWPORT_ROWS = 12;

export class WindowManager {
  private spec: WindowSpec | null = null;
  private selected = 0;
  private scrollTop = 0;
  private scrollViewportRows = 1;
  private filter = '';
  /**
   * List rows the viewport shows for THIS paint.
   *
   * The centred modal could afford a fixed 12; a docked panel cannot, because
   * it shares the composer's slot and its height comes from the terminal. Set
   * per render (`render` resets it to the modal default) rather than stored, so
   * a window opened in one mode and repainted in the other cannot inherit the
   * other mode's viewport.
   */
  private viewportRows = VIEWPORT_ROWS;

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

  /**
   * Replace the rows without reopening the window.
   *
   * A settings list whose Enter cycles a value has to redraw the row it just
   * changed; going through `open` would reset the selection to the top and
   * drop the filter the user typed, which reads as the list jumping away.
   */
  updateItems(items: readonly WindowItem[]): void {
    if (this.spec === null) return;
    this.spec = { ...this.spec, items };
    const rows = this.visibleItems();
    this.selected = Math.max(0, Math.min(this.selected, Math.max(0, rows.length - 1)));
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
    //
    // The DESCRIPTION is part of the searchable text, not decoration: a model
    // row's qualifier names its provider, so typing a provider name has to
    // narrow the list to that provider's models.
    return fuzzyFilter(spec.items, this.filter, (item) => (
      item.description === undefined ? item.label : `${item.label} ${item.description}`
    ));
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
        if (spec.onActivate !== undefined) {
          // Stay open. Selection is kept by index, because the row the user
          // just changed is the row they are looking at.
          const index = this.selected;
          spec.onActivate(item.value);
          if (this.spec !== null) this.selected = Math.min(index, this.visibleItems().length - 1);
          return true;
        }
        this.spec = null;
        if (spec.onSubmit !== undefined) spec.onSubmit(item.value);
        return true;
      }

      case 'space': {
        // Only a control panel (one with `onActivate`) eats the space bar. A
        // filterable picker must keep it: `deep seek` is a legitimate query,
        // and swallowing it there would make half the model list unsearchable.
        if (spec.onActivate === undefined) return false;
        const rows = this.visibleItems();
        const item = rows[this.selected];
        if (item === undefined) return true;
        const index = this.selected;
        spec.onActivate(item.value);
        if (this.spec !== null) this.selected = Math.min(index, this.visibleItems().length - 1);
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
        const delta = name === 'pageup' ? -this.viewportRows : this.viewportRows;
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
    this.viewportRows = VIEWPORT_ROWS;
    return this.compose(maxRows, 0);
  }

  /**
   * The window body for a bottom-docked panel: tagged rows, no framing.
   *
   * The docked panel occupies the composer's slot, so its height is whatever
   * the terminal has left rather than a fixed modal height — hence the
   * viewport being derived from `maxRows` here and restored by `render`.
   * Framing (the rules above and below) belongs to the caller: only it knows
   * the terminal width and whether the surface draws its own border.
   *
   * `width` clips rows to the slot. It is not cosmetic: the dock is the bottom
   * of a live area whose height is already committed, and a row that wraps
   * pushes the footer off-screen.
   */
  renderDocked(maxRows: number, width = 0): readonly string[] | null {
    const budget = Math.max(1, Math.floor(maxRows));
    // Title, filter line, blank, blank, footer: five rows are structure, the
    // rest is list. On a short terminal the viewport collapses to one row
    // rather than the panel refusing to paint. A list whose rows carry a
    // `detail` spends two more on the selected row's explanation.
    const detailRows = this.specHasDetail() ? 2 : 0;
    this.viewportRows = Math.max(1, Math.min(VIEWPORT_ROWS, budget - 4 - detailRows));
    // Two rows of headroom so the hint below survives the trim: it is the one
    // line that says how to leave the panel.
    const body = this.compose(budget + 2, width);
    this.viewportRows = VIEWPORT_ROWS;
    if (body === null) return null;
    const lines = body.split('\n');
    if (lines.length <= budget) return lines;
    const hint = lines[lines.length - 1] ?? '';
    return [...lines.slice(0, Math.max(0, budget - 2)), '…', hint];
  }

  /** Whether any row carries a `detail`, which costs two rows under the list. */
  private specHasDetail(): boolean {
    return this.spec?.items?.some((item) => item.detail !== undefined && item.detail !== '') === true;
  }

  private compose(maxRows: number, width: number): string | null {
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
        const viewport = this.viewportRows;
        // Scroll the viewport only when the selection leaves it.
        if (this.selected < this.scrollTop) this.scrollTop = this.selected;
        else if (this.selected >= this.scrollTop + viewport) {
          this.scrollTop = this.selected - viewport + 1;
        }

        const first = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - viewport)));
        const last = Math.min(rows.length, first + viewport);
        if (first > 0) lines.push('{gray-fg}  …{/gray-fg}');
        for (let i = first; i < last; i += 1) {
          const item = rows[i] as WindowItem;
          const row = renderItem(item, i === this.selected, width);
          lines.push(row);
        }
        if (last < rows.length) lines.push('{gray-fg}  …{/gray-fg}');

        // The selected row's explanation. Under the list, not on it: the same
        // reason pi puts it there — a second column of prose would push the
        // values off the row, and only one row needs it at a time.
        const focused = rows[this.selected];
        if (focused !== undefined && focused.detail !== undefined && focused.detail !== '') {
          const room = width > 0 ? width - 2 : 0;
          const text = room > 0 ? truncateToWidth(focused.detail, room) : focused.detail;
          lines.push('', `{gray-fg}  ${escapeTags(text)}{/gray-fg}`);
        }
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

/**
 * One list row: marker, label, then the dim qualifier.
 *
 * The selected row is cyan end to end, including its marker. Unselected rows
 * leave the label in the terminal's own foreground and dim only the qualifier,
 * so the two columns stay readable as columns rather than as one long string.
 *
 * `width` is the panel's usable columns (the composer slot's inner width), or 0
 * for the centred modal, which clips in blessed and must not be clipped twice.
 */
function renderItem(item: WindowItem, selected: boolean, width: number): string {
  const marker = selected ? '❯ ' : '  ';
  const available = width > 0 ? Math.max(0, width - 2) : 0;
  const description = item.description ?? '';
  const valueLabel = item.valueLabel ?? '';

  // The value column is reserved FIRST: it is the thing a settings row exists
  // to show, and a long label that ate it would leave a row with no answer on
  // it. The label is what the user is choosing between, so it clips second.
  const valueWidth = visibleWidth(valueLabel);
  const reserved = valueLabel === '' ? 0 : Math.min(24, valueWidth) + 2;
  const labelRoom = available > 0 ? Math.max(8, available - reserved) : 0;
  const label = labelRoom > 0 ? truncateToWidth(item.label, labelRoom) : item.label;
  const labelWidth = visibleWidth(label);

  const room = available > 0 ? available - labelWidth - reserved - 2 : description.length;
  const desc = description !== '' && room >= 8 ? truncateToWidth(description, room) : '';

  const labelText = escapeTags(label);
  const head = selected ? `{cyan-fg}${marker}${labelText}{/cyan-fg}` : `${marker}${labelText}`;
  const descText = desc === '' ? '' : `  {gray-fg}${escapeTags(desc)}{/gray-fg}`;

  if (valueLabel === '') return head + descText;

  // Right-align the value: pad to the last column available, not to a fixed
  // offset, so a narrow dock still shows it instead of pushing it off-screen.
  const gap = Math.max(2, available - labelWidth - visibleWidth(desc === '' ? '' : `  ${desc}`) - valueWidth);
  const valueText = selected
    ? `{cyan-fg}${escapeTags(valueLabel)}{/cyan-fg}`
    : `{gray-fg}${escapeTags(valueLabel)}{/gray-fg}`;
  return head + descText + ' '.repeat(gap) + valueText;
}
