import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { parse as parseYaml } from 'yaml'
import {
  WorkflowTemplateSchema,
  type WorkflowTemplate,
} from '../../workflows/index.js'

export interface CapabilityIndexItem {
  name: string
  path: string
  description?: string
}

function scanMdFiles(dirPath: string): CapabilityIndexItem[] {
  if (!existsSync(dirPath)) return []

  try {
    return readdirSync(dirPath)
      .filter((name) => extname(name) === '.md' && statSync(join(dirPath, name)).isFile())
      .map((name) => ({
        name: basename(name, '.md'),
        path: join(dirPath, name),
      }))
  } catch {
    return []
  }
}

export function discoverCommands(pluginDir: string): CapabilityIndexItem[] {
  return scanMdFiles(join(pluginDir, 'commands'))
}

export function discoverAgents(pluginDir: string): CapabilityIndexItem[] {
  return scanMdFiles(join(pluginDir, 'agents'))
}

/**
 * Discover skills declared by a plugin directory.
 *
 * Scans `skills/<skill-name>/SKILL.md` subdirectories. A subdirectory
 * whose `SKILL.md` is missing is skipped silently so a half-scaffolded
 * skill directory does not poison the index.
 */
export function discoverSkills(pluginDir: string): CapabilityIndexItem[] {
  const skillsDir = join(pluginDir, 'skills')
  if (!existsSync(skillsDir)) return []

  try {
    return readdirSync(skillsDir)
      .filter((name) => {
        const entryPath = join(skillsDir, name)
        return statSync(entryPath).isDirectory()
      })
      .map((name) => {
        const skillFile = join(skillsDir, name, 'SKILL.md')
        if (existsSync(skillFile) && statSync(skillFile).isFile()) {
          return { name, path: skillFile }
        }
        return null
      })
      .filter((item): item is CapabilityIndexItem => item !== null)
  } catch {
    return []
  }
}

export interface HookCapability {
  event: string
  handler: string
  [key: string]: unknown
}

/**
 * MCP server declaration resolved from `mcp/servers.json`.
 *
 * Shape matches `PluginManifest.capabilities.mcpServers` so the manifest
 * reader can populate that field directly from disk without a separate
 * adapter. Underscore-prefixed authoring hints (`_status`, `_authentication`,
 * ...) are stripped — they are documentation, not runtime config.
 */
export interface McpServerCapability {
  name: string
  transport?: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

/**
 * Plan: plugin-config-simplification — discover MCP servers from
 * `<pluginDir>/mcp/servers.json`.
 *
 * The file shape is `{ servers: [...] }` (a single object wrapping the
 * array); a bare top-level array is also accepted for convenience. Invalid
 * entries (non-objects, missing `name`) are dropped silently, mirroring the
 * fault-tolerance of `discoverHooks`. Underscore-prefixed authoring keys
 * are dropped so they never leak into the runtime manifest view.
 */
export function discoverMcpServers(pluginDir: string): McpServerCapability[] {
  const serversPath = join(pluginDir, 'mcp', 'servers.json')
  if (!existsSync(serversPath)) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(serversPath, 'utf-8'))
  } catch {
    return []
  }

  const list = Array.isArray(parsed)
    ? parsed
    : isObjectRecord(parsed) && Array.isArray(parsed.servers)
      ? parsed.servers
      : []

  const servers: McpServerCapability[] = []
  for (const entry of list) {
    if (!isObjectRecord(entry)) continue
    const name = typeof entry.name === 'string' ? entry.name : undefined
    if (!name) continue
    const server: McpServerCapability = { name }
    if (typeof entry.transport === 'string') {
      server.transport = entry.transport as McpServerCapability['transport']
    }
    if (typeof entry.command === 'string') server.command = entry.command
    if (Array.isArray(entry.args)) {
      server.args = entry.args.filter((a): a is string => typeof a === 'string')
    }
    if (isObjectRecord(entry.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(entry.env)) {
        if (typeof v === 'string') env[k] = v
      }
      server.env = env
    }
    if (typeof entry.url === 'string') server.url = entry.url
    if (isObjectRecord(entry.headers)) {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(entry.headers)) {
        if (typeof v === 'string') headers[k] = v
      }
      server.headers = headers
    }
    servers.push(server)
  }
  return servers
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function discoverHooks(pluginDir: string): HookCapability[] {
  const hooksPath = join(pluginDir, 'hooks', 'hooks.json')
  if (!existsSync(hooksPath)) return []

  try {
    const raw = readFileSync(hooksPath, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

/**
 * Plan 311 — Scan `<pluginDir>/workflows/*.yaml` for workflow templates.
 *
 * Each file is parsed as YAML and validated against
 * `WorkflowTemplateSchema`. Invalid files are silently skipped
 * (mirroring `discoverHooks`'s fault-tolerance). Returns the full
 * template list so callers can either count them or expose
 * summaries via `toWorkflowSummary`.
 */
export function discoverWorkflows(pluginDir: string): WorkflowTemplate[] {
  const workflowsDir = join(pluginDir, 'workflows')
  if (!existsSync(workflowsDir)) return []

  let files: string[]
  try {
    files = readdirSync(workflowsDir).filter(
      (name) => extname(name) === '.yaml' || extname(name) === '.yml',
    )
  } catch {
    return []
  }

  const templates: WorkflowTemplate[] = []
  for (const name of files) {
    const fullPath = join(workflowsDir, name)
    try {
      if (!statSync(fullPath).isFile()) continue
      const raw = readFileSync(fullPath, 'utf-8')
      const parsed = parseYaml(raw) as unknown
      const result = WorkflowTemplateSchema.safeParse(parsed)
      if (result.success) {
        templates.push(result.data)
      }
      // Invalid workflow files are skipped silently — same fault
      // tolerance as `discoverHooks`. A real plugin dev experience
      // surfaces these via `plugin:doctor` in a separate path.
    } catch {
      // Ignore unreadable / unparseable files.
    }
  }
  return templates
}

export interface PluginCapabilities {
  commands: CapabilityIndexItem[]
  agents: CapabilityIndexItem[]
  skills: CapabilityIndexItem[]
  hooks: HookCapability[]
  /**
   * Plan 311 — workflow templates discovered under
   * `<pluginDir>/workflows/*.yaml`. Empty when the directory is
   * absent or contains no valid templates.
   */
  workflows: WorkflowTemplate[]
  /**
   * Plan: plugin-config-simplification — MCP servers discovered from
   * `<pluginDir>/mcp/servers.json`. Empty when the file is absent or
   * contains no valid server declarations.
   */
  mcpServers: McpServerCapability[]
}

export function discoverAllCapabilities(pluginDir: string): PluginCapabilities {
  return {
    commands: discoverCommands(pluginDir),
    agents: discoverAgents(pluginDir),
    skills: discoverSkills(pluginDir),
    hooks: discoverHooks(pluginDir),
    workflows: discoverWorkflows(pluginDir),
    mcpServers: discoverMcpServers(pluginDir),
  }
}
