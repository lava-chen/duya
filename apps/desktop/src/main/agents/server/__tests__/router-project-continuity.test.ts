import { describe, expect, it, vi } from 'vitest';
import { resolveProjectContinuityPrompt } from '../router';

/**
 * The old bootstrap keyed continuity by `projectId`, which came from a cwd
 * reverse-lookup. That cannot distinguish a Coordinator from a work Session,
 * cannot supply the work Session's Task, and picks the wrong project when two
 * share a directory. These tests pin the Session-keyed replacement and the
 * fact that it is re-read on every chat init (i.e. every Run).
 */

function contextResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    context: {
      text: '## Project continuity: duya\n### Next step\nShip it',
      projectName: 'duya',
      role: 'coordinator',
      taskId: null,
      ...overrides,
    },
  };
}

describe('resolveProjectContinuityPrompt', () => {
  it('asks the Host by Session id — never by a caller-supplied project id', async () => {
    const dbRequest = vi.fn().mockResolvedValue(contextResult());
    const prompt = await resolveProjectContinuityPrompt(dbRequest, 'session-1', 'base');

    expect(dbRequest).toHaveBeenCalledWith('project:continuity-context', { sessionId: 'session-1' });
    expect(prompt).toContain('## Durable Project Context: duya');
    expect(prompt).toContain('You are the project COORDINATOR session.');
    expect(prompt).toContain('Ship it');
    expect(prompt?.startsWith('base\n\n')).toBe(true);
  });

  it('tells a work Session which Task it was dispatched for', async () => {
    const dbRequest = vi.fn().mockResolvedValue(contextResult({ role: 'work', taskId: 'task-42' }));
    const prompt = await resolveProjectContinuityPrompt(dbRequest, 'session-work', undefined);

    expect(prompt).toContain('You are a WORK session for task task-42.');
    expect(prompt).not.toContain('COORDINATOR session');
    expect(prompt?.startsWith('## Durable Project Context')).toBe(true);
  });

  it('re-reads continuity on every call, so a confirmed decision reaches the next Run', async () => {
    const dbRequest = vi.fn()
      .mockResolvedValueOnce(contextResult())
      .mockResolvedValueOnce(contextResult({ text: '## Project continuity: duya\n### Project memory\n- owner: A' }));

    const first = await resolveProjectContinuityPrompt(dbRequest, 'session-1', 'base');
    const second = await resolveProjectContinuityPrompt(dbRequest, 'session-1', 'base');

    expect(dbRequest).toHaveBeenCalledTimes(2);
    expect(first).toContain('Ship it');
    expect(first).not.toContain('owner: A');
    expect(second).toContain('owner: A');
  });

  it('leaves an ordinary non-project Session untouched', async () => {
    const dbRequest = vi.fn().mockResolvedValue({ success: true, context: null });
    await expect(resolveProjectContinuityPrompt(dbRequest, 'session-plain', 'base')).resolves.toBe('base');
    expect(dbRequest).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: no dbRequest, a failed read, or a bad shape all keep the chat alive', async () => {
    await expect(resolveProjectContinuityPrompt(undefined, 'session-1', 'base')).resolves.toBe('base');

    const failed = vi.fn().mockResolvedValue({ success: false, error: 'sessionId_required' });
    await expect(resolveProjectContinuityPrompt(failed, 'session-1', 'base')).resolves.toBe('base');

    const malformed = vi.fn().mockResolvedValue({ success: true, context: { text: 42 } });
    await expect(resolveProjectContinuityPrompt(malformed, 'session-1', 'base')).resolves.toBe('base');

    const warn = vi.fn();
    const throwing = vi.fn().mockRejectedValue(new Error('db offline'));
    await expect(resolveProjectContinuityPrompt(throwing, 'session-1', 'base', warn)).resolves.toBe('base');
    expect(warn).toHaveBeenCalledWith('Could not load project continuity context',
      expect.objectContaining({ sessionId: 'session-1', error: 'db offline' }));
  });
});
