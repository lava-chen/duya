/**
 * The input buffer, cursor, and paste placeholder.
 *
 * ## Why this replaces `blessed.textbox`
 *
 * `textbox._listener` computes `visible = -(this.width - this.iwidth - 1)`
 * (`node_modules/blessed/lib/widgets/textbox.js`): a single line with a
 * horizontal scroll window. It has no multiline, no East-Asian awareness for
 * cursor placement, and no paste semantics. This is a plain `blessed.box`
 * plus the buffer below, so all three are decisions rather than limitations.
 *
 * ## The buffer is CODE POINTS
 *
 * Indexed by code point, not by UTF-16 unit. Backspace after an emoji has to
 * delete the whole grapheme, and a cursor offset computed over surrogate
 * halves lands between the two halves of a character — which the terminal
 * renders as a replacement glyph.
 *
 * IME composition is deliberately not handled here. Composition belongs to the
 * OS: measured on blessed's own key path, a committed CJK character arrives as
 * an ordinary keypress with `ch` set and `key.name === undefined`, so the OS
 * owns composition and this only ever sees committed characters.
 */

/** Pasts longer than this collapse to a placeholder. */
export const PASTE_PLACEHOLDER_THRESHOLD = 1000;

/** The text shown in place of a collapsed paste. */
export function pastePlaceholder(content: string): string {
  return `[Pasted Content ${content.length} chars]`;
}

export class InputEditor {
  /** Code points, so cursor arithmetic never splits a character. */
  private cells: string[] = [];
  private cursorAt = 0;
  private history: string[] = [];
  private historyAt: number | null = null;
  /** Draft stashed while the user pages through history. */
  private draft: string[] = [];
  /** A collapsed paste awaiting expansion on submit. */
  private paste: { placeholder: string; content: string } | null = null;

  /** The current buffer text. */
  get text(): string {
    return this.cells.join('');
  }

  /** Cursor position, in code points. */
  get cursor(): number {
    return this.cursorAt;
  }

  get isEmpty(): boolean {
    return this.cells.length === 0;
  }

  /** True while a collapsed paste stands in for the real content. */
  get hasCollapsedPaste(): boolean {
    return this.paste !== null;
  }

  /** Character count of the buffer as displayed. */
  get length(): number {
    return this.cells.length;
  }

  /**
   * Insert text at the cursor.
   *
   * A chunk longer than the threshold is collapsed to a placeholder and the
   * real content held aside. This bounds layout cost as well as scroll
   * position: a 200KB paste wrapped across a box is thousands of rows, and
   * re-wrapping it on every keystroke after it is why editors that allow this
   * feel broken.
   */
  insert(text: string): void {
    if (text.length === 0) return;

    if (text.length > PASTE_PLACEHOLDER_THRESHOLD) {
      const marker = pastePlaceholder(text);
      this.cells.splice(this.cursorAt, 0, ...Array.from(marker));
      this.cursorAt += Array.from(marker).length;
      this.paste = { placeholder: marker, content: text };
      return;
    }

    const chars = Array.from(text);
    this.cells.splice(this.cursorAt, 0, ...chars);
    this.cursorAt += chars.length;
  }

  /** Delete the code point before the cursor. */
  backspace(): void {
    if (this.cursorAt === 0) return;
    this.cells.splice(this.cursorAt - 1, 1);
    this.cursorAt -= 1;
    // Deleting inside the placeholder invalidates it: the user is now editing
    // a label that no longer describes the buffer.
    this.invalidatePasteIfEdited();
  }

  /** Delete the code point at the cursor. */
  deleteForward(): void {
    if (this.cursorAt >= this.cells.length) return;
    this.cells.splice(this.cursorAt, 1);
    this.invalidatePasteIfEdited();
  }

  private invalidatePasteIfEdited(): void {
    if (this.paste === null) return;
    const current = this.cells.join('');
    if (current !== this.paste.placeholder) this.paste = null;
  }

  moveLeft(): void {
    if (this.cursorAt > 0) this.cursorAt -= 1;
  }

  moveRight(): void {
    if (this.cursorAt < this.cells.length) this.cursorAt += 1;
  }

  moveHome(): void {
    this.cursorAt = 0;
  }

  moveEnd(): void {
    this.cursorAt = this.cells.length;
  }

  /** Move to the start of the previous word, skipping runs of spaces. */
  moveWordLeft(): void {
    let i = this.cursorAt;
    while (i > 0 && /\s/.test(this.cells[i - 1] as string)) i -= 1;
    while (i > 0 && !/\s/.test(this.cells[i - 1] as string)) i -= 1;
    this.cursorAt = i;
  }

  moveWordRight(): void {
    let i = this.cursorAt;
    const n = this.cells.length;
    while (i < n && /\s/.test(this.cells[i] as string)) i += 1;
    while (i < n && !/\s/.test(this.cells[i] as string)) i += 1;
    this.cursorAt = i;
  }

  /** Delete from the cursor to the end of the line. */
  killToEnd(): void {
    this.cells.splice(this.cursorAt, this.cells.length - this.cursorAt);
    this.invalidatePasteIfEdited();
  }

  /** Delete from the start of the line to the cursor. */
  killToStart(): void {
    this.cells.splice(0, this.cursorAt);
    this.cursorAt = 0;
    this.invalidatePasteIfEdited();
  }

  /**
   * Delete the word before the cursor (Ctrl+W).
   *
   * The word is deleted WITHOUT the whitespace that separates it from the one
   * before it, so killing one word out of "alpha beta gamma" leaves
   * "alpha gamma" rather than "alphagamma". Deleting the separator as well is
   * what a naive implementation does, and it quietly runs words together.
   */
  killWordBackward(): void {
    let start = this.cursorAt;
    // Skip whitespace immediately behind the cursor...
    while (start > 0 && /\s/.test(this.cells[start - 1] as string)) start -= 1;
    // ...then walk back over the word itself, stopping before the whitespace
    // that precedes it.
    while (start > 0 && !/\s/.test(this.cells[start - 1] as string)) start -= 1;
    // Delete up to the CURSOR, not up to `start`: the run from `start` to the
    // cursor includes the separator that followed the word, so killing one
    // word out of "alpha beta gamma" leaves "alpha gamma" and not
    // "alpha  gamma" (both separators intact) or "alphagamma" (both gone).
    this.cells.splice(start, this.cursorAt - start);
    this.cursorAt = start;
    this.invalidatePasteIfEdited();
  }

  /** Empty the buffer. */
  clear(): void {
    this.cells = [];
    this.cursorAt = 0;
    this.paste = null;
  }

  /**
   * Take the buffer's contents for submission, expanding any collapsed paste.
   *
   * Expansion happens HERE, not at paste time, so a collapsed paste costs one
   * short string in the layout and the full content is only ever materialised
   * on the way to the agent.
   */
  submit(): string {
    const value = this.paste !== null ? this.paste.content : this.text;
    this.pushHistory(this.paste !== null ? this.paste.content : this.text);
    this.clear();
    return value;
  }

  /** Submit the buffer only if it holds something. */
  submitIfPresent(): string | null {
    if (this.paste === null && this.isEmpty) return null;
    const trimmed = this.paste !== null ? this.paste.content : this.text.trim();
    if (trimmed === '') return null;
    this.pushHistory(trimmed);
    this.clear();
    return trimmed;
  }

  private pushHistory(entry: string): void {
    if (entry.trim() === '') return;
    const last = this.history[this.history.length - 1];
    if (last !== entry) this.history.push(entry);
    if (this.history.length > 1000) this.history.splice(0, this.history.length - 1000);
    this.historyAt = null;
    this.draft = [];
  }

  /** Seed history from a persisted file. */
  loadHistory(entries: readonly string[]): void {
    this.history = [...entries];
    this.historyAt = null;
  }

  /** The persisted history. */
  exportHistory(): string[] {
    return [...this.history];
  }

  /** Recall the previous history entry. */
  historyPrevious(): void {
    if (this.history.length === 0) return;
    if (this.historyAt === null) {
      // Remember what the user was typing, so paging back past the newest
      // entry restores it rather than leaving them in the last recalled one.
      this.draft = [...this.cells];
      this.historyAt = this.history.length - 1;
    } else if (this.historyAt > 0) {
      this.historyAt -= 1;
    } else {
      return;
    }
    this.applyHistoryEntry(this.history[this.historyAt] as string);
  }

  /** Recall the next history entry, and past the newest restore the draft. */
  historyNext(): void {
    if (this.historyAt === null) return;
    if (this.historyAt >= this.history.length - 1) {
      this.historyAt = null;
      this.applyHistoryEntry(this.draft.join(''));
      this.draft = [];
      return;
    }
    this.historyAt += 1;
    this.applyHistoryEntry(this.history[this.historyAt] as string);
  }

  private applyHistoryEntry(entry: string): void {
    this.cells = Array.from(entry);
    this.cursorAt = this.cells.length;
    this.paste = null;
  }
}
