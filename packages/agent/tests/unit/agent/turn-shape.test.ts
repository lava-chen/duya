/**
 * Turn shape (the data algorithm) unit tests — Plan 587 M5.4.
 *
 * `turn-assembler.test.ts` (Plan 550 2a-2) pins the same rules through
 * the IO adapter and still passes unchanged. This file pins them at
 * their new home, with no agent in scope at all, and adds the
 * turn-consistency case that only the snapshot read can satisfy.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildTurnShape, flattenPrompt } from '../../../src/agent/turnShape.js';
import { readAgentSnapshot } from '../../../src/agent/TurnAssembler.js';
import {
  NO_APPROVAL_LEDGER,
  NO_MENTIONS,
} from '../../../src/agent/TurnContext.js';
import type { TurnStateSnapshot } from '../../../src/agent/turnShape.js';
import type { AgentRuntime } from '../../../src/agent/AgentRuntime.js';

const snapshot = (
  overrides: Partial<TurnStateSnapshot> = {},
): TurnStateSnapshot => ({
  turnSequence: 7,
  sessionId: 'session-1',
  workingDirectory: 'E:\\Projects\\duya',
  communicationPlatform: undefined,
  language: undefined,
  permissionMode: 'default',
  hostToolPermission: undefined,
  additionalWorkingDirectories: new Map(),
  alwaysAllowTools: [],
  ...overrides,
});

describe('buildTurnShape: presence rules', () => {
  it('omits optional keys entirely rather than setting them undefined', () => {
    const shape = buildTurnShape(snapshot(), undefined, 'hi');

    // The loop branches on these with `in` / spread, so a present-but-
    // undefined key is a real difference, not a cosmetic one.
    expect('communicationPlatform' in shape).toBe(false);
    expect('language' in shape).toBe(false);
    expect('hostToolPermission' in shape).toBe(false);
    expect(Object.keys(shape).sort()).toEqual(
      [
        'additionalWorkingDirectories',
        'approval',
        'mentions',
        'permissionMode',
        'promptText',
        'sessionId',
        'turnId',
        'workingDirectory',
      ].sort(),
    );
  });

  it('includes an optional key once the snapshot carries it', () => {
    const shape = buildTurnShape(
      snapshot({
        communicationPlatform: 'cli',
        language: 'zh-CN',
        hostToolPermission: { allow: ['ReadTool'] },
      }),
      undefined,
      'hi',
    );

    expect(shape.communicationPlatform).toBe('cli');
    expect(shape.language).toBe('zh-CN');
    expect(shape.hostToolPermission).toEqual({ allow: ['ReadTool'] });
  });

  it('normalises a missing session id and working directory to null', () => {
    const shape = buildTurnShape(
      snapshot({ sessionId: undefined, workingDirectory: undefined }),
      undefined,
      'hi',
    );

    expect(shape.sessionId).toBeNull();
    expect(shape.workingDirectory).toBeNull();
  });

  it('builds the turn id from the same snapshot the rest of the turn uses', () => {
    const shape = buildTurnShape(
      snapshot({ turnSequence: 42 }),
      { turnId: 'turn-xyz' },
      'hi',
    );

    expect(shape.turnId).toEqual({ sequence: 42, id: 'turn-xyz' });
    expect(buildTurnShape(snapshot({ turnSequence: 42 }), undefined, 'hi').turnId).toBeNull();
  });

  it('passes additional working directories through verbatim', () => {
    const dirs = new Map<string, unknown>([['C:/extra', { reason: 'project' }]]);
    const shape = buildTurnShape(
      snapshot({ additionalWorkingDirectories: dirs }),
      undefined,
      'hi',
    );

    expect(shape.additionalWorkingDirectories).toBe(dirs);
  });
});

describe('buildTurnShape: prompt flattening', () => {
  it('keeps a string prompt', () => {
    expect(flattenPrompt('hello')).toBe('hello');
    expect(buildTurnShape(snapshot(), undefined, 'hello').promptText).toBe('hello');
  });

  it('flattens a MessageContent[] prompt to the empty string (legacy behaviour)', () => {
    expect(
      flattenPrompt([{ type: 'text', text: 'multi-block' }] as never),
    ).toBe('');
  });
});

describe('buildTurnShape: approval ledger', () => {
  it('collapses to the shared empty value when there are no grants', () => {
    expect(buildTurnShape(snapshot(), undefined, 'hi').approval).toBe(NO_APPROVAL_LEDGER);
  });

  it('prefers the caller grants over the agent grants', () => {
    const shape = buildTurnShape(
      snapshot({ alwaysAllowTools: ['FromAgent'] }),
      { approvedAlwaysAllowTools: ['FromOptions'] },
      'hi',
    );

    expect([...shape.approval.alwaysAllowTools]).toEqual(['FromOptions']);
  });

  it('keeps a ledger that exists only to carry consumeApprovedEffect', () => {
    const consumeApprovedEffect = async () => true;
    const shape = buildTurnShape(
      snapshot(),
      { consumeApprovedEffect },
      'hi',
    );

    expect(shape.approval).not.toBe(NO_APPROVAL_LEDGER);
    expect(shape.approval.consumeApprovedEffect).toBe(consumeApprovedEffect);
  });
});

describe('buildTurnShape: mentions', () => {
  it('collapses to the shared empty value when nothing was mentioned', () => {
    expect(buildTurnShape(snapshot(), undefined, 'hi').mentions).toBe(NO_MENTIONS);
  });

  it('reduces plugin descriptors to bare names and freezes the record', () => {
    const shape = buildTurnShape(
      snapshot(),
      {
        mentionedProviders: 'github',
        mentionedSkills: ['agent-create'],
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

    expect(shape.mentions.plugins).toEqual(['plan-mcp']);
    expect(shape.mentions.skills).toEqual(['agent-create']);
    expect(shape.mentions.provider).toBe('github');
    expect(Object.isFrozen(shape.mentions)).toBe(true);
  });
});

describe('readAgentSnapshot: turn consistency', () => {
  it('reads every accessor exactly once', () => {
    // The pre-split assembler called readCommunicationPlatform() and
    // readLanguage() twice each while building the shape.
    const agent = {
      readTurnSequence: vi.fn(() => 1),
      readSessionId: vi.fn(() => 's'),
      readWorkingDirectory: vi.fn(() => 'E:\\w'),
      readCommunicationPlatform: vi.fn(() => 'cli'),
      readLanguage: vi.fn(() => 'zh-CN'),
      readPermissionMode: vi.fn(() => 'default' as const),
      readHostToolPermission: vi.fn(() => undefined),
      readAdditionalWorkingDirectories: vi.fn(() => new Map()),
      readTurnAlwaysAllowTools: vi.fn(() => []),
    } satisfies AgentRuntime;

    const read = readAgentSnapshot(agent);

    for (const fn of Object.values(agent)) {
      expect(fn).toHaveBeenCalledTimes(1);
    }
    expect(read.communicationPlatform).toBe('cli');
    expect(read.language).toBe('zh-CN');
  });

  it('cannot be fooled by an accessor whose value moves between calls', () => {
    // This is the failure the snapshot removes. Each read answers a
    // different value, so any code path that reads a field twice can
    // build a context whose fields disagree with one another.
    let platformCall = 0;
    let languageCall = 0;
    const agent: AgentRuntime = {
      readTurnSequence: () => 1,
      readSessionId: () => 's',
      readWorkingDirectory: () => 'E:\\w',
      readCommunicationPlatform: () =>
        (platformCall++ === 0 ? 'cli' : undefined) as never,
      readLanguage: () => (languageCall++ === 0 ? 'zh-CN' : undefined) as never,
      readPermissionMode: () => 'default',
      readHostToolPermission: () => undefined,
      readAdditionalWorkingDirectories: () => new Map(),
      readTurnAlwaysAllowTools: () => [],
    };

    const shape = buildTurnShape(readAgentSnapshot(agent), undefined, 'hi');

    // One observation, one value: the two optional fields that the old
    // body could disagree with are now both present and consistent.
    expect(shape.communicationPlatform).toBe('cli');
    expect(shape.language).toBe('zh-CN');
  });
});
