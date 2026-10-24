/**
 * A FIFO concurrency gate whose limit can be changed while work is active.
 * Lowering the limit never interrupts in-flight work; queued work starts as
 * permits become available under the new limit.
 */
export class ConcurrencyGate {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private currentLimit: number) {
    this.assertLimit(currentLimit);
  }

  get limit(): number {
    return this.currentLimit;
  }

  get active(): number {
    return this.activeCount;
  }

  get pending(): number {
    return this.waiters.length;
  }

  setLimit(limit: number): void {
    this.assertLimit(limit);
    this.currentLimit = limit;
    this.drain();
  }

  async acquire(): Promise<() => void> {
    if (this.activeCount >= this.currentLimit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.activeCount++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeCount--;
      this.drain();
    };
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  private drain(): void {
    const available = Math.max(0, this.currentLimit - this.activeCount);
    for (let i = 0; i < available && this.waiters.length > 0; i++) {
      this.waiters.shift()?.();
    }
  }

  private assertLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('concurrency limit must be an integer >= 1');
  }
}

export function readyNodes<T extends { id: string }>(
  nodes: readonly T[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  completed: ReadonlySet<string>,
): T[] {
  return nodes.filter((node) =>
    !completed.has(node.id) &&
    [...(dependencies.get(node.id) ?? [])].every((dependency) => completed.has(dependency)),
  );
}
