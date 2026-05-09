/**
 * AGENTS.md Section - Dynamic prompt section for AGENTS.md instructions
 *
 * This section loads AGENTS.md files and injects them into the system prompt.
 * AGENTS.md files provide project-specific and user-specific instructions.
 */

import type { PromptContext } from '../../types.js'
import { getAgentsMdManager } from '../../../agentsmd/index.js'

/**
 * Get the AGENTS.md section content.
 * Returns the combined prompt from all loaded AGENTS.md files.
 */
export function getAgentsMdSection(ctx: PromptContext): string | null {
  const manager = getAgentsMdManager()

  // Load for session if not already loaded
  if (!manager.isLoadedForPath(ctx.workingDirectory)) {
    // Return null for now - will be loaded asynchronously by the caller
    return null
  }

  const prompt = manager.buildAgentsMdPrompt()
  return prompt || null
}

/**
 * Initialize AGENTS.md for a session.
 * This should be called once at session start.
 */
export async function initializeAgentsMd(workingDirectory: string): Promise<void> {
  const manager = getAgentsMdManager()

  if (!manager.isLoadedForPath(workingDirectory)) {
    await manager.loadForSession(workingDirectory)
  }
}

/**
 * Get the AGENTS.md guidance section.
 * Provides instructions on how to use AGENTS.md files.
 */
export function getAgentsMdGuidanceSection(): string {
  return `## AGENTS.md Instructions

You can customize your behavior using AGENTS.md files. These files provide instructions that override default behavior.

### File Locations (in priority order)

1. **Managed** (/etc/duya/AGENTS.md or C:\\ProgramData\\duya\\AGENTS.md)
   - System-wide instructions for all users

2. **User** (~/.duya/AGENTS.md)
   - Your personal global instructions for all projects

3. **Project** (AGENTS.md, .duya/AGENTS.md, .duya/rules/*.md)
   - Project-specific instructions checked into the codebase
   - Files closer to the current directory have higher priority

4. **Local** (AGENTS.local.md)
   - Private project-specific instructions (not checked in)

### Features

- **@include directives**: Include other files with @path, @./relative/path, @~/home/path
- **Frontmatter**: Use YAML frontmatter for conditional rules
  \`\`\`yaml
  ---
  paths: "src/**/*.ts"
  ---
  \`\`\`
- **HTML Comments**: Use <!-- --> for notes that won't be included

### Priority

Later files override earlier files. Local > Project > User > Managed.`
}

