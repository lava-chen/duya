/**
 * Bot PromptSystem config.
 *
 * Path A (Plan 474): a config-driven bot session uses a self-contained
 * system prompt instead of the general profile composition:
 *
 *   BOT_BASIC_SYSTEM_PROMPT (static base, injected separately — byte-stable)
 *   + this config's dynamic sections (the runtime backbone a bot still needs)
 *   + the bot section catalog (botIdentity / comms / memory tiers / channels /
 *     roster / … via BotPromptAssembly.renderSections).
 *
 * The stable behavioral baseline is the distilled `basicPrompt.ts`, which is
 * prepended directly by `_buildSystemPrompt` rather than re-rendered through
 * PromptCache (byte-stable, KV-cache friendly, single-sourced).
 *
 * Bot sessions reuse the general dynamic renderers via the registry, keeping
 * only what a bot actually needs:
 *   keep    language / outputStyle / platform / environment / mcp / skills /
 *           scratchpad / sessionGuidance
 *   cut     memory          — superseded by the bot memory tiers
 *                            (botMemoryOwn/User/Project)
 *           sessionSearch / recentSessions   — host-side UX, not bot-facing
 *           visionGuidelines / visualVerification — bots render text, no
 *                            vision pipeline in the agent run
 * Cut sections are re-added here if a bot surface needs them later.
 */

import type { PromptSystemConfig } from '../PromptSystem.js'
import { initializeAgentsMd } from '../sections/dynamic/agentsMdSection.js'
import { createEnvironmentPreBuildHook } from '../sections/dynamic/environmentPreBuildHook.js'

// Dynamic sections — recomputed every call via registry module refs.
export const botConfig: PromptSystemConfig = {
  name: 'bot',
  // The bot's stable behavioral baseline stays the distilled `basicPrompt.ts`
  // prepended by `_buildSystemPrompt` (byte-stable, KV-cache friendly) — it
  // is not assembled through PromptSystem, so the sections list contains only
  // the volatile runtime sections.
  sections: [
    // Dynamic sections — recomputed every call via .hbs templates
    { module: 'language', cachePolicy: 'every-call' },
    { module: 'outputStyle', cachePolicy: 'every-call' },
    { module: 'platform', cachePolicy: 'every-call' },
    { module: 'environment', cachePolicy: 'every-call' },
    { module: 'mcp', cachePolicy: 'every-call' },
    { module: 'skills', cachePolicy: 'every-call' },
    { module: 'scratchpad', cachePolicy: 'every-call' },
    { module: 'sessionGuidance', cachePolicy: 'every-call' },
  ],
  preBuildHook: async (ctx) => {
    // Sub-agents with omitClaudeMd set skip the AGENTS.md refresh walk.
    if (ctx.omitAgentsMd) return
    // Plan 550 1d-rest (environment section): pre-populate isGitRepo /
    // nowMs / unameSr / marketingName / knowledgeCutoff so the .hbs
    // template can render them synchronously. Bot config has no memory
    // hook (botMemory tiers replace it), so the extension is solely the
    // env one here.
    const envHook = createEnvironmentPreBuildHook()
    const envResult = await envHook(ctx)
    // Plan 525 / 408 follow-up: thread the project-entity home into the
    // loader so it can read `<projectHome>/AGENTS.md` as a `'Project entity'`
    // source. Absent when cwd is outside any registered duya project.
    if (await initializeAgentsMd(ctx.workingDirectory, ctx.projectHome)) {
      return {
        invalidateCacheKeys: ['project'],
        promptContextExtension: envResult?.promptContextExtension,
      }
    }
    return envResult
  },
}