import test from 'node:test';
import assert from 'node:assert/strict';
import { noopPerfRecorder, PerfRecorder } from './recorder.mjs';

test('records synchronous and asynchronous spans without changing return values', async () => {
  let now = 10;
  const recorder = new PerfRecorder(() => now);
  const sync = recorder.span('sync', { phase: 'fixture' }, () => { now += 2; return 42; });
  const async = await recorder.span('async', {}, async () => { now += 3; return 'done'; });
  assert.equal(sync, 42);
  assert.equal(async, 'done');
  assert.deepEqual(recorder.snapshot().spans.map(({ name, durationMs, status }) => ({ name, durationMs, status })), [
    { name: 'sync', durationMs: 2, status: 'ok' },
    { name: 'async', durationMs: 3, status: 'ok' },
  ]);
});

test('records thrown and rejected work, then preserves the original error', async () => {
  const recorder = new PerfRecorder(() => 1);
  assert.throws(() => recorder.span('throw', {}, () => { throw new Error('sync failure'); }), /sync failure/);
  await assert.rejects(recorder.span('reject', {}, async () => { throw new Error('async failure'); }), /async failure/);
  assert.deepEqual(recorder.snapshot().spans.map(({ status }) => status), ['error', 'error']);
});

test('records the lifetime of an async iterable through its final frame', async () => {
  let now = 0;
  const recorder = new PerfRecorder(() => now);
  const source = (async function* () {
    now += 2;
    yield 'first';
    now += 3;
    yield 'last';
  })();
  const values = [];
  for await (const value of recorder.spanIterable('provider.stream', {}, source)) values.push(value);
  assert.deepEqual(values, ['first', 'last']);
  assert.deepEqual(recorder.snapshot().spans, [
    { name: 'provider.stream', attributes: {}, durationMs: 5, status: 'ok' },
  ]);
});

test('counts aggregate values and noop recorder preserves sync/async calls', async () => {
  const recorder = new PerfRecorder();
  recorder.count('events');
  recorder.count('events', 4);
  assert.equal(recorder.snapshot().counters.events, 5);
  assert.equal(noopPerfRecorder.span('sync', {}, () => 9), 9);
  assert.equal(await noopPerfRecorder.span('async', {}, async () => 11), 11);
  assert.doesNotThrow(() => noopPerfRecorder.count('ignored'));
});
