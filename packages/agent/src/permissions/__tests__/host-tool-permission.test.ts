/**
 * Plan 487 — host-level standing permission switch tests.
 *
 * Coverage matrix:
 *   - host=ask    × {default, acceptEdits, plan, auto}           → fall through
 *   - host=always × {default, acceptEdits, plan, auto, bubble}   → HOST_PERMISSION_GRANTED
 *   - host=never  × {default, acceptEdits, plan, auto, bubble}   → HOST_PERMISSION_DENIED
 *   - host=always × {bypassPermissions, dontAsk}                 → mode bypass wins (allow)
 *   - host=never  × {bypassPermissions, dontAsk}                 → mode bypass wins (allow)
 *   - catastrophic tool × host=always                            → step 4.7 deny wins
 *   - host=undefined (backward compat)                           → behaves like 'ask'
 *   - DEFAULT_LOCAL_TOOL_PERMISSION constant                    → 'ask'
 */

import { describe, expect, it } from 'vitest'

import { createHasPermissionsToUseTool } from '../permissions.js'
import {
  DEFAULT_LOCAL_TOOL_PERMISSION,
  HOST_PERMISSION_GRANTED,
  HOST_PERMISSION_DENIED,
} from '../types.js'
import type {
  LocalToolPermission,
  PermissionDecision,
  PermissionMode,
  ToolPermissionContext,
} from '../types.js'
import type { ToolPermissionCheckContext } from '../permissions.js'

const SESSION_MODES_GATED_BY_HOST: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bubble',
]
const SESSION_MODES_BYPASS: PermissionMode[] = ['bypassPermissions', 'dontAsk']

function makeContext(
  mode: PermissionMode,
  hostToolPermission: LocalToolPermission | undefined,
): ToolPermissionCheckContext {
  const ctx: ToolPermissionContext = {
    mode,
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    hostToolPermission,
  }
  return {
    getAppState: () => ({
      toolPermissionContext: ctx,
    }),
    abortController: new AbortController(),
  }
}

async function run(
  mode: PermissionMode,
  host: LocalToolPermission | undefined,
  toolName = 'Bash',
  input: Record<string, unknown> = { command: 'echo hello' },
): Promise<PermissionDecision> {
  const fn = createHasPermissionsToUseTool()
  return fn(toolName, input, makeContext(mode, host))
}

describe('plan 487 host tool permission switch', () => {
  it('host=ask falls through to existing pipeline', async () => {
    const decision = await run('default', 'ask')
    expect(String(decision.decisionReason?.reason ?? '')).not.toContain(HOST_PERMISSION_GRANTED)
    expect(String(decision.decisionReason?.reason ?? '')).not.toContain(HOST_PERMISSION_DENIED)
  })

  for (const mode of SESSION_MODES_GATED_BY_HOST) {
    it(`host=always with mode=${mode} → allow with HOST_PERMISSION_GRANTED`, async () => {
      const decision = await run(mode, 'always')
      expect(decision.behavior).toBe('allow')
      expect(decision.decisionReason?.type).toBe('safetyCheck')
      expect(String(decision.decisionReason?.reason ?? '')).toContain(HOST_PERMISSION_GRANTED)
    })

    it(`host=never with mode=${mode} → deny with HOST_PERMISSION_DENIED`, async () => {
      const decision = await run(mode, 'never')
      expect(decision.behavior).toBe('deny')
      expect(decision.decisionReason?.type).toBe('safetyCheck')
      expect(String(decision.decisionReason?.reason ?? '')).toContain(HOST_PERMISSION_DENIED)
    })
  }

  for (const mode of SESSION_MODES_BYPASS) {
    it(`host=always with explicit bypass mode=${mode} → mode bypass wins (allow)`, async () => {
      const decision = await run(mode, 'always')
      expect(decision.behavior).toBe('allow')
      const reason = String(decision.decisionReason?.reason ?? '')
      expect(reason).not.toContain(HOST_PERMISSION_GRANTED)
    })

    it(`host=never with explicit bypass mode=${mode} → mode bypass wins (allow)`, async () => {
      const decision = await run(mode, 'never')
      expect(decision.behavior).toBe('allow')
      const reason = String(decision.decisionReason?.reason ?? '')
      expect(reason).not.toContain(HOST_PERMISSION_DENIED)
    })
  }

  it('catastrophic tool is denied even when host=always', async () => {
    const decision = await run('default', 'always', 'Bash', {
      command: 'rm -rf /',
      cwd: '/',
    })
    expect(decision.behavior).toBe('deny')
    expect(String(decision.decisionReason?.reason ?? '')).not.toContain(HOST_PERMISSION_GRANTED)
  })

  it('host=undefined behaves like ask (backward compatible)', async () => {
    const decision = await run('default', undefined)
    const reason = String(decision.decisionReason?.reason ?? '')
    expect(reason).not.toContain(HOST_PERMISSION_GRANTED)
    expect(reason).not.toContain(HOST_PERMISSION_DENIED)
  })

  it('DEFAULT_LOCAL_TOOL_PERMISSION is ask', () => {
    expect(DEFAULT_LOCAL_TOOL_PERMISSION).toBe('ask')
  })
})
