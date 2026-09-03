import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { renderBotIdentity } from '../identity'
import { renderBotRoster, BOT_ROSTER_MAX_ENTRIES } from '../roster'
import { loadBotPromptContext } from '../loader'
import { createBotPromptAssembly } from '../factory'
import type { BotPromptContext } from '../framework'

// config-agents.ts reads `os.homedir()` for the config root — redirect it to
// a per-test temp dir via a hoisted holder (same pattern as config-agents.test).
const homedirHolder = vi.hoisted(() => ({ value: '' }))
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, homedir: () => homedirHolder.value }
})

const emptyCtx: BotPromptContext = {}

describe('renderBotIdentity (P2.1)', () => {
  it('returns null when there is no bot id or name', () => {
    expect(renderBotIdentity(emptyCtx)).toBeNull()
    expect(renderBotIdentity({ botName: undefined })).toBeNull()
  })

  it('renders name, stable agent id and description', () => {
    const out = renderBotIdentity({
      botAgentId: 'frontend-expert',
      botName: 'Frontend Expert',
      botDescription: '前端架构与 React 专家',
    })
    expect(out).toContain('Frontend Expert')
    expect(out).toContain('`frontend-expert`')
    expect(out).toContain('前端架构与 React 专家')
    expect(out).toContain('persistent bot')
  })

  it('renders with only an agent id (name falls back to id elsewhere)', () => {
    const out = renderBotIdentity({ botAgentId: 'ops-watch' })
    expect(out).not.toBeNull()
    expect(out).toContain('`ops-watch`')
  })
})

describe('renderBotRoster (P2.3 static part)', () => {
  it('returns null when the directory is empty/unset', () => {
    expect(renderBotRoster(emptyCtx)).toBeNull()
    expect(renderBotRoster({ agentDirectory: [] })).toBeNull()
  })

  it('lists each other bot with id, name and description', () => {
    const out = renderBotRoster({
      agentDirectory: [
        { id: 'alpha', name: 'Alpha', description: '文档助手' },
        { id: 'beta', name: 'Beta' },
      ],
    })
    expect(out).toContain('`alpha`: Alpha — 文档助手')
    expect(out).toContain('`beta`: Beta')
  })

  it('caps the directory at BOT_ROSTER_MAX_ENTRIES', () => {
    const many = Array.from({ length: BOT_ROSTER_MAX_ENTRIES + 5 }, (_, i) => ({
      id: `a${i}`,
      name: `Agent ${i}`,
    }))
    const out = renderBotRoster({ agentDirectory: many })!
    expect(out).toContain('5 more')
  })
})

describe('loadBotPromptContext (config-driven data)', () => {
  let tempDir: string
  let configRoot: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ctx-'))
    configRoot = path.join(tempDir, '.duya')
    fs.mkdirSync(configRoot, { recursive: true })
    homedirHolder.value = tempDir
  })

  afterEach(() => {
    homedirHolder.value = ''
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeConfig(toml: string): void {
    fs.writeFileSync(path.join(configRoot, 'config.toml'), toml, 'utf8')
  }

  it('returns {} for an unknown agent id', async () => {
    writeConfig(`[agents."alpha"]\nname = "Alpha"\n`)
    const ctx = await loadBotPromptContext('ghost')
    expect(ctx).toEqual({ botAgentId: 'ghost' })
  })

  it('fills identity + roster excluding self', async () => {
    writeConfig(`
[agents."alpha"]
name = "Alpha"
description = "文档助手"

[agents."beta"]
name = "Beta"
description = "运维看护"
`)
    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.botName).toBe('Alpha')
    expect(ctx.botDescription).toBe('文档助手')
    expect(ctx.agentDirectory).toEqual([
      { id: 'beta', name: 'Beta', description: '运维看护' },
    ])
  })

  it('end-to-end: assembly renders identity + roster after the basic prompt', async () => {
    writeConfig(`
[agents."alpha"]
name = "Alpha"
description = "文档助手"

[agents."beta"]
name = "Beta"
`)
    const assembly = createBotPromptAssembly()
    const ctx = await loadBotPromptContext('alpha')
    const out = await assembly.render(ctx)
    expect(out).toContain('Your identity as a bot')
    expect(out).toContain('Other agents you can reach')
    expect(out).toContain('`beta`: Beta')
  })

  it('prefers profile.json over config for self identity (485 P2.2)', async () => {
    writeConfig(`
[agents."alpha"]
name = "Config Alpha"
description = "config desc"
`)
    // Runtime identity (e.g. renamed by the model) diverges from config.
    const agentDir = path.join(configRoot, 'agents', 'alpha')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, 'profile.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'Alpha (runtime)',
        title: '运行时改名',
        description: 'runtime desc',
      }),
      'utf8',
    )

    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.botName).toBe('Alpha (runtime)')
    expect(ctx.botDescription).toBe('runtime desc')
  })

  it('prefers profile.json names in the roster over config entries', async () => {
    writeConfig(`
[agents."alpha"]
name = "Alpha"
description = "文档助手"

[agents."beta"]
name = "Config Beta"
description = "config desc"
`)
    // beta renamed itself at runtime.
    const betaDir = path.join(configRoot, 'agents', 'beta')
    fs.mkdirSync(betaDir, { recursive: true })
    fs.writeFileSync(
      path.join(betaDir, 'profile.json'),
      JSON.stringify({ schemaVersion: 1, name: 'Beta (runtime)', description: 'runtime desc' }),
      'utf8',
    )

    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.agentDirectory).toEqual([
      { id: 'beta', name: 'Beta (runtime)', description: 'runtime desc' },
    ])
  })

  it('falls back to config identity when profile.json is missing', async () => {
    writeConfig(`
[agents."alpha"]
name = "Alpha"
description = "文档助手"
`)
    const ctx = await loadBotPromptContext('alpha')
    expect(ctx.botName).toBe('Alpha')
    expect(ctx.botDescription).toBe('文档助手')
  })
})
