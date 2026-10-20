/** Low overhead, process-local performance recorder used by the lab harness. */
export const noopPerfRecorder = Object.freeze({
  count() {},
  span(_name, _attributes, work) { return work(); },
});

export class PerfRecorder {
  #spans = [];
  #counters = new Map();
  #clock;

  constructor(clock = () => performance.now()) {
    this.#clock = clock;
  }

  count(name, value = 1) {
    this.#counters.set(name, (this.#counters.get(name) ?? 0) + value);
  }

  span(name, attributes, work) {
    const start = this.#clock();
    const finish = (status) => this.#spans.push({
      name,
      attributes,
      durationMs: Math.max(0, this.#clock() - start),
      status,
    });
    let value;
    try {
      value = work();
    } catch (error) {
      finish('error');
      throw error;
    }
    if (value != null && typeof value.then === 'function') {
      return value.then(
        (result) => { finish('ok'); return result; },
        (error) => { finish('error'); throw error; },
      );
    }
    finish('ok');
    return value;
  }

  spanIterable(name, attributes, iterable) {
    const recorder = this;
    return (async function* () {
      const start = recorder.#clock();
      let status = 'ok';
      try {
        yield* iterable;
      } catch (error) {
        status = 'error';
        throw error;
      } finally {
        recorder.#spans.push({
          name,
          attributes,
          durationMs: Math.max(0, recorder.#clock() - start),
          status,
        });
      }
    })();
  }

  snapshot() {
    return {
      counters: Object.fromEntries([...this.#counters].sort(([a], [b]) => a.localeCompare(b))),
      spans: this.#spans.map((span) => ({ ...span })),
    };
  }
}
