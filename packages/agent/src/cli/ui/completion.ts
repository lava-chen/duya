/**
 * The CLI completion state machine.
 *
 * ## Why this is separate from `TUIApp`
 *
 * Every rule here is a decision about text: given what was typed and where the
 * caret is, what is offered, which row is selected, and what accepting does.
 * None of it is a terminal concern, which means all of it is reachable from a
 * test with no TTY — and the parts that were previously only observable by hand
 * (`Tab` accepting a row, `Esc` closing, the selection surviving a filter change)
 * become assertions.
 *
 * `TUIApp` keeps only what is genuinely terminal: which blessed element shows
 * the list, and where it is painted.
 *
 * ## What it deliberately does not decide
 *
 * Candidate SOURCES. Those live in `candidates.ts` and are injected, because
 * the workspace walk is IO and this is not. The boundary is the point: the state
 * machine can be tested with three fixed items, and the walk can be tested on a
 * fixture directory, without either pretending to be the other.
 */

import {
  cycleIndex,
  detectPopoverTrigger,
  filterItems,
  filterItemsFuzzy,
  resolveItemSelection,
  type PopoverItem,
  type PopoverMode,
} from '@duya/input-completion';

/** A key the popup reacts to. Terminal names, as blessed reports them. */
export type CompletionKey = 'up' | 'down' | 'return' | 'tab' | 'escape';

export interface CompletionState {
  /** Which popup is open, or `null`. */
  mode: PopoverMode;
  /** Index of the trigger character in the input text. */
  triggerPos: number;
  /** What has been typed since the trigger. */
  filter: string;
  /** The rows currently offered, after filtering. */
  items: PopoverItem[];
  /** Highlighted row. Always a valid index into `items`. */
  selectedIndex: number;
}

export interface CompletionSources {
  /** Candidates for the `/` trigger. */
  slash: () => PopoverItem[];
  /** Candidates for the `@` trigger, excluding file paths. */
  context: () => PopoverItem[];
  /**
   * Candidates for the `@` trigger that are FILE PATHS.
   *
   * Separate from `context` because they are filtered differently: substring
   * finds `/doctor` from `doc`, but no contiguous run of `src/uA` exists in
   * `src/app/useApp.ts`, so paths are ranked by the fuzzy matcher instead.
   */
  files: () => PopoverItem[];
}

const CLOSED: CompletionState = {
  mode: null,
  triggerPos: -1,
  filter: '',
  items: [],
  selectedIndex: 0,
};

export class CompletionController {
  private state: CompletionState = { ...CLOSED, items: [] };

  constructor(private readonly sources: CompletionSources) {}

  /** Current state. Exposed so the shell can paint it and tests can assert it. */
  get snapshot(): CompletionState {
    return this.state;
  }

  /** True when a popup is open AND has rows, which is the only case that steals keys. */
  get isOpen(): boolean {
    return this.state.mode !== null && this.state.items.length > 0;
  }

  /**
   * Recompute from the input text and caret.
   *
   * Called on every keystroke and every caret move. When the trigger is gone the
   * popup closes, which is the behaviour that matters: leaving it open over
   * unrelated text means `Enter` accepts a row the user can no longer see the
   * context for.
   *
   * The selected index is CLAMPED rather than reset, so filtering a 10-row list
   * down to 2 and back out again returns the user to the row they were on
   * instead of jumping to the top.
   */
  update(text: string, cursor: number): CompletionState {
    const trigger = detectPopoverTrigger(text, cursor);
    if (trigger === null || trigger.mode === null || trigger.mode === 'cli') {
      this.state = { ...CLOSED, items: [] };
      return this.state;
    }

    // Paths are ranked; commands and context rows are substring filtered. The
    // reason is in `CompletionSources.files`.
    //
    // The two triggers read DIFFERENT pools, and conflating them is a bug this
    // shape is chosen to prevent: `/` must never offer a file path (the desktop
    // does not), and `@` must never offer a slash command.
    const contextRows = trigger.mode === 'context' ? this.sources.context() : [];
    const fileRows = trigger.mode === 'context' ? this.sources.files() : [];
    const commandRows = trigger.mode === 'skill' ? this.sources.slash() : [];

    const contextHits = filterItems(contextRows, trigger.filter);
    const fileHits = fileRows.length > 0 ? filterItemsFuzzy(fileRows, trigger.filter, (i) => i.label) : [];
    const commandHits = filterItems(commandRows, trigger.filter);

    // Context rows before paths: a bare `@` should offer what it can ADD
    // before it offers what it can POINT AT, which is also the desktop's order
    // (attachments and modes lead the list).
    const items = [...contextHits, ...fileHits, ...commandHits];
    if (items.length === 0) {
      this.state = { ...CLOSED, items: [] };
      return this.state;
    }

    const selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, items.length - 1));

    this.state = {
      mode: trigger.mode,
      triggerPos: trigger.triggerPos,
      filter: trigger.filter,
      items,
      selectedIndex,
    };
    return this.state;
  }

  /** Move the selection, wrapping at both ends. */
  move(direction: 'up' | 'down'): CompletionState {
    if (!this.isOpen) return this.state;
    this.state = {
      ...this.state,
      selectedIndex: cycleIndex(this.state.selectedIndex, direction, this.state.items.length),
    };
    return this.state;
  }

  /**
   * Accept the selected row.
   *
   * Returns the new text and caret, or `null` when the popup is closed or
   * nothing is selected — a caller that gets `null` has no insertion to make and
   * should fall through to its normal handling of the key.
   *
   * The caret lands AFTER the inserted text, including the trailing space that
   * `resolveItemSelection` adds, because otherwise typing resumes inside the
   * just-inserted command and the next character edits it.
   */
  accept(text: string): { text: string; cursor: number } | null {
    if (!this.isOpen) return null;
    const item = this.state.items[this.state.selectedIndex];
    if (item === undefined) return null;

    const result = resolveItemSelection(
      item,
      this.state.mode,
      this.state.triggerPos,
      text,
      this.state.filter,
    );
    if (result.newInputValue === undefined) return null;

    const cursor = this.state.triggerPos + result.newInputValue.slice(this.state.triggerPos).length;
    return { text: result.newInputValue, cursor };
  }

  /** Close without inserting. */
  close(): void {
    this.state = { ...CLOSED, items: [] };
  }

  /**
   * Apply one key.
   *
   * Returns what happened so the caller knows whether the key was CONSUMED —
   * `Enter` while the popup is open must submit a completion, not the prompt,
   * and `Tab` must never reach the input line.
   */
  handleKey(
    key: CompletionKey,
    text: string,
  ): { consumed: boolean; accepted: { text: string; cursor: number } | null } {
    switch (key) {
      case 'up':
        if (!this.isOpen) return { consumed: false, accepted: null };
        this.move('up');
        return { consumed: true, accepted: null };
      case 'down':
        if (!this.isOpen) return { consumed: false, accepted: null };
        this.move('down');
        return { consumed: true, accepted: null };
      case 'tab':
        if (!this.isOpen) return { consumed: false, accepted: null };
        return { consumed: true, accepted: this.accept(text) };
      case 'return': {
        if (!this.isOpen) return { consumed: false, accepted: null };
        const accepted = this.accept(text);
        // A popup open with NO rows is not offered, so reaching here with rows
        // means an accept. If the accept produced nothing, the key is released
        // rather than swallowed, which is the lesser failure: the user submits
        // what they typed instead of nothing happening.
        return { consumed: accepted !== null, accepted };
      }
      case 'escape':
        if (this.state.mode === null) return { consumed: false, accepted: null };
        this.close();
        return { consumed: true, accepted: null };
    }
  }
}