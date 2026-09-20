/**
 * botAutomations — data prepare step for `bot/automations.hbs`
 * (Plan 476 P2.3b).
 *
 * Plan 558 split: the *content* lives in this module — it reads
 * `~/.duya/cronjob.toml`, filters routines bound to this bot, formats
 * schedule / last-run / error strings, and produces a flat data array
 * the .hbs template iterates. The template holds zero logic.
 *
 * Stays sync: this routine runs inside `BotSectionDef.prepare` and must
 * not return a Promise (HbsPromptSystem.renderStaticTemplate is sync).
 * Reading a small TOML file synchronously is fine and matches the
 * pre-migration contract.
 *
 * Standalone crons (no `agent`) and other bots' jobs are silently omitted.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parse } from '@iarna/toml'
import { getDuyaRoot } from '../../memory-state/memory_paths.js'
import { ROUTINE_WAKE_CUE } from '../../wake/cue.js'
import type { BotPromptContext } from './framework.js'
import { identityHbsSentinel, makeBotTemplateHbs } from './hbsCompat.js'

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

export interface BotAutomationsContext extends BotPromptContext {
  /** Wake cue for routine fires (wake/cue.js). */
  routineWakeCue: string
  /** Flat array of routine lines ready for `{{#each}}` in the .hbs. */
  routineLines: string[]
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

export function prepareAutomationsContext(ctx: BotPromptContext): BotAutomationsContext | null {
  const botAgentId = ctx.botAgentId
  if (!botAgentId) return null

  const doc = readCronFile()
  const bound = doc.jobs.filter((j) => j.agent === botAgentId)

  const routineLines = bound.map((job) => {
    const state = job.enabled ? 'enabled' : 'paused'
    const schedule = describeSchedule(job.schedule)
    const lastRun = formatRelativeTime(job.last_run_at)
    const lastError = job.last_error ? `; last error: ${job.last_error.slice(0, 80)}` : ''
    const id = job.id ?? 'unknown'
    return `${job.name} (id ${id}) [${state}] — ${schedule}; last run ${lastRun}${lastError}`
  })

  return {
    ...ctx,
    routineWakeCue: ROUTINE_WAKE_CUE,
    routineLines,
  }
}

/**
 * @deprecated Use the catalog + `BotPromptAssembly.render()`.
 *   Sync wrapper kept for legacy callers; mirrors the pre-plan-558
 *   `renderBotAutomations` semantics.
 */
export function renderBotAutomations(ctx: BotPromptContext): string | null {
  const prepared = prepareAutomationsContext(ctx)
  if (!prepared) return null
  const hbs = makeBotTemplateHbs()
  const body = hbs.renderStaticTemplate(
    'bot/automations.hbs',
    identityHbsSentinel,
    { ...prepared },
  )
  return body === '' ? null : body
}