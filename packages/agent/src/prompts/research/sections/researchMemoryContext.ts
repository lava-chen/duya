import type { PromptContext } from '../../types.js'

export function getResearchMemoryContextPromptSection(context: PromptContext): string {
  const projectLine = context.researchProjectId
    ? `Current project_id: ${context.researchProjectId}`
    : 'Current project_id: unknown'

  return [
    'Research memory context policy:',
    projectLine,
    '- Inject only task-relevant memory slices (not full memory dump).',
    '- Keep memory structured: project state, active hypotheses, open questions, recent decisions.',
    '- Do not treat deprecated memories as current project state.',
    '- Use tentative memories carefully and label uncertainty.',
    '- If new evidence contradicts active hypotheses, surface conflict and propose memory update.',
  ].join('\n')
}

