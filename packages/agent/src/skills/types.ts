/**
 * Skill Types for duya Agent
 * Based on claude-code-haha/src/types/command.ts
 */

import type { ToolUseContext } from '../types.js';

/**
 * Skill source
 */
export type SkillSource = 'user' | 'project' | 'bundled' | 'mcp' | 'plugin';

/**
 * Skill category (Hermes-inspired classification)
 */
export type SkillCategory =
  | 'cognition'         // cognitive methodologies, search philosophy, mental models
  | 'agentic'           // plan execution, task decomposition, reflection loops
  | 'development'       // coding, debugging, testing, architecture
  | 'research'          // academic research, paper discovery, literature review
  | 'creative'          // art generation, visual design, creative ideation
  | 'productivity'      // document creation, presentations, note-taking
  | 'data-science'      // data analysis, visualization, Jupyter
  | 'automation'        // scripting, CI/CD, workflow automation
  | 'communication'     // email, messaging, social media
  | 'media'             // media search, content creation
  | 'apple'             // Apple ecosystem integrations
  | 'mcp'              // MCP tool integrations
  | 'system'           // system utilities, file operations
  | 'other';            // uncategorized

/**
 * Skill argument definition
 */
export interface SkillArgument {
  name: string;
  description?: string;
  required?: boolean;
}

/**
 * Prompt-based skill command
 * The skill content is expanded into the conversation
 */
export interface PromptSkill {
  type: 'prompt';
  name: string;
  description: string;
  aliases?: string[];
  hasUserSpecifiedDescription?: boolean;
  argumentHint?: string;
  whenToUse?: string;
  allowedTools?: string[];
  arguments?: SkillArgument[];
  model?: string;
  effort?: number;
  source: SkillSource;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  isEnabled?: () => boolean;
  isHidden?: boolean;
  /** Base directory for skill resources */
  skillRoot?: string;
  /** Skill category */
  category?: SkillCategory;
  /** Execution mode: inline (default) or fork */
  context?: 'inline' | 'fork';
  /** Agent type for fork mode */
  agent?: string;
  /** Glob patterns for conditional activation */
  paths?: string[];
  /** Hooks to register when skill is invoked */
  hooks?: Record<string, unknown>;
  /** Required environment variables */
  requiredEnvVars?: RequiredEnvVar[];
  /** Setup configuration */
  setup?: SkillSetupConfig;
  /** Whether this skill is conditionally activated (has paths but not yet activated) */
  isConditional?: boolean;
  /** Get the prompt content for this skill */
  getPromptForCommand(args: string, context: ToolUseContext): Promise<string>;
}

/**
 * Bundled skill definition (programmatically registered)
 */
export interface BundledSkillDefinition {
  name: string;
  description: string;
  aliases?: string[];
  whenToUse?: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  isEnabled?: () => boolean;
  hooks?: Record<string, unknown>;
  context?: 'inline' | 'fork';
  agent?: string;
  category?: SkillCategory;
  /** Additional reference files to extract to disk on first invocation */
  files?: Record<string, string>;
  getPromptForCommand(args: string, context: ToolUseContext): Promise<string>;
}

/**
 * Skill metadata for listing/discovery (without getPromptForCommand)
 */
export interface SkillMetadata {
  name: string;
  description: string;
  aliases?: string[];
  allowedTools?: string[];
  argumentHint?: string;
  whenToUse?: string;
  source: SkillSource;
  category?: SkillCategory;
  userInvocable: boolean;
  isHidden: boolean;
  paths?: string[];
  /** Supported platforms (e.g., ['macos', 'windows', 'linux']) */
  platforms?: string[];
  /** Required environment variables */
  requiredEnvVars?: RequiredEnvVar[];
  /** Whether this skill needs setup */
  setupNeeded?: boolean;
  /** Whether this skill is conditionally activated */
  isConditional?: boolean;
}

/**
 * Skill category with metadata
 */
export interface SkillCategoryInfo {
  id: SkillCategory;
  name: string;
  description: string;
  skills: SkillMetadata[];
}

/**
 * Category description from DESCRIPTION.md
 */
export interface CategoryDescription {
  id: string;
  description: string;
  source: 'file' | 'builtin';
}

/**
 * Skill execution result
 */
export interface SkillResult {
  success: boolean;
  commandName: string;
  status: 'inline' | 'forked';
  agentId?: string;
  result?: string;
  allowedTools?: string[];
  model?: string;
}

/**
 * Required environment variable definition
 */
export interface RequiredEnvVar {
  name: string;
  prompt: string;
  help?: string;
  required_for?: string;
  optional?: boolean;
}

/**
 * Setup configuration for environment variable collection
 */
export interface SkillSetupConfig {
  help?: string;
  collect_secrets?: Array<{
    env_var: string;
    prompt: string;
    provider_url?: string;
    secret?: boolean;
  }>;
}

/**
 * Skill frontmatter parsed from SKILL.md
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  allowedTools?: string[];
  arguments?: SkillArgument[];
  userInvocable?: boolean;
  whenToUse?: string;
  version?: string;
  model?: string;
  disableModelInvocation?: boolean;
  context?: 'inline' | 'fork';
  agent?: string;
  effort?: number;
  paths?: string[];
  hooks?: Record<string, unknown>;
  /** Supported platforms (e.g., ['macos', 'windows', 'linux']) */
  platforms?: string[];
  /** Required environment variables */
  required_environment_variables?: RequiredEnvVar[];
  /** Legacy prerequisites (env_vars, commands) */
  prerequisites?: {
    env_vars?: string[];
    commands?: string[];
  };
  /** Setup configuration for secret collection */
  setup?: SkillSetupConfig;
}
