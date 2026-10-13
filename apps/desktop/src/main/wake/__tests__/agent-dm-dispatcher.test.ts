/**
 * agent-dm-dispatcher.test.ts — Plan 477 P3.1 agent_dm mailbox → wake queue
 * adapter. Mirrors `idle-dispatcher.test.ts`: covers the gate (kind/sessionId),
 * the idempotent bot-session get-or-create (DB-level), and the enqueue +
 * dm-prompt rendering against the injected wake dispatcher deps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  maybeDispatchAgentDm,
  defaultBotSessionCreator,
  _setBotSessionCreatorForTest,
} from '../agent-dm-dispatcher'
import { encodeEnvelope } from '@duya/agent-protocol'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  _queuedWakeCount,
} from '../wake-dispatcher'

const mailboxApi = vi.hoisted(() => ({
  getByClientMsgId: vi.fn(async () => null as { content: string } | null),
}))
const hostSessionApi = vi.hoisted(() => ({
  get: vi.fn(async () => null as { id: string } | null),
  create: vi.fn(async (input: Record<string, unknown>) => input),
  appendTimeline: vi.fn(async () => ({ writtenCount: 1 })),
}))
const localSessionApi = vi.hoisted(() => ({
  readLocalSession: vi.fn(async () => null as { agentName?: string } | null),
}))

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostLocalMailboxApi: () => mailboxApi,
  getDesktopHostSessionApi: () => hostSessionApi,
  getDesktopHostLocalSessionApi: () => localSessionApi,
}))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function envelope(from = { id: 'bot-a', name: 'Alpha' }, text = 'Hello peer', clientMsgId = 'dm-1'): string {
  return encodeEnvelope({
    from,
    to: { id: 'bot-b', name: 'Beta' },
    text,
    timestampMs: Date.now(),
    clientMsgId,
  })
}

describe('defaultBotSessionCreator (Host session API)', () => {
  beforeEach(() => {
    hostSessionApi.get.mockReset()
    hostSessionApi.get.mockResolvedValue(null)
    hostSessionApi.create.mockReset()
  })

  it('creates a bot session carrying its profile and source metadata', async () => {
    await defaultBotSessionCreator.createIfMissing('bot:target', 'target')
    expect(hostSessionApi.get).toHaveBeenCalledWith('bot:target', { includeAllSessions: true })
    expect(hostSessionApi.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'bot:target',
      title: 'target',
      status: 'active',
      mode: 'chat',
      permissionMode: 'auto',
      agentType: 'bot',
      agentName: 'target',
      agentProfileId: 'target',
      extensions: { source: 'bot' },
    }))
  })

  it('does not update an existing bot session', async () => {
    hostSessionApi.get.mockResolvedValue({ id: 'bot:target' })
    await defaultBotSessionCreator.createIfMissing('bot:target', 'target')
    expect(hostSessionApi.create).not.toHaveBeenCalled()
  })
})

describe('maybeDispatchAgentDm (orchestration)', () => {
  const calls: Array<{ sessionId: string; agentId: string }> = []
  const fakeCreator = {
    createIfMissing: (sessionId: string, agentId: string): void => {
      calls.push({ sessionId, agentId })
    },
  }

  const dmRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 'mail-1',
    sessionId: 'bot:bot-b',
    kind: 'agent_dm',
    content: envelope(),
    clientMsgId: 'dm-1',
    ...overrides,
  })

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    calls.length = 0
    _setBotSessionCreatorForTest(fakeCreator)
    _setWakeDispatcherDeps({ isLocked: () => true, runWake: async () => {} })
    mailboxApi.getByClientMsgId.mockResolvedValue(null)
  })

  afterEach(() => {
    _resetWakeDispatcherForTest()
  })

  it('ignores non-agent_dm kinds', async () => {
    const result = await maybeDispatchAgentDm(dmRow({ kind: 'queued' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(0)
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('ignores rows without a sessionId', async () => {
    const result = await maybeDispatchAgentDm(dmRow({ sessionId: '' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(0)
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('ensures the target bot session and enqueues one agent.dm wake', async () => {
    const result = await maybeDispatchAgentDm(dmRow())
    expect(result).toBe(true)
    // createIfMissing receives the fixed `bot:<agentId>` session id and the
    // parsed agent id (the `bot:` prefix stripped).
    expect(calls).toEqual([{ sessionId: 'bot:bot-b', agentId: 'bot-b' }])
    expect(_queuedWakeCount('bot:bot-b')).toBe(1)
  })

  it('falls back to row.id as the clientMsgId when missing', async () => {
    const result = await maybeDispatchAgentDm(
      dmRow({ content: envelope({ id: 'bot-a', name: 'Alpha' }, 'hi', 'dm-1'), clientMsgId: null }),
    )
    expect(result).toBe(true)
    expect(_queuedWakeCount('bot:bot-b')).toBe(1)
  })

  it('returns false for unparseable content but still ensures the session', async () => {
    const result = await maybeDispatchAgentDm(dmRow({ content: 'not-json' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(1) // session is still ensured best-effort
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('drains and renders the dm prompt with the sender identity', async () => {
    const runWake = vi.fn(async () => {})
    _setWakeDispatcherDeps({ isLocked: () => false, runWake })
    const result = await maybeDispatchAgentDm(dmRow())
    expect(result).toBe(true)
    await flush()
    expect(runWake).toHaveBeenCalledTimes(1)
    const prompt = runWake.mock.calls[0][1] as string
    expect(prompt).toContain('Alpha')
    expect(prompt).toContain('Hello peer')
    // It must carry the target agent's identity so the woken worker builds
    // the bot profile.
    expect(runWake.mock.calls[0][2]).toMatchObject({ agentProfileId: 'bot-b' })
  })

  // ---- Plan 477 P4.1/P4.2 — intent-driven prompt + hop limit ----

  it('renders the intent-driven request paragraph (auto-return promise)', async () => {
    const content = encodeEnvelope({
      from: { id: 'bot-a', name: 'Alpha' },
      to: { id: 'bot-b', name: 'Beta' },
      text: 'Please summarize the report',
      intent: 'request',
      timestampMs: Date.now(),
      clientMsgId: 'dm-intent',
    })
    const runWake = vi.fn(async () => {})
    _setWakeDispatcherDeps({ isLocked: () => false, runWake })
    expect(await maybeDispatchAgentDm(dmRow({ content, clientMsgId: 'dm-intent' }))).toBe(true)
    await flush()
    const prompt = runWake.mock.calls[0][1] as string
    expect(prompt).toContain('AUTOMATICALLY returned to Alpha')
    // The cue must expose the clientMsgId so replies can thread (P4.2).
    expect(prompt).toContain('replyToMessageId: dm-intent')
  })

  it('renders the fyi paragraph (silence acceptable)', async () => {
    const content = encodeEnvelope({
      from: { id: 'bot-a', name: 'Alpha' },
      to: { id: 'bot-b', name: 'Beta' },
      text: 'FYI only',
      intent: 'fyi',
      timestampMs: Date.now(),
      clientMsgId: 'dm-fyi',
    })
    const runWake = vi.fn(async () => {})
    _setWakeDispatcherDeps({ isLocked: () => false, runWake })
    expect(await maybeDispatchAgentDm(dmRow({ content, clientMsgId: 'dm-fyi' }))).toBe(true)
    await flush()
    const prompt = runWake.mock.calls[0][1] as string
    expect(prompt).toContain('This is an FYI')
    expect(prompt).toContain('staying silent is fine')
  })

  it('accepts a DM whose replyTo chain is very deep (no hop cap)', async () => {
    // hops=6 inbound in the sender's mailbox → the reply would resolve to
    // hops=7. There is no longer a hop cap that drops it: multi-round bot↔bot
    // exchange is the intended shape (grok parity), so the deep reply is woken
    // normally even at depth past any historical limit.
    const inboundContent = encodeEnvelope({
      from: { id: 'bot-b', name: 'Beta' },
      to: { id: 'bot-a', name: 'Alpha' },
      text: 'deep chain',
      hops: 6,
      timestampMs: Date.now(),
      clientMsgId: 'dm-deep',
    })
    mailboxApi.getByClientMsgId.mockResolvedValue({ content: inboundContent })
    try {
      const replyContent = encodeEnvelope({
        from: { id: 'bot-a', name: 'Alpha' },
        to: { id: 'bot-b', name: 'Beta' },
        text: 'deep reply stays delivered',
        replyTo: { messageId: 'dm-deep' },
        timestampMs: Date.now(),
        clientMsgId: 'dm-reply',
      })
      const runWake = vi.fn(async () => {})
      _setWakeDispatcherDeps({ isLocked: () => false, runWake })
      const result = await maybeDispatchAgentDm(
        dmRow({ content: replyContent, clientMsgId: 'dm-reply', source: 'bot:bot-a' }),
      )
      expect(result).not.toBe(false)
      await flush()
      expect(runWake).toHaveBeenCalledTimes(1)
      expect(runWake.mock.calls[0][1] as string).toContain('deep reply stays delivered')
    } finally {
      mailboxApi.getByClientMsgId.mockResolvedValue(null)
    }
  })

  it('accepts a reply within the hop chain and passes computed hops', async () => {
    const inboundContent = encodeEnvelope({
      from: { id: 'bot-b', name: 'Beta' },
      to: { id: 'bot-a', name: 'Alpha' },
      text: 'shallow chain',
      hops: 1,
      timestampMs: Date.now(),
      clientMsgId: 'dm-shallow',
    })
    mailboxApi.getByClientMsgId.mockResolvedValue({ content: inboundContent })
    try {
      const replyContent = encodeEnvelope({
        from: { id: 'bot-a', name: 'Alpha' },
        to: { id: 'bot-b', name: 'Beta' },
        text: 'within limit',
        replyTo: { messageId: 'dm-shallow' },
        intent: 'status',
        timestampMs: Date.now(),
        clientMsgId: 'dm-reply-2',
      })
      const runWake = vi.fn(async () => {})
      _setWakeDispatcherDeps({ isLocked: () => false, runWake })
      expect(
        await maybeDispatchAgentDm(dmRow({ content: replyContent, clientMsgId: 'dm-reply-2', source: 'bot:bot-a' })),
      ).toBe(true)
      await flush()
      expect(runWake).toHaveBeenCalledTimes(1)
      const prompt = runWake.mock.calls[0][1] as string
      expect(prompt).toContain('within limit')
    } finally {
      mailboxApi.getByClientMsgId.mockResolvedValue(null)
    }
  })
})
