export function getTaskIntentPromptSection(): string {
  return [
    'Task intent routing policy:',
    'Select prompt behavior based on intent class.',
    'Supported intents:',
    '- paper_reading',
    '- literature_review',
    '- research_planning',
    '- hypothesis_update',
    '- experiment_planning',
    '- writing_assistance',
    '- citation_check',
    '- memory_review',
    '- general_research_chat',
    'Only inject sections relevant to current intent.',
  ].join('\n')
}

