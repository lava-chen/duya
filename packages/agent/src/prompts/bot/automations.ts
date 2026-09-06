/**
 * botAutomations — real section renderer (Plan 476 P2.3b).
 *
 * Renders the routines that are bound to this bot (jobs in
 * `~/.duya/cronjob.toml` whose `agent` field matches the bot id) plus the
 * standing-order conduct for handling their fires. Standalone crons (no
 * agent) and other bots' jobs are silently omitted.
 *
 * Grok equivalent: the "Routines (your scheduling/automation feature)"
 * block of `renderAutomationsSystemPrompt`, condensed — schedule ETIQUETTE
 * (cadence choice, weekday daytime default, minute rule, self-expiry)
 * lives in the manage_routine tool description where the model reads it at
 * call time; this section carries only what the model needs when a fire
 * WAKES it (cue semantics, voice, silence) and the current routine
 * inventory with the ids manage_routine mutates by.
 *
 * Reads cronjob.toml directly (the agent process runs on the same machine
 * as main); a missing/corrupt file degrades to "no routines" — the
 * renderer is pure over the file and never throws.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from '@iarna/toml'
import { getDuyaRoot } from '../../memory-state/memory_paths.js'
import { ROUTINE_WAKE_CUE } from '../../wake/cue.js'
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
 * Render the automations section. Returns null only for non-bot sessions
 * (no agent id to filter by) — bots always get the conduct block, with the
 * routine inventory appended when one exists.
 *
 * Budget: `BOT_AUTOMATIONS_SECTION.budgetChars` (catalog.ts).
 */
export function renderBotAutomations(ctx: BotPromptContext): string | null {
  // Never render for non-bot sessions (no agent id to filter by).
  const botAgentId = ctx.botAgentId
  if (!botAgentId) return null

  const doc = readCronFile()

  // Filter to jobs bound to this bot
  const bound = doc.jobs.filter((j) => j.agent === botAgentId)

  const lines: string[] = ['# Routines']
  lines.push('')
  lines.push(
    `Routines are your scheduling feature: a saved prompt plus a trigger that fires it on time, running even when the user is away. When one fires, your session wakes with a hidden message opening with the cue ${ROUTINE_WAKE_CUE} and naming the routine — that means one of your own standing orders just fired, never the user reaching out. Carry out its saved prompt, then deliver the result with SendMessage in your normal voice; never announce "routine triggered" or read the schedule back. If the saved instruction says to stay quiet when there is nothing to report, end the turn without sending filler — silence is a valid result.`,
  )
  lines.push('')
  lines.push(
    'Create and change routines with the manage_routine tool. Be proactive: the moment a request is recurring, time-based, or a "let me know when X" need, create a routine instead of doing the thing once or trying to stay awake. Make short-lived watches self-expiring — put a deadline in the prompt and delete the routine after reporting the watched condition. If a routine keeps failing on auth, pause it and tell the user what to reconnect instead of reporting the same failure every fire.',
  )

  if (bound.length === 0) {
    lines.push('')
    lines.push('You have no routines yet.')
    return lines.join('\n')
  }

  lines.push('')
  lines.push('Current routines:')
  for (const job of bound) {
    const state = job.enabled ? 'enabled' : 'paused'
    const schedule = describeSchedule(job.schedule)
    const lastRun = formatRelativeTime(job.last_run_at)
    const lastError = job.last_error ? `; last error: ${job.last_error.slice(0, 80)}` : ''
    lines.push(`- ${job.name} (id ${job.id ?? 'unknown'}) [${state}] — ${schedule}; last run ${lastRun}${lastError}`)
  }

  return lines.join('\n')
}
