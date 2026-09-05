/**
 * Automations section for bot system prompt.
 *
 * Reads `~/.duya/cronjob.toml` directly and renders the cron jobs that are
 * bound to this bot (via the `agent` field in each job). Jobs bound to other
 * bots or to no bot (standalone crons) are silently omitted.
 *
 * Grok-bot equivalent: `renderAutomationsSystemPrompt` (simplified — duya has
 * no event-driven triggers yet, only schedules).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from '@iarna/toml'
import { getDuyaRoot } from '../../memory-state/memory_paths.js'
import type { BotPromptContext } from './framework.js'

interface CronJobFile {
  id?: string
  name: string
  prompt: string
  enabled: boolean
  schedule: unknown
  agent?: string | null
  last_run_at?: number
  last_error?: string | null
  retry_count?: number
  created_at?: number
  updated_at?: number
}

interface CronJobFileDoc {
  version: number
  jobs: CronJobFile[]
}

/** Format a schedule for display in the prompt. */
function describeSchedule(schedule: unknown): string {
  if (!schedule || typeof schedule !== 'object') return 'unknown schedule'
  const s = schedule as Record<string, unknown>
  if (s.kind === 'once') return `once at ${s.at ?? '?'}`
  if (s.kind === 'every') return `every ${s.every ?? '?'}`
  if (s.kind === 'cron') {
    const expr = (s.expr as string) ?? ''
    const tz = (s.tz as string) ?? ''
    return tz ? `cron ${expr} (${tz})` : `cron ${expr}`
  }
  return 'unknown schedule'
}

/** Format a timestamp as a relative or absolute string. */
function formatRelativeTime(ts: number | undefined): string {
  if (!ts || ts === 0) return 'never'
  const diff = Date.now() - ts
  const minutes = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days = Math.floor(diff / 86_400_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

function defaultCronFilePath(): string {
  const duyaRoot = getDuyaRoot()
  if (duyaRoot) return path.join(duyaRoot, 'cronjob.toml')
  // fallback to ~/.duya/cronjob.toml
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
  return path.join(home, '.duya', 'cronjob.toml')
}

function readCronFile(): CronJobFileDoc {
  const filePath = defaultCronFilePath()
  if (!fs.existsSync(filePath)) return { version: 1, jobs: [] }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return parse(raw) as unknown as CronJobFileDoc
  } catch {
    return { version: 1, jobs: [] }
  }
}

/**
 * Render the automations section. Returns null when there are no bot-bound
 * cron jobs or when the bot agent id is not set (non-bot session).
 *
 * Budget: 1200 chars (matches `BOT_AUTOMATIONS_SECTION.budgetChars`).
 */
export function renderBotAutomations(ctx: BotPromptContext): string | null {
  // Never render for non-bot sessions (no agent id to filter by).
  const botAgentId = ctx.botAgentId
  if (!botAgentId) return null

  const doc = readCronFile()

  // Filter to jobs bound to this bot
  const bound = doc.jobs.filter((j) => j.agent === botAgentId)
  if (bound.length === 0) return null

  const lines: string[] = ['## Automations']

  for (const job of bound) {
    const state = job.enabled ? 'enabled' : 'paused'
    const schedule = describeSchedule(job.schedule)
    const lastRun = formatRelativeTime(job.last_run_at)
    const lastError = job.last_error ? ` (last error: ${job.last_error.slice(0, 80)})` : ''

    lines.push(
      `### ${job.name} [${state}]`,
      `- Schedule: ${schedule}`,
      `- Last run: ${lastRun}${lastError}`,
      `- Prompt: ${job.prompt.slice(0, 120)}${job.prompt.length > 120 ? '…' : ''}`,
    )
  }

  return lines.join('\n')
}
