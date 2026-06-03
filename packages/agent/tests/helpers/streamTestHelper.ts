/**
 * Collect all events from an async generator into an array
 */
export async function collectStreamEvents<T>(
  generator: AsyncGenerator<T, void, unknown>
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

/**
 * Collect events up to a specified count or until predicate returns false
 */
export async function collectStreamEventsUntil<T>(
  generator: AsyncGenerator<T, void, unknown>,
  maxCount: number,
  predicate?: (event: T) => boolean
): Promise<T[]> {
  const events: T[] = [];
  for await (const event of generator) {
    if (events.length >= maxCount) break;
    if (predicate && !predicate(event)) break;
    events.push(event);
  }
  return events;
}

/**
 * Test helper to verify stream event sequence
 */
export async function expectStreamEvents<T>(
  generator: AsyncGenerator<T, void, unknown>,
  expected: Array<{ type?: string; check?: (event: T) => boolean }>
): Promise<T[]> {
  const events: T[] = [];

  for await (const event of generator) {
    events.push(event);
    if (events.length > expected.length) {
      throw new Error(
        `Expected ${expected.length} events but got ${events.length}. ` +
        `Extra event: ${JSON.stringify(event)}`
      );
    }
  }

  expect(events).toHaveLength(expected.length);

  for (let i = 0; i < expected.length; i++) {
    const event = events[i];
    const exp = expected[i];
    expect(event).toBeDefined();
    if (exp.check) {
      expect(exp.check(event)).toBe(true);
    }
  }

  return events;
}

/**
 * Test streaming with abort signal
 */
export async function testStreamInterruption<T>(
  createGenerator: (signal: AbortSignal) => AsyncGenerator<T, void, unknown>,
  abortAfterMs: number
): Promise<T[]> {
  const abortController = new AbortController();
  const events: T[] = [];

  const timeout = setTimeout(() => abortController.abort(), abortAfterMs);

  try {
    for await (const event of createGenerator(abortController.signal)) {
      events.push(event);
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      throw error;
    }
  } finally {
    clearTimeout(timeout);
  }

  return events;
}

/**
 * Create a mock async generator for testing consumers
 */
export function createMockStream<T>(events: T[]): AsyncGenerator<T, void, unknown> {
  let index = 0;
  return {
    next: async () => {
      if (index < events.length) {
        return { value: events[index++], done: false };
      }
      return { value: undefined, done: true };
    },
    return: async () => ({ value: undefined, done: true }),
    throw: async (err: Error) => Promise.reject(err),
    [Symbol.asyncIterator]: () => createMockStream(events),
  };
}
