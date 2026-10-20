// Pure-logic tests for grouping tool actions by research lifecycle stage
// (plan 423 UI). Kept dependency-free so it runs without jsdom.

import { describe, expect, it } from 'vitest';
import { splitByStage, stageLabel, STAGE_LABELS } from './researchStageLogic';
import type { ActionItem } from './tools/types';

function stagedTool(name: string, stage: string): ActionItem {
  return { kind: 'tool', tool: { name, input: {}, stage } };
}

describe('stageLabel', () => {
  it('returns bilingual labels for known stages', () => {
    expect(stageLabel('gathering')).toEqual({ zh: '收集资料', en: 'Gathering sources' });
  });

  it('falls back to a clean sibling label for unknown stages', () => {
    expect(stageLabel('foo_bar')).toEqual({ zh: 'foo bar', en: 'foo bar' });
  });

  it('exposes the full ordered stage list', () => {
    expect(STAGE_LABELS.map((s) => s.key)).toEqual([
      'clarifying',
      'planning',
      'gathering',
      'evaluating',
      'synthesizing',
    ]);
  });
});

describe('splitByStage', () => {
  it('splits actions at stage boundaries in arrival order', () => {
    const actions: ActionItem[] = [
      stagedTool('web_search', 'gathering'),
      stagedTool('web_search', 'gathering'),
      stagedTool('research_advance', 'evaluating'),
      stagedTool('web_search', 'evaluating'),
    ];
    const sections = splitByStage(actions);
    expect(sections.map((s) => s.stage)).toEqual(['gathering', 'evaluating']);
    expect(sections[0].actions).toHaveLength(2);
    expect(sections[1].actions).toHaveLength(2);
  });

  it('attaches unstaged thinking/text to the preceding staged section', () => {
    const actions: ActionItem[] = [
      stagedTool('web_search', 'gathering'),
      { kind: 'thinking', content: 'weighing sources' },
      { kind: 'text', content: 'still gathering' },
    ];
    const sections = splitByStage(actions);
    expect(sections).toHaveLength(1);
    expect(sections[0].stage).toBe('gathering');
    expect(sections[0].actions).toHaveLength(3);
  });

  it('collects unstaged tools into their own leading bucket', () => {
    const actions: ActionItem[] = [
      stagedTool('bash', ''),
      stagedTool('web_search', 'gathering'),
    ];
    const sections = splitByStage(actions);
    expect(sections.map((s) => s.stage)).toEqual(['', 'gathering']);
  });

  it('returns an empty list for no actions', () => {
    expect(splitByStage([])).toEqual([]);
  });
});