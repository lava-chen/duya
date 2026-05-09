/**
 * Skill Registry for duya Agent
 * Manages registration and lookup of skills
 */

import type { PromptSkill, SkillCategory, SkillCategoryInfo, SkillMetadata, SkillSource, CategoryDescription } from './types.js';

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  'development': 'Development',
  'research': 'Research',
  'creative': 'Creative',
  'productivity': 'Productivity',
  'data-science': 'Data Science',
  'automation': 'Automation',
  'communication': 'Communication',
  'media': 'Media',
  'mcp': 'MCP',
  'system': 'System',
  'other': 'Other',
};

const CATEGORY_DESCRIPTIONS: Record<SkillCategory, string> = {
  'development': 'Coding, debugging, testing, and architecture',
  'research': 'Academic research, paper discovery, and literature review',
  'creative': 'Art generation, visual design, and creative ideation',
  'productivity': 'Document creation, presentations, and note-taking',
  'data-science': 'Data analysis, visualization, and Jupyter',
  'automation': 'Scripting, CI/CD, and workflow automation',
  'communication': 'Email, messaging, and social media',
  'media': 'Media search and content creation',
  'mcp': 'MCP tool integrations',
  'system': 'System utilities and file operations',
  'other': 'Uncategorized skills',
};

/**
 * Skill registry for managing loaded skills
 */
export class SkillRegistry {
  private skills: Map<string, PromptSkill> = new Map();
  private aliases: Map<string, string> = new Map();
  private categoryDescriptions: Map<string, CategoryDescription> = new Map();

  /**
   * Register a skill
   */
  register(skill: PromptSkill): void {
    this.skills.set(skill.name, skill);

    // Register aliases
    if (skill.aliases) {
      for (const alias of skill.aliases) {
        this.aliases.set(alias, skill.name);
      }
    }
  }

  /**
   * Unregister a skill
   */
  unregister(name: string): void {
    const skill = this.skills.get(name);
    if (skill?.aliases) {
      for (const alias of skill.aliases) {
        this.aliases.delete(alias);
      }
    }
    this.skills.delete(name);
  }

  /**
   * Get a skill by name or alias
   */
  get(name: string): PromptSkill | undefined {
    const resolvedName = this.aliases.get(name) || name;
    return this.skills.get(resolvedName);
  }

  /**
   * Check if a skill exists
   */
  has(name: string): boolean {
    return this.aliases.has(name) || this.skills.has(name);
  }

  /**
   * List all skills
   */
  list(): PromptSkill[] {
    return Array.from(this.skills.values());
  }

  /**
   * List skills by source
   */
  listBySource(source: SkillSource): PromptSkill[] {
    return this.list().filter(s => s.source === source);
  }

  /**
   * List only user-invocable skills
   */
  listUserInvocable(): PromptSkill[] {
    return this.list().filter(s => s.userInvocable !== false && !s.isHidden);
  }

  /**
   * Get skill metadata (without getPromptForCommand)
   */
  getMetadata(name: string): SkillMetadata | undefined {
    const skill = this.get(name);
    if (!skill) return undefined;

    return {
      name: skill.name,
      description: skill.description,
      aliases: skill.aliases,
      allowedTools: skill.allowedTools,
      argumentHint: skill.argumentHint,
      whenToUse: skill.whenToUse,
      source: skill.source,
      category: skill.category,
      userInvocable: skill.userInvocable ?? true,
      isHidden: skill.isHidden ?? false,
      paths: skill.paths,
    };
  }

  /**
   * List all skill metadata
   */
  listMetadata(): SkillMetadata[] {
    return this.list().map(s => ({
      name: s.name,
      description: s.description,
      aliases: s.aliases,
      allowedTools: s.allowedTools,
      argumentHint: s.argumentHint,
      whenToUse: s.whenToUse,
      source: s.source,
      category: s.category,
      userInvocable: s.userInvocable ?? true,
      isHidden: s.isHidden ?? false,
      paths: s.paths,
    }));
  }

  /**
   * Clear all skills
   */
  clear(): void {
    this.skills.clear();
    this.aliases.clear();
    this.categoryDescriptions.clear();
  }

  /**
   * Register a category description from DESCRIPTION.md
   */
  registerCategoryDescription(categoryId: string, description: string, source: 'file' | 'builtin' = 'file'): void {
    this.categoryDescriptions.set(categoryId, {
      id: categoryId,
      description,
      source,
    });
  }

  /**
   * Get category description
   */
  getCategoryDescription(categoryId: string): CategoryDescription | undefined {
    return this.categoryDescriptions.get(categoryId);
  }

  /**
   * Get all category descriptions
   */
  getAllCategoryDescriptions(): CategoryDescription[] {
    return Array.from(this.categoryDescriptions.values());
  }

  /**
   * Get the number of registered skills
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * List skills by category
   */
  listByCategory(category: SkillCategory): PromptSkill[] {
    return this.list().filter(s => s.category === category);
  }

  /**
   * Get all categories with their skills
   */
  getCategories(): SkillCategoryInfo[] {
    const skills = this.listUserInvocable();
    const categoryMap = new Map<SkillCategory, SkillCategoryInfo>();

    for (const cat of Object.keys(CATEGORY_LABELS) as SkillCategory[]) {
      categoryMap.set(cat, {
        id: cat,
        name: CATEGORY_LABELS[cat],
        description: CATEGORY_DESCRIPTIONS[cat],
        skills: [],
      });
    }

    for (const skill of skills) {
      const cat = skill.category ?? 'other';
      const info = categoryMap.get(cat);
      if (info) {
        info.skills.push(this.getMetadata(skill.name)!);
      }
    }

    return Array.from(categoryMap.values())
      .filter(c => c.skills.length > 0);
  }

  /**
   * Find skills by glob pattern
   */
  findByPattern(pattern: string): PromptSkill[] {
    const regex = new RegExp(pattern.replace(/\*/g, '.*'));
    return this.list().filter(s => regex.test(s.name));
  }
}

// Global skill registry instance
let globalRegistry: SkillRegistry | null = null;

/**
 * Get the global skill registry
 */
export function getSkillRegistry(): SkillRegistry {
  if (!globalRegistry) {
    globalRegistry = new SkillRegistry();
  }
  return globalRegistry;
}

/**
 * Reset the global skill registry
 */
export function resetSkillRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear();
    globalRegistry = null;
  }
}
