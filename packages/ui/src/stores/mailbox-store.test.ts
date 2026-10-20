// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/stream-session-manager', () => ({ deliverQueuedRow: vi.fn(), resumeBackgroundTask: vi.fn() }));
import { useMailboxStore } from './mailbox-store';

beforeEach(() => useMailboxStore.setState({ bySession: new Map() }));
describe('pending edit lifecycle', () => {
  it('does not authorize replacement when the agent has already claimed the row', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { mailbox: { cancel: vi.fn().mockResolvedValue(null) } } });
    expect(await useMailboxStore.getState().cancel('row')).toBeNull();
  });
  it('returns a cancellation receipt before the composer replaces a pending row', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { mailbox: { cancel: vi.fn().mockResolvedValue({ id: 'row', session_id: 's', status: 'cancelled' }) } } });
    expect(await useMailboxStore.getState().cancel('row')).toMatchObject({ id: 'row', status: 'cancelled' });
  });
  it('removes failed optimistic input and propagates the failure to the composer', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { mailbox: { send: vi.fn().mockRejectedValue(new Error('not saved')) } } });
    await expect(useMailboxStore.getState().send({ sessionId: 's', content: 'input', kind: 'queued', submittedDuringRunId: 'run' })).rejects.toThrow('not saved');
    expect(useMailboxStore.getState().getBySession('s')).toEqual([]);
  });
});
