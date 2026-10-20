// Pure logic for grouping tool actions by research lifecycle stage (plan 423
// UI). Kept dependency-free so it can be unit-tested in isolation without
// pulling in the React render tree (which transitively imports window-dependent
// modules like the conductor canvas).

import type { ActionItem } from './tools/types';

/** Ordered research stages with bilingual labels. */
export const STAGE_LABELS: Array<{ key: string; zh: string; en: string }> = [
  { key: 'clarifying', zh: '澄清需求', en: 'Clarifying scope' },
  { key: 'planning', zh: '制定调研计划', en: 'Planning' },
  { key: 'gathering', zh: '收集资料', en: 'Gathering sources' },
  { key: 'evaluating', zh: '来源质量评估', en: 'Evaluating sources' },
  { key: 'synthesizing', zh: '撰写报告', en: 'Synthesizing report' },
];

export function stageLabel(stage: string): { zh: string; en: string } {
  const found = STAGE_LABELS.find((s) => s.key === stage);
  if (found) return { zh: found.zh, en: found.en };
  return { zh: stage.replace(/_/g, ' '), en: stage.replace(/_/g, ' ') };
}

export interface StageSection {
  stage: string;
  actions: ActionItem[];
}

/** Split actions at stage boundaries, preserving arrival order. Actions
 *  without a stage are attached to the preceding staged section (or a
 *  leading bucket when they appear before any staged tool). */
export function splitByStage(actions: ActionItem[]): StageSection[] {
  const sections: StageSection[] = [];
  let current: StageSection | null = null;

  for (const action of actions) {
    const stage = (action.kind === 'tool' ? action.tool.stage : undefined) || '';
    if (stage) {
      if (!current || current.stage !== stage) {
        current = { stage, actions: [] };
        sections.push(current);
      }
      current.actions.push(action);
    } else if (action.kind === 'thinking' || action.kind === 'text') {
      if (current) {
        current.actions.push(action);
      }
    } else if (action.kind === 'tool') {
      if (current) {
        current.actions.push(action);
      } else {
        current = { stage: '', actions: [action] };
        sections.push(current);
      }
    }
  }
  return sections;
}