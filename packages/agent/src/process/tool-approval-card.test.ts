/**
 * tool-approval-card.test.ts — worker-side surface-aware permission handler
 * and card persistence (plan 498).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  append: vi.fn(async () => ({ success: true })),
  create: vi.fn(async () => ({})),
}));

vi.mock('../ipc/db-client.js', () => ({
  messageDb: { append: mocks.append },
  toolApprovalDb: {
    create: mocks.create,
    consumeApproved: vi.fn(async () => false),
    listRules: vi.fn(async () => []),
  },
}));

import { describeApprovalAction, createSurfaceAwarePermissionHandler } from './tool-approval-card';

const REQUEST = {
  id: 'perm-42',
  toolName: 'send_email',
  toolInput: { to: 'a@b.c' },
  mode: 'generic',
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  mocks.append.mockClear();
  mocks.create.mockClear();
});

describe('createSurfaceAwarePermissionHandler', () => {
  it('bot surface persists the card and returns paused without consulting the base handler', async () => {
    const base = vi.fn(async () => 'allow' as const);
    const handler = createSurfaceAwarePermissionHandler(base, {
      sessionId: 'bot:tester',
      surface: 'bot',
      botAgentId: 'tester',
    });
    await expect(handler(REQUEST)).resolves.toBe('paused');
    expect(base).not.toHaveBeenCalled();

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'perm-42',
        messageId: 'approval-card-perm-42',
        sessionId: 'bot:tester',
        scopeType: 'bot',
        scopeId: 'tester',
        toolName: 'send_email',
      }),
    );
    const [sessionId, messages] = mocks.append.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(sessionId).toBe('bot:tester');
    const card = messages[0];
    expect(card.id).toBe('approval-card-perm-42');
    expect(card.msg_type).toBe('tool-approval');
    expect(card.source).toBe('send_message');
    expect((card.metadata as { sendMessage: { approval: { approvalId: string } } }).sendMessage.approval.approvalId).toBe('perm-42');
  });

  it('default surface persists the card (crash fallback) and delegates to the base handler', async () => {
    const base = vi.fn(async () => 'deny' as const);
    const handler = createSurfaceAwarePermissionHandler(base, {
      sessionId: 'sess-1',
      surface: 'default',
    });
    await expect(handler(REQUEST)).resolves.toBe('deny');
    expect(base).toHaveBeenCalledWith(REQUEST);
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ scopeType: 'session', scopeId: 'sess-1' }),
    );
  });

  it('two-phase prompts (ask_user_question) are never persisted nor paused', async () => {
    const base = vi.fn(async () => 'allow' as const);
    const handler = createSurfaceAwarePermissionHandler(base, {
      sessionId: 'bot:tester',
      surface: 'bot',
      botAgentId: 'tester',
    });
    await expect(handler({ ...REQUEST, mode: 'ask_user_question' })).resolves.toBe('allow');
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it('a failed card write still pauses on the bot surface (best-effort persistence)', async () => {
    mocks.create.mockRejectedValueOnce(new Error('db closed'));
    const base = vi.fn(async () => 'allow' as const);
    const handler = createSurfaceAwarePermissionHandler(base, {
      sessionId: 'bot:tester',
      surface: 'bot',
      botAgentId: 'tester',
    });
    await expect(handler(REQUEST)).resolves.toBe('paused');
  });
});

describe('describeApprovalAction', () => {
  it('summarizes the tool plus a few key params', () => {
    const text = describeApprovalAction('send_email', { to: 'a@b.c', subject: 'hi', extra: 'x' });
    expect(text).toContain('send_email');
    expect(text).toContain('to: a@b.c');
    expect(text).toContain('subject: hi');
    expect(text).not.toContain('extra');
  });

  it('falls back to the bare tool name', () => {
    expect(describeApprovalAction('do_thing', {})).toBe('Approval needed: do_thing');
  });
});
