import { describe, expect, it } from 'vitest'
import { PromptsRegistry } from '../../../src/prompts/registry.js'
import {
  getProjectContinuitySection,
} from '../../../src/prompts/sections/projectContinuity.js'
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
  it('defines canonical-plan continuity', () => {
    const context = makeContext()
    const continuity = getProjectContinuitySection(context)

    expect(continuity).toContain('one canonical execution plan')
    expect(continuity).toContain('The coordinating agent owns integration')
    expect(continuity).toContain('not raw terminal output')
  })

  it('keeps continuity in the code config static sections', async () => {
    const context = makeContext()
    const promptSystem = PromptsRegistry.getOrCreate('code')!
    const staticNames = promptSystem.getStaticSections(context).map(section => section.name)

    expect(staticNames).toContain('projectContinuity')
    expect(staticNames).toContain('agentsMd')
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
      '# Project continuity\nMaintain a canonical plan.',
    )

    expect(prompt).toContain('You are a verification agent.')
    expect(prompt).toContain('# Project continuity')
    expect(prompt.indexOf('verification agent')).toBeLessThan(prompt.indexOf('# Project continuity'))
  })
})