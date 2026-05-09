/**
 * Environment Section - Dynamic Runtime Information
 */

import type { PromptContext } from '../../types.js'
import { MODEL_CONSTANTS, KNOWLEDGE_CUTOFFS } from '../../types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type as osType, version as osVersion, release as osRelease } from 'os'
import { hasUnixCompatibleShell } from '../../../utils/shellDetector.js'

async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await fs.access(path.join(cwd, '.git'))
    return true
  } catch {
    return false
  }
}

function getShellInfoLine(shell: string, platform: string): string {
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

function getUnameSR(platform: string): string {
  if (platform === 'win32') {
    return `${osVersion()} ${osRelease()}`
  }
  return `${osType()} ${osRelease()}`
}

function getKnowledgeCutoff(modelId: string): string | null {
  for (const [pattern, cutoff] of Object.entries(KNOWLEDGE_CUTOFFS)) {
    if (modelId.includes(pattern)) {
      return cutoff
    }
  }
  return null
}

function getMarketingNameForModel(modelId: string): string | null {
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

export async function getEnvironmentSection(ctx: PromptContext): Promise<string> {
  const hasWorkingDir = ctx.workingDirectory && ctx.workingDirectory.trim() !== ''
  const isGit = hasWorkingDir ? await isGitRepo(ctx.workingDirectory) : false
  const unameSR = ctx.osVersion ?? getUnameSR(ctx.platform)

  const marketingName = ctx.modelName ?? getMarketingNameForModel(ctx.modelId)
  const modelDescription = marketingName
    ? `You are powered by the model named ${marketingName}. The exact model ID is ${ctx.modelId}.`
    : `You are powered by the model ${ctx.modelId}.`

  const cutoff = ctx.knowledgeCutoff ?? getKnowledgeCutoff(ctx.modelId)
  const knowledgeCutoffMessage = cutoff
    ? `Assistant knowledge cutoff is ${cutoff}.`
    : null

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
    getShellInfoLine(ctx.shell, ctx.platform),
    `OS Version: ${unameSR}`,
    modelDescription,
    knowledgeCutoffMessage,
    `Duya is available as a CLI in the terminal, desktop app (Mac/Windows).`,
  ].filter(item => item !== null)

  return `# Environment

You have been invoked in the following environment:
${envItems.map(item => ` - ${item}`).join('\n')}`
}
