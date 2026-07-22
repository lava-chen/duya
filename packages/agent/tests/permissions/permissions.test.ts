import { describe, it, expect } from 'vitest'
import { createHasPermissionsToUseTool } from '../../src/permissions/permissions'
import type { ToolPermissionContext } from '../../src/permissions/types'

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

  it.each(['AskUserQuestion', 'read_module', 'show_widget', 'LSP', 'task', 'Agent', 'Task'])('allows internal tool %s in default mode', async (toolName) => {
    const result = await hasPermissions(toolName, {}, createContext('default'))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: `${toolName} is an internal application operation.`,
    })
  })

  it('still asks for non-canvas tools in default mode', async () => {
    const result = await hasPermissions('Bash', { command: 'rm -rf /' }, createContext('default'))
    expect(result.behavior).toBe('ask')
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
