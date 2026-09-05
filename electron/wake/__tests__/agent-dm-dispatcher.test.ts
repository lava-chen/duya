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
})