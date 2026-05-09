/**
 * Skills System
 * A flexible skill/command framework inspired by claude-code-haha
 *
 * Features:
 * 1. User-defined slash commands with custom prompts
 * 2. Tool restrictions per skill
 * 3. Skill context (inline or forked)
 * 4. Built-in skills (commit, review, etc.)
 * 5. Hooks support
 */

import type { Message } from '../types.js'

/**
 * Skill execution context
 */
export interface ToolUseContext {
  sessionId: string
  workspacePath?: string
  currentMessages: Message[]
  toolNames: string[]
}

/**
 * Content block for skill prompts
 */
export interface ContentBlockParam {
  type: 'text' | 'image' | 'tool_use' | 'tool_result'
  text?: string
  [key: string]: unknown
}

/**
 * Skill definition - the core configuration for a skill
 */
export interface SkillDefinition {
  /** Unique name of the skill */
  name: string
  /** Human-readable description shown in UI */
  description: string
  /** Allowed tools for this skill (empty = all tools allowed) */
  allowedTools?: string[]
  /** Custom model override for this skill */
  model?: string
  /** Execution context: inline (same conversation) or forked (new agent) */
  context?: 'inline' | 'fork'
  /** Agent type to use if forked */
  agent?: string
  /** Reference files to include in context */
  files?: Record<string, string>
  /** Whether this skill is user-invocable from UI */
  userInvocable?: boolean
  /** Whether this skill is hidden from command list */
  isHidden?: boolean
  /** Source of this skill */
  source?: 'built-in' | 'project' | 'user' | 'custom'
  /** Category for grouping in UI */
  category?: string
  /** Icon name for UI display */
  icon?: string
  /** Whether this command executes immediately without waiting for more input */
  immediate?: boolean
  /**
   * Get prompt content for this skill when invoked with arguments
   * @param args Arguments passed after /skillname
   * @param ctx Current tool use context
   */
  getPromptForCommand: (args: string, ctx: ToolUseContext) => Promise<ContentBlockParam[]>
}

/**
 * Skill hooks - callbacks at various lifecycle points
 */
export interface SkillHooks {
  /** Called before skill execution */
  preExecute?: (skillName: string, args: string) => Promise<boolean>
  /** Called after successful skill execution */
  postExecute?: (skillName: string, result: unknown) => Promise<void>
  /** Called on error during skill execution */
  onError?: (skillName: string, error: Error) => Promise<void>
}

/**
 * Skill metadata for UI display
 */
export interface SkillMetadata {
  name: string
  description: string
  source: SkillDefinition['source']
  category?: string
  icon?: string
  userInvocable: boolean
  isHidden: boolean
  hasAllowedTools: boolean
  allowedToolsCount: number
}

/**
 * Skill invocation result
 */
export interface SkillInvocationResult {
  success: boolean
  output?: string
  error?: string
  duration: number
  messagesAdded?: Message[]
}

/**
 * Skill Registry - manages all available skills
 *
 * The registry supports:
 * - Built-in skills (shipped with the application)
 * - Project skills (loaded from .duya/skills/ directory)
 * - User custom skills (created via UI)
 */
export class SkillRegistry {
  private skills: Map<string, SkillDefinition> = new Map()
  private hooks: SkillHooks = {}
  private customSkillsDir?: string

  constructor(options?: { customSkillsDir?: string }) {
    this.customSkillsDir = options?.customSkillsDir

    // Register built-in skills
    this.registerBuiltInSkills()
  }

  /**
   * Register a new skill
   */
  register(definition: SkillDefinition): void {
    if (!definition.name || !definition.getPromptForCommand) {
      throw new Error('Skill must have a name and getPromptForCommand function')
    }

    // Validate that required fields are present
    const existing = this.skills.get(definition.name)
    if (existing && existing.source === 'built-in') {
      console.warn(`Cannot override built-in skill: ${definition.name}`)
      return
    }

    this.skills.set(definition.name, definition)
  }

  /**
   * Unregister a skill (only non-built-in)
   */
  unregister(name: string): boolean {
    const skill = this.skills.get(name)
    if (skill?.source === 'built-in') {
      return false
    }
    return this.skills.delete(name)
  }

  /**
   * Get a skill by name
   */
  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name)
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.skills.has(name)
  }

  /**
   * Get all skills metadata (for UI listing)
   */
  getAllMetadata(): SkillMetadata[] {
    return Array.from(this.skills.values()).map(skill => ({
      name: skill.name,
      description: skill.description,
      source: skill.source ?? 'custom',
      category: skill.category,
      icon: skill.icon,
      userInvocable: skill.userInvocable !== false,
      isHidden: skill.isHidden ?? false,
      hasAllowedTools: !!skill.allowedTools && skill.allowedTools.length > 0,
      allowedToolsCount: skill.allowedTools?.length ?? 0,
    }))
  }

  /**
   * Get user-invocable skills (shown in slash command menu)
   */
  getUserInvocableSkills(): SkillMetadata[] {
    return this.getAllMetadata().filter(s => s.userInvocable && !s.isHidden)
  }

  /**
   * Get skills by source
   */
  getBySource(source: SkillDefinition['source']): SkillMetadata[] {
    return this.getAllMetadata().filter(s => s.source === source)
  }

  /**
   * Invoke a skill by name
   */
  async invoke(
    name: string,
    args: string,
    context: ToolUseContext,
  ): Promise<SkillInvocationResult> {
    const skill = this.skills.get(name)
    if (!skill) {
      return {
        success: false,
        error: `Skill not found: ${name}`,
        duration: 0,
      }
    }

    const startTime = Date.now()

    try {
      // Run pre-execute hook
      if (this.hooks.preExecute) {
        const shouldContinue = await this.hooks.preExecute(name, args)
        if (!shouldContinue) {
          return {
            success: false,
            error: `Execution cancelled by hook`,
            duration: Date.now() - startTime,
          }
        }
      }

      // Generate prompt for the skill
      const promptBlocks = await skill.getPromptForCommand(args, context)

      // Build result messages
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            ...promptBlocks,
            { type: 'text', text: `\n\n[Skill: /${name}]` },
          ],
          timestamp: Date.now(),
          metadata: { skillName: name, skillArgs: args },
        } as Message,
      ]

      // Run post-execute hook
      if (this.hooks.postExecute) {
        await this.hooks.postExecute(name, { promptBlocks })
      }

      return {
        success: true,
        duration: Date.now() - startTime,
        messagesAdded: messages,
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))

      // Run error hook
      if (this.hooks.onError) {
        await this.hooks.onError(name, err)
      }

      return {
        success: false,
        error: err.message,
        duration: Date.now() - startTime,
      }
    }
  }

  /**
   * Set global hooks for all skills
   */
  setHooks(hooks: Partial<SkillHooks>): void {
    this.hooks = { ...this.hooks, ...hooks }
  }

  /**
   * Check if a tool is allowed for a given skill
   */
  isToolAllowed(skillName: string, toolName: string): boolean {
    const skill = this.skills.get(skillName)
    if (!skill || !skill.allowedTools || skill.allowedTools.length === 0) {
      return true // No restrictions means all tools allowed
    }
    return skill.allowedTools.includes(toolName)
  }

  /**
   * Get allowed tools for a skill
   */
  getAllowedTools(skillName: string): string[] | undefined {
    return this.skills.get(skillName)?.allowedTools
  }

  /**
   * Search skills by query string
   */
  search(query: string): SkillMetadata[] {
    const q = query.toLowerCase()
    return this.getUserInvocableSkills().filter(
      s =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.category?.toLowerCase().includes(q),
    )
  }

  /**
   * Get total count of registered skills
   */
  getCount(): number {
    return this.skills.size
  }

  /**
   * Clear all non-built-in skills
   */
  clearCustom(): void {
    for (const [name, skill] of this.skills) {
      if (skill.source !== 'built-in') {
        this.skills.delete(name)
      }
    }
  }

  /**
   * Register built-in skills
   */
  private registerBuiltInSkills(): void {
    // These will be registered via individual registration calls
    // See built-in skills below
  }
}

// ============================================================================
// BUILT-IN SKILLS
// ============================================================================

/**
 * Commit Skill - Smart Git commit message generation
 */
const commitSkill: SkillDefinition = {
  name: 'commit',
  description: 'Generate a smart Git commit message based on staged changes',
  category: 'Git',
  icon: 'GitCommit',
  source: 'built-in',
  userInvocable: true,
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],
  context: 'fork',

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    const basePrompt = [
      {
        type: 'text',
        text: `You are a commit message generator. Analyze the staged changes and create an appropriate commit message.

Rules:
1. Use conventional commits format: type(scope): description
2. Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build
3. Keep the subject line under 72 characters
4. Write the body if needed to explain WHY not WHAT
5. If there are breaking changes, add "BREAKING CHANGE:" footer
6. Reference issues/PRs if applicable

${args ? `Additional instructions from user: ${args}` : ''}

Please:
1. First run \`git diff --cached\` to see staged changes
2. Also run \`git log --oneline -5\` to see recent commit style
3. Then generate an appropriate commit message
4. Finally run \`git commit -m "message"\` to apply it`,
      },
    ]

    return basePrompt as ContentBlockParam[]
  },
}

/**
 * Review Skill - Code review assistant
 */
const reviewSkill: SkillDefinition = {
  name: 'review',
  description: 'Review code changes and provide feedback',
  category: 'Code Quality',
  icon: 'CodeReview',
  source: 'built-in',
  userInvocable: true,
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep', 'LSP'],
  context: 'fork',

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    const target = args.trim() || 'HEAD~1'

    return [
      {
        type: 'text',
        text: `You are a senior code reviewer. Review the changes in ${target}.

Review criteria:
1. **Correctness**: Does the code do what it's supposed to?
2. **Security**: Any potential vulnerabilities?
3. **Performance**: Any obvious performance issues?
4. **Maintainability**: Is the code readable and well-structured?
5. **Best Practices**: Does it follow language/framework conventions?

Format your review as:

## Summary
Brief overview of changes

## Issues Found
### 🔴 Critical
- ...

### 🟡 Warning
- ...

### 💡 Suggestion
- ...

## Positive Aspects
Things done well

## Overall Verdict
✅ Approve / ⚠️ Request Changes / ❌ Needs Work

${args && !args.includes('HEAD') ? `Focus area: ${args}` : ''}`,
      },
    ] as ContentBlockParam[]
  },
}

/**
 * Simplify Skill - Simplify complex code
 */
const simplifySkill: SkillDefinition = {
  name: 'simplify',
  description: 'Simplify and refactor complex code',
  category: 'Code Quality',
  icon: 'Simplify',
  source: 'built-in',
  userInvocable: true,
  allowedTools: ['Read', 'Write', 'Edit', 'Grep'],

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    return [
      {
        type: 'text',
        text: `You are a code simplification expert. Your goal is to make code simpler without changing its behavior.

Principles:
1. Remove unnecessary complexity
2. Reduce nesting levels
3. Extract meaningful functions/methods
4. Use clearer variable names
5. Apply KISS and DRY principles
6. Preserve existing behavior exactly

${args ? `Target: ${args}\n` : ''}Please read the file(s), analyze them, and propose simplifications. Show before/after comparisons for each change.`,
      },
    ] as ContentBlockParam[]
  },
}

/**
 * Doctor Skill - Diagnose project issues
 */
const doctorSkill: SkillDefinition = {
  name: 'doctor',
  description: 'Diagnose common project issues and suggest fixes',
  category: 'Debugging',
  icon: 'Doctor',
  source: 'built-in',
  userInvocable: true,
  allowedTools: ['Bash', 'Read', 'Glob', 'Grep'],

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    return [
      {
        type: 'text',
        text: `You are a project health diagnostician. Check for common issues and provide actionable fixes.

Checklist:
1. **Dependencies**: Outdated/vulnerable packages, missing dependencies
2. **Configuration**: Invalid configs, missing env vars
3. **Code Quality**: Lint errors, type errors, unused imports
4. **Build**: Can the project build successfully?
5. **Tests**: Are tests passing? Coverage adequate?
6. **Git**: Large files, uncommitted changes, branch hygiene
7. **Performance**: Obvious performance bottlenecks

Format output as:
## ✅ Healthy
Items that look good

## ⚠️ Warnings
Non-critical issues

## 🔴 Issues Found
Problems needing attention

## 📋 Recommended Actions
Prioritized list of fixes

${args ? `Focus area: ${args}` : 'Run full diagnosis'}`,
      },
    ] as ContentBlockParam[]
  },
}

/**
 * Memory Skill - Manage session memory
 */
const memorySkill: SkillDefinition = {
  name: 'memory',
  description: 'View or update session memory',
  category: 'Session',
  icon: 'Memory',
  source: 'built-in',
  userInvocable: true,

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    const action = args.trim().toLowerCase()

    if (action === 'clear' || action === 'reset') {
      return [{ type: 'text', text: 'Session memory has been cleared.' }] as ContentBlockParam[]
    }

    if (action === 'show' || action === 'view' || !action) {
      return [{ type: 'text', text: 'Displaying current session memory...' }] as ContentBlockParam[]
    }

    return [{ type: 'text', text: `Memory command: ${args}` }] as ContentBlockParam[]
  },
}

/**
 * Export Skill - Export conversation
 */
const exportSkill: SkillDefinition = {
  name: 'export',
  description: 'Export conversation to various formats',
  category: 'Session',
  icon: 'Export',
  source: 'built-in',
  userInvocable: true,

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    const format = args.trim().toLowerCase() || 'markdown'

    const formatInstructions: Record<string, string> = {
      markdown: 'Export as Markdown (.md) with proper formatting',
      json: 'Export as JSON with full message structure',
      text: 'Export as plain text',
      html: 'Export as HTML with syntax highlighting',
    }

    return [
      {
        type: 'text',
        text: `Export the current conversation.
Format: ${format}
${formatInstructions[format] || `Custom format: ${format}`}
Include timestamps and tool usage information.`,
      },
    ] as ContentBlockParam[]
  },
}

/**
 * Plan Skill - Enter planning mode
 */
const planSkill: SkillDefinition = {
  name: 'plan',
  description: 'Create a detailed implementation plan before coding',
  category: 'Workflow',
  icon: 'Plan',
  source: 'built-in',
  userInvocable: true,
  allowedTools: ['Read', 'Glob', 'Grep', 'ExploreAgent'],

  async getPromptForCommand(args: string, ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    return [
      {
        type: 'text',
        text: `You are now in PLAN MODE. Create a detailed implementation plan for the following task:

${args || '[No specific task provided - ask what to plan]'}

Your plan should include:

## 1. Understanding
- What needs to be done
- Why it's needed
- Success criteria

## 2. Approach
- Technical approach
- Key decisions and rationale
- Potential risks and mitigations

## 3. Implementation Steps
Numbered, actionable steps with:
- File paths to modify/create
- Brief description of each change
- Dependencies between steps

## 4. Testing Strategy
How to verify the implementation works

## 5. Considerations
- Edge cases
- Performance implications
- Breaking changes

IMPORTANT: Only create the plan. Do NOT implement anything yet. Wait for user approval.`,
      },
    ] as ContentBlockParam[]
  },
}

/**
 * Cost Skill - Show API cost statistics
 */
const costSkill: SkillDefinition = {
  name: 'cost',
  description: 'Show token usage and estimated costs',
  category: 'Info',
  icon: 'Cost',
  source: 'built-in',
  userInvocable: true,
  immediate: true,

  async getPromptForCommand(_args: string, _ctx: ToolUseContext): Promise<ContentBlockParam[]> {
    return [
      {
        type: 'text',
        text: 'Display token usage statistics...',
      },
    ] as ContentBlockParam[]
  },
}

// Create singleton registry with built-in skills
let defaultRegistry: SkillRegistry | null = null

/**
 * Get or create the default skill registry
 */
export function getDefaultSkillRegistry(): SkillRegistry {
  if (!defaultRegistry) {
    defaultRegistry = new SkillRegistry()

    // Register all built-in skills
    defaultRegistry.register(commitSkill)
    defaultRegistry.register(reviewSkill)
    defaultRegistry.register(simplifySkill)
    defaultRegistry.register(doctorSkill)
    defaultRegistry.register(memorySkill)
    defaultRegistry.register(exportSkill)
    defaultRegistry.register(planSkill)
    defaultRegistry.register(costSkill)
  }

  return defaultRegistry
}

/**
 * Create a new skill registry (for testing or isolated contexts)
 */
export function createSkillRegistry(options?: { customSkillsDir?: string }): SkillRegistry {
  const registry = new SkillRegistry(options)

  // Register built-in skills
  registry.register(commitSkill)
  registry.register(reviewSkill)
  registry.register(simplifySkill)
  registry.register(doctorSkill)
  registry.register(memorySkill)
  registry.register(exportSkill)
  registry.register(planSkill)
  registry.register(costSkill)

  return registry
}

/**
 * All built-in skill names for reference
 */
export const BUILT_IN_SKILL_NAMES = [
  'commit',
  'review',
  'simplify',
  'doctor',
  'memory',
  'export',
  'plan',
  'cost',
] as const
