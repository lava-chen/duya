import { describe, expect, it } from 'vitest';
import { resolveDirectSlash, resolveItemSelection } from './message-input-logic';
import type { PopoverItem } from '@/types/slash-command';

describe('slash command input behavior', () => {
  const skill: PopoverItem = {
    label: '/docx',
    value: '/docx',
    kind: 'agent_skill',
    group: 'skills',
  };

  it('inserts a selected skill into the message text', () => {
    expect(resolveItemSelection(skill, 'skill', 0, '/do', 'do')).toEqual({
      action: 'insert_slash_command',
      commandValue: '/docx',
      newInputValue: '/docx ',
    });
  });

  it('replaces only the active slash fragment', () => {
    expect(resolveItemSelection(skill, 'skill', 6, 'hello /do world', 'do').newInputValue)
      .toBe('hello /docx world');
  });

  it('sends skill commands as normal message content', () => {
    expect(resolveDirectSlash('/docx')).toEqual({ action: 'not_slash' });
    expect(resolveDirectSlash('/docx update this file')).toEqual({ action: 'not_slash' });
  });

  it('keeps immediate local commands immediate', () => {
    expect(resolveDirectSlash('/help')).toEqual({
      action: 'immediate_command',
      commandValue: '/help',
    });
  });
});
