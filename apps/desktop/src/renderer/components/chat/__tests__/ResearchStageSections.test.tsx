import { describe, it, expect } from 'vitest';
import { splitByStage, stageLabel } from '../researchStageLogic';
import type { ActionItem } from '../tools/types';

function toolAction(name: string, stage?: string): ActionItem {
  return { kind: 'tool', tool: { name, input: {}, result: 'ok', stage } };
}

describe('splitByStage', () => {
  it('groups tools into sections by stage in arrival order', () => {
    const actions = [
      toolAction('browser', 'gathering'),
      toolAction('bash', 'gathering'),
      toolAction('browser', 'evaluating'),
    ];
    const sections = splitByStage(actions);
    expect(sections.map((s) => s.stage)).toEqual(['gathering', 'evaluating']);
    expect(sections[0].actions).toHaveLength(2);
    expect(sections[1].actions).toHaveLength(1);
  });

  it('merges consecutive tools of the same stage into one section', () => {
    const actions = [toolAction('bash', 'gathering'), toolAction('bash', 'gathering')];
    const sections = splitByStage(actions);
    expect(sections).toHaveLength(1);
    expect(sections[0].stage).toBe('gathering');
    expect(sections[0].actions).toHaveLength(2);
  });

  it('attaches unstaged prose to the current staged section', () => {
    const actions = [
      toolAction('bash', 'gathering'),
      { kind: 'text' as const, content: 'thinking...' },
      toolAction('bash', 'evaluating'),
    ];
    const sections = splitByStage(actions);
    expect(sections).toHaveLength(2);
    expect(sections[0].actions).toHaveLength(2); // tool + text
  });

  it('returns empty for no actions', () => {
    expect(splitByStage([])).toEqual([]);
  });
});

describe('stageLabel', () => {
  it('returns bilingual labels for known stages', () => {
    expect(stageLabel('evaluating')).toEqual({ zh: '来源质量评估', en: 'Evaluating sources' });
    expect(stageLabel('synthesizing').zh).toBe('撰写报告');
  });

  it('falls back to the raw stage for unknown values', () => {
    expect(stageLabel('some_thing')).toEqual({ zh: 'some thing', en: 'some thing' });
  });
});