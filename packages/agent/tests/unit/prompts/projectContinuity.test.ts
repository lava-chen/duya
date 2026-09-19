import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PromptsRegistry } from '../../../src/prompts/registry.js'
import { HbsPromptSystem } from '../../../src/prompts/hbs/HbsPromptSystem.js'
import { getSessionSearchSection } from '../../../src/prompts/sections/dynamic/sessionSearchSection.js'
import type { PromptContext } from '../../../src/prompts/types.js'
import { composeSubagentSystemPrompt } from '../../../src/tool/SubagentTool/promptComposition.js'

const hbs = new HbsPromptSystem({
  assetsRoot: resolve(__dirname, '../../../src/prompts/assets'),
})

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
    const continuity = hbs.renderModule('projectContinuity', context).trim()

    expect(continuity).toContain('one canonical execution plan')
    expect(continuity).toContain('The coordinating agent owns integration')
    expect(continuity).toContain('not raw terminal output')
  })

  it('keeps continuity in the code config static assembly', () => {
    const context = makeContext()
    const promptSystem = PromptsRegistry.getOrCreate('code')!
    const staticNames = promptSystem.getStaticSections(context).map(section => section.name)

    expect(staticNames).toContain('projectContinuity')
    // AGENTS.md refresh is a preBuildHook side effect (Plan 408), not a
    // static section — the hook contract is what invalidates the cached
    // projectInstructions module after a refresh walk.
    expect(typeof promptSystem.buildSystemPrompt).toBe('function')
    const codeConfig = promptSystem.getProfile()
    expect(codeConfig).toBeDefined()
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