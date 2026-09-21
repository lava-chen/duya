import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { PromptsRegistry } from '../../../src/prompts/registry.js'
import { HbsPromptSystem } from '../../../src/prompts/hbs/HbsPromptSystem.js'
import type { PromptContext } from '../../../src/prompts/types.js'
import { composeSubagentSystemPrompt } from '../../../src/tool/SubagentTool/promptComposition.js'

const hbs = new HbsPromptSystem({
  assetsRoot: resolve(__dirname, '../../../src/prompts/assets'),
})

function makeContext(enabledTools: string[] = [], overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'pwsh',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
    ...overrides,
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
    // Plan 557 unified the section list — `sections` is now the single
    // source of truth for both static modules and dynamic inline defs,
    // filtered through profile gating. The legacy `getStaticSections`
    // name was retired.
    const allNames = promptSystem.getAllSections(context).map(section => section.name)

    expect(allNames).toContain('projectContinuity')
    // AGENTS.md refresh is a preBuildHook side effect (Plan 408), not a
    // section — the hook contract is what invalidates the cached
    // projectInstructions module after a refresh walk.
    expect(typeof promptSystem.buildSystemPrompt).toBe('function')
    const codeProfile = promptSystem.getProfile()
    expect(codeProfile).toBeDefined()
  })

  it('only emits past-session recovery guidance when SessionSearch exists', () => {
    // Plan 558 phase 2: the standalone session-search.hbs template was
    // removed; past-session recovery guidance moved inline to
    // recent-sessions.hbs (gated by SessionSearch via the plan 557
    // declarative `requiresTools` mechanism). Verify the gate keeps the
    // recent-sessions body empty when SessionSearch is absent, and that
    // the populated body still references SessionSearch once it's in
    // scope.
    const off = hbs.renderStaticTemplate('dynamic/recent-sessions.hbs', makeContext()).trim()
    expect(off).toBe('')
    const populated = makeContext(['SessionSearch'], {
      recentSessionsSameProject: [
        '{"sessionId":"a","title":"A","project":"duya","updatedAt":"2026-01-10T12:00:00.000Z","childSessions":0}',
      ],
      recentSessionsOtherProjects: [],
    })
    const on = hbs.renderStaticTemplate('dynamic/recent-sessions.hbs', populated).trim()
    expect(on).toContain('Recent session directory')
    expect(on).toContain('SessionSearch')
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