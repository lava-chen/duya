/**
 * Tests for Plan 492 P1.1 — buildAgentMessagingSystemPrompt contract
 * upgrade (fan-out policy, capability visibility, agent-management
 * preview, group placeholder) and the directory rendering.
 */

import { describe, it, expect } from 'vitest'
import {
  buildAgentMessagingSystemPrompt,
  buildAgentInboundWakePrompt,
  type AgentDirectoryEntry,
  type AgentGroupSummary,
} from './wake-prompt.js'
import { AGENT_INBOUND_WAKE_CUE, type AgentDmEnvelope } from './types.js'

describe('buildAgentMessagingSystemPrompt (492 P1.1)', () => {
  it('renders the section header even with no teammates', () => {
    const text = buildAgentMessagingSystemPrompt([])
    expect(text).toContain('# Other agents you can reach')
    expect(text).toContain('This user has no other agents yet.')
    expect(text).not.toContain('Teammates you can message right now:')
  })

  it('lists teammates with id and optional description', () => {
    const agents: AgentDirectoryEntry[] = [
      { id: 'alpha', name: 'Alpha', description: 'Docs helper' },
      { id: 'beta', name: 'Beta' },
    ]
    const text = buildAgentMessagingSystemPrompt(agents)
    expect(text).toContain('Teammates you can message right now:')
    expect(text).toContain('- Alpha (id: alpha) — Docs helper')
    expect(text).toContain('- Beta (id: beta)')
  })

  it('carries the full contract key phrases', () => {
    const text = buildAgentMessagingSystemPrompt([
      { id: 'alpha', name: 'Alpha' },
    ])
    // Async semantics + two-channel separation
    expect(text).toContain('Messaging is ASYNCHRONOUS')
    expect(text).toContain(`the cue ${AGENT_INBOUND_WAKE_CUE}`)
    expect(text).toContain(
      'SendToAgent reaches another agent, SendMessage reaches the user in this chat.',
    )
    // Judgment + privacy relay
    expect(text).toContain('Use this with judgment')
    expect(text).toContain('never relay their unfiltered words')
    // Fan-out policy (new in 492 P1.1)
    expect(text).toContain('Fan-out policy')
    expect(text).toContain('only when the user explicitly asked for it')
    expect(text).toContain("Never fan out \"while you're at it\"")
    // Capability visibility (new in 492 P1.1)
    expect(text).toContain('may not know this capability exists')
    // Agent-management preview (text-first, honest before 492 P4 lands)
    expect(text).toContain('agent-management tools are available to you')
    expect(text).toContain('CreateAgent / UpdateAgent')
    // Receiving etiquette
    expect(text).toContain('never ping-pong acknowledgements')
    expect(text).toContain('staying silent is fine')
  })

  it('omits the group block when no groups are supplied', () => {
    const text = buildAgentMessagingSystemPrompt([{ id: 'a', name: 'A' }])
    expect(text).not.toContain('Shared rooms')
    expect(text).not.toContain('Rooms you are in:')
  })

  it('renders the group placeholder when groups are supplied (478 hook)', () => {
    const groups: AgentGroupSummary[] = [
      {
        id: 'room-1',
        name: 'War Room',
        members: [
          { id: 'alpha', name: 'Alpha' },
          { id: 'beta', name: 'Beta' },
        ],
      },
    ]
    const text = buildAgentMessagingSystemPrompt([{ id: 'a', name: 'A' }], { groups })
    expect(text).toContain('Shared rooms (group chats)')
    expect(text).toContain('Rooms you are in:')
    expect(text).toContain('- War Room (id: room-1) — members: Alpha, Beta')
  })
})

describe('buildAgentInboundWakePrompt (477 P1.3, regression guard)', () => {
  const envelope: AgentDmEnvelope = {
    from: { id: 'alpha', name: 'Alpha' },
    to: { id: 'beta', name: 'Beta' },
    text: 'hello there',
    timestampMs: 0,
    clientMsgId: 'm1',
  }

  it('marks the message as coming from another agent, not the user', () => {
    const text = buildAgentInboundWakePrompt(envelope)
    expect(text).toContain(AGENT_INBOUND_WAKE_CUE)
    expect(text).toContain('Alpha (id: alpha)')
    expect(text).toContain('Alpha: hello there')
  })
})

// ---- Plan 477 P4.1 — intent-driven action paragraphs ----

describe('buildAgentInboundWakePrompt intent paragraphs (P4.1)', () => {
  const base = {
    from: { id: 'alpha', name: 'Alpha' },
    to: { id: 'beta', name: 'Beta' },
    text: 'do the thing',
    timestampMs: 0,
    clientMsgId: 'm-intent',
  }

  it('promises auto-return for request intent and threads replyToMessageId', () => {
    const text = buildAgentInboundWakePrompt({ ...base, intent: 'request' })
    expect(text).toContain('AUTOMATICALLY returned to Alpha')
    expect(text).toContain('replyToMessageId: m-intent')
  })

  it('promises auto-return for question intent', () => {
    const text = buildAgentInboundWakePrompt({ ...base, intent: 'question' })
    expect(text).toContain('This is a question')
    expect(text).toContain('AUTOMATICALLY returned to Alpha')
  })

  it('requires the receiver to report a result, not stay silent', () => {
    const text = buildAgentInboundWakePrompt({ ...base, intent: 'result' })
    expect(text).toContain('result of work you delegated to Alpha')
    expect(text).toContain('concisely summarize it to your user now')
    expect(text).toContain('Do not stay silent')
    expect(text).toContain('do not merely acknowledge it')
    expect(text).not.toContain('SendToAgent')
  })

  it('requires a status update to conveyor progress, not an ack', () => {
    const text = buildAgentInboundWakePrompt({ ...base, intent: 'status' })
    expect(text).toContain('status update on work')
    expect(text).toContain('Do not stay silent')
    expect(text).toContain('do not merely acknowledge it')
  })

  it('allows silence for fyi intent but forbids an acknowledgement', () => {
    const text = buildAgentInboundWakePrompt({ ...base, intent: 'fyi' })
    expect(text).toContain('This is an FYI')
    expect(text).toContain('staying silent is fine')
    expect(text).toContain('Do not send an acknowledgement message')
  })

  it('keeps the truthful visibility wording (P4.5)', () => {
    const text = buildAgentInboundWakePrompt(base)
    expect(text).toContain('visible in your chat as an agent-message card')
    // The grok-copied lie must not regress.
    expect(text).not.toContain('Your user can already see it in this chat')
  })
})
