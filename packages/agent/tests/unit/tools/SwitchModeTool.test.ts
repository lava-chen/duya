import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SwitchModeTool, switchModeTool, getCurrentMode, setAgentMode, isReadOnlyMode } from '../../../src/tool/SwitchModeTool/SwitchModeTool.js'
import { filterToolsByMode, isToolAllowedInMode, MODE_CONFIGS } from '../../../src/tool/SwitchModeTool/modes.js'
import type { Tool } from '../../../src/types.js'

describe('SwitchModeTool', () => {
  afterEach(() => {
    // Reset to general mode after each test
    setAgentMode('general')
  })

  describe('getCurrentMode', () => {
    it('should return general by default', () => {
      expect(getCurrentMode()).toBe('general')
    })

    it('should return the current mode after switching', () => {
      setAgentMode('plan')
      expect(getCurrentMode()).toBe('plan')
    })
  })

  describe('setAgentMode', () => {
    it('should switch to plan mode', () => {
      setAgentMode('plan')
      expect(getCurrentMode()).toBe('plan')
    })

    it('should switch to explore mode', () => {
      setAgentMode('explore')
      expect(getCurrentMode()).toBe('explore')
    })

    it('should switch to verify mode', () => {
      setAgentMode('verify')
      expect(getCurrentMode()).toBe('verify')
    })

    it('should switch to code-review mode', () => {
      setAgentMode('code-review')
      expect(getCurrentMode()).toBe('code-review')
    })

    it('should switch back to general mode', () => {
      setAgentMode('plan')
      setAgentMode('general')
      expect(getCurrentMode()).toBe('general')
    })
  })

  describe('isReadOnlyMode', () => {
    it('should return false for general mode', () => {
      setAgentMode('general')
      expect(isReadOnlyMode()).toBe(false)
    })

    it('should return true for plan mode', () => {
      setAgentMode('plan')
      expect(isReadOnlyMode()).toBe(true)
    })

    it('should return true for explore mode', () => {
      setAgentMode('explore')
      expect(isReadOnlyMode()).toBe(true)
    })

    it('should return true for verify mode', () => {
      setAgentMode('verify')
      expect(isReadOnlyMode()).toBe(true)
    })

    it('should return true for code-review mode', () => {
      setAgentMode('code-review')
      expect(isReadOnlyMode()).toBe(true)
    })
  })

  describe('SwitchModeTool instance', () => {
    it('should have correct name', () => {
      expect(switchModeTool.name).toBe('SwitchMode')
    })

    it('should have correct description', () => {
      expect(switchModeTool.description).toBeTruthy()
      expect(switchModeTool.description.length).toBeGreaterThan(0)
    })

    it('should have valid input_schema', () => {
      expect(switchModeTool.input_schema).toBeDefined()
      expect(switchModeTool.input_schema.type).toBe('object')
      expect(switchModeTool.input_schema.properties).toBeDefined()
      expect(switchModeTool.input_schema.properties.mode).toBeDefined()
    })

    it('should have mode enum with all valid modes', () => {
      const modeProperty = switchModeTool.input_schema.properties.mode as { enum: string[] }
      expect(modeProperty.enum).toContain('general')
      expect(modeProperty.enum).toContain('plan')
      expect(modeProperty.enum).toContain('explore')
      expect(modeProperty.enum).toContain('verify')
      expect(modeProperty.enum).toContain('code-review')
    })

    it('should require mode field', () => {
      expect(switchModeTool.input_schema.required).toContain('mode')
    })
  })

  describe('SwitchModeTool.execute', () => {
    it('should switch mode and return result', async () => {
      const result = await switchModeTool.execute({ mode: 'plan' })
      expect(result).toBeDefined()
      expect(result.name).toBe('SwitchMode')
      expect(result.error).toBeFalsy()

      const parsed = JSON.parse(result.result)
      expect(parsed.currentMode).toBe('plan')
      expect(parsed.previousMode).toBe('general')
      expect(parsed.readOnly).toBe(true)
    })

    it('should include reason in message for non-predefined transitions', async () => {
      // Non-predefined transitions include reason in message
      // Using plan->general which is predefined (but we can test with a truly custom scenario)
      // Actually, all our transitions are predefined, so we test the general->general case
      const result = await switchModeTool.execute({ mode: 'general', reason: 'Done planning' })
      const parsed = JSON.parse(result.result)
      expect(parsed.message).toContain('Done planning')
    })

    it('should handle mode transitions correctly', async () => {
      // Start from general
      await switchModeTool.execute({ mode: 'plan' })
      expect(getCurrentMode()).toBe('plan')

      // Switch to explore
      await switchModeTool.execute({ mode: 'explore' })
      expect(getCurrentMode()).toBe('explore')

      // Switch to general
      await switchModeTool.execute({ mode: 'general' })
      expect(getCurrentMode()).toBe('general')
    })

    it('should return error for invalid mode', async () => {
      const result = await switchModeTool.execute({ mode: 'invalid' as any })
      expect(result.error).toBe(true)
      const parsed = JSON.parse(result.result)
      expect(parsed.error).toContain('Invalid mode')
    })

    it('should include guidance in result for read-only modes', async () => {
      const result = await switchModeTool.execute({ mode: 'plan' })
      const parsed = JSON.parse(result.result)
      expect(parsed.guidance).toBeDefined()
      expect(parsed.guidance).toContain('READ-ONLY MODE')
    })

    it('should not include guidance for general mode', async () => {
      const result = await switchModeTool.execute({ mode: 'general' })
      const parsed = JSON.parse(result.result)
      expect(parsed.guidance).toBeUndefined()
    })
  })

  describe('toTool', () => {
    it('should return valid Tool definition', () => {
      const tool = switchModeTool.toTool()
      expect(tool.name).toBe('SwitchMode')
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeDefined()
    })
  })

  describe('getPrompt', () => {
    it('should return non-empty prompt', () => {
      const prompt = switchModeTool.getPrompt()
      expect(prompt).toBeTruthy()
      expect(prompt.length).toBeGreaterThan(100)
    })

    it('should mention available modes in prompt', () => {
      const prompt = switchModeTool.getPrompt()
      expect(prompt).toContain('general')
      expect(prompt).toContain('plan')
      expect(prompt).toContain('explore')
      expect(prompt).toContain('verify')
      expect(prompt).toContain('code-review')
    })
  })
})

describe('Mode filtering', () => {
  const mockTools: Tool[] = [
    { name: 'Read', description: 'Read files', input_schema: {} },
    { name: 'Write', description: 'Write files', input_schema: {} },
    { name: 'Edit', description: 'Edit files', input_schema: {} },
    { name: 'Bash', description: 'Run bash', input_schema: {} },
    { name: 'Glob', description: 'Glob files', input_schema: {} },
    { name: 'Grep', description: 'Search', input_schema: {} },
    { name: 'Agent', description: 'Spawn agent', input_schema: {} },
  ]

  describe('isToolAllowedInMode', () => {
    it('should allow all tools in general mode', () => {
      expect(isToolAllowedInMode('Read', 'general')).toBe(true)
      expect(isToolAllowedInMode('Write', 'general')).toBe(true)
      expect(isToolAllowedInMode('Edit', 'general')).toBe(true)
      expect(isToolAllowedInMode('Bash', 'general')).toBe(true)
    })

    it('should allow read tools in plan mode', () => {
      expect(isToolAllowedInMode('Read', 'plan')).toBe(true)
      expect(isToolAllowedInMode('Glob', 'plan')).toBe(true)
      expect(isToolAllowedInMode('Grep', 'plan')).toBe(true)
    })

    it('should disallow write tools in plan mode', () => {
      expect(isToolAllowedInMode('Write', 'plan')).toBe(false)
      expect(isToolAllowedInMode('Edit', 'plan')).toBe(false)
    })

    it('should allow Agent tool in all modes', () => {
      expect(isToolAllowedInMode('Agent', 'plan')).toBe(true)
      expect(isToolAllowedInMode('Agent', 'explore')).toBe(true)
      expect(isToolAllowedInMode('Agent', 'verify')).toBe(true)
      expect(isToolAllowedInMode('Agent', 'code-review')).toBe(true)
    })

    it('should apply same rules to explore, verify, and code-review modes', () => {
      const readonlyModes = ['explore', 'verify', 'code-review'] as const
      for (const mode of readonlyModes) {
        expect(isToolAllowedInMode('Read', mode)).toBe(true)
        expect(isToolAllowedInMode('Write', mode)).toBe(false)
        expect(isToolAllowedInMode('Edit', mode)).toBe(false)
      }
    })
  })

  describe('filterToolsByMode', () => {
    it('should return all tools in general mode', () => {
      const filtered = filterToolsByMode(mockTools, 'general')
      expect(filtered).toHaveLength(mockTools.length)
    })

    it('should filter write tools in plan mode', () => {
      const filtered = filterToolsByMode(mockTools, 'plan')
      expect(filtered.find(t => t.name === 'Write')).toBeUndefined()
      expect(filtered.find(t => t.name === 'Edit')).toBeUndefined()
      expect(filtered.find(t => t.name === 'Read')).toBeDefined()
      expect(filtered.find(t => t.name === 'Glob')).toBeDefined()
    })

    it('should filter write tools in explore mode', () => {
      const filtered = filterToolsByMode(mockTools, 'explore')
      expect(filtered.find(t => t.name === 'Write')).toBeUndefined()
      expect(filtered.find(t => t.name === 'Edit')).toBeUndefined()
    })

    it('should filter write tools in verify mode', () => {
      const filtered = filterToolsByMode(mockTools, 'verify')
      expect(filtered.find(t => t.name === 'Write')).toBeUndefined()
      expect(filtered.find(t => t.name === 'Edit')).toBeUndefined()
    })

    it('should filter write tools in code-review mode', () => {
      const filtered = filterToolsByMode(mockTools, 'code-review')
      expect(filtered.find(t => t.name === 'Write')).toBeUndefined()
      expect(filtered.find(t => t.name === 'Edit')).toBeUndefined()
    })
  })

  describe('MODE_CONFIGS', () => {
    it('should have readOnly=true for readonly modes', () => {
      expect(MODE_CONFIGS.general.readOnly).toBe(false)
      expect(MODE_CONFIGS.plan.readOnly).toBe(true)
      expect(MODE_CONFIGS.explore.readOnly).toBe(true)
      expect(MODE_CONFIGS.verify.readOnly).toBe(true)
      expect(MODE_CONFIGS['code-review'].readOnly).toBe(true)
    })

    it('should have systemPromptSuffix for readonly modes', () => {
      expect(MODE_CONFIGS.plan.systemPromptSuffix).toContain('READ-ONLY MODE')
      expect(MODE_CONFIGS.explore.systemPromptSuffix).toContain('READ-ONLY MODE')
      expect(MODE_CONFIGS.verify.systemPromptSuffix).toContain('READ-ONLY MODE')
      expect(MODE_CONFIGS['code-review'].systemPromptSuffix).toContain('READ-ONLY MODE')
      expect(MODE_CONFIGS.general.systemPromptSuffix).toBe('')
    })
  })
})