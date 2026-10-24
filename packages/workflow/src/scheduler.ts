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
    if (this.activeCount < this.currentLimit) {
      this.activeCount++;
      return this.createRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.createRelease();
  }

  private createRelease(): () => void {
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
    while (this.activeCount < this.currentLimit && this.waiters.length > 0) {
      this.activeCount++;
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

export interface AimdGovernorOptions {
  initialLimit: number;
  minLimit?: number;
  maxLimit?: number;
  additiveIncrease?: number;
  multiplicativeDecrease?: number;
  increaseEvery?: number;
  onChange?: (event: { previous: number; current: number; cause: 'success' | 'congestion' }) => void;
}

/** Shared provider-level AIMD controller, separate from any run's gate. */
export class AimdConcurrencyGovernor {
  private readonly gate: ConcurrencyGate;
  private readonly minLimit: number;
  private readonly maxLimit: number;
  private readonly additiveIncrease: number;
  private readonly multiplicativeDecrease: number;
  private readonly increaseEvery: number;
  private successes = 0;

  constructor(private readonly options: AimdGovernorOptions) {
    this.minLimit = options.minLimit ?? 1;
    this.maxLimit = options.maxLimit ?? 32;
    this.additiveIncrease = options.additiveIncrease ?? 1;
    this.multiplicativeDecrease = options.multiplicativeDecrease ?? 0.5;
    this.increaseEvery = options.increaseEvery ?? 4;
    if (!Number.isInteger(this.minLimit) || this.minLimit < 1) throw new Error('AIMD minLimit must be >= 1');
    if (!Number.isInteger(this.maxLimit) || this.maxLimit < this.minLimit) throw new Error('AIMD maxLimit must be >= minLimit');
    if (!Number.isInteger(this.additiveIncrease) || this.additiveIncrease < 1) throw new Error('AIMD additiveIncrease must be >= 1');
    if (!(this.multiplicativeDecrease > 0 && this.multiplicativeDecrease < 1)) {
      throw new Error('AIMD multiplicativeDecrease must be between 0 and 1');
    }
    if (!Number.isInteger(this.increaseEvery) || this.increaseEvery < 1) throw new Error('AIMD increaseEvery must be >= 1');
    this.gate = new ConcurrencyGate(Math.max(this.minLimit, Math.min(this.maxLimit, options.initialLimit)));
  }

  get limit(): number {
    return this.gate.limit;
  }

  get active(): number {
    return this.gate.active;
  }

  run<T>(
    task: () => Promise<T>,
    isCongestion: (errorOrResult: unknown) => boolean,
    isSuccessful: (result: T) => boolean = () => true,
  ): Promise<T> {
    return this.gate.run(async () => {
      try {
        const value = await task();
        if (isSuccessful(value)) this.recordSuccess();
        else if (isCongestion(value)) this.recordCongestion();
        return value;
      } catch (error) {
        if (isCongestion(error)) this.recordCongestion();
        throw error;
      }
    });
  }

  recordSuccess(): number {
    this.successes++;
    if (this.successes < this.increaseEvery || this.limit >= this.maxLimit) return this.limit;
    this.successes = 0;
    const previous = this.limit;
    const current = Math.min(this.maxLimit, previous + this.additiveIncrease);
    this.gate.setLimit(current);
    this.options.onChange?.({ previous, current, cause: 'success' });
    return current;
  }

  recordCongestion(): number {
    this.successes = 0;
    const previous = this.limit;
    const current = Math.max(this.minLimit, Math.floor(previous * this.multiplicativeDecrease));
    if (current === previous) return current;
    this.gate.setLimit(current);
    this.options.onChange?.({ previous, current, cause: 'congestion' });
    return current;
  }
}

/** Host scoped registry shares one governor per upstream provider key. */
export class ProviderGovernorRegistry {
  private readonly governors = new Map<string, AimdConcurrencyGovernor>();

  constructor(private readonly optionsFor: (provider: string) => AimdGovernorOptions) {}

  forProvider(provider: string): AimdConcurrencyGovernor {
    let governor = this.governors.get(provider);
    if (!governor) {
      governor = new AimdConcurrencyGovernor(this.optionsFor(provider));
      this.governors.set(provider, governor);
    }
    return governor;
  }
}
