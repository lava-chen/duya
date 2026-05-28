import { readdirSync, readFileSync, existsSync, statSync } from 'fs'
import { join, basename, extname } from 'path'

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

export function discoverSkills(pluginDir: string): CapabilityIndexItem[] {
  return scanMdFiles(join(pluginDir, 'skills'))
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

export interface PluginCapabilities {
  commands: CapabilityIndexItem[]
  agents: CapabilityIndexItem[]
  skills: CapabilityIndexItem[]
  hooks: HookCapability[]
}

export function discoverAllCapabilities(pluginDir: string): PluginCapabilities {
  return {
    commands: discoverCommands(pluginDir),
    agents: discoverAgents(pluginDir),
    skills: discoverSkills(pluginDir),
    hooks: discoverHooks(pluginDir),
  }
}