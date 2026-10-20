/** Invalidates stale run-history restores when a newer run is started. */
export class RunAttachmentGate {
  #generation = 0;

  beginRestore(): number {
    this.#generation += 1;
    return this.#generation;
  }

  invalidateRestores(): void {
    this.#generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }
}
