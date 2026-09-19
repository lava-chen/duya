import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { HbsPromptSystem } from '../../../../src/prompts/hbs/HbsPromptSystem.js'
import type { PromptContext } from '../../../../src/prompts/types.js'

const hbs = new HbsPromptSystem({
  assetsRoot: resolve(__dirname, '../../../../src/prompts/assets'),
})

function makeCtx(): PromptContext {
  return {
    workingDirectory: process.cwd(),
    platform: process.platform,
    shell: 'bash',
    modelId: 'test-model',
    enabledTools: new Set(),
    sessionStartTime: Date.now(),
  } as PromptContext
}

const getWorkingWithTheUserSection = (ctx: PromptContext) =>
  hbs.renderModule('workingWithTheUser', ctx).trim()

describe('getWorkingWithTheUserSection (code)', () => {
  it('keeps the two-channel contract and self-contained final answer', () => {
    const out = getWorkingWithTheUserSection(makeCtx())

    expect(out).toContain('# Working with the user')
    expect(out).toContain('`commentary`')
    expect(out).toContain('`final`')
    expect(out).toContain('final answer must stand alone')
  })

  it('keeps progress, local-link, visualization, and honest-reporting rules', () => {
    const out = getWorkingWithTheUserSection(makeCtx())

    expect(out).toContain('Before tool use')
    expect(out).toContain('do not use `file://`')
    expect(out).toContain('Use a visualization only when')
    expect(out).toContain('failed or skipped verification plainly')
  })

  it('stays concise enough to preserve room for task instructions', () => {
    expect(getWorkingWithTheUserSection(makeCtx()).length).toBeLessThan(3_000)
  })
})
