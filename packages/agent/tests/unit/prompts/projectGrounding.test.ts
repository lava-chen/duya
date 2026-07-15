import { describe, expect, it } from 'vitest'
import { CodePromptSystem } from '../../../src/prompts/code/CodePromptSystem.js'
import {
  getProjectContinuitySection,
  getProjectGroundingSection,
} from '../../../src/prompts/sections/projectGrounding.js'
import { getSessionSearchSection } from '../../../src/prompts/sections/dynamic/sessionSearchSection.js'
import type { PromptContext } from '../../../src/prompts/types.js'
import { composeSubagentSystemPrompt } from '../../../src/tool/SubagentTool/promptComposition.js'

function makeContext(enabledTools: string[] = []): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'pwsh',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  }
}

describe('project harness prompt', () => {
  it('defines a bounded investigation gate and canonical-plan continuity', () => {
    const context = makeContext()
    const grounding = getProjectGroundingSection(context)
    const continuity = getProjectContinuitySection(context)

    expect(grounding).toContain('sufficient context before the first state-changing action')
    expect(grounding).toContain('closer scoped AGENTS.md')
    expect(grounding).toContain('continue it instead of creating a competing plan')
    expect(grounding).toContain('sufficiency gate, not a requirement to read the whole repository')
    expect(continuity).toContain('one canonical execution plan')
    expect(continuity).toContain('The coordinating agent owns integration')
    expect(continuity).toContain('not raw terminal output')
  })

  it('keeps continuity on full prompts but only grounding on worker prompts', () => {
    const context = makeContext()
    const fullNames = new CodePromptSystem({ base: 'full' })
      .getStaticSections(context)
      .map(section => section.name)
    const minimalNames = new CodePromptSystem({ base: 'minimal' })
      .getStaticSections(context)
      .map(section => section.name)
    const bareNames = new CodePromptSystem({ base: 'bare' })
      .getStaticSections(context)
      .map(section => section.name)

    expect(fullNames).toContain('projectGrounding')
    expect(fullNames).toContain('projectContinuity')
    expect(fullNames).toContain('agentsMd')
    expect(minimalNames).toContain('projectGrounding')
    expect(minimalNames).toContain('agentsMd')
    expect(minimalNames).not.toContain('projectContinuity')
    expect(bareNames).toContain('projectGrounding')
    expect(bareNames).toContain('agentsMd')
    expect(bareNames).not.toContain('projectContinuity')
  })

  it('only emits past-session recovery guidance when SessionSearch exists', () => {
    expect(getSessionSearchSection(makeContext())).toBeNull()
    const section = getSessionSearchSection(makeContext(['SessionSearch']))
    expect(section).toContain('long-running task or handoff')
    expect(section).toContain('not as a ritual on every task')
  })

  it('composes role instructions with the shared subagent harness', () => {
    const prompt = composeSubagentSystemPrompt(
      'You are a verification agent.',
      '# Project grounding\nFollow scoped AGENTS.md.',
    )

    expect(prompt).toContain('You are a verification agent.')
    expect(prompt).toContain('# Project grounding')
    expect(prompt.indexOf('verification agent')).toBeLessThan(prompt.indexOf('# Project grounding'))
  })
})
