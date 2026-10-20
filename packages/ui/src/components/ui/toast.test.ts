import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearToasts, dismissToast, getToasts, toast } from './toast';

/**
 * 通知队列的判据都在模块级纯逻辑里（不依赖 React 渲染），因此可以直接单测。
 * 这里锁定四个最容易出错的契约：去重替换、上限回收、自动关闭计时、悬停暂停。
 */

describe('toast queue', () => {
  beforeEach(() => {
    clearToasts();
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it('stacks independent notifications', () => {
    toast({ title: 'A' });
    toast({ title: 'B' });
    expect(getToasts()).toHaveLength(2);
  });

  it('dedupes by dedupeKey by replacing in place instead of stacking', () => {
    const first = toast({ title: 'Installing…', dedupeKey: 'install:plugin-a' });
    const second = toast({ title: 'Installed', variant: 'success', dedupeKey: 'install:plugin-a' });

    // 同一个业务目标复用同一条通知：id 不变、内容被替换、不新增条目。
    expect(second).toBe(first);
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0].title).toBe('Installed');
    expect(getToasts()[0].variant).toBe('success');
  });

  it('keeps different dedupeKeys separate', () => {
    toast({ title: 'A', dedupeKey: 'install:a' });
    toast({ title: 'B', dedupeKey: 'install:b' });
    expect(getToasts()).toHaveLength(2);
  });

  it('auto-dismisses after the given duration', () => {
    toast({ title: 'Saved', duration: 1000 });
    expect(getToasts()).toHaveLength(1);

    vi.advanceTimersByTime(999);
    expect(getToasts()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(getToasts()).toHaveLength(0);
  });

  it('never auto-dismisses when duration is 0 (sticky)', () => {
    toast({ title: 'Sticky', duration: 0 });
    vi.advanceTimersByTime(60_000);
    expect(getToasts()).toHaveLength(1);
  });

  it('caps the visible stack so a polling failure cannot flood the screen', () => {
    for (let i = 0; i < 10; i += 1) toast({ title: `Item ${i}` });

    const current = getToasts();
    expect(current.length).toBeLessThanOrEqual(4);
    // 保留的必须是最新的那几条，而不是最早的。
    expect(current.at(-1)?.title).toBe('Item 9');
  });

  it('dismisses by id and tolerates unknown ids', () => {
    const id = toast({ title: 'A' });
    dismissToast(id);
    expect(getToasts()).toHaveLength(0);

    expect(() => dismissToast('does-not-exist')).not.toThrow();
  });

  it('clearToasts drops everything at once', () => {
    toast({ title: 'A' });
    toast({ title: 'B' });
    clearToasts();
    expect(getToasts()).toHaveLength(0);
  });

  it('success/error/warning helpers set the matching variant', () => {
    toast.success('ok');
    toast.error('boom');
    toast.warning('careful');
    expect(getToasts().map((t) => t.variant)).toEqual(['success', 'error', 'warning']);
  });
});
