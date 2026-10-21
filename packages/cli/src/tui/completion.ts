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
  filterItemsRanked,
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
  /** The slash command whose finite argument choices are currently shown. */
  argumentCommand?: string;
  /** Start of the current argument token in the input. */
  argumentStart?: number;
  /** End of the current argument token in the input. */
  argumentEnd?: number;
  /** The selected value follows a bare command and needs a separating space. */
  argumentNeedsSpace?: boolean;
}

export interface CompletionSources {
  /** Candidates for the `/` trigger. */
  slash: () => PopoverItem[];
  /** Finite argument choices for a slash command, keyed by its `/name`. */
  slashOptions?: (command: string) => PopoverItem[];
  /** Slash commands that should show their argument picker before a space is typed. */
  slashOptionsOnBare?: (command: string) => boolean;
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
  /** Keep an explicitly dismissed/Tab-accepted menu closed until text changes. */
  private suppressedText: string | null = null;

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
    if (this.suppressedText !== null) {
      if (this.suppressedText === text) {
        this.state = { ...CLOSED, items: [] };
        return this.state;
      }
      this.suppressedText = null;
    }

    const slashOptions = this.slashOptionsState(text, cursor);
    if (slashOptions !== null) {
      this.state = slashOptions;
      return this.state;
    }

    const trigger = detectPopoverTrigger(text, cursor);
    if (trigger === null || trigger.mode === null || trigger.mode === 'cli') {
      this.state = { ...CLOSED, items: [] };
      return this.state;
    }

    // All three pools are filtered where their kind decides how:
    //
    //  - paths are RANKED (see `CompletionSources.files`);
    //  - commands are RANKED, because the popup's first row is the one Enter
    //    accepts and a list that keeps catalog order while the user types
    //    puts the command they meant somewhere below one they did not;
    //  - context rows stay substring-filtered and in input order, which is
    //    the desktop's order (`attachments` and `modes` lead the list).
    //
    // The two triggers read DIFFERENT pools, and conflating them is a bug this
    // shape is chosen to prevent: `/` must never offer a file path (the desktop
    // does not), and `@` must never offer a slash command.
    const contextRows = trigger.mode === 'context' ? this.sources.context() : [];
    const fileRows = trigger.mode === 'context' ? this.sources.files() : [];
    const commandRows = trigger.mode === 'skill' ? this.sources.slash() : [];

    const contextHits = filterItems(contextRows, trigger.filter);
    const fileHits = fileRows.length > 0 ? filterItemsFuzzy(fileRows, trigger.filter, (i) => i.label) : [];
    const commandHits = filterItemsRanked(commandRows, trigger.filter);

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

    if (this.state.argumentCommand !== undefined
      && this.state.argumentStart !== undefined
      && this.state.argumentEnd !== undefined) {
      const before = text.slice(0, this.state.argumentStart);
      const after = text.slice(this.state.argumentEnd);
      const separator = this.state.argumentNeedsSpace === true ? ' ' : '';
      const nextText = before + separator + item.value + after;
      return { text: nextText, cursor: before.length + separator.length + item.value.length };
    }

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
   * `Enter` while the popup is open must accept a completion, not submit the
   * prompt, and `Tab` must never reach the input line. `submitAfterAccept` is
   * the half that goes beyond "consumed": when it is set the caller submits the
   * accepted text, which is how one Enter runs a command — see
   * {@link CompletionController.submitsOnEnter} for where that is and is not
   * true.
   */
  handleKey(
    key: CompletionKey,
    text: string,
  ): {
    consumed: boolean;
    accepted: { text: string; cursor: number } | null;
    submitAfterAccept?: boolean;
  } {
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
        {
          const isSlashOption = this.state.argumentCommand !== undefined;
          const accepted = this.accept(text);
          if (isSlashOption && accepted !== null) {
            this.suppressedText = accepted.text;
            this.close();
          }
          return { consumed: true, accepted };
        }
      case 'return': {
        if (!this.isOpen) return { consumed: false, accepted: null };
        const accepted = this.accept(text);
        // A popup open with NO rows is not offered, so reaching here with rows
        // means an accept. If the accept produced nothing, the key is released
        // rather than swallowed, which is the lesser failure: the user submits
        // what they typed instead of nothing happening.
        if (accepted === null) return { consumed: false, accepted: null };
        return {
          consumed: true,
          accepted,
          ...(this.submitsOnEnter(text) ? { submitAfterAccept: true } : {}),
        };
      }
      case 'escape':
        if (this.state.mode === null) return { consumed: false, accepted: null };
        this.suppressedText = text;
        this.close();
        return { consumed: true, accepted: null };
    }
  }

  /**
   * Whether Enter RUNS what it just accepted, instead of only inserting it.
   *
   * Two cases, and the second is the one that had to be reasoned about rather
   * than asserted:
   *
   *  1. **An argument row** (`/resume <session>`). Always. The row IS the
   *     argument, so the command is complete the moment it is chosen and
   *     leaving it in the editor buys the user nothing.
   *
   *  2. **A command name**, but only when the command is the whole line.
   *     `/mod` + Enter means "run /model", and one keystroke is the point of
   *     offering the row. `please run /mod|` + Enter must NOT send the
   *     sentence as a prompt — there the popup is completing a word inside a
   *     larger text, and Enter has to stay an insertion.
   *
   * `Tab` is the deliberate counterpart: it always inserts and never submits,
   * so a command whose argument the user wants to type by hand
   * (`/export <dir>`) still has a key that does not run it.
   */
  private submitsOnEnter(text: string): boolean {
    if (this.state.argumentCommand !== undefined) return true;
    if (this.state.mode !== 'skill') return false;

    // The trigger marks where `/` is; the token ends after what was typed.
    const before = text.slice(0, this.state.triggerPos);
    const after = text.slice(this.state.triggerPos + 1 + this.state.filter.length);
    return before.trim() === '' && after.trim() === '';
  }

  /** Show the next-level menu in a command argument or on opted-in bare commands. */
  private slashOptionsState(text: string, cursor: number): CompletionState | null {
    if (this.sources.slashOptions === undefined) return null;

    const beforeCursor = text.slice(0, cursor);
    const match = /^\s*(\/[^\s]+)(?:\s+([^\s]*))?$/u.exec(beforeCursor);
    if (match === null) return null;

    const command = match[1];
    if (command === undefined) return null;
    const bareCommand = match[2] === undefined;
    if (bareCommand && this.sources.slashOptionsOnBare?.(command.toLowerCase()) !== true) return null;
    const candidates = this.sources.slashOptions(command.toLowerCase());
    if (candidates.length === 0) return null;

    const filter = match[2] ?? '';
    const items = filterItemsRanked(candidates, filter);
    if (items.length === 0) return { ...CLOSED, items: [] };

    const argumentStart = cursor - filter.length;
    const suffix = /^[^\s]*/u.exec(text.slice(cursor))?.[0] ?? '';
    const argumentEnd = cursor + suffix.length;
    const sameCommand = this.state.argumentCommand === command.toLowerCase();
    const selectedIndex = sameCommand
      ? Math.min(this.state.selectedIndex, Math.max(0, items.length - 1))
      : 0;

    return {
      mode: 'skill',
      triggerPos: argumentStart,
      filter,
      items,
      selectedIndex,
      argumentCommand: command.toLowerCase(),
      argumentStart,
      argumentEnd,
      ...(bareCommand ? { argumentNeedsSpace: true } : {}),
    };
  }
}
