import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, basename, extname } from 'path'
import { parse as parseYaml } from 'yaml'
import {
  WorkflowTemplateSchema,
  type WorkflowTemplate,
} from '@duya/plugin-core'

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
}

export function discoverAllCapabilities(pluginDir: string): PluginCapabilities {
  return {
    commands: discoverCommands(pluginDir),
    agents: discoverAgents(pluginDir),
    skills: discoverSkills(pluginDir),
    hooks: discoverHooks(pluginDir),
    workflows: discoverWorkflows(pluginDir),
  }
}
