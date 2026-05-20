/**
 * General Agent Environment Section
 * Dynamic runtime information
 */

import type { PromptContext } from '../../../types.js'
import { KNOWLEDGE_CUTOFFS } from '../../../types.js'
import fs from 'node:fs/promises'
import path from 'node:path'
import { type as osType, release as osRelease } from 'os'
import { hasUnixCompatibleShell } from '../../../../utils/shellDetector.js'

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
      return `Shell: ${shellName} (Unix-compatible shell available on Windows)`
    }
    return `Shell: ${shellName} (Windows native shell)`
  }
  return `Shell: ${shellName}`
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
  if (modelId.includes('opus-4-6')) return 'Claude Opus 4.6'
  if (modelId.includes('sonnet-4-6')) return 'Claude Sonnet 4.6'
  if (modelId.includes('claude')) return 'Claude'
  if (modelId.includes('gpt-4o')) return 'GPT-4o'
  if (modelId.includes('gemini')) return 'Gemini'
  if (modelId.includes('deepseek')) return 'DeepSeek'
  return null
}

export async function getEnvironmentSection(ctx: PromptContext): Promise<string> {
  const hasWorkingDir = ctx.workingDirectory && ctx.workingDirectory.trim() !== ''
  const isGit = hasWorkingDir ? await isGitRepo(ctx.workingDirectory) : false

  const marketingName = ctx.modelName ?? getMarketingNameForModel(ctx.modelId)
  const modelDescription = marketingName
    ? `You are powered by the model named ${marketingName}. The exact model ID is ${ctx.modelId}.`
    : `You are powered by the model ${ctx.modelId}.`

  const cutoff = ctx.knowledgeCutoff ?? getKnowledgeCutoff(ctx.modelId)
  const knowledgeCutoffMessage = cutoff ? `Assistant knowledge cutoff is ${cutoff}.` : null

  const envItems: (string | null)[] = [
    hasWorkingDir
      ? `Primary working directory: ${ctx.workingDirectory}`
      : `Primary working directory: (no project folder associated with this session)`,
    ctx.isWorktree
      ? `This is a git worktree — an isolated copy of the repository.`
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
    `OS Version: ${osType()} ${osRelease()}`,
    modelDescription,
    knowledgeCutoffMessage,
    `Duya is available as a CLI in the terminal, desktop app (Mac/Windows).`,
  ].filter(item => item !== null)

  return `# Environment

You have been invoked in the following environment:
${envItems.map(item => ` - ${item}`).join('\n')}`
}