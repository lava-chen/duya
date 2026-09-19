/**
 * Environment Section - Dynamic Runtime Information
 *
 * Plan 550 1d-rest: this file now exposes both the legacy TS path
 * (`getEnvironmentSection`) and the helpers the `.hbs` mapper needs
 * (`buildEnvironmentItems`, `getShellInfoLine`, `formatCurrentDateTime`,
 * `getUnameSR`, `getMarketingNameForModel`, `getKnowledgeCutoff`).
 *
 * The mapper in `hbs/HbsPromptSystem.ts` calls `buildEnvironmentItems`
 * to produce a `string[]` that the `{{#each}}` block in
 * `assets/dynamic/environment.hbs` renders. The legacy TS path keeps
 * the same public surface so unit tests and direct callers still work
 * without the preBuildHook.
 *
 * Byte-level parity between the TS path and the .hbs path is locked by
 * `tests/unit/prompts/hbs/environment-1d-rest.test.ts`. Both paths share
 * `buildEnvironmentItems` so any drift surfaces immediately.
 */

import type { PromptContext } from '../../types.js'
import { KNOWLEDGE_CUTOFFS } from '../../types.js'
import { hasUnixCompatibleShell } from '../../../utils/shellDetector.js'

/** Best-effort model marketing name from a wire model id. */
export function getMarketingNameForModel(modelId: string): string | null {
  // Claude models
  if (modelId.includes('opus-4-6')) return 'Claude Opus 4.6'
  if (modelId.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
  if (modelId.includes('opus-4-5')) return 'Claude Opus 4.5'
  if (modelId.includes('haiku-4')) return 'Claude Haiku 4.5'
  if (modelId.includes('opus-4')) return 'Claude Opus 4'
  if (modelId.includes('sonnet-4')) return 'Claude Sonnet 4'
  if (modelId.includes('claude')) return 'Claude'

  // OpenAI models
  if (modelId.includes('gpt-4.5')) return 'GPT-4.5'
  if (modelId.includes('gpt-4o-mini')) return 'GPT-4o Mini'
  if (modelId.includes('gpt-4o')) return 'GPT-4o'
  if (modelId.includes('o4-mini')) return 'o4-mini'
  if (modelId.includes('o3-mini')) return 'o3-mini'
  if (modelId.includes('o1')) return 'o1'

  // Google Gemini models
  if (modelId.includes('gemini-2.5-pro')) return 'Gemini 2.5 Pro'
  if (modelId.includes('gemini-2.5-flash')) return 'Gemini 2.5 Flash'
  if (modelId.includes('gemini-1.5-pro')) return 'Gemini 1.5 Pro'
  if (modelId.includes('gemini-1.5-flash')) return 'Gemini 1.5 Flash'
  if (modelId.includes('gemini')) return 'Gemini'

  // DeepSeek models
  if (modelId.includes('deepseek-flash')) return 'DeepSeek V4.1 Flash'
  if (modelId.includes('deepseek-v4-pro')) return 'DeepSeek V4 Pro'
  if (modelId.includes('deepseek-r1')) return 'DeepSeek R1'
  if (modelId.includes('deepseek-v3')) return 'DeepSeek V3'
  if (modelId.includes('deepseek')) return 'DeepSeek'

  // Qwen models
  if (modelId.includes('qwen-max')) return 'Qwen Max'
  if (modelId.includes('qwen-plus')) return 'Qwen Plus'
  if (modelId.includes('qwen-turbo')) return 'Qwen Turbo'
  if (modelId.includes('qwen-coder')) return 'Qwen Coder'
  if (modelId.includes('qwen')) return 'Qwen'

  // MiniMax models
  if (modelId.includes('minimax-m')) return 'MiniMax-M'
  if (modelId.includes('minimax')) return 'MiniMax'

  // Kimi models
  if (modelId.includes('moonshot')) return 'Kimi'
  if (modelId.includes('kimi')) return 'Kimi'

  // Zhipu GLM models
  if (modelId.includes('glm-5')) return 'GLM-5'
  if (modelId.includes('glm-4')) return 'GLM-4'
  if (modelId.includes('glm')) return 'GLM'

  return null
}

/** Resolve the knowledge-cutoff date string for a model id, or `null`. */
export function getKnowledgeCutoff(modelId: string): string | null {
  for (const [pattern, cutoff] of Object.entries(KNOWLEDGE_CUTOFFS)) {
    if (modelId.includes(pattern)) {
      return cutoff
    }
  }
  return null
}

/** Build the human-readable shell info line for the prompt. */
export function getShellInfoLine(shell: string, platform: string): string {
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell.includes('pwsh')
        ? 'pwsh'
        : shell.includes('powershell')
          ? 'powershell'
          : shell.includes('cmd')
            ? 'cmd'
            : shell
  if (platform === 'win32') {
    const hasUnixShell = hasUnixCompatibleShell()
    if (hasUnixShell) {
      return `Shell: ${shellName} (Unix-compatible shell available on Windows — use Unix syntax like forward slashes, /dev/null)`
    }
    return `Shell: ${shellName} (Windows native shell — use Windows syntax like backslashes, NUL instead of /dev/null, 'dir' instead of 'ls')`
  }
  return `Shell: ${shellName}`
}

/** Format the wall-clock snapshot as a stable locale-aware string. */
export function formatCurrentDateTime(nowMs: number, tzStr?: string): string {
  const now = new Date(nowMs)
  const dateStr = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const resolvedTz = tzStr ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const tzOffset = now.toLocaleTimeString('en-US', { timeZoneName: 'short' }).split(' ').pop() ?? ''
  return `${dateStr}, ${timeStr} (${resolvedTz}, ${tzOffset})`
}

/**
 * Build the environment body as a flat string array (no ` - ` prefix and
 * no `Environment\n\nYou have been invoked in the following environment:\n`
 * wrapper — those are the template's job). The legacy `getEnvironmentSection`
 * joins these with `\n` + prefix and wraps with the header; the new `.hbs`
 * path emits the wrapper and the ` - ` prefix via the template.
 *
 * Async `fs.access(<cwd>/.git)` is the preBuildHook's job — the hook
 * populates `ctx.isGitRepo`. When the override is absent (e.g. unit tests
 * that call this function directly without going through the hook), the
 * caller is responsible for supplying the boolean. The mapper in
 * `HbsPromptSystem.ts` always runs after the preBuildHook, so the override
 * is always present in production.
 */
export function buildEnvironmentItems(ctx: PromptContext): string[] {
  const hasWorkingDir = !!(ctx.workingDirectory && ctx.workingDirectory.trim() !== '')
  const isGit = ctx.isGitRepo === true
  const unameSR = ctx.unameSr ?? ''

  const marketingName = ctx.marketingName ?? getMarketingNameForModel(ctx.modelId)
  const modelDescription = ctx.modelName
    ? `You are powered by the model named ${ctx.modelName}. The exact model ID is ${ctx.modelId}.`
    : `You are powered by the model ${ctx.modelId}.`

  const cutoff = ctx.knowledgeCutoff ?? getKnowledgeCutoff(ctx.modelId)
  const knowledgeCutoffMessage = cutoff
    ? `Assistant knowledge cutoff is ${cutoff}.`
    : null

  const shellInfoLine = getShellInfoLine(ctx.shell, ctx.platform)
  const nowMs = ctx.nowMs ?? Date.now()
  const currentDateTime = formatCurrentDateTime(nowMs, ctx.location?.timezone)

  const envItems: (string | null)[] = [
    hasWorkingDir
      ? `Primary working directory: ${ctx.workingDirectory}`
      : `Primary working directory: (no project folder associated with this session)`,
    ctx.isWorktree
      ? `This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT \`cd\` to the original repository root.`
      : null,
    hasWorkingDir ? `Is a git repository: ${isGit ? 'Yes' : 'No'}` : null,
    ctx.additionalWorkingDirectories && ctx.additionalWorkingDirectories.length > 0
      ? `Additional working directories:`
      : null,
    ...(ctx.additionalWorkingDirectories && ctx.additionalWorkingDirectories.length > 0
      ? ctx.additionalWorkingDirectories.map((d: string) => `  - ${d}`)
      : []),
    `Platform: ${ctx.platform}`,
    shellInfoLine,
    `OS Version: ${unameSR}`,
    ctx.location
      ? `Location: ${ctx.location.locale}${ctx.location.localeCountryCode ? ` (${ctx.location.localeCountryCode})` : ''}, timezone ${ctx.location.timezone}`
      : null,
    `Current date and time: ${currentDateTime}`,
    modelDescription,
    knowledgeCutoffMessage,
    `Duya is available as a CLI in the terminal, desktop app (Mac/Windows).`,
  ].filter(item => item !== null)

  return envItems as string[]
}

/**
 * Legacy TS path — kept for the unit tests that exercise `getEnvironmentSection`
 * directly, plus any caller that hasn't migrated to the preBuildHook + .hbs
 * pipeline. Wraps `buildEnvironmentItems` with the `Environment` header
 * and the ` - ` item prefix.
 */
export async function getEnvironmentSection(ctx: PromptContext): Promise<string> {
  return `# Environment

You have been invoked in the following environment:
${buildEnvironmentItems(ctx).map(item => ` - ${item}`).join('\n')}`
}