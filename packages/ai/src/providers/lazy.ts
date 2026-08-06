import type { ApiFormat, Model, SSEEvent } from '../types.js';

/**
 * Async generator that awaits a setup promise before yielding, forwarding
 * events and the final return value. Used to defer loading a provider api
 * module until the first stream is requested.
 */
export function lazyStream(
  model: Model,
  setup: () => Promise<AsyncGenerator<SSEEvent, unknown, unknown>>,
): AsyncGenerator<SSEEvent, unknown, unknown> {
  return (async function* () {
    const inner = await setup();
    let next = await inner.next();
    while (!next.done) {
      yield next.value;
      next = await inner.next();
    }
    return next.value;
  })();
}

/**
 * A provider api module that knows how to stream tokens for a model.
 * `stream` yields SSE events and returns an opaque final value (e.g. the
 * assistant message) as the generator return.
 */
export interface ProviderStreams<T extends ApiFormat = ApiFormat> {
  stream(
    model: Model<T>,
    options: { messages: unknown[]; systemPrompt?: string },
  ): AsyncGenerator<SSEEvent, unknown, unknown>;
}

/**
 * Wrap a lazily-loaded ProviderStreams so the underlying module is imported
 * only on the first stream call.
 */
export function lazyApi(load: () => Promise<ProviderStreams>): ProviderStreams {
  return {
    stream: (model, options) =>
      lazyStream(model, async () => (await load()).stream(model, options)),
  };
}