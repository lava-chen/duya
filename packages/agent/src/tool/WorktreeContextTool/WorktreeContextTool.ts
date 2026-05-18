import { execa } from 'execa'
import type { Tool, ToolResult } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import {
  WORKTREE_CONTEXT_TOOL_NAME,
  type WorktreeAction,
} from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'
import { isReadOnlyMode } from '../SwitchModeTool/SwitchModeTool.js'

export interface WorktreeContextInput {
  action: WorktreeAction
  branch?: string
  name?: string
  path?: string
}

interface WorktreeEntry {
  name: string
  branch: string
  path: string
}

let currentWorktree: WorktreeEntry | null = null

export function getCurrentWorktree(): WorktreeEntry | null {
  return currentWorktree
}

export class WorktreeContextTool implements Tool, ToolExecutor {
  readonly name = WORKTREE_CONTEXT_TOOL_NAME
  readonly description = DESCRIPTION
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['enter', 'exit', 'status', 'list'],
        description: 'The action to perform on the worktree context',
      },
      branch: {
        type: 'string',
        description: 'Branch name for the worktree (required for enter)',
      },
      name: {
        type: 'string',
        description: 'Name for the worktree (optional, defaults to branch name)',
      },
      path: {
        type: 'string',
        description: 'Path where to create the worktree (optional, defaults to .worktrees/<name>)',
      },
    },
    required: ['action'],
  }

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    }
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { action, branch, name, path } = input as unknown as WorktreeContextInput

    if (!action) {
      return this.error('action is required')
    }

    switch (action) {
      case 'enter':
        return this.handleEnter(branch, name, path)
      case 'exit':
        return this.handleExit(name)
      case 'status':
        return this.handleStatus()
      case 'list':
        return this.handleList()
      default:
        return this.error(`Unknown action: ${action}`)
    }
  }

  getPrompt(): string {
    return getPrompt()
  }

  private async handleEnter(
    branch?: string,
    name?: string,
    path?: string,
  ): Promise<ToolResult> {
    if (isReadOnlyMode()) {
      return this.error('Cannot enter a worktree in read-only mode')
    }

    if (!branch) {
      return this.error('branch is required for enter action')
    }

    const worktreeName = name || branch
    const worktreePath = path || `.worktrees/${worktreeName}`

    try {
      await execa('git', ['rev-parse', '--git-dir'], { shell: true })

      const listResult = await execa('git', ['worktree', 'list', '--porcelain'], { shell: true })
      if (listResult.stdout.includes(worktreePath)) {
        return this.error(`Worktree already exists at ${worktreePath}`)
      }

      await execa('git', ['worktree', 'add', '-b', branch, worktreePath], { shell: true })

      currentWorktree = { name: worktreeName, branch, path: worktreePath }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          action: 'enter',
          worktreeName,
          worktreePath,
          branch,
          message: `Entered worktree ${worktreeName} at ${worktreePath}`,
        }),
      }
    } catch (err) {
      return this.error(
        err instanceof Error ? err.message : 'Failed to enter worktree',
      )
    }
  }

  private async handleExit(name?: string): Promise<ToolResult> {
    const targetName = name || currentWorktree?.name
    if (!targetName) {
      return this.error('No worktree to exit. Provide a name or enter a worktree first.')
    }

    const worktreePath = `.worktrees/${targetName}`

    try {
      await execa('git', ['rev-parse', '--git-dir'], { shell: true })

      const listResult = await execa('git', ['worktree', 'list', '--porcelain'], { shell: true })
      if (!listResult.stdout.includes(worktreePath)) {
        return this.error(`Worktree ${targetName} not found at ${worktreePath}`)
      }

      await execa('git', ['worktree', 'remove', worktreePath], { shell: true })

      if (currentWorktree?.name === targetName) {
        currentWorktree = null
      }

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          action: 'exit',
          worktreeName: targetName,
          message: `Exited and removed worktree ${targetName}`,
        }),
      }
    } catch (err) {
      return this.error(
        err instanceof Error ? err.message : 'Failed to exit worktree',
      )
    }
  }

  private async handleStatus(): Promise<ToolResult> {
    if (!currentWorktree) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          action: 'status',
          active: false,
          message: 'No active worktree context',
        }),
      }
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        action: 'status',
        active: true,
        worktree: currentWorktree,
      }),
    }
  }

  private async handleList(): Promise<ToolResult> {
    try {
      await execa('git', ['rev-parse', '--git-dir'], { shell: true })
      const { stdout } = await execa('git', ['worktree', 'list', '--porcelain'], { shell: true })
      const worktrees = stdout
        .split('\n\n')
        .filter(Boolean)
        .map((block) => {
          const lines = block.split('\n')
          let worktreePath = ''
          let head = ''
          let branch = ''
          for (const line of lines) {
            if (line.startsWith('worktree ')) worktreePath = line.slice(9)
            if (line.startsWith('HEAD ')) head = line.slice(5)
            if (line.startsWith('branch ')) branch = line.slice(7)
          }
          return { path: worktreePath, head, branch }
        })

      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          action: 'list',
          worktrees,
        }),
      }
    } catch (err) {
      return this.error(
        err instanceof Error ? err.message : 'Failed to list worktrees',
      )
    }
  }

  private error(message: string): ToolResult {
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({ error: message }),
      error: true,
    }
  }
}

export const worktreeContextTool = new WorktreeContextTool()