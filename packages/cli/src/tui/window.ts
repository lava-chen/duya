/**
 * The window manager: F1 help, Ctrl+R history, Ctrl+P usage, the selectable
 * lists slash commands raise, and the tabbed rich panel behind them.
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
 * The manager owns the layout; the row navigation lives in `ListState`, which
 * a plain window owns through `open()` and a `RichPanelController` owns one per
 * tab (630a) so switching tabs keeps each tab's filter and cursor. The caller
 * owns where the box goes and what frame it gets.
 *
 * ## Keys
 *
 * `handleKey` answers TERMINAL key names (blessed's `key.name`), plus the
 * shift modifier for the one chord the panel needs (`S-tab`). Printable
 * characters arrive through `feedCharacter`, which only consumes them when the
 * list is filterable — a static section must not swallow typing.
 */

import { fuzzyFilter } from '@duya/input-completion';

import { escapeTags } from './transcript-view.js';
import { truncateToWidth, visibleWidth } from './width.js';

/** One selectable row. */
export interface WindowItem {
  label: string;
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

/** Key modifiers that ride a terminal key name. */
export interface KeyMods {
  readonly shift?: boolean;
}

/** Rows the list viewport shows before it starts scrolling. */
const VIEWPORT_ROWS = 12;

/** The per-section parts of a `WindowSpec` a list tab provides instead. */
export interface ListSection {
  readonly items?: readonly WindowItem[];
  readonly filterable?: boolean;
  readonly initialFilter?: string;
  readonly initialSelected?: number;
  readonly onSubmit?: (value: string) => void;
  readonly onActivate?: (value: string) => void;
}

/**
 * The navigation state of one list: rows, filter, selection, scroll, and the
 * callbacks that say what Enter and Space do.
 *
 * Extracted from `WindowManager` because the tabbed panel needs this whole
 * machine once PER TAB and holding it in the window would make "switch tabs"
 * mean "lose the filter and the cursor". A plain window creates one per
 * `open()`; a panel creates one per tab and swaps the active one in.
 */
export class ListState {
  items: readonly WindowItem[] = [];
  filterable = false;
  onSubmit?: (value: string) => void;
  onActivate?: (value: string) => void;
  private selected = 0;
  private scrollTop = 0;
  private filter = '';
  private viewportRows = VIEWPORT_ROWS;

  /** Replace the section's content; selection/scroll/filter start fresh. */
  openSection(section: ListSection): void {
    this.items = section.items ?? [];
    this.filterable = section.filterable === true;
    this.onSubmit = section.onSubmit;
    this.onActivate = section.onActivate;
    this.selected = clampIndex(section.initialSelected ?? 0, this.items.length);
    this.scrollTop = 0;
    this.filter = section.initialFilter ?? '';
  }

  /**
   * Replace the rows while KEEPING the navigation state.
   *
   * A control panel whose Enter cycles a value has to redraw the row it just
   * changed; going through `openSection` would reset the selection to the top
   * and drop the filter the user typed, which reads as the list jumping away.
   */
  updateItems(items: readonly WindowItem[]): void {
    this.items = items;
    this.selected = clampIndex(this.selected, items.length);
  }

  /** The row the cursor sits on after the filter, or undefined. */
  selectedRow(): WindowItem | undefined {
    return this.visibleItems()[this.selected];
  }

  /**
   * Replace rows and callbacks while KEEPING the query and the cursor's row.
   *
   * A panel whose actions mutate state (install a plugin, add a provider)
   * re-reads its source and pushes the result here. Going through
   * `openSection` would reset the selection to the top and drop the filter the
   * user typed, which reads as the list jumping away under the cursor — and
   * re-typing a query to find the next row is what makes a list of 60 models
   * unusable as a settings page.
   */
  refresh(section: ListSection): void {
    const keepValue = this.selectedRow()?.value;
    const keepFilter = this.filter;
    this.openSection({ ...section, initialFilter: keepFilter });
    if (keepValue !== undefined) this.reveal(keepValue);
  }

  /**
   * Move the cursor to the row carrying `value`.
   *
   * A panel returning from a detail page knows the row it came from by value,
   * not by index — the viewport is short and the row may be scrolled off. The
   * SEARCH runs over the filtered rows, because that is the list the cursor
   * indexes: a value the query hides leaves the cursor where it is rather than
   * pointing at a row that is not on screen.
   */
  reveal(value: string): void {
    const rows = this.visibleItems();
    const index = rows.findIndex((item) => item.value === value);
    if (index < 0) {
      this.selected = clampIndex(this.selected, rows.length);
      return;
    }
    this.selected = index;
    this.scrollTop = Math.max(0, index - this.viewportRows + 1);
  }

  /**
   * Drop the typed query, keeping the cursor on the row it was on.
   *
   * The first stage of the panel's staged exit. Resetting to row 0 would make
   * "oops, that search was wrong" also lose the user's place in the full list.
   */
  clearFilter(): void {
    if (this.filter === '') return;
    const keepValue = this.selectedRow()?.value;
    this.filter = '';
    if (keepValue !== undefined) this.reveal(keepValue);
    else this.selected = clampIndex(this.selected, this.visibleItems().length);
    this.scrollTop = 0;
  }

  /** Feed a terminal key name. Returns true when the list consumed it. */
  handleKey(name: string, _mods?: KeyMods): boolean {
    switch (name) {
      case 'return':
      case 'enter': {
        const item = this.visibleItems()[this.selected];
        if (item === undefined) return false;
        if (this.onActivate !== undefined) {
          // Stay open. Selection is kept by index, because the row the user
          // just changed is the row they are looking at.
          const index = this.selected;
          this.onActivate(item.value);
          this.selected = Math.min(index, Math.max(0, this.visibleItems().length - 1));
          return true;
        }
        this.onSubmit?.(item.value);
        return true;
      }

      case 'space': {
        // Only a control panel (one with `onActivate`) eats the space bar. A
        // filterable picker must keep it: `deep seek` is a legitimate query,
        // and swallowing it there would make half the model list unsearchable.
        if (this.onActivate === undefined) return false;
        return this.handleKey('return', _mods);
      }

      case 'up':
      case 'down': {
        const rows = this.visibleItems();
        if (rows.length === 0) return true;
        const delta = name === 'up' ? -1 : 1;
        this.selected = (this.selected + delta + rows.length) % rows.length;
        return true;
      }

      case 'pageup':
      case 'pagedown': {
        const rows = this.visibleItems();
        if (rows.length === 0) return true;
        const delta = (name === 'pageup' ? -1 : 1) * Math.max(1, this.viewportRows - 1);
        this.selected = clampIndex(this.selected + delta, rows.length);
        return true;
      }

      case 'backspace':
        if (!this.filterable) return false;
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
    if (!this.filterable) return false;
    const clean = ch.replace(/[\r\n\0]/gu, '');
    if (clean === '') return true;
    this.filter += clean;
    this.selected = 0;
    this.scrollTop = 0;
    return true;
  }

  /** The current filter text. */
  get filterText(): string {
    return this.filter;
  }

  /**
   * The filter line plus the list rows as tagged lines (no title, no footer).
   *
   * `maxRows` bounds the rows; the viewport scrolls to keep the selection
   * inside it. `width` clips rows to the dock's slot (0 = no clipping).
   */
  renderBody(maxRows: number, width: number): string[] {
    const lines: string[] = [];
    if (this.filterable) {
      lines.push(`{gray-fg}filter: ${escapeTags(this.filter)}{/gray-fg}`);
    }
    lines.push('');
    // The caller's budget and the viewport it armed via rowsViewportSize are
    // both ceilings: render(20) must still show 12 rows (the modal default),
    // while the dock — which derives viewportSize FROM its budget — fills it.
    const viewport = Math.max(1, Math.min(this.viewportRows, maxRows - lines.length));
    lines.push(...this.renderRows(viewport, width));
    return lines;
  }

  /** The list rows only: `…` markers, selectable rows, the detail line. */
  renderRows(maxRows: number, width: number): string[] {
    const viewport = Math.max(1, maxRows);
    const lines: string[] = [];
    const rows = this.visibleItems();
    if (rows.length === 0) {
      lines.push('{gray-fg}no matches{/gray-fg}');
      return lines;
    }
    this.selected = clampIndex(this.selected, rows.length);
    // Scroll the viewport only when the selection leaves it.
    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    else if (this.selected >= this.scrollTop + viewport) {
      this.scrollTop = this.selected - viewport + 1;
    }
    const first = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - viewport)));
    const last = Math.min(rows.length, first + viewport);
    if (first > 0) lines.push('{gray-fg}  …{/gray-fg}');
    for (let i = first; i < last; i += 1) {
      lines.push(renderItem(rows[i] as WindowItem, i === this.selected, width));
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
    return lines;
  }

  /** Rows the current viewport would show, for the caller's height math. */
  get rowsViewportSize(): number {
    return this.viewportRows;
  }

  set rowsViewportSize(rows: number) {
    this.viewportRows = Math.max(1, rows);
  }

  /** Whether any row carries a `detail`, which costs two rows under the list. */
  hasDetail(): boolean {
    return this.items.some((item) => item.detail !== undefined && item.detail !== '');
  }

  /** Items after the filter, best match first. */
  private visibleItems(): readonly WindowItem[] {
    if (this.filter === '') return this.items;
    // Fuzzy, not substring: `nwp` should find `newest prompt`, and a query
    // typed in the wrong order should still rank the real match first. The
    // matcher is the same one `@`-file completion uses, so the ranking the
    // user learned in the popup is the ranking they get here.
    //
    // The DESCRIPTION is part of the searchable text, not decoration: a model
    // row's qualifier names its provider, so typing a provider name has to
    // narrow the list to that provider's models.
    return fuzzyFilter(this.items, this.filter, (item) => (
      item.description === undefined ? item.label : `${item.label} ${item.description}`
    ));
  }
}

/**
 * What a window host calls on the controller that owns the window's chrome
 * and navigation (the tabbed rich panel). Everything here is about CHROME and
 * FOCUS; the rows themselves are answered by the `ListState` per tab.
 */
export interface PanelController {
  /** Chrome above the list: the title + tab strip. */
  renderHeader(width: number): readonly string[];
  /** The active tab's hint line. */
  footerText(): string;
  /** Rows of non-list furniture the chrome spends inside the height budget. */
  structureRows(): number;
  /** `escape`: true leaves the panel, false was absorbed (filter or focus).
   * Other names: true = consumed before the list saw the key. */
  handleChromeKey(name: string, mods: KeyMods): boolean;
  /**
   * Flush hook the window host calls when the panel closes, for any reason.
   *
   * Not driven from `handleChromeKey`: leaving by F1, by a permission ask
   * taking the dock, or by `RichPanelHandle.close()` is the same departure to
   * a panel that has queued writes.
   */
  handleClose(): void;
  /** The list the window should currently render and navigate. */
  activeList(): ListState;
  /** A single-letter row action (`i`, `u`, `C-d`…) the panel offers. */
  hasRowAction(name: string): boolean;
  /** Run a single-letter row action on the selected row. True = handled. */
  runRowAction(name: string): boolean;
  /** True while the cursor is in the list: letters belong to the filter. */
  contentFocused(): boolean;
  /** Hand the window host back so the controller can report swaps. */
  attach(manager: WindowManager): void;
}

/** One tab of a rich panel. */
export interface RichPanelTab extends ListSection {
  readonly id: string;
  readonly label: string;
  readonly footer?: string;
  /** True = tab is visible but inert (an action can refuse it). */
  disabled?: boolean;
  /**
   * Single-letter actions on the selected row, keyed by blessed's name for
   * the chord (`i`, `u`, `r`, `x`, and control chords like `C-d`). They only
   * fire when the row itself is not being typed over: the filter owns plain
   * letters while the cursor is in the list, so a tab binds letters it can
   * afford to lose from search.
   */
  readonly rowActions?: Readonly<Record<string, (value: string) => void>>;
}

/** The panel a `RichPanelController` renders. */
export interface RichPanelSpec {
  readonly title: string;
  readonly tabs: readonly RichPanelTab[];
  readonly initialTab?: string;
  /**
   * Fired when the panel closes for any reason — Esc from the strip, another
   * window taking the dock, `RichPanelHandle.close()`. Choosing a row through
   * a tab's `onSubmit` does NOT fire it: there the choice is the write.
   */
  readonly onClose?: () => void;
}

/**
 * A tabbed list panel: the 630a primitive behind `/plugin`- and
 * `/provider`-class interfaces.
 *
 * ## Focus protocol (the part a plain window does not have)
 *
 * The cursor lives in exactly one place: the tab strip (header focus) or the
 * list (content focus). In the header, `←/→` and `Tab` move between tabs and
 * `↓`/`space` drop into the list; `Esc` leaves the panel. In the list,
 * `↑`/`↓`/typing do what they always did, `Tab` switches to the NEXT TAB but
 * keeps content focus — switching tabs twice is two Tab presses either way —
 * and `S-Tab` steps back. `Esc` clears a typed filter first, then leaves.
 *
 * Each tab keeps its OWN filter and cursor: a panel that forgets where you
 * were when you peek at another tab is a panel people open once.
 *
 * `Esc` backs out one layer per press — typed filter, then the list, then the
 * panel — so leaving is never the same gesture as undoing the last thing you
 * did. There is no `/` to start a search: in content focus the filter already
 * owns every plain letter, which is what makes the strip's letters affordable
 * as row actions.
 */
export class RichPanelController implements PanelController {
  private readonly spec: RichPanelSpec;
  private readonly lists = new Map<string, ListState>();
  private activeIndex: number;
  private focus: 'header' | 'content' = 'header';
  private manager: WindowManager | null = null;

  constructor(spec: RichPanelSpec) {
    this.spec = spec;
    const requested = spec.initialTab === undefined
      ? -1
      : spec.tabs.findIndex((tab) => tab.id === spec.initialTab);
    this.activeIndex = Math.max(0, requested);
    for (const tab of spec.tabs) this.lists.set(tab.id, freshList(tab));
  }

  attach(manager: WindowManager): void {
    this.manager = manager;
  }

  /**
   * Refresh one tab's rows from a later read, keeping the query and the row.
   *
   * This is the only way a command gets new state into a live panel; the tab's
   * own `ListSection` is the fresh content and its static parts (footer,
   * row actions) ride along, so a tab that gained a plugin also keeps the
   * letters that install it.
   */
  syncTab(tabId: string, section: ListSection): void {
    const tab = this.spec.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;
    const list = this.lists.get(tabId) ?? new ListState();
    list.refresh({ ...tab, ...section });
    this.lists.set(tabId, list);
    if (this.activeTabId() === tabId) this.manager?.repaint();
  }

  activeTabId(): string | undefined {
    return this.spec.tabs[this.activeIndex]?.id;
  }

  /** The selected row's value in the active tab, for detail pages. */
  activeSelectedValue(): string | undefined {
    return this.currentList().selectedRow()?.value;
  }

  activeList(): ListState {
    return this.currentList();
  }

  structureRows(): number {
    // Two header rows (title, tab strip) + the list's leading blank + the
    // footer's blank and the footer itself. The dock derives its viewport by
    // subtracting this, so a panel that grows its chrome must grow this too or
    // the footer is the row that gets pushed off screen.
    return 5;
  }

  renderHeader(width: number): readonly string[] {
    const per = Math.max(6, Math.floor(Math.max(width, 40) / Math.max(1, this.spec.tabs.length)));
    const parts = this.spec.tabs.map((tab, index) => {
      const count = this.lists.get(tab.id)?.items.length ?? 0;
      const text = count > 0 ? `${tab.label} ${count}` : tab.label;
      const clean = escapeTags(truncateToWidth(text, per));
      const selected = index === this.activeIndex;
      if (selected && this.focus === 'header') return `{inverse}{cyan-fg} ${clean} {/cyan-fg}{/inverse}`;
      if (selected) return `{cyan-fg}{bold} ${clean} {/bold}{/cyan-fg}`;
      if (tab.disabled === true) return `{red-fg} ${clean} {/red-fg}`;
      return `{gray-fg} ${clean} {/gray-fg}`;
    });
    const hint = this.focus === 'header' ? '↓ list · Tab ⇄' : 'Tab ⇄ tab';
    return [
      `{bold}{cyan-fg}${escapeTags(this.spec.title)}{/cyan-fg}{/bold}`,
      `${parts.join('|')}  {gray-fg}${hint}{/gray-fg}`,
    ];
  }

  footerText(): string {
    return this.spec.tabs[this.activeIndex]?.footer ?? '';
  }

  hasRowAction(name: string): boolean {
    return this.currentTab()?.rowActions?.[name] !== undefined;
  }

  runRowAction(name: string): boolean {
    const handler = this.currentTab()?.rowActions?.[name];
    if (handler === undefined) return false;
    const value = this.currentList().selectedRow()?.value;
    if (value === undefined) return true;
    handler(value);
    return true;
  }

  contentFocused(): boolean {
    return this.focus === 'content';
  }

  handleChromeKey(name: string, mods: KeyMods): boolean {
    if (name === 'escape') {
      // Staged exit, one layer per press: the typed query goes first, then the
      // list hands the cursor back to the tab strip, then the panel leaves.
      // Losing a filter you did not mean to type is worse than one extra
      // keypress. `true` means "leave", and the window host runs the flush on
      // the way out — see `WindowManager.close`.
      const list = this.currentList();
      if (this.focus === 'content' && list.filterText !== '') {
        list.clearFilter();
        return false;
      }
      if (this.focus === 'content') {
        this.focus = 'header';
        return false;
      }
      return true;
    }
    if (name === 'tab' && mods.shift !== true) {
      this.move(1);
      return true;
    }
    if (name === 'S-tab' || (name === 'tab' && mods.shift === true)) {
      this.move(-1);
      return true;
    }
    if (this.focus !== 'header') return false;
    if (name === 'right') {
      this.move(1);
      return true;
    }
    if (name === 'left') {
      this.move(-1);
      return true;
    }
    if (name === 'down') {
      this.focus = 'content';
      return true;
    }
    if (name === 'space') {
      // In the strip, space means "open the list", not "toggle the row" — a
      // tab with an onActivate list would otherwise fire on the strip itself.
      this.focus = 'content';
      return true;
    }
    if (name === 'up' || name === 'pageup') return true; // the strip has one row
    if (name === 'return' || name === 'enter') {
      this.focus = 'content';
      return true;
    }
    return false;
  }

  handleClose(): void {
    this.spec.onClose?.();
  }

  private move(delta: number): void {
    const count = this.spec.tabs.length;
    if (count === 0) return;
    let next = this.activeIndex;
    for (let step = 0; step < count; step += 1) {
      next = (next + delta + count) % count;
      if (this.spec.tabs[next]?.disabled !== true) break;
    }
    if (next === this.activeIndex) return;
    this.activeIndex = next;
  }

  private currentTab(): RichPanelTab | undefined {
    return this.spec.tabs[this.activeIndex];
  }

  private currentList(): ListState {
    const tab = this.currentTab();
    const list = tab === undefined ? undefined : this.lists.get(tab.id);
    if (list !== undefined) return list;
    const fresh = new ListState();
    if (tab !== undefined) this.lists.set(tab.id, fresh);
    return fresh;
  }
}

function freshList(tab: RichPanelTab): ListState {
  const list = new ListState();
  list.openSection(tab);
  return list;
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
  /**
   * The row the list opens on.
   *
   * A detail page that sends the user BACK reopens the list, and reopening
   * at row 0 would make "look at three entries in a row" lose their place
   * each time. Clamped on open, so a stale index after the items changed
   * reads as the nearest row rather than an out-of-range selection.
   */
  readonly initialSelected?: number;
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
  /**
   * A controller that owns the window's chrome and navigation (the tabbed
   * rich panel). When present, `items`/`lines` on the spec are ignored and
   * the controller's active `ListState` answers instead.
   */
  readonly controller?: PanelController;
}

export class WindowManager {
  private spec: WindowSpec | null = null;
  private list: ListState = new ListState();
  private staticScrollTop = 0;
  private staticViewportRows = 1;

  constructor(private readonly onRepaint: () => void = () => {}) {}

  /** Open (or replace) the window. Navigation state resets. */
  open(spec: WindowSpec): void {
    this.spec = spec;
    this.staticScrollTop = 0;
    if (spec.controller !== undefined) {
      spec.controller.attach(this);
      this.list = spec.controller.activeList();
    } else {
      this.list = new ListState();
      this.list.openSection(spec);
    }
  }

  /** Close whatever is open. Closing a closed window is fine. */
  close(): void {
    const spec = this.spec;
    this.spec = null;
    // The controller flushes BEFORE the host learns the window is gone: a
    // panel's `onClose` is where its queued writes run, and it has to run for
    // every way of leaving — Esc, F1 taking the dock, a permission ask closing
    // it — not only the one the user pressed.
    spec?.controller?.handleClose();
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
    this.activeList.updateItems(items);
  }

  /** Ask the host to repaint (controller path; kept off the spec callbacks). */
  repaint(): void {
    this.onRepaint();
  }

  /**
   * The list the window currently renders and navigates.
   *
   * Under a controller this asks the controller every time: a tab switch
   * moves its active list, and a cached reference would keep navigating and
   * painting the tab the user already left.
   */
  private get activeList(): ListState {
    const controller = this.spec?.controller;
    return controller === undefined ? this.list : controller.activeList();
  }

  /** The current filter text, so tests can assert the typing path. */
  get filterText(): string {
    return this.activeList.filterText;
  }

  /**
   * Feed a terminal key name. Returns true when the window consumed it.
   *
   * An Enter on an empty filtered list closes the window — there is nothing
   * to submit, and acknowledging with Enter reads as "done here" — but
   * submits nothing and still reports consumed, so the key cannot fall
   * through into the editor underneath the modal.
   */
  handleKey(name: string, mods: KeyMods = {}): boolean {
    const spec = this.spec;
    if (spec === null) return false;
    const controller = spec.controller;

    if (controller !== undefined) {
      if (name === 'escape') {
        // `false` means the controller absorbed the key (the filter went
        // away). Leaving goes through `close()` so the host's `onCancel` runs:
        // a TUI that tracks "a panel is on screen" learns from that callback,
        // and a stale flag there would route later keys to a dead panel.
        if (controller.handleChromeKey('escape', mods)) this.close();
        return true;
      }
      if (controller.handleChromeKey(name, mods)) return true;
      const list = controller.activeList();
      if (name === 'return' || name === 'enter') {
        if (list.selectedRow() === undefined) return true;
        if (list.onActivate !== undefined) return list.handleKey(name, mods);
        this.spec = null;
        list.onSubmit?.((list.selectedRow() as WindowItem).value);
        return true;
      }
      if (name === 'space' && list.onActivate !== undefined) return list.handleKey(name, mods);
      if (
        !controller.contentFocused()
        && controller.hasRowAction(name)
      ) {
        return controller.runRowAction(name);
      }
      if (name === 'up' || name === 'down' || name === 'pageup' || name === 'pagedown') {
        return list.handleKey(name, mods);
      }
      if (name === 'backspace') return list.handleKey(name, mods);
      return false;
    }

    switch (name) {
      case 'escape':
        this.close();
        return true;

      case 'return':
      case 'enter': {
        if (this.activeList.selectedRow() === undefined) {
          this.close();
          return true;
        }
        if (spec.onActivate !== undefined) return this.activeList.handleKey(name, mods);
        const item = this.activeList.selectedRow() as WindowItem;
        this.spec = null;
        if (spec.onSubmit !== undefined) spec.onSubmit(item.value);
        return true;
      }

      case 'space': {
        // Only a control panel (one with `onActivate`) eats the space bar. A
        // filterable picker must keep it: `deep seek` is a legitimate query,
        // and swallowing it there would make half the model list unsearchable.
        if (spec.onActivate === undefined) return false;
        return this.activeList.handleKey(name, mods);
      }

      case 'up':
      case 'down': {
        if (spec.items === undefined && spec.scrollable === true) {
          this.scrollStatic(name === 'up' ? -1 : 1, 1);
          return true;
        }
        return this.activeList.handleKey(name, mods);
      }

      case 'pageup':
      case 'pagedown': {
        if (spec.items === undefined && spec.scrollable === true) {
          this.scrollStatic(name === 'pageup' ? -1 : 1, Math.max(1, this.staticViewportRows - 1));
          return true;
        }
        return this.activeList.handleKey(name, mods);
      }

      case 'backspace':
        this.activeList.handleKey(name, mods);
        return true;

      default:
        return false;
    }
  }

  /** Feed a printable character to the filter. Consumed only when filterable. */
  feedCharacter(ch: string): boolean {
    const spec = this.spec;
    if (spec === null) return false;
    if (spec.controller !== undefined) return spec.controller.activeList().feedCharacter(ch);
    if (spec.filterable !== true) return false;
    return this.activeList.feedCharacter(ch);
  }

  /**
   * The window body as tagged lines, or `null` when closed.
   *
   * `maxRows` bounds the output; the viewport scrolls to keep the selection
   * inside it. The title, filter line, and footer count against the bound, so
   * the caller's height arithmetic never overflows the terminal.
   */
  render(maxRows: number): string | null {
    this.activeList.rowsViewportSize = VIEWPORT_ROWS;
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
    // Plain window: title, filter line, blank, blank, footer = four structure
    // rows (the filter line only exists for filterable lists, and the two
    // blanks cover both the pre-list gap and the footer's). A controller
    // spends its own header. Rows carrying a `detail` cost two more.
    const structure = this.spec?.controller?.structureRows() ?? 4;
    const detailRows = this.activeList.hasDetail() ? 2 : 0;
    this.activeList.rowsViewportSize = Math.max(1, Math.min(VIEWPORT_ROWS, budget - structure - detailRows));
    // Two rows of headroom so the hint below survives the trim: it is the one
    // line that says how to leave the panel.
    const body = this.compose(budget + 2, width);
    this.activeList.rowsViewportSize = VIEWPORT_ROWS;
    if (body === null) return null;
    const lines = body.split('\n');
    if (lines.length <= budget) return lines;
    const hint = lines[lines.length - 1] ?? '';
    return [...lines.slice(0, Math.max(0, budget - 2)), '…', hint];
  }

  private scrollStatic(delta: number, stride: number): void {
    const spec = this.spec;
    if (spec === null || spec.lines === undefined) return;
    const maxScroll = Math.max(0, spec.lines.length - this.staticViewportRows);
    this.staticScrollTop = Math.max(0, Math.min(maxScroll, this.staticScrollTop + delta * stride));
  }

  private compose(maxRows: number, width: number): string | null {
    const spec = this.spec;
    if (spec === null) return null;
    const controller = spec.controller;

    const lines: string[] = [];
    if (controller !== undefined) {
      lines.push(...controller.renderHeader(width));
      const footer = controller.footerText();
      const list = controller.activeList();
      const bodyRows = list.renderBody(Math.max(1, maxRows - lines.length - (footer === '' ? 0 : 2)), width);
      lines.push(...bodyRows);
      if (footer !== '') lines.push('', `{gray-fg}${escapeTags(footer)}{/gray-fg}`);
      return capLines(lines, maxRows);
    }

    lines.push(`{bold}{cyan-fg}${escapeTags(spec.title)}{/cyan-fg}{/bold}`);

    if (spec.items !== undefined) {
      lines.push(...this.activeList.renderBody(Math.max(1, maxRows - lines.length), width));
      if (spec.footer !== undefined && spec.footer !== '') {
        lines.push('', `{gray-fg}${escapeTags(spec.footer)}{/gray-fg}`);
      }
      return capLines(lines, maxRows);
    }

    if (spec.lines !== undefined) {
      if (spec.scrollable === true) {
        const footerRows = spec.footer === undefined || spec.footer === '' ? 0 : 2;
        this.staticViewportRows = maxRows > 0
          ? Math.max(1, maxRows - lines.length - footerRows)
          : Math.max(1, spec.lines.length);
        this.scrollStatic(0, 0);
        lines.push(...(spec.lines ?? []).slice(this.staticScrollTop, this.staticScrollTop + this.staticViewportRows));
        if (spec.footer !== undefined && spec.footer !== '') {
          const total = spec.lines.length;
          const first = total === 0 ? 0 : this.staticScrollTop + 1;
          const last = Math.min(total, this.staticScrollTop + this.staticViewportRows);
          const position = total > this.staticViewportRows ? ` · ${first}-${last}/${total}` : '';
          lines.push('', `{gray-fg}${escapeTags(spec.footer + position)}{/gray-fg}`);
        }
        return capLines(lines, maxRows, false);
      }
      lines.push(...spec.lines);
    }

    if (spec.footer !== undefined && spec.footer !== '') {
      lines.push('', `{gray-fg}${escapeTags(spec.footer)}{/gray-fg}`);
    }
    return capLines(lines, maxRows);
  }
}

/**
 * The hard cap: a window taller than the terminal would push its footer
 * off-screen, and with it the "how do I leave" hint.
 */
function capLines(lines: string[], maxRows: number, ellipsis = true): string {
  if (maxRows > 0 && lines.length > maxRows) {
    const capped = lines.slice(0, maxRows);
    if (ellipsis) capped[capped.length - 1] = '…';
    return capped.join('\n');
  }
  return lines.join('\n');
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

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
