import { readFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'

export interface PluginMdMetadata {
  name: string
  description: string
  version: string
  author: string
}

export interface PluginMdResult {
  metadata: PluginMdMetadata
  body: string
}

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export function parsePluginMd(filePath: string): PluginMdResult {
  const content = readFileSync(filePath, 'utf-8')
  const match = content.match(FRONTMATTER_REGEX)

  if (!match) {
    return {
      metadata: { name: '', description: '', version: '0.0.0', author: '' },
      body: content.trim(),
    }
  }

  const rawYaml = match[1]
  const body = match[2].trim()

  let parsed: Record<string, unknown> = {}
  try {
    parsed = parseYaml(rawYaml) ?? {}
  } catch {
    parsed = {}
  }

  const metadata: PluginMdMetadata = {
    name: String(parsed.name ?? ''),
    description: String(parsed.description ?? ''),
    version: String(parsed.version ?? '0.0.0'),
    author: String(parsed.author ?? ''),
  }

  return { metadata, body }
}

export function parsePluginMdString(content: string): PluginMdResult {
  const match = content.match(FRONTMATTER_REGEX)

  if (!match) {
    return {
      metadata: { name: '', description: '', version: '0.0.0', author: '' },
      body: content.trim(),
    }
  }

  const rawYaml = match[1]
  const body = match[2].trim()

  let parsed: Record<string, unknown> = {}
  try {
    parsed = parseYaml(rawYaml) ?? {}
  } catch {
    parsed = {}
  }

  const metadata: PluginMdMetadata = {
    name: String(parsed.name ?? ''),
    description: String(parsed.description ?? ''),
    version: String(parsed.version ?? '0.0.0'),
    author: String(parsed.author ?? ''),
  }

  return { metadata, body }
}