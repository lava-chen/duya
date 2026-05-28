import type { ResearchTaskIntent } from '../types.js'

export function getOutputFormatPromptSection(intent: ResearchTaskIntent): string {
  const byIntent: Record<ResearchTaskIntent, string[]> = {
    paper_reading: [
      'Focus on one source deeply: problem, method, data, experiments, findings, limitations, reusable ideas.',
      'Connect each important claim to evidence spans.',
    ],
    literature_review: [
      'Compare multiple sources by questions, methods, datasets, findings, limitations, disagreements.',
      'Prioritize synthesis over paper-by-paper listing.',
    ],
    research_planning: [
      'Use project state + hypotheses + evidence + user constraints.',
      'Provide concrete next steps with low/medium/high risk tracks.',
    ],
    hypothesis_update: [
      'State old hypothesis, new evidence, conflict or reinforcement, and updated confidence.',
    ],
    experiment_planning: [
      'Provide experiment goal, setup, metrics, ablations, expected failure modes.',
    ],
    writing_assistance: [
      'Draft in academic style with explicit evidence anchors and uncertainty labels.',
    ],
    citation_check: [
      'Return supported, unsupported, and ambiguous claims with citation status.',
    ],
    memory_review: [
      'Evaluate candidate memories by evidence, relevance, novelty, and conflict.',
      'Recommend accept/merge/reject/revise.',
    ],
    general_research_chat: [
      'Answer directly but preserve evidence labels and uncertainty where needed.',
    ],
  }

  return [
    `Task intent: ${intent}`,
    ...byIntent[intent],
    '',
    'When material claims are present, prefer tags:',
    '[证据支持] [基于当前项目记忆] [我的推测] [需要进一步验证]',
  ].join('\n')
}

