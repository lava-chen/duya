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

import { KillRing } from './kill-ring.js';
import { UndoStack } from './undo-stack.js';

/** Pasts longer than this collapse to a placeholder. */
export const PASTE_PLACEHOLDER_THRESHOLD = 1000;

/**
 * The text shown in place of a collapsed paste.
 *
 * `seq` is a per-editor counter, and it is IN the label because the label is
 * the map key: two same-length pastes (`[Pasted Content 1000 chars]` twice)
 * would otherwise collide and one would expand into the other's content.
 */
export function pastePlaceholder(content: string, seq = 1): string {
  return `[Pasted Content #${seq} · ${content.length} chars]`;
}

/** Everything an undo must restore to make the buffer whole again. */
interface EditorSnapshot {
  cells: string[];
  cursor: number;
  pastes: Map<string, string>;
}

export class InputEditor {
  /** Code points, so cursor arithmetic never splits a character. */
  private cells: string[] = [];
  private cursorAt = 0;
  private history: string[] = [];
  private historyAt: number | null = null;
  /** Draft stashed while the user pages through history. */
  private draft: string[] = [];
  /**
   * Collapsed pastes awaiting expansion on submit, keyed by their placeholder
   * label. A MAP, not a single field: a prompt with two pasted documents used
   * to keep only the second, because the second `insert` overwrote the first.
   */
  private readonly pastes = new Map<string, string>();
  /** Monotonic paste counter; gives every placeholder label a unique key. */
  private pasteSeq = 0;
  /**
   * Whole-buffer snapshots, pushed BEFORE every mutation and popped by
   * `undo`. Ported from minimax-code's editor, which restores the same
   * triple (buffer, caret, paste map) on undo.
   */
  private readonly undoStack = new UndoStack<EditorSnapshot>();
  /** Emacs kill ring: kills land here, Ctrl+Y yanks them back. */
  private readonly killRing = new KillRing();
  /**
   * What the previous mutation was. Kills use it to ACCUMULATE into the ring
   * (killing line-end then word yields one entry, not two), and yank-pop uses
   * it to refuse cycling when the user has typed since the yank.
   */
  private lastAction: 'kill' | 'yank' | null = null;
  /** Span of the text the last yank inserted, so yank-pop can replace it. */
  private lastYank: { start: number; length: number } | null = null;

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
    return this.pastes.size > 0;
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
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;

    if (text.length > PASTE_PLACEHOLDER_THRESHOLD) {
      this.pasteSeq += 1;
      const marker = pastePlaceholder(text, this.pasteSeq);
      this.pastes.set(marker, text);
      const chars = Array.from(marker);
      this.cells.splice(this.cursorAt, 0, ...chars);
      this.cursorAt += chars.length;
      return;
    }

    const chars = Array.from(text);
    this.cells.splice(this.cursorAt, 0, ...chars);
    this.cursorAt += chars.length;
  }

  /** Delete the code point before the cursor. */
  backspace(): void {
    if (this.cursorAt === 0) return;
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;
    this.cells.splice(this.cursorAt - 1, 1);
    this.cursorAt -= 1;
    // Deleting inside the placeholder invalidates it: the user is now editing
    // a label that no longer describes the buffer.
    this.invalidatePasteIfEdited();
  }

  /** Delete the code point at the cursor. */
  deleteForward(): void {
    if (this.cursorAt >= this.cells.length) return;
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;
    this.cells.splice(this.cursorAt, 1);
    this.invalidatePasteIfEdited();
  }

  private invalidatePasteIfEdited(): void {
    if (this.pastes.size === 0) return;
    const current = this.cells.join('');
    // Only the placeholder the user actually broke is dropped: editing one
    // label must not orphan a second paste sitting elsewhere in the buffer.
    for (const marker of this.pastes.keys()) {
      if (!current.includes(marker)) this.pastes.delete(marker);
    }
  }

  /** Capture the whole buffer state for one undo step. Called BEFORE mutating. */
  private pushUndoSnapshot(): void {
    this.undoStack.push({
      cells: this.cells,
      cursor: this.cursorAt,
      pastes: this.pastes,
    });
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

  /** Delete from the cursor to the end of the buffer, into the kill ring. */
  killToEnd(): void {
    if (this.cursorAt >= this.cells.length) return;
    this.pushUndoSnapshot();
    this.killRange(this.cursorAt, this.cells.length, { prepend: false });
    this.lastAction = 'kill';
    this.lastYank = null;
  }

  /** Delete from the start of the buffer to the cursor, into the kill ring. */
  killToStart(): void {
    if (this.cursorAt === 0) return;
    this.pushUndoSnapshot();
    this.killRange(0, this.cursorAt, { prepend: true });
    this.cursorAt = 0;
    this.lastAction = 'kill';
    this.lastYank = null;
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
    if (start === this.cursorAt) return;
    this.pushUndoSnapshot();
    this.killRange(start, this.cursorAt, { prepend: true });
    this.cursorAt = start;
    this.lastYank = null;
  }

  /**
   * Splice out `[from, to)`, land it in the kill ring, and prune any paste
   * placeholder the kill orphaned.
   *
   * The killed text goes into the ring EXPANDED: killing a collapsed paste
   * must put the real content on the ring, because the label alone is dead
   * text — yanking it back would insert a string that no longer maps to any
   * paste, and submitting it would send the bracketed label to the agent.
   */
  private killRange(from: number, to: number, direction: { prepend: boolean }): void {
    const killed = this.cells.splice(from, to - from).join('');
    let expanded = killed;
    for (const [marker, content] of this.pastes) {
      if (expanded.includes(marker)) expanded = expanded.split(marker).join(content);
    }
    // A forward kill reads AFTER anything killed before it, so it appends; a
    // backward kill reads BEFORE, so it prepends — accumulate or not, the
    // yanked-back text must read in document order.
    this.killRing.push(expanded, {
      prepend: direction.prepend,
      accumulate: this.lastAction === 'kill',
    });
    this.lastAction = 'kill';
    this.invalidatePasteIfEdited();
  }

  /**
   * Restore the buffer to its state before the last mutation.
   *
   * Snapshot granularity follows minimax-code's editor: one snapshot per
   * MUTATION (a whole insert burst, one kill), so undo steps back one
   * operation, not one keystroke of an operation.
   */
  undo(): void {
    const snapshot = this.undoStack.pop();
    if (snapshot === undefined) return;
    this.cells = [...snapshot.cells];
    this.cursorAt = snapshot.cursor;
    this.pastes.clear();
    for (const [marker, content] of snapshot.pastes) this.pastes.set(marker, content);
    this.lastAction = null;
    this.lastYank = null;
  }

  /** Yank the most recent kill back in at the cursor. */
  yank(): void {
    const text = this.killRing.peek();
    if (text === undefined || text === '') return;
    const start = this.cursorAt;
    this.insert(text);
    // `insert` may have collapsed a large yank to a placeholder; the span it
    // actually occupied is what yank-pop must replace, and `insert` moved the
    // caret to its end.
    this.lastYank = { start, length: this.cursorAt - start };
    this.lastAction = 'yank';
  }

  /**
   * Replace the last yank with the next-older kill entry.
   *
   * Only meaningful immediately after a yank (or a prior yank-pop): the user
   * typed since, the replaced span no longer describes the buffer and cycling
   * would corrupt it, so the call refuses.
   */
  yankPop(): void {
    if (this.lastAction !== 'yank') return;
    if (this.killRing.length <= 1) return;
    const span = this.lastYank;
    if (span === null) return;

    this.pushUndoSnapshot();
    // The entry being replaced is still the ring's top until it rotates.
    this.cells.splice(span.start, span.length);
    this.cursorAt = span.start;
    this.killRing.rotate();
    const next = this.killRing.peek() ?? '';
    const chars = Array.from(next);
    this.cells.splice(span.start, 0, ...chars);
    this.cursorAt = span.start + chars.length;
    this.lastYank = { start: span.start, length: chars.length };
    this.invalidatePasteIfEdited();
  }

  /** Empty the buffer. */
  clear(): void {
    if (this.cells.length === 0 && this.pastes.size === 0) return;
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;
    this.cells = [];
    this.cursorAt = 0;
    this.pastes.clear();
  }

  /**
   * Replace the whole buffer and place the caret.
   *
   * Needed by completion: accepting a row rewrites the text around the trigger,
   * not just the span the editor happened to be tracking. Rebuilding through
   * `insert` and `backspace` instead would push every replaced character
   * through the paste bookkeeping, so a completion would look like a hand-typed
   * burst to anything watching `hasCollapsedPaste`.
   *
   * The history is NOT touched: accepting a completion is not the user having
   * typed a prompt, and a recalled command should not replace what they just
   * completed.
   */
  setText(text: string, cursor: number): void {
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;
    this.cells = [...text];
    this.cursorAt = Math.max(0, Math.min(cursor, this.cells.length));
    this.pastes.clear();
  }

  /**
   * Replace every intact placeholder in the buffer with the paste it stands
   * for.
   *
   * `split`/`join`, not `replaceAll` with a string pattern: a placeholder
   * contains no regex metacharacters, but this reads the same in every engine
   * and avoids the `replaceAll`-with-`$` quirk entirely.
   */
  private expandPastes(text: string): string {
    let expanded = text;
    for (const [marker, content] of this.pastes) {
      expanded = expanded.split(marker).join(content);
    }
    return expanded;
  }

  /**
   * Take the buffer's contents for submission, expanding any collapsed paste.
   *
   * Expansion happens HERE, not at paste time, so a collapsed paste costs one
   * short string in the layout and the full content is only ever materialised
   * on the way to the agent. ALL intact placeholders expand, which is the
   * behaviour a prompt with two pasted documents needs.
   */
  submit(): string {
    const value = this.expandPastes(this.text);
    this.pushHistory(value);
    this.clear();
    return value;
  }

  /** Submit the buffer only if it holds something. */
  submitIfPresent(): string | null {
    if (this.pastes.size === 0 && this.isEmpty) return null;
    const expanded = this.expandPastes(this.text);
    const trimmed = this.pastes.size === 0 ? expanded.trim() : expanded;
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
    this.pushUndoSnapshot();
    this.lastAction = null;
    this.lastYank = null;
    this.cells = Array.from(entry);
    this.cursorAt = this.cells.length;
    this.pastes.clear();
  }
}
