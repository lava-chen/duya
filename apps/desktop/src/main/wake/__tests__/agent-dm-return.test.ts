/**
 * agent-dm-return.test.ts — Plan 477 P4.3 automatic result return.
 *
 * Covers the auto-return gate (intent + real output), the envelope the
 * return writes (intent=result + replyTo threading), and the explicit
 * send_to_agent event detector that prevents double delivery.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  maybeAutoReturnDmResult,
  runUsedSendToAgent,
} from '../agent-dm-return'
import {
  _setCoreStoresForTesting,
  type CoreStores,
} from '../../db/core-connection'
import {
  _resetWakeDispatcherForTest,
  _setWakeDispatcherDeps,
} from '../wake-dispatcher'
import {
  _setBotSessionCreatorForTest,
} from '../agent-dm-dispatcher'
import { decodeEnvelope } from '@duya/agent-protocol'

const mailboxApi = vi.hoisted(() => ({
  enqueue: vi.fn(async (_input: unknown) => ({
    id: 'row-1',
    sessionId: '',
    kind: 'agent_dm',
    content: '',
    clientMsgId: 'auto-1',
  })),
  getByClientMsgId: vi.fn(async () => null),
}))

vi.mock('../../cli/desktop-host-api', () => ({
  getDesktopHostLocalMailboxApi: () => mailboxApi,
}))

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface CapturedRow {
  sessionId: string
  content: string
}

describe('maybeAutoReturnDmResult (P4.3)', () => {
  const enqueuedRows: CapturedRow[] = []

  beforeEach(() => {
    _resetWakeDispatcherForTest()
    enqueuedRows.length = 0
    mailboxApi.enqueue.mockImplementation(async (value: unknown) => {
      const input = value as { sessionId: string; content: string }
      enqueuedRows.push({ sessionId: input.sessionId, content: input.content })
      return {
        id: 'row-1',
        sessionId: input.sessionId,
        kind: 'agent_dm',
        content: input.content,
        clientMsgId: 'auto-1',
      }
    })
    mailboxApi.getByClientMsgId.mockResolvedValue(null)
    _setWakeDispatcherDeps({ isLocked: () => true, runWake: async () => ({ output: '', events: [] }) })
    _setBotSessionCreatorForTest({ createIfMissing: () => {} })
    _setCoreStoresForTesting({
      sessions: { get: () => ({ agentName: 'Receiver' }) },
    } as unknown as CoreStores)
  })

  afterEach(() => {
    _setCoreStoresForTesting(null)
    _resetWakeDispatcherForTest()
  })

  const ctx = {
    sessionId: 'bot:receiver',
    clientMsgId: 'inbound-1',
    fromAgentId: 'bot:sender',
    fromAgentName: 'Sender',
    intent: 'request',
    hops: 1,
  }

  it('auto-returns a request outcome as intent=result threaded via replyTo', async () => {
    const ok = await maybeAutoReturnDmResult(ctx, 'Here is the summary you asked for.')
    expect(ok).toBe(true)
    expect(enqueuedRows).toHaveLength(1)
    expect(enqueuedRows[0].sessionId).toBe('bot:sender')
    const envelope = decodeEnvelope(enqueuedRows[0].content)
    expect(envelope.intent).toBe('result')
    expect(envelope.replyTo?.messageId).toBe('inbound-1')
    expect(envelope.from.id).toBe('bot:receiver')
    expect(envelope.to.id).toBe('bot:sender')
    expect(envelope.text).toContain('summary')
  })

  it('does not auto-return for result/status/fyi intents', async () => {
    for (const intent of ['result', 'status', 'fyi']) {
      expect(await maybeAutoReturnDmResult({ ...ctx, intent }, 'done')).toBe(false)
    }
    expect(enqueuedRows).toHaveLength(0)
  })

  it('does not auto-return placeholder or empty output', async () => {
    expect(await maybeAutoReturnDmResult(ctx, 'completed in 123ms')).toBe(false)
    expect(await maybeAutoReturnDmResult(ctx, '   ')).toBe(false)
    expect(enqueuedRows).toHaveLength(0)
  })

  it('rejects a self-addressed return', async () => {
    expect(await maybeAutoReturnDmResult({ ...ctx, fromAgentId: 'bot:receiver' }, 'done')).toBe(false)
    expect(enqueuedRows).toHaveLength(0)
  })
})

describe('runUsedSendToAgent (P4.3 dedupe)', () => {
  it('detects an explicit send_to_agent tool_use', () => {
    expect(
      runUsedSendToAgent([
        { type: 'text', data: { content: 'hi' } },
        { type: 'tool_use', data: { name: 'send_to_agent', input: { toAgentId: 'bot:x' } } },
      ]),
    ).toBe(true)
  })

  it('ignores other tool calls and empty event lists', () => {
    expect(runUsedSendToAgent([{ type: 'tool_use', data: { name: 'SendMessage' } }])).toBe(false)
    expect(runUsedSendToAgent([])).toBe(false)
  })
})
