/**
 * agent-dm-dispatcher.test.ts — Plan 477 P3.1 agent_dm mailbox → wake queue
 * adapter. Mirrors `idle-dispatcher.test.ts`: covers the gate (kind/sessionId),
 * the idempotent bot-session get-or-create (DB-level), and the enqueue +
 * dm-prompt rendering against the injected wake dispatcher deps.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  maybeDispatchAgentDm,
  defaultBotSessionCreator,
  _setBotSessionCreatorForTest,
} from '../agent-dm-dispatcher'
import { _setCoreStoresForTesting, type CoreStores } from '../../db/core-connection'
import { SessionStore } from '../../db/core/session-store'
import { encodeEnvelope } from '../../../packages/agent/src/agent/dm/index.js'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
  _queuedWakeCount,
} from '../wake-dispatcher'
import type { SqliteDatabase } from '../../db/core/database'

let nativeSqliteAvailable = true
try {
  const probe = new Database(':memory:')
  probe.close()
} catch {
  nativeSqliteAvailable = false
}

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

describe.skipIf(!nativeSqliteAvailable)('defaultBotSessionCreator (core store)', () => {
  let tempDir: string
  let db: SqliteDatabase
  let sessionStore: SessionStore

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dm-test-'))
    db = new Database(path.join(tempDir, 'core.db')) as unknown as SqliteDatabase
    for (const m of SessionStore.migrations) m.up(db)
    sessionStore = new SessionStore(db)
    // Only `sessions` is consumed by the default creator; stub the rest.
    _setCoreStoresForTesting({ sessions: sessionStore } as unknown as CoreStores)
  })

  afterEach(() => {
    _setCoreStoresForTesting(null)
    try { db.close() } catch { /* already closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort */ }
  })

  it('creates a bot session carrying agent_profile_id + extensions.source=bot', () => {
    defaultBotSessionCreator.createIfMissing('bot:target', 'target')
    const s = sessionStore.get('bot:target')
    expect(s).not.toBeNull()
    expect(s!.agentProfileId).toBe('target')
    expect(s!.extensions.source).toBe('bot')
    expect(s!.agentType).toBe('bot')
  })

  it('is idempotent on an existing session', () => {
    defaultBotSessionCreator.createIfMissing('bot:target', 'target')
    // The second call must short-circuit on the get() guard — a real
    // duplicate INSERT would throw on the PRIMARY KEY.
    defaultBotSessionCreator.createIfMissing('bot:target', 'target')
    expect(sessionStore.get('bot:target')!.agentProfileId).toBe('target')
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
  })

  afterEach(() => {
    _resetWakeDispatcherForTest()
  })

  it('ignores non-agent_dm kinds', () => {
    const result = maybeDispatchAgentDm(dmRow({ kind: 'queued' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(0)
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('ignores rows without a sessionId', () => {
    const result = maybeDispatchAgentDm(dmRow({ sessionId: '' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(0)
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('ensures the target bot session and enqueues one agent.dm wake', () => {
    const result = maybeDispatchAgentDm(dmRow())
    expect(result).toBe(true)
    // createIfMissing receives the fixed `bot:<agentId>` session id and the
    // parsed agent id (the `bot:` prefix stripped).
    expect(calls).toEqual([{ sessionId: 'bot:bot-b', agentId: 'bot-b' }])
    expect(_queuedWakeCount('bot:bot-b')).toBe(1)
  })

  it('falls back to row.id as the clientMsgId when missing', () => {
    const result = maybeDispatchAgentDm(
      dmRow({ content: envelope({ id: 'bot-a', name: 'Alpha' }, 'hi', 'dm-1'), clientMsgId: null }),
    )
    expect(result).toBe(true)
    expect(_queuedWakeCount('bot:bot-b')).toBe(1)
  })

  it('returns false for unparseable content but still ensures the session', () => {
    const result = maybeDispatchAgentDm(dmRow({ content: 'not-json' }))
    expect(result).toBe(false)
    expect(calls.length).toBe(1) // session is still ensured best-effort
    expect(_queuedWakeCount('bot:bot-b')).toBe(0)
  })

  it('drains and renders the dm prompt with the sender identity', async () => {
    const runWake = vi.fn(async () => {})
    _setWakeDispatcherDeps({ isLocked: () => false, runWake })
    const result = maybeDispatchAgentDm(dmRow())
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
    expect(maybeDispatchAgentDm(dmRow({ content, clientMsgId: 'dm-intent' }))).toBe(true)
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
    expect(maybeDispatchAgentDm(dmRow({ content, clientMsgId: 'dm-fyi' }))).toBe(true)
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
    _setCoreStoresForTesting({
      mailbox: { getByClientMsgId: () => ({ content: inboundContent }) },
    } as unknown as CoreStores)
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
      const result = maybeDispatchAgentDm(
        dmRow({ content: replyContent, clientMsgId: 'dm-reply', source: 'bot:bot-a' }),
      )
      expect(result).not.toBe(false)
      await flush()
      expect(runWake).toHaveBeenCalledTimes(1)
      expect(runWake.mock.calls[0][1] as string).toContain('deep reply stays delivered')
    } finally {
      _setCoreStoresForTesting(null)
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
    _setCoreStoresForTesting({
      mailbox: { getByClientMsgId: () => ({ content: inboundContent }) },
    } as unknown as CoreStores)
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
        maybeDispatchAgentDm(dmRow({ content: replyContent, clientMsgId: 'dm-reply-2', source: 'bot:bot-a' })),
      ).toBe(true)
      await flush()
      expect(runWake).toHaveBeenCalledTimes(1)
      const prompt = runWake.mock.calls[0][1] as string
      expect(prompt).toContain('within limit')
    } finally {
      _setCoreStoresForTesting(null)
    }
  })
})