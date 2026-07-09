import type { PromptContext } from '../../types.js'

/**
 * Project References section.
 *
 * Injected only when the main process detected a `.duya/references/` directory
 * under the working directory at agent spawn time. The section provides lazy
 * guidance — it does NOT inject file contents or a file manifest. The agent
 * is expected to use its existing `glob` / `read` tools to discover and load
 * reference files on demand.
 *
 * The literal `<workingDirectory>` placeholder is intentionally not
 * interpolated; the agent already knows its working directory from the
 * Environment section, and keeping the string static avoids cache invalidation
 * when the working directory changes.
 */
export function getReferencesSection(ctx: PromptContext): string | null {
  if (!ctx.referencesEnabled) return null

  return `# Project References

This project has a user-curated references directory at \`<workingDirectory>/.duya/references/\`.
When a task may benefit from project-specific knowledge (API specs, schemas, design
notes, prior decisions, etc.), FIRST use the \`glob\` tool to list files under
\`.duya/references/\` (use pattern \`**/*\` and path \`<workingDirectory>/.duya/references\`),
then \`read\` the relevant file(s) before answering. Treat these files as
higher-authority context than your general knowledge.

If no file in the references directory is relevant to the current task, proceed
normally without forcing a reference.`
}
