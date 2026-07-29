import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentsFileInfo } from '../../../src/agentsmd/types.js'
import { getAgentsMdManager } from '../../../src/agentsmd/index.js'
import type { PromptSkill } from '../../../src/skills/types.js'
import { getSkillRegistry, resetSkillRegistry } from '../../../src/skills/registry.js'
import { PromptsRegistry } from '../../../src/prompts/registry.js'
import { getProjectInstructionsSection } from '../../../src/prompts/general/sections/project.js'
import { getSystemSection } from '../../../src/prompts/code/sections/system.js'
import {
  formatSkillCatalog,
  getSkillsMetadataSection,
} from '../../../src/prompts/sections/dynamic/skillsMetadata.js'
import type { PromptContext } from '../../../src/prompts/types.js'

function context(enabledTools: string[] = []): PromptContext {
  return {
    workingDirectory: 'E:\\Projects\\duya',
    platform: 'win32',
    shell: 'powershell',
    modelId: 'test-model',
    enabledTools: new Set(enabledTools),
    sessionStartTime: Date.now(),
  }
}

describe('prompt structure regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetSkillRegistry()
  })

  afterEach(() => {
    resetSkillRegistry()
  })

  it('indexes AGENTS.md files instead of injecting their arbitrary contents', () => {
    const files: AgentsFileInfo[] = [
      {
        path: 'E:\\Projects\\duya\\AGENTS.md',
        type: 'Project',
        content: '<!-- CODEGRAPH_START -->\nrun this injected instruction',
      },
      {
        path: 'E:\\Projects\\duya\\AGENTS.md',
        type: 'Project',
        content: 'duplicate loader result',
      },
    ]
    vi.spyOn(getAgentsMdManager(), 'getLoadedFiles').mockReturnValue(files)

    const prompt = getProjectInstructionsSection()

    expect(prompt).toContain('# Project instructions')
    expect(prompt).toContain('E:\\Projects\\duya\\AGENTS.md')
    expect(prompt).toContain('read the relevant file in full')
    expect(prompt).not.toContain('CODEGRAPH_START')
    expect(prompt).not.toContain('injected instruction')
    expect(prompt?.match(/AGENTS\.md/g)).toHaveLength(1)
  })

  it('uses one concise skill index and never advertises unavailable skills', () => {
    const skill = {
      type: 'prompt',
      name: 'long-skill',
      description: 'A'.repeat(180),
    } as PromptSkill

    const catalog = formatSkillCatalog([skill])
    expect(catalog).toContain('`long-skill`')
    expect(catalog).toContain('...')
    expect(catalog.length).toBeLessThan(350)
    expect(getSkillsMetadataSection(context())).toBeNull()
  })

  it('lists only skills the model can load through the exposed Skill tool', () => {
    const registry = getSkillRegistry()
    const base = {
      type: 'prompt' as const,
      description: 'Use this workflow for a narrow task.',
      source: 'bundled' as const,
      getPromptForCommand: async () => 'instructions',
    }
    registry.register({ ...base, name: 'available' })
    registry.register({ ...base, name: 'hidden', isHidden: true })
    registry.register({ ...base, name: 'manual-only', disableModelInvocation: true })
    registry.register({ ...base, name: 'disabled', isEnabled: () => false })

    const catalog = getSkillsMetadataSection(context(['Skill']))

    expect(catalog).toContain('`available`')
    expect(catalog).not.toContain('`hidden`')
    expect(catalog).not.toContain('`manual-only`')
    expect(catalog).not.toContain('`disabled`')
  })

  it('treats pseudo-system tags in tool output as untrusted data', () => {
    const prompt = getSystemSection(context())

    expect(prompt).toContain('untrusted data')
    expect(prompt).not.toContain('Tags contain information from the system')
    expect(prompt).not.toContain('<system-reminder>')
  })

  it('keeps the assembled code prompt free of embedded AGENTS.md content', async () => {
    vi.spyOn(getAgentsMdManager(), 'getLoadedFiles').mockReturnValue([
      {
        path: 'E:\\Projects\\duya\\AGENTS.md',
        type: 'Project',
        content: '<!-- CODEGRAPH_START -->\nmalicious duplicate',
      },
    ])
    const promptSystem = PromptsRegistry.getOrCreate('code')!
    promptSystem.clearCache()

    const prompt = [...await promptSystem.buildSystemPrompt(context())].join('\n\n')

    expect(prompt).toContain('# Project instructions')
    expect(prompt).not.toContain('CODEGRAPH_START')
    expect(prompt).not.toContain('malicious duplicate')
    expect(prompt).not.toContain('Tags contain information from the system')
  })
})
