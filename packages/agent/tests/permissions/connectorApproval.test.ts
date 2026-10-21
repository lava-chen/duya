// Plan 449: connector approval memory in the permission gate.
//
// Covers the three write/modify-tier outcomes for app-connection tools:
//   1. no approval            → ask with the templated provider message
//   2. session approval       → allow (safetyCheck reason)
//   3. global preApproval     → allow
// Plus: destructive tier is never exempted, and non-connector tools are
// unaffected by session approvals.

import { describe, it, expect, beforeEach } from 'vitest'
import { createHasPermissionsToUseTool } from '../../src/permissions/permissions'
import type { ToolPermissionContext } from '../../src/permissions/types'
import {
  rememberSessionApproval,
  clearSessionApprovals,
} from '../../src/tool/AppConnectionTool/approvals'
import {
  setCachedAppConnectionDescriptors,
  getCachedAppConnectionDescriptors,
  type AppConnectionToolDescriptor,
} from '../../src/tool/AppConnectionTool/index'

function makeDescriptor(
  overrides?: Partial<AppConnectionToolDescriptor>,
): AppConnectionToolDescriptor {
  return {
    name: 'remote_notion_create_page',
    description: 'Creates a page in Notion',
    inputSchema: { type: 'object', properties: {} },
    inputSchemaSummary: 'Official notion Remote MCP',
    riskTier: 'modify',
    provider: 'notion',
    connectionId: 'conn-1',
    action: 'remote:create_page',
    ...overrides,
  }
}

function createContext(mode: ToolPermissionContext['mode']): {
  getAppState: () => {
    toolPermissionContext: ToolPermissionContext & {
      getToolRiskTier?: (toolName: string) => string | undefined
    }
  }
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
        getToolRiskTier: (toolName: string) => {
          const descriptor = getCachedAppConnectionDescriptors().find((d) => d.name === toolName)
          return descriptor?.riskTier
        },
      } as ToolPermissionContext,
    }),
    abortController: new AbortController(),
  }
}

describe('permission gate × connector approval memory (Plan 449)', () => {
  const hasPermissions = createHasPermissionsToUseTool()
  const descriptor = makeDescriptor()

  beforeEach(() => {
    clearSessionApprovals()
    setCachedAppConnectionDescriptors([descriptor])
  })

  it('asks with a templated message when there is no approval', async () => {
    const result = await hasPermissions(descriptor.name, {}, createContext('default'))
    expect(result.behavior).toBe('ask')
    if (result.behavior === 'ask') {
      expect(result.message).toContain('Notion')
      expect(result.message).not.toBe(`Allow ${descriptor.name}?`)
    }
  })

  it('allows without asking after a session approval', async () => {
    rememberSessionApproval(descriptor.name)
    const result = await hasPermissions(descriptor.name, {}, createContext('default'))
    expect(result.behavior).toBe('allow')
    expect(result.decisionReason).toMatchObject({
      type: 'safetyCheck',
      reason: expect.stringContaining('approved'),
    })
  })

  it('allows without asking when globally preApproved', async () => {
    setCachedAppConnectionDescriptors([makeDescriptor({ preApproved: true })])
    const result = await hasPermissions(descriptor.name, {}, createContext('default'))
    expect(result.behavior).toBe('allow')
  })

  it('never exempts a destructive tier', async () => {
    const destructive = makeDescriptor({ name: 'acme_drop_all', riskTier: 'destructive' })
    setCachedAppConnectionDescriptors([destructive])
    rememberSessionApproval(destructive.name)
    const result = await hasPermissions(destructive.name, {}, createContext('default'))
    expect(result.behavior).toBe('ask')
    if (result.behavior === 'ask') {
      expect(result.message).toContain('destructive');
    }
  })

  it('does not exempt non-connector tools that share the risk tier path', async () => {
    // Session memory keyed by exact tool name — another tool with the same
    // tier but no descriptor still asks.
    const other = makeDescriptor({ name: 'remote_github_merge_pr' })
    rememberSessionApproval(other.name)
    const result = await hasPermissions(other.name, {}, createContext('default'))
    expect(result.behavior).toBe('ask')
  })

  it('session approval does not leak to differently-named tools', async () => {
    rememberSessionApproval(descriptor.name)
    const sibling = makeDescriptor({ name: 'remote_notion_delete_page' })
    const result = await hasPermissions(sibling.name, {}, createContext('default'))
    expect(result.behavior).toBe('ask')
  })
})
