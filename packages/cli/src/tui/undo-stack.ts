/**
 * Generic undo stack with clone-on-push semantics.
 *
 * Ported from minimax-code (`packages/tui/src/tui/engine/undo-stack.ts`), whose
 * editor stores whole-buffer snapshots and pops them on undo. The class is
 * engine-independent: the CALLER owns what a snapshot looks like and when one
 * is pushed.
 *
 * `structuredClone` rather than a hand-written copy: the snapshots pushed here
 * contain arrays and Maps, and a shallow copy of either would alias the live
 * buffer — an undo that "restores" a buffer still being mutated is not an undo.
 */
export class UndoStack<S> {
  private stack: S[] = [];

  /** Push a deep clone of the given state onto the stack. */
  push(state: S): void {
    this.stack.push(structuredClone(state));
    // Bounded on purpose: a long session of large pastes must not turn the
    // editor into a memory leak. 100 snapshots is far past anything a user
    // will actually walk back through.
    if (this.stack.length > MAX_UNDO_ENTRIES) this.stack.shift();
  }

  /** Pop and return the most recent snapshot, or `undefined` if empty. */
  pop(): S | undefined {
    return this.stack.pop();
  }

  /** Remove all snapshots. */
  clear(): void {
    this.stack.length = 0;
  }

  get length(): number {
    return this.stack.length;
  }
}

/** Cap on retained snapshots; see `push`. */
export const MAX_UNDO_ENTRIES = 100;
