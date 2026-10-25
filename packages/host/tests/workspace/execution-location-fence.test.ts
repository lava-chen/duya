import { describe, expect, it } from 'vitest';
import { ExecutionLocationFence, acquireExecutionLocation } from '../../src/workspace/execution-location-fence.js';

function location() {
  let cwd = '/source';
  const fence = new ExecutionLocationFence(() => cwd);
  const move = (next: string) => {
    const transition = fence.beginSwitch(fence.capture().revision);
    transition.commit(() => { cwd = next; });
  };
  return { fence, move, read: () => cwd };
}

describe('execution location admission', () => {
  it('invalidates old contexts even after moving back to the original path', () => {
    const { fence, move } = location();
    const old = fence.capture();
    move('/checkout');
    move('/source');
    expect(old.acquire()).toMatchObject({ ok: false, code: 'stale_execution_context' });
    const current = fence.capture().acquire();
    expect(current.ok).toBe(true);
    if (current.ok) current.release();
  });

  it('blocks switching until all executions release and makes release idempotent', () => {
    const { fence, move, read } = location();
    const first = fence.capture().acquire();
    const second = fence.capture().acquire();
    expect(first.ok && second.ok).toBe(true);
    expect(() => move('/checkout')).toThrow(expect.objectContaining({ code: 'execution_context_busy' }));
    if (first.ok) { first.release(); first.release(); }
    expect(() => move('/checkout')).toThrow(expect.objectContaining({ code: 'execution_context_busy' }));
    if (second.ok) second.release();
    move('/checkout');
    expect(read()).toBe('/checkout');
  });

  it('closes admission during asynchronous preparation and keeps old approvals invalid on cancellation', () => {
    const { fence, read } = location();
    const old = fence.capture();
    const transition = fence.beginSwitch(old.revision);
    expect(old.acquire()).toMatchObject({ ok: false, code: 'execution_context_switching' });
    expect(fence.capture().acquire()).toMatchObject({ ok: false, code: 'execution_context_switching' });
    expect(() => fence.beginSwitch(1)).toThrow(expect.objectContaining({ code: 'execution_context_switching' }));
    transition.cancel();
    transition.cancel();
    expect(read()).toBe('/source');
    expect(old.acquire()).toMatchObject({ ok: false, code: 'stale_execution_context' });
    expect(() => fence.beginSwitch(old.revision)).toThrow(expect.objectContaining({ code: 'stale_execution_context' }));
    expect(() => transition.commit(() => {})).toThrow(expect.objectContaining({ code: 'stale_execution_context' }));
  });

  it('reopens admission after a failed commit without reviving the previous context', () => {
    const { fence } = location();
    const old = fence.capture();
    const transition = fence.beginSwitch(old.revision);
    expect(() => transition.commit(() => { throw new Error('storage refused'); })).toThrow('storage refused');
    expect(old.acquire()).toMatchObject({ ok: false, code: 'stale_execution_context' });
    const lease = fence.capture().acquire();
    expect(lease.ok).toBe(true);
    if (lease.ok) lease.release();
  });

  it('rejects an overridden dispatch directory and preserves compatibility for unbound callers', () => {
    const { fence } = location();
    expect(acquireExecutionLocation({ executionLocation: fence.capture() }, '/other')).toMatchObject({ ok: false, code: 'stale_execution_context' });
    expect(acquireExecutionLocation(undefined, '/source').ok).toBe(true);
  });
});
