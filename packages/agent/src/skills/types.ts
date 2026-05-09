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
  | 'development'       // coding, debugging, testing, architecture
  | 'research'          // academic research, paper discovery, literature review
  | 'creative'          // art generation, visual design, creative ideation
  | 'productivity'      // document creation, presentations, note-taking
  | 'data-science'      // data analysis, visualization, Jupyter
  | 'automation'        // scripting, CI/CD, workflow automation
  | 'communication'     // email, messaging, social media
  | 'media'             // media search, content creation
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
}
