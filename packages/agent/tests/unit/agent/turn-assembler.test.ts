/**
 * TurnAssembler unit tests — Plan 550 step 2a-2.
 *
 * Pins the assembler behaviour against a stub `AgentRuntime`. The
 * real `duyaAgent` will implement `AgentRuntime` in a follow-up
 * commit; until then these tests verify the pure logic without
 * pulling in the god class.
 *
 * @see docs/exec-plans/active/550-prompt-hbs-and-agent-decomposition.md
 */

import { describe, expect, it } from 'vitest';

import { TurnAssembler } from '../../../src/agent/TurnAssembler.js';
import type { AgentRuntime } from '../../../src/agent/AgentRuntime.js';
import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
} from '../../../src/agent/TurnContext.js';
import type { CommunicationPlatform } from '../../../src/prompts/types.js';

function fakeAgent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    turnSequence: () => 7,
    sessionId: () => 'session-1',
    workingDirectory: () => 'E:\\Projects\\duya',
    communicationPlatform: () => undefined,
    language: () => undefined,
    permissionMode: () => 'default',
    hostToolPermission: () => undefined,
    additionalWorkingDirectories: () => new Map(),
    turnAlwaysAllowTools: () => [],
    ...overrides,
  };
}

describe('TurnAssembler.build', () => {
  it('returns a TurnContext with the flattened prompt and per-turn fields', () => {
    const ctx = TurnAssembler.build(
      fakeAgent({
        sessionId: () => 'session-abc',
        language: () => 'zh-CN',
        communicationPlatform: () => 'cli' as CommunicationPlatform,
      }),
      undefined,
      'hello world',
    );
    expect(ctx.promptText).toBe('hello world');
    expect(ctx.sessionId).toBe('session-abc');
    expect(ctx.language).toBe('zh-CN');
    expect(ctx.communicationPlatform).toBe('cli');
    expect(ctx.permissionMode).toBe('default');
    expect(ctx.turnId).toBeNull();
  });

  it('flattens a MessageContent[] prompt to empty string (legacy behaviour)', () => {
    const ctx = TurnAssembler.build(
      fakeAgent(),
      undefined,
      [
        { type: 'text', text: 'multi-block' },
        { type: 'text', text: 'should not surface' },
      ] as never,
    );
    expect(ctx.promptText).toBe('');
  });

  it('honours options.turnId when the caller supplies one', () => {
    const ctx = TurnAssembler.build(
      fakeAgent({ turnSequence: () => 42 }),
      { turnId: 'turn-xyz' },
      'hi',
    );
    expect(ctx.turnId).toEqual({ sequence: 42, id: 'turn-xyz' });
  });

  it('falls back to NO_APPROVAL_LEDGER when no grants are present', () => {
    const ctx = TurnAssembler.build(fakeAgent(), undefined, 'hi');
    expect(ctx.approval).toBe(NO_APPROVAL_LEDGER);
  });

  it('captures always-allow grants from options', () => {
    const ctx = TurnAssembler.build(
      fakeAgent(),
      { approvedAlwaysAllowTools: ['ReadTool', 'WriteTool'] },
      'hi',
    );
    expect([...ctx.approval.alwaysAllowTools].sort()).toEqual([
      'ReadTool',
      'WriteTool',
    ]);
  });

  it('captures always-allow grants from the agent when no options', () => {
    const ctx = TurnAssembler.build(
      fakeAgent({ turnAlwaysAllowTools: () => ['EditTool'] }),
      undefined,
      'hi',
    );
    expect([...ctx.approval.alwaysAllowTools]).toEqual(['EditTool']);
  });

  it('falls back to NO_MENTIONS when no mentions are supplied', () => {
    const ctx = TurnAssembler.build(fakeAgent(), undefined, 'hi');
    expect(ctx.mentions).toBe(NO_MENTIONS);
  });

  it('captures provider / skills / plugins mentions into a frozen record', () => {
    const ctx = TurnAssembler.build(
      fakeAgent(),
      {
        mentionedProviders: 'github',
        mentionedSkills: ['agent-create'],
        // ChatOptions.mentionedPlugins carries structured plugin
        // descriptors; the assembler flattens them to bare names.
        mentionedPlugins: [
          {
            pluginId: 'plan-mcp',
            name: 'plan-mcp',
            appConnections: [],
            mcpServers: [],
            skillNames: [],
          },
        ],
      },
      'hi',
    );
    expect(ctx.mentions.provider).toBe('github');
    expect(ctx.mentions.skills).toEqual(['agent-create']);
    expect(ctx.mentions.plugins).toEqual(['plan-mcp']);
    expect(ctx.mentions.contexts).toEqual([]);
    expect(Object.isFrozen(ctx.mentions)).toBe(true);
  });

  it('reads permission mode from the agent runtime', () => {
    const ctx = TurnAssembler.build(
      fakeAgent({ permissionMode: () => 'bypassPermissions' }),
      undefined,
      'hi',
    );
    expect(ctx.permissionMode).toBe('bypassPermissions');
  });

  it('passes additional working directories through verbatim', () => {
    const dirs = new Map<string, unknown>([
      ['C:/extra/one', { reason: 'project' }],
      ['C:/extra/two', { reason: 'scratch' }],
    ]);
    const ctx = TurnAssembler.build(
      fakeAgent({ additionalWorkingDirectories: () => dirs }),
      undefined,
      'hi',
    );
    expect(ctx.additionalWorkingDirectories).toBe(dirs);
  });
});