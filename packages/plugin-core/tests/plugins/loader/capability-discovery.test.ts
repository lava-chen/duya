// packages/plugin-core/tests/plugins/loader/capability-discovery.test.ts
// Unit tests for the plugin capability discovery helpers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  discoverSkills,
  discoverCommands,
  discoverAgents,
  discoverAllCapabilities,
  discoverWorkflows,
  discoverAgentPluginsMcpServers,
  AGENT_PLUGINS_MCP_SCHEMA,
} from '../../../src/plugins/loader/capability-discovery'

describe('discoverSkills — subdirectory layout (skills/<name>/SKILL.md)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-skills-sub-'))
    mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true })
    mkdirSync(join(dir, 'skills', 'beta'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '# Alpha\n')
    writeFileSync(join(dir, 'skills', 'beta', 'SKILL.md'), '# Beta\n')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('discovers each skill directory containing SKILL.md', () => {
    const skills = discoverSkills(dir)
    expect(skills).toHaveLength(2)
    const names = skills.map((s) => s.name).sort()
    expect(names).toEqual(['alpha', 'beta'])
  })

  it('points the path at the SKILL.md inside the subdirectory', () => {
    const skills = discoverSkills(dir)
    const alpha = skills.find((s) => s.name === 'alpha')
    expect(alpha?.path).toBe(join(dir, 'skills', 'alpha', 'SKILL.md'))
  })

  it('skips subdirectories that have no SKILL.md', () => {
    mkdirSync(join(dir, 'skills', 'incomplete'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'incomplete', 'README.md'), '# not a skill\n')
    const skills = discoverSkills(dir)
    expect(skills.map((s) => s.name)).not.toContain('incomplete')
    expect(skills).toHaveLength(2)
  })
})

describe('discoverSkills — noise filtering', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-skills-noise-'))
    mkdirSync(join(dir, 'skills', 'real-skill'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'real-skill', 'SKILL.md'), '# Real\n')
    // Noise: non-markdown file + nested dir without SKILL.md
    writeFileSync(join(dir, 'skills', 'notes.txt'), 'noise\n')
    mkdirSync(join(dir, 'skills', 'empty-dir'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('only picks up subdirectory skills with SKILL.md', () => {
    const skills = discoverSkills(dir)
    expect(skills.map((s) => s.name)).toEqual(['real-skill'])
  })

  it('ignores non-markdown files and empty subdirectories', () => {
    const skills = discoverSkills(dir)
    expect(skills.map((s) => s.name)).not.toContain('notes')
    expect(skills.map((s) => s.name)).not.toContain('empty-dir')
  })
})

describe('discoverSkills — edge cases', () => {
  it('returns an empty array when the skills directory does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-skills-empty-'))
    try {
      expect(discoverSkills(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty array for an empty skills directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-skills-blank-'))
    mkdirSync(join(dir, 'skills'), { recursive: true })
    try {
      expect(discoverSkills(dir)).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('discoverSkills — does not affect other discover* helpers', () => {
  it('discoverCommands still uses the flat layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-cmd-'))
    try {
      mkdirSync(join(dir, 'commands'), { recursive: true })
      writeFileSync(join(dir, 'commands', 'lint.md'), '# Lint\n')
      expect(discoverCommands(dir).map((c) => c.name)).toEqual(['lint'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discoverAgents still uses the flat layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-agt-'))
    try {
      mkdirSync(join(dir, 'agents'), { recursive: true })
      writeFileSync(join(dir, 'agents', 'reviewer.md'), '# Reviewer\n')
      expect(discoverAgents(dir).map((a) => a.name)).toEqual(['reviewer'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discoverAllCapabilities exposes skills from the subdirectory layout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-all-'))
    try {
      mkdirSync(join(dir, 'skills', 'one'), { recursive: true })
      writeFileSync(join(dir, 'skills', 'one', 'SKILL.md'), '# One\n')
      const caps = discoverAllCapabilities(dir)
      expect(caps.skills.map((s) => s.name)).toEqual(['one'])
      expect(caps.commands).toEqual([])
      expect(caps.agents).toEqual([])
      expect(caps.hooks).toEqual([])
      expect(caps.workflows).toEqual([])
      expect(caps.mcpServers).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// Plan 311 — discoverWorkflows
describe('discoverWorkflows — workflows/*.yaml (Plan 311)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-wf-'))
    mkdirSync(join(dir, 'workflows'), { recursive: true })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('discovers a schema-valid workflow template', () => {
    writeFileSync(
      join(dir, 'workflows', 'review.yaml'),
      [
        'id: literature-review',
        'name: Literature Review',
        'description: Survey the literature on a topic.',
        'prompt: |',
        '  Survey {{topic}} and produce an evidence table.',
        'requiredCapabilities:',
        '  - mcp:literature',
        'permissionTier: read',
      ].join('\n'),
    )
    const templates = discoverWorkflows(dir)
    expect(templates).toHaveLength(1)
    expect(templates[0].id).toBe('literature-review')
    expect(templates[0].name).toBe('Literature Review')
    expect(templates[0].permissionTier).toBe('read')
    expect(templates[0].requiredCapabilities).toEqual(['mcp:literature'])
  })

  it('accepts .yml extension as an alternative to .yaml', () => {
    writeFileSync(
      join(dir, 'workflows', 'short.yml'),
      [
        'id: short',
        'name: Short',
        'description: A short template.',
        'prompt: Hello',
      ].join('\n'),
    )
    const templates = discoverWorkflows(dir)
    expect(templates).toHaveLength(1)
    expect(templates[0].id).toBe('short')
  })

  it('silently skips yaml files that fail schema validation', () => {
    // Missing required `id` field
    writeFileSync(
      join(dir, 'workflows', 'bad.yaml'),
      [
        'name: Bad',
        'description: Missing id',
        'prompt: Hello',
      ].join('\n'),
    )
    // Valid file alongside the bad one
    writeFileSync(
      join(dir, 'workflows', 'good.yaml'),
      [
        'id: good',
        'name: Good',
        'description: Valid template.',
        'prompt: Hello',
      ].join('\n'),
    )
    const templates = discoverWorkflows(dir)
    expect(templates).toHaveLength(1)
    expect(templates[0].id).toBe('good')
  })

  it('defaults requiredCapabilities to [] and permissionTier to read', () => {
    writeFileSync(
      join(dir, 'workflows', 'minimal.yaml'),
      [
        'id: minimal',
        'name: Minimal',
        'description: Minimal template.',
        'prompt: Hello',
      ].join('\n'),
    )
    const templates = discoverWorkflows(dir)
    expect(templates).toHaveLength(1)
    expect(templates[0].requiredCapabilities).toEqual([])
    expect(templates[0].permissionTier).toBe('read')
  })

  it('returns an empty array when the workflows directory does not exist', () => {
    rmSync(join(dir, 'workflows'), { recursive: true, force: true })
    expect(discoverWorkflows(dir)).toEqual([])
  })

  it('returns an empty array for an empty workflows directory', () => {
    expect(discoverWorkflows(dir)).toEqual([])
  })

  it('ignores non-yaml files in the workflows directory', () => {
    writeFileSync(join(dir, 'workflows', 'README.md'), '# Workflows\n')
    writeFileSync(join(dir, 'workflows', 'notes.txt'), 'not a workflow\n')
    expect(discoverWorkflows(dir)).toEqual([])
  })

  it('discoverAllCapabilities includes workflows alongside other capabilities', () => {
    writeFileSync(
      join(dir, 'workflows', 'review.yaml'),
      [
        'id: review',
        'name: Review',
        'description: A review workflow.',
        'prompt: Do a review.',
      ].join('\n'),
    )
    mkdirSync(join(dir, 'skills', 'foo'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'foo', 'SKILL.md'), '# Foo\n')
    const caps = discoverAllCapabilities(dir)
    expect(caps.workflows).toHaveLength(1)
    expect(caps.workflows[0].id).toBe('review')
    expect(caps.skills).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Plan 335 — Agent Plugins 1.0.0 `mcp.json` discovery
// ---------------------------------------------------------------------------

describe('discoverAgentPluginsMcpServers — mcp.json (Plan 335)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-apmcp-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('discovers stdio, streamable-http, and sse servers', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: {
          local: { type: 'stdio', command: './bin/server', args: ['--x'] },
          remote: { type: 'streamable-http', url: 'https://mcp.example.com' },
          legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
        },
      }),
    )
    const servers = discoverAgentPluginsMcpServers(dir)
    expect(servers).toHaveLength(3)
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
    expect(byName['local'].transport).toBe('stdio')
    expect(byName['remote'].transport).toBe('streamable-http')
    expect(byName['legacy'].transport).toBe('sse')
    expect(byName['legacy'].url).toBe('https://mcp.example.com/sse')
  })

  it('injects PLUGIN_ROOT and PLUGIN_DATA into stdio env', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: { local: { type: 'stdio', command: './bin/server' } },
      }),
    )
    const servers = discoverAgentPluginsMcpServers(dir, { pluginDataDir: join(dir, 'data') })
    expect(servers[0].env?.PLUGIN_ROOT).toBe(dir)
    expect(servers[0].env?.PLUGIN_DATA).toBe(join(dir, 'data'))
  })

  it('resolves ${PLUGIN_ROOT} and ${PLUGIN_DATA} path placeholders', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: {
          rootCmd: { type: 'stdio', command: '${PLUGIN_ROOT}/bin/server' },
          dataCwd: { type: 'stdio', command: './bin/server', cwd: '${PLUGIN_DATA}/work' },
        },
      }),
    )
    const data = join(dir, 'data')
    const servers = discoverAgentPluginsMcpServers(dir, { pluginDataDir: data })
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
    expect(byName['rootCmd'].command).toBe(join(dir, 'bin', 'server'))
    expect(byName['dataCwd'].env?.DUYA_PLUGIN_CWD).toBe(join(data, 'work'))
  })

  it('drops servers whose ${PLUGIN_ROOT} path escapes the plugin root', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: {
          escape: { type: 'stdio', command: '${PLUGIN_ROOT}/../../evil' },
        },
      }),
    )
    const servers = discoverAgentPluginsMcpServers(dir)
    expect(servers).toHaveLength(0)
  })

  it('skips the whole mcp.json when $schema does not match exactly', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/1.0.0/other.schema.json',
        mcpServers: { local: { type: 'stdio', command: './bin/server' } },
      }),
    )
    expect(discoverAgentPluginsMcpServers(dir)).toEqual([])
  })

  it('skips unknown transport types', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: { weird: { type: 'custom-transport', url: 'x' } },
      }),
    )
    expect(discoverAgentPluginsMcpServers(dir)).toEqual([])
  })

  it('returns an empty array when mcp.json is absent', () => {
    expect(discoverAgentPluginsMcpServers(dir)).toEqual([])
  })
})

describe('discoverAllCapabilities — mcp.json fallback (Plan 335)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-apall-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('uses the standard mcp.json when mcp/servers.json is absent', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: { remote: { type: 'streamable-http', url: 'https://mcp.example.com' } },
      }),
    )
    const caps = discoverAllCapabilities(dir)
    expect(caps.mcpServers).toHaveLength(1)
    expect(caps.mcpServers[0].name).toBe('remote')
  })

  it('prefers the native mcp/servers.json when both exist', () => {
    writeFileSync(
      join(dir, 'mcp.json'),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: { remote: { type: 'streamable-http', url: 'https://mcp.example.com' } },
      }),
    )
    mkdirSync(join(dir, 'mcp'), { recursive: true })
    writeFileSync(
      join(dir, 'mcp', 'servers.json'),
      JSON.stringify({ servers: [{ name: 'native', transport: 'stdio', command: 'node', args: ['x'] }] }),
    )
    const caps = discoverAllCapabilities(dir)
    expect(caps.mcpServers).toHaveLength(1)
    expect(caps.mcpServers[0].name).toBe('native')
  })
})

describe('discoverSkills — symlink boundary check (Plan 335)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duya-skill-bound-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips a SKILL.md symlink that resolves outside the plugin root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'duya-outside-'))
    mkdirSync(join(dir, 'skills', 'evil'), { recursive: true })
    try {
      writeFileSync(join(outside, 'SKILL.md'), '# Evil\n')
      symlinkSync(join(outside, 'SKILL.md'), join(dir, 'skills', 'evil', 'SKILL.md'))
      const skills = discoverSkills(dir)
      expect(skills).toHaveLength(0)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})