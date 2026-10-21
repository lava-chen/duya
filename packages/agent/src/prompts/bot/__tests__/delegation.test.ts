import { describe, it, expect } from 'vitest'
import { BotPromptAssembly } from '../framework'
import { createBotPromptAssembly } from '../factory'
import { BOT_TASK_DELEGATION_SECTION } from '../catalog'
import { renderBotTaskDelegation } from '../delegation'

describe('botTaskDelegation section', () => {
  it('omits itself until a bot id exists (safe to keep registered)', () => {
    expect(renderBotTaskDelegation({})).toBeNull()
  })

  it('renders the coordinator/hands guidance when a bot id is present', () => {
    const text = renderBotTaskDelegation({ botAgentId: 'dev' })
    expect(text).not.toBeNull()
    // Points at the `session` tool and frames delegation as the preference.
    expect(text).toContain('# Task delegation')
    expect(text).toContain('`session` tool')
    expect(text).toContain('coordinator')
    // Soft preference wording — not a hard mandate.
    expect(text).toContain('preference, not a mandate')
  })

  it('appears in the registered catalog assembly outside the basic prompt', async () => {
    const assembly = createBotPromptAssembly()
    expect(assembly.listSections()).toContain(BOT_TASK_DELEGATION_SECTION.name)
    const out = await assembly.renderSections({ botAgentId: 'dev' })
    expect(out).toContain('# Task delegation')
    expect(out).not.toContain(await import('../basicPrompt').then((m) => m.BOT_BASIC_SYSTEM_PROMPT))
  })

  it('respects its char budget via the framework', async () => {
    const assembly = new BotPromptAssembly()
    assembly.register(BOT_TASK_DELEGATION_SECTION)
    const text = await assembly.renderSections({ botAgentId: 'dev' })
    expect(Array.from(text).length).toBeLessThanOrEqual((BOT_TASK_DELEGATION_SECTION.budgetChars ?? 0) + 2)
  })
})