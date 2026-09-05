/**
 * Tests for the grok-bot mention-format port (agent/dm/mentions.ts).
 */

import { describe, it, expect } from 'vitest'
import {
  agentMentionHandles,
  parseAgentMentions,
  buildMentionedAgentsContext,
} from './mentions'

const ROSTER = [
  { id: 'alpha', name: 'Alpha' },
  { id: 'ops', name: 'Ops Bot' },
  { id: 'research', name: 'Research Agent' },
]

describe('agentMentionHandles', () => {
  it('derives full, no-space, and first-word handles', () => {
    expect(agentMentionHandles('Ops Bot')).toEqual(['ops bot', 'opsbot', 'ops'])
  })

  it('is empty for blank names', () => {
    expect(agentMentionHandles('   ')).toEqual([])
  })

  it('keeps non-ASCII names intact', () => {
    expect(agentMentionHandles('小助手')).toEqual(['小助手'])
  })
})

describe('parseAgentMentions', () => {
  it('matches a full-name mention', () => {
    expect(parseAgentMentions('ask @Ops Bot to check', ROSTER)).toEqual([
      { id: 'ops', name: 'Ops Bot' },
    ])
  })

  it('matches the no-space and first-word handles', () => {
    expect(parseAgentMentions('@opsbot status?', ROSTER)).toEqual([
      { id: 'ops', name: 'Ops Bot' },
    ])
    expect(parseAgentMentions('@research any news', ROSTER)).toEqual([
      { id: 'research', name: 'Research Agent' },
    ])
  })

  it('is case-insensitive', () => {
    expect(parseAgentMentions('hey @ALPHA', ROSTER)).toEqual([
      { id: 'alpha', name: 'Alpha' },
    ])
  })

  it('requires word boundaries (no match inside a longer ASCII word)', () => {
    // Trailing boundary: '@alpha' followed by a word char.
    expect(parseAgentMentions('ping @alphas about it', ROSTER)).toEqual([])
    // Leading boundary: '@alpha' preceded by a word char.
    expect(parseAgentMentions('x@alpha not a mention', ROSTER)).toEqual([])
  })

  it('matches CJK names without ASCII boundary interference', () => {
    const roster = [...ROSTER, { id: 'helper', name: '小助手' }]
    expect(parseAgentMentions('让@小助手 看一下', roster)).toEqual([
      { id: 'helper', name: '小助手' },
    ])
  })

  it('returns matches in roster order, deduplicated', () => {
    const text = '@research then @Ops Bot, again @research'
    expect(parseAgentMentions(text, ROSTER)).toEqual([
      { id: 'ops', name: 'Ops Bot' },
      { id: 'research', name: 'Research Agent' },
    ])
  })

  it('returns empty for no mentions', () => {
    expect(parseAgentMentions('just a normal message', ROSTER)).toEqual([])
    expect(parseAgentMentions('', ROSTER)).toEqual([])
  })
})

describe('buildMentionedAgentsContext', () => {
  it('renders the grok-format reachability block', () => {
    const block = buildMentionedAgentsContext([
      { id: 'ops', name: 'Ops Bot' },
    ])
    expect(block).toBe(
      '[Agents mentioned in this message — you can reach any of them with SendToAgent using their id:\n- Ops Bot (id: ops)\n]',
    )
  })

  it('lists every mentioned agent', () => {
    const block = buildMentionedAgentsContext(ROSTER)
    expect(block).toContain('- Alpha (id: alpha)')
    expect(block).toContain('- Research Agent (id: research)')
  })

  it('is null when nothing was mentioned', () => {
    expect(buildMentionedAgentsContext([])).toBeNull()
  })
})
