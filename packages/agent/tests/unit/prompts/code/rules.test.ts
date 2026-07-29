import { describe, expect, it } from 'vitest'
import { getRulesSection } from '../../../../src/prompts/code/sections/rules.js'
import { TOOL_NAMES } from '../../../../src/prompts/types.js'
import type { PromptContext } from '../../../../src/prompts/types.js'

function makeCtx(enabledTools: string[] = []): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  } as PromptContext
}

describe('getRulesSection (code)', () => {
  it('keeps the essential work, tools, editing, safety, and autonomy sections', () => {
    const out = getRulesSection(makeCtx())

    expect(out).toContain('# Rules for getting work done')
    expect(out).toContain('## Doing tasks')
    expect(out).toContain('## Using your tools')
    expect(out).toContain('## File editing constraints')
    expect(out).toContain('## Executing actions with care')
    expect(out).toContain('## Autonomy and persistence')
  })

  it('keeps dedicated-tool, verification, dirty-tree, and destructive-action guardrails', () => {
    const out = getRulesSection(makeCtx())

    expect(out).toContain(TOOL_NAMES.GREP)
    expect(out).toContain('Verify before claiming completion')
    expect(out).toContain('Preserve unrelated user work in a dirty tree')
    expect(out).toContain('hard-to-reverse actions')
    expect(out).toContain('Authorization is limited to its stated action and scope')
  })

  it('adds task coordination only when its tool is available', () => {
    expect(getRulesSection(makeCtx())).not.toContain('inspect existing tasks before creating work')
    expect(getRulesSection(makeCtx([TOOL_NAMES.TASK]))).toContain('inspect existing tasks before creating work')
  })

  it('stays concise enough to preserve room for project instructions', () => {
    expect(getRulesSection(makeCtx()).length).toBeLessThan(4_000)
  })
})
