import { readdirSync, readFileSync, existsSync, statSync, realpathSync } from 'fs'
import { join, basename, extname, resolve, relative, isAbsolute } from 'path'
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
        if (
          existsSync(skillFile) &&
          statSync(skillFile).isFile() &&
          isSkillWithinPlugin(pluginDir, skillFile)
        ) {
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
  transport?: 'stdio' | 'streamable-http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** Short, stable prefix for model-visible tool names (`mcp_<nameOverride>_<tool>`). */
  nameOverride?: string
  /** Startup (spawn + handshake + listTools) timeout in seconds. */
  startupTimeoutSec?: number
  /** Default per-tool-call timeout in seconds for this server. */
  toolTimeoutSec?: number
  /** Per-tool-call timeout overrides, keyed by tool name, in seconds. */
  toolTimeouts?: Record<string, number>
  /**
   * How much of the agent process environment the stdio child inherits.
   * `allowlist` (the default at the runtime layer) passes only the
   * permitted variables; `inherit` opts the server into the full parent
   * environment. Declared by `collect.ts` on the manifest view and
   * forwarded there, so it has to be filled by BOTH discovery paths.
   */
  envPassthrough?: 'allowlist' | 'inherit'
  /** Run the stdio command through the platform shell instead of exec'ing it. */
  useShell?: boolean
}

/**
 * One shared normaliser for BOTH MCP discovery paths, so the same server
 * always yields the same field set no matter which file declared it.
 *
 * `base` holds the transport-specific fields each path resolves on its
 * own (stdio `command`/`args`/`env`, or http `url`/`headers`); `raw` is
 * the on-disk entry and supplies the declaration-level fields that must
 * survive either path — above all `nameOverride`, because a provider tool
 * name that changes between the native `mcp/servers.json` and the
 * Agent Plugins `mcp.json` of one plugin is very hard to debug, plus the
 * timeout knobs and the two env/shell switches that `collect.ts` declares.
 */
function normalizeMcpServer(
  base: McpServerCapability,
  raw: Record<string, unknown>,
): McpServerCapability {
  const server: McpServerCapability = { ...base }

  if (typeof raw.nameOverride === 'string') {
    server.nameOverride = raw.nameOverride
  }
  if (typeof raw.startupTimeoutSec === 'number') {
    server.startupTimeoutSec = raw.startupTimeoutSec
  }
  if (typeof raw.toolTimeoutSec === 'number') {
    server.toolTimeoutSec = raw.toolTimeoutSec
  }
  const toolTimeouts = numberRecordOrUndefined(raw.toolTimeouts)
  if (toolTimeouts) server.toolTimeouts = toolTimeouts
  if (raw.envPassthrough === 'allowlist' || raw.envPassthrough === 'inherit') {
    server.envPassthrough = raw.envPassthrough
  }
  if (typeof raw.useShell === 'boolean') {
    server.useShell = raw.useShell
  }

  return server
}

/** `undefined` rather than `[]` so both paths agree on the field set. */
function stringArrayOrUndefined(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

function stringRecordOrUndefined(value: unknown): Record<string, string> | undefined {
  const out = stringRecord(value)
  return Object.keys(out).length > 0 ? out : undefined
}

function numberRecordOrUndefined(value: unknown): Record<string, number> | undefined {
  if (!isObjectRecord(value)) return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'number') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
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
    const base: McpServerCapability = { name }
    if (typeof entry.transport === 'string') {
      base.transport = entry.transport as McpServerCapability['transport']
    }
    if (typeof entry.command === 'string') base.command = entry.command
    const args = stringArrayOrUndefined(entry.args)
    if (args) base.args = args
    const env = stringRecordOrUndefined(entry.env)
    if (env) base.env = env
    if (typeof entry.url === 'string') base.url = entry.url
    const headers = stringRecordOrUndefined(entry.headers)
    if (headers) base.headers = headers
    servers.push(normalizeMcpServer(base, entry))
  }
  return servers
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Boundary check for a discovered skill file (spec §4.1.3): the skill must
 * resolve, after symlink resolution, to a path inside the plugin root.
 * A symlink pointing outside the plugin root makes the skill ineligible.
 */
function isSkillWithinPlugin(pluginDir: string, skillFile: string): boolean {
  try {
    return isWithin(realpathSync(pluginDir), realpathSync(skillFile))
  } catch {
    return false
  }
}

/**
 * Agent Plugins 1.0.0 — canonical `mcp.json` schema identifier. The
 * `$schema` field must match this exactly (it is a `const` in the schema,
 * not a prefix). Unknown schemas are skipped per the "clients must not
 * fetch schemas over the network" rule.
 */
export const AGENT_PLUGINS_MCP_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'

export interface AgentPluginsMcpOptions {
  /**
   * Absolute path to the plugin's data directory. Used to resolve the
   * `${PLUGIN_DATA}` placeholder and to inject the `PLUGIN_DATA` env var.
   * Defaults to `pluginDir` when omitted (a plugin-root data dir is the
   * common case for third-party packages).
   */
  pluginDataDir?: string
}

type PathResolution =
  | { reason: 'ok'; resolved: string }
  | { reason: 'opaque'; resolved: undefined }
  | { reason: 'invalid-escape'; resolved: undefined }

export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Resolve an Agent Plugins path token against the package roots.
 *
 * The spec's `cwd` pattern allows exactly three forms: `./`-relative,
 * `${PLUGIN_ROOT}/...`, and `${PLUGIN_DATA}/...`. Forms that resolve to a
 * path outside their root are invalid. Absolute and other relative paths
 * ("opaque strings" per §4.1.5) are passed through unchanged.
 */
function resolveAgentPluginPath(
  value: string,
  pluginRoot: string,
  pluginDataDir: string,
): PathResolution {
  const rootPrefixed = value.startsWith('${PLUGIN_ROOT}')
  const dataPrefixed = value.startsWith('${PLUGIN_DATA}')
  const dotPrefixed = value.startsWith('./')
  if (!rootPrefixed && !dataPrefixed && !dotPrefixed) {
    return { reason: 'opaque', resolved: undefined }
  }
  const base = dataPrefixed ? pluginDataDir : pluginRoot
  const rest = dataPrefixed
    ? value.slice('${PLUGIN_DATA}'.length)
    : rootPrefixed
      ? value.slice('${PLUGIN_ROOT}'.length)
      : value
  const resolved = resolve(base, rest.replace(/^[/\\]+/, ''))
  if (!isWithin(base, resolved)) {
    return { reason: 'invalid-escape', resolved: undefined }
  }
  return { reason: 'ok', resolved }
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (isObjectRecord(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') out[k] = v
    }
  }
  return out
}

/**
 * Agent Plugins 1.0.0 — discover MCP servers from the fixed root
 * `<pluginDir>/mcp.json`.
 *
 * The file shape is `{ $schema, mcpServers: { <name>: {...} } }` (an object
 * mapping, unlike duya's native `mcp/servers.json` array). `$schema` must
 * exactly equal `AGENT_PLUGINS_MCP_SCHEMA`; the three `server.oneOf` types
 * map to `McpServerCapability`. Path placeholders, containment checks, and
 * the `PLUGIN_ROOT`/`PLUGIN_DATA` env injection are applied per the spec.
 *
 * The spec defines only the transport fields, so the declaration-level
 * fields (`nameOverride`, the timeouts, `envPassthrough`, `useShell`) are
 * not in `mcp.json` by definition — but they are read from the entry when
 * present, through the same `normalizeMcpServer` the native path uses, so
 * a server cannot change tool name or timeouts merely by moving between
 * the two file formats.
 */
export function discoverAgentPluginsMcpServers(
  pluginDir: string,
  options?: AgentPluginsMcpOptions,
): McpServerCapability[] {
  const mcpPath = join(pluginDir, 'mcp.json')
  if (!existsSync(mcpPath)) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(mcpPath, 'utf-8'))
  } catch {
    return []
  }
  if (!isObjectRecord(parsed)) return []
  if (parsed.$schema !== AGENT_PLUGINS_MCP_SCHEMA) return []
  const rawServers = parsed.mcpServers
  if (!isObjectRecord(rawServers)) return []

  const pluginDataDir = options?.pluginDataDir ?? pluginDir
  const servers: McpServerCapability[] = []
  for (const [name, raw] of Object.entries(rawServers)) {
    if (!isObjectRecord(raw)) continue
    const type = typeof raw.type === 'string' ? raw.type : undefined
    if (type === 'stdio') {
      const command =
        typeof raw.command === 'string' && raw.command.length > 0 ? raw.command : undefined
      if (!command) continue
      const cmdRes = resolveAgentPluginPath(command, pluginDir, pluginDataDir)
      if (cmdRes.reason === 'invalid-escape') continue
      const args = stringArrayOrUndefined(raw.args)
      // The spec forbids authors from writing PLUGIN_ROOT/PLUGIN_DATA, which
      // implies the client must inject them into the stdio process env.
      const env: Record<string, string> = {
        ...stringRecord(raw.env),
        PLUGIN_ROOT: pluginDir,
        PLUGIN_DATA: pluginDataDir,
      }
      if (typeof raw.cwd === 'string' && raw.cwd.length > 0) {
        const cwdRes = resolveAgentPluginPath(raw.cwd, pluginDir, pluginDataDir)
        if (cwdRes.reason === 'invalid-escape') continue
        if (cwdRes.resolved) env.DUYA_PLUGIN_CWD = cwdRes.resolved
      }
      servers.push(
        normalizeMcpServer(
          {
            name,
            transport: 'stdio',
            command: cmdRes.resolved ?? command,
            ...(args ? { args } : {}),
            env,
          },
          raw,
        ),
      )
    } else if (type === 'streamable-http' || type === 'sse') {
      const url = typeof raw.url === 'string' && raw.url.length > 0 ? raw.url : undefined
      if (!url) continue
      const headers = stringRecordOrUndefined(raw.headers)
      servers.push(
        normalizeMcpServer(
          {
            name,
            transport: type,
            url,
            ...(headers ? { headers } : {}),
          },
          raw,
        ),
      )
    }
    // Unknown `type` (or a missing one) → server is skipped.
  }
  return servers
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

export function discoverAllCapabilities(
  pluginDir: string,
  options?: AgentPluginsMcpOptions,
): PluginCapabilities {
  // Native `mcp/servers.json` wins when present; fall back to the standard
  // Agent Plugins `mcp.json` otherwise so a duya-authored plugin never gets
  // the same server injected twice.
  const nativeMcp = discoverMcpServers(pluginDir)
  return {
    commands: discoverCommands(pluginDir),
    agents: discoverAgents(pluginDir),
    skills: discoverSkills(pluginDir),
    hooks: discoverHooks(pluginDir),
    workflows: discoverWorkflows(pluginDir),
    mcpServers:
      nativeMcp.length > 0
        ? nativeMcp
        : discoverAgentPluginsMcpServers(pluginDir, options),
  }
}
