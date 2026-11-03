/**
 * Plan 636 -- the taskId-keyed shell output channel.
 *
 * This module is the whole coupling between a running command (one layer down)
 * and a run that renders it (one layer up), so the behaviour under test is the
 * coupling contract: keying, idempotent teardown, and the guarantee that one
 * broken subscriber cannot cost another its slice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emitShellOutput,
  hasShellOutputListener,
  onShellOutput,
  resetShellOutputListeners,
  type ShellOutputSlice,
} from '../../src/managed-shell/output-stream.js';

afterEach(() => {
  resetShellOutputListeners();
});

describe('shell output channel', () => {
  it('publishes only to the task that was subscribed', () => {
    const mine = vi.fn();
    const other = vi.fn();
    onShellOutput('task-a', mine);
    onShellOutput('task-b', other);

    emitShellOutput({ taskId: 'task-a', delta: 'first' });

    expect(mine).toHaveBeenCalledWith({ taskId: 'task-a', delta: 'first' });
    expect(other).not.toHaveBeenCalled();
  });

  it('reports presence only while a listener is attached', () => {
    expect(hasShellOutputListener('task-a')).toBe(false);
    const stop = onShellOutput('task-a', () => {});
    expect(hasShellOutputListener('task-a')).toBe(true);
    stop();
    expect(hasShellOutputListener('task-a')).toBe(false);
  });

  it('is idempotent on unsubscribe, because teardown has more than one exit', () => {
    const listener = vi.fn();
    const stop = onShellOutput('task-a', listener);
    const second = onShellOutput('task-a', listener);
    // The same function is one subscriber, not two: Set semantics, so a run that
    // subscribes twice does not receive every slice twice.
    expect(hasShellOutputListener('task-a')).toBe(true);

    stop();
    stop();
    second();

    emitShellOutput({ taskId: 'task-a', delta: 'x' });
    expect(listener).not.toHaveBeenCalled();
    expect(hasShellOutputListener('task-a')).toBe(false);
  });

  it('keeps a second listener alive while a throwing one still runs', () => {
    const broken = vi.fn(() => {
      throw new Error('subscriber blew up');
    });
    const healthy = vi.fn();
    onShellOutput('task-a', broken);
    onShellOutput('task-a', healthy);

    const slice: ShellOutputSlice = { taskId: 'task-a', delta: 'keep going' };
    expect(() => emitShellOutput(slice)).not.toThrow();

    expect(broken).toHaveBeenCalledOnce();
    expect(healthy).toHaveBeenCalledWith(slice);
    // The broken listener is still registered: this channel does not police
    // subscribers, it only refuses to let one decide the others' fate.
    expect(hasShellOutputListener('task-a')).toBe(true);
  });

  it('ignores an empty taskId instead of keying the whole map on it', () => {
    const stop = onShellOutput('', () => {});
    expect(hasShellOutputListener('')).toBe(false);
    expect(() => stop()).not.toThrow();
  });

  it('drops a slice with no subscriber rather than buffering it', () => {
    // Ephemeral by contract: a slice nobody was watching is not replayable, and
    // the final tool result is what the transcript keeps.
    expect(() => emitShellOutput({ taskId: 'nobody-home', delta: 'lost' })).not.toThrow();
  });
});
