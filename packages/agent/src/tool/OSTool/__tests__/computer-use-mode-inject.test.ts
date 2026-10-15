import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearComputerUseContextTrigger,
  recordComputerUseContextTrigger,
} from '@duya/capabilities/OSTool/context-tool';
import { computerUseMode } from '../../../modes/computer-use-mode.js';
import type { ToolRegistration } from '../../../modes/types.js';

const SESSION = 'ctx-test-session';

beforeEach(() => {
  clearComputerUseContextTrigger(SESSION);
  clearComputerUseContextTrigger('other-session');
});

function injectFor(sessionId: string | undefined): ToolRegistration[] {
  return (
    computerUseMode.tools!.inject as (ctx: {
      sessionId: string | undefined;
      workingDirectory: string;
      state: Record<string, never>;
    }) => ToolRegistration[]
  )({ sessionId, workingDirectory: '/tmp', state: {} });
}

describe('computer-use-mode conditional tool injection', () => {
  it('injects computer_use and computer_cua when unarmed', () => {
    const tools = injectFor(SESSION);
    expect(tools.map((tool) => tool.definition.name)).toEqual(['computer_use', 'computer_cua']);
  });

  it('injects all three tools after a zero-element capture', () => {
    recordComputerUseContextTrigger(SESSION, 'capture-zero-elements');
    const tools = injectFor(SESSION);
    expect(tools.map((tool) => tool.definition.name)).toEqual([
      'computer_use',
      'computer_use_context',
      'computer_cua',
    ]);
  });

  it.each(['click-suspected-noop', 'explicit-call'] as const)(
    'injects computer_use_context when armed by %s',
    (trigger) => {
      recordComputerUseContextTrigger(SESSION, trigger);
      expect(injectFor(SESSION).map((tool) => tool.definition.name)).toContain('computer_use_context');
    },
  );

  it('keeps other sessions unarmed', () => {
    recordComputerUseContextTrigger(SESSION, 'explicit-call');
    expect(injectFor('other-session').map((tool) => tool.definition.name)).toEqual([
      'computer_use',
      'computer_cua',
    ]);
  });
});
