/**
 * Tests for Plan 474 P2.2 (botCommsRules), P3.1 (ProfileUpdateEnvelope)
 * and G2 (per-section snapshot inspection).
 */

import { describe, it, expect } from 'vitest'
import { renderBotCommsRules } from '../commsRules'
import {
  PROFILE_UPDATE_ENVELOPE_TAG,
  buildProfileUpdateEnvelope,
  parseProfileUpdateEnvelope,
  detectProfileUpdate,
  mergeProfileUpdate,
  getLatestProfileUpdate,
  isProfileUpdateFolded,
} from '../profileUpdate'
import type { ProfileBaseline, ProfileUpdate } from '../profileUpdate'
import { BotPromptAssembly } from '../framework'
import type { BotSectionDef } from '../framework'
import { renderBotIdentity } from '../identity'
import { createBotPromptAssembly } from '../factory'

describe('botCommsRules (P2.2)', () => {
  it('renders user voice + wakes/quiet-work rules for a bot (492 P1.2 trim)', () => {
    const text = renderBotCommsRules({ botAgentId: 'alpha' })
    expect(text).toContain('# Communication rules')
    expect(text).toContain('Never wake the user')
    expect(text).toContain('Quiet work stays quiet')
  })

  it('no longer repeats agent-to-agent rules (single exit in botRoster, 492 P1)', () => {
    const text = renderBotCommsRules({ botAgentId: 'alpha' })!
    expect(text).not.toContain('Talking to other agents')
    expect(text).not.toContain('send_to_agent')
    expect(text).not.toContain('ack ping-pong')
  })
  it('returns null without a bot id (non-bot sessions omit it)', () => {
    expect(renderBotCommsRules({})).toBeNull()
  })

  it('stays within its budget', () => {
    const text = renderBotCommsRules({ botAgentId: 'alpha' })!
    // 1500 (pre-style-port) + ~2900 for the grok "Reply length and shape" port.
    expect(text.length).toBeLessThanOrEqual(4600)
  })

  it('renders the reply length and shape style rules (grok 0.18 port)', () => {
    const text = renderBotCommsRules({ botAgentId: 'alpha' })!
    expect(text).toContain('## Reply length and shape')
    expect(text).toContain('Match their length')
    expect(text).toContain('two to four separate SendMessage calls')
    expect(text).toContain('Prose, not outlines')
    expect(text).toContain('"Done —" or "Fixed —"')
  })

  it('is registered in the factory catalog and renders through the assembly', async () => {
    const assembly = createBotPromptAssembly()
    const text = await assembly.renderSections({ botAgentId: 'alpha' })
    expect(text).toContain('# Communication rules')
  })
})

describe('ProfileUpdateEnvelope round-trip (P3.1)', () => {
  it('wraps and parses losslessly', () => {
    const update: ProfileUpdate = {
      name: 'New Name',
      description: 'New role',
      changedAt: '2026-09-03T08:00:00.000Z',
    }
    const envelope = buildProfileUpdateEnvelope(update)
    expect(envelope).toMatch(
      new RegExp(`^<<${PROFILE_UPDATE_ENVELOPE_TAG}:v1:[A-Za-z0-9_-]+>>$`),
    )
    expect(parseProfileUpdateEnvelope(envelope)).toEqual(update)
  })

  it('rejects malformed payloads', () => {
    expect(parseProfileUpdateEnvelope('<<BOT_AGENT_PROFILE_UPDATE:v1:!!!>>')).toBeNull()
    expect(parseProfileUpdateEnvelope('hello world')).toBeNull()
    expect(parseProfileUpdateEnvelope('<<BOT_AGENT_PROFILE_UPDATE:v1:eyJhIjoxfQ>>')).toBeNull()
  })

  it('finds the newest envelope among mixed contents (changedAt comparison)', () => {
    const older = buildProfileUpdateEnvelope({
      name: 'A',
      changedAt: '2026-09-03T08:00:00.000Z',
    })
    const newer = buildProfileUpdateEnvelope({
      name: 'B',
      changedAt: '2026-09-03T09:00:00.000Z',
    })
    const latest = getLatestProfileUpdate(['noise', older, 'more noise', newer])
    expect(latest?.name).toBe('B')
    expect(getLatestProfileUpdate(['noise'])).toBeNull()
  })
})

describe('detect + merge + fold (P3.1 idempotency & compaction folding)', () => {
  it('detects only real changes (idempotent on repeated calls)', () => {
    const baseline: ProfileBaseline = { name: 'Alpha', description: 'v1' }
    const current = { name: 'Alpha', description: 'v1' }
    expect(detectProfileUpdate(baseline, current, '2026-09-03T08:00:00.000Z')).toBeNull()

    const renamed = detectProfileUpdate(
      baseline,
      { name: 'Alpha2', description: 'v1' },
      '2026-09-03T08:00:00.000Z',
    )
    expect(renamed?.name).toBe('Alpha2')
    expect(renamed?.description).toBeUndefined()
  })

  it('merge: update wins for carried fields; foldedUntil advances monotonically', () => {
    const baseline: ProfileBaseline = {
      name: 'Alpha',
      description: 'v1',
      foldedUntil: '2026-09-03T08:00:00.000Z',
    }
    const merged = mergeProfileUpdate(baseline, {
      name: 'Alpha2',
      changedAt: '2026-09-03T09:00:00.000Z',
    })
    expect(merged).toEqual({
      name: 'Alpha2',
      description: 'v1',
      foldedUntil: '2026-09-03T09:00:00.000Z',
    })

    // An older envelope must not rewind the fold marker.
    const rewound = mergeProfileUpdate(merged, {
      name: 'Old',
      changedAt: '2026-09-03T07:00:00.000Z',
    })
    expect(rewound.foldedUntil).toBe('2026-09-03T09:00:00.000Z')
  })

  it('fold marker suppresses re-announcement (isProfileUpdateFolded)', () => {
    const update: ProfileUpdate = { name: 'X', changedAt: '2026-09-03T08:00:00.000Z' }
    expect(isProfileUpdateFolded({}, update)).toBe(false)
    expect(isProfileUpdateFolded({ foldedUntil: '2026-09-03T08:00:00.000Z' }, update)).toBe(true)
    expect(isProfileUpdateFolded({ foldedUntil: '2026-09-03T09:00:00.000Z' }, update)).toBe(true)
    expect(isProfileUpdateFolded({ foldedUntil: '2026-09-03T07:00:00.000Z' }, update)).toBe(false)
  })

  it('prompt consistency: merge-then-render equals render of the merged identity', () => {
    // §2.2: the fold path and the render path share mergeProfileUpdate, so
    // the identity section is identical before and after compaction folding.
    const baseline: ProfileBaseline = { name: 'Alpha', description: 'v1' }
    const update: ProfileUpdate = {
      name: 'Alpha2',
      description: 'v2',
      changedAt: '2026-09-03T08:00:00.000Z',
    }
    const merged = mergeProfileUpdate(baseline, update)

    const renderMerged = renderBotIdentity({
      botAgentId: 'alpha',
      botName: merged.name,
      botDescription: merged.description,
    })
    // After folding, the baseline carries the update and renders identically
    // on a fresh load (profile.json = merged view).
    const renderFresh = renderBotIdentity({
      botAgentId: 'alpha',
      botName: 'Alpha2',
      botDescription: 'v2',
    })
    expect(renderMerged).toBe(renderFresh)
  })
})

describe('inspectSections (G2 snapshot debug)', () => {
  function assemblyWithSections(): BotPromptAssembly {
    const assembly = new BotPromptAssembly('')
    assembly.register({ name: 'small', compute: () => 'abc' } as BotSectionDef)
    assembly.register({
      name: 'big',
      budgetChars: 5,
      compute: () => 'abcdefgh',
    } as BotSectionDef)
    assembly.register({ name: 'empty', compute: () => null } as BotSectionDef)
    return assembly
  }

  it('reports per-section rendered lengths, omission and truncation', async () => {
    const snapshots = await assemblyWithSections().inspectSections({})
    expect(snapshots).toEqual([
      { name: 'small', chars: 3, omitted: false, budgetChars: undefined, truncated: false },
      { name: 'big', chars: 7, omitted: false, budgetChars: 5, truncated: true },
      { name: 'empty', chars: 0, omitted: true, budgetChars: undefined, truncated: false },
    ])
  })

  it('honors the sections filter', async () => {
    const snapshots = await assemblyWithSections().inspectSections({
      promptConfig: { sections: { disable: ['big'] } },
    })
    expect(snapshots.map((s) => s.name)).toEqual(['small', 'empty'])
  })

  it('shares the frozen-snapshot cache with renderSections', async () => {
    const assembly = assemblyWithSections()
    let count = 0
    assembly.register({
      name: 'counted',
      compute: () => {
        count += 1
        return 'X'
      },
    } as BotSectionDef)

    const key = { botId: 'alpha', contentHash: 'h', summaryEpoch: 0 }
    await assembly.inspectSections({}, { snapshot: key })
    await assembly.renderSections({}, { snapshot: key })
    expect(count).toBe(1)
  })
})
