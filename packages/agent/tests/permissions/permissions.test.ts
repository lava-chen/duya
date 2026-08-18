import { describe, it, expect } from 'vitest'
import { createHasPermissionsToUseTool, decideMcpSource } from '../../src/permissions/permissions'
import type { ToolPermissionContext } from '../../src/permissions/types'
import type { McpToolSource } from '../../src/permissions/types'

function createContext(
  mode: ToolPermissionContext['mode'],
  overrides?: Partial<ToolPermissionContext>,
): {
  getAppState: () => { toolPermissionContext: ToolPermissionContext }
  abortController: AbortController
} {
  return {
    getAppState: () => ({
      toolPermissionContext: {
        mode,
        additionalWorkingDirectories: new Map(),
        alwaysAllowRules: {},
        alwaysDenyRules: {},
        alwaysAskRules: {},
        isBypassPermissionsModeAvailable: false,
        ...overrides,
      },
    }),
    abortController: new AbortController(),
  }
}

describe('createHasPermissionsToUseTool', () => {
  const hasPermissions = createHasPermissionsToUseTool()

  it.each([
    'default',
    'acceptEdits',
    'auto',
    'plan',
  ] as ToolPermissionContext['mode'][])('allows canvas tools in %s mode', async (mode) => {
    const result = await hasPermissions('canvas_create_element', {}, createContext(mode))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'canvas_create_element is an internal canvas operation.',
    })
  })

  it('allows canvas_manage in auto mode', async () => {
    const result = await hasPermissions('canvas_manage', { action: 'list' }, createContext('auto'))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'canvas_manage is an internal canvas operation.',
    })
  })

  it('allows database_manage as an internal conductor operation', async () => {
    const result = await hasPermissions('database_manage', { action: 'query' }, createContext('auto'))

    expect(result).toEqual({
      behavior: 'allow',
      decisionReason: {
        type: 'safetyCheck',
        reason: 'database_manage is an internal canvas operation.',
        classifierApprovable: false,
      },
    })
  })

  it('ignores user deny rules for internal canvas tools', async () => {
    const result = await hasPermissions(
      'canvas_manage',
      { action: 'list' },
      createContext('auto', {
        alwaysDenyRules: { userSettings: ['canvas_manage'] },
      }),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'canvas_manage is an internal canvas operation.',
    })
  })

  it.each(['AskUserQuestion', 'read_module', 'show_widget', 'LSP', 'task', 'Agent', 'Task', 'send_artifact'])('allows internal tool %s in default mode', async (toolName) => {
    const result = await hasPermissions(toolName, {}, createContext('default'))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: `${toolName} is an internal application operation.`,
    })
  })

  it('still asks for non-canvas tools in default mode', async () => {
    const result = await hasPermissions('Bash', { command: 'echo hello' }, createContext('default'))
    expect(result.behavior).toBe('ask')
  })

  it('bypasses prompting in dontAsk (background/headless) mode', async () => {
    const result = await hasPermissions('Bash', { command: 'echo hello' }, createContext('dontAsk'))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'mode', mode: 'dontAsk' })
  })

  it('denies catastrophic bash commands even in default mode', async () => {
    // `rm -rf /` bricks the system — the catastrophic safety boundary
    // fires before the mode short-circuit, so it is denied regardless
    // of permission mode (including bypassPermissions).
    const result = await hasPermissions('Bash', { command: 'rm -rf /' }, createContext('default'))
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  it('denies catastrophic bash commands even in bypassPermissions mode', async () => {
    const result = await hasPermissions(
      'Bash',
      { command: 'rm -rf /' },
      createContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  it('denies catastrophic write paths even in bypassPermissions mode', async () => {
    const result = await hasPermissions(
      'Write',
      { file_path: 'C:\\Windows\\System32\\evil.dll' },
      createContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('deny')
    expect(result.decisionReason).toMatchObject({ type: 'safetyCheck' })
  })

  it('allows non-catastrophic bash in bypassPermissions mode', async () => {
    const result = await hasPermissions(
      'Bash',
      { command: 'echo hello' },
      createContext('bypassPermissions'),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({ type: 'mode' })
  })

  it('respects explicit user deny rules for non-internal tools', async () => {
    const result = await hasPermissions(
      'Bash',
      { command: 'echo hello' },
      createContext('default', {
        alwaysDenyRules: { userSettings: ['Bash'] },
      }),
    )
    expect(result.behavior).toBe('deny')
  })

  it('ignores user deny rules for internal state-only tools', async () => {
    const result = await hasPermissions(
      'AskUserQuestion',
      {},
      createContext('default', {
        alwaysDenyRules: { userSettings: ['AskUserQuestion'] },
      }),
    )
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: 'AskUserQuestion is an internal application operation.',
    })
  })
})

describe('decideMcpSource (unified MCP provenance gate)', () => {
  const d = (source: McpToolSource, mode?: string, toolName = 'tool/x') =>
    decideMcpSource(source, (mode as never) ?? undefined, toolName)

  it('allows bundled tool in any / undefined mode', () => {
    expect(d('bundled', undefined).behavior).toBe('allow')
    expect(d('bundled', 'default').behavior).toBe('allow')
  })

  it('allows plugin/local in bypass modes (user explicit intent)', () => {
    expect(d('plugin', 'bypassPermissions').behavior).toBe('allow')
    expect(d('local', 'dontAsk').behavior).toBe('allow')
  })

  it('prompts for plugin/local/unknown in non-bypass modes (never silent)', () => {
    for (const mode of [undefined, 'default', 'auto', 'plan', 'acceptEdits'] as const) {
      expect(d('plugin', mode).behavior).toBe('ask')
      expect(d('local', mode).behavior).toBe('ask')
      expect(d('unknown', mode).behavior).toBe('ask')
    }
  })

  it('allows settings in any mode (explicit user config = trust)', () => {
    for (const mode of ['default', 'auto', undefined]) {
      expect(d('settings', mode).behavior).toBe('allow')
    }
  })

  it('includes the tool name in the ask message', () => {
    const r = d('plugin', 'default', 'marketplace/dangerous')
    expect(r.behavior).toBe('ask')
    expect(r.message).toContain('marketplace/dangerous')
  })

  it('settings ask/allow reason names the tool', () => {
    const r = d('settings', 'default', 'cfg/tool')
    if (r.behavior !== 'allow' || !r.decisionReason || r.decisionReason.type !== 'safetyCheck') {
      throw new Error('expected settings allow with safetyCheck reason')
    }
    expect(r.decisionReason.reason).toContain('cfg/tool')
  })
})
