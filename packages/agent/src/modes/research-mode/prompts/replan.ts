import type { ResearchQuestion, QualityReport, PlanDeltaType } from '../types.js';

export const REPLAN_VERSION = '1.0.0';

export interface ReplanInput {
  contextText: string;
  qualityReport: QualityReport;
  remaining: number;
  currentGoal: string;
}

export interface ReplanOutput {
  add: Array<{ text: string; purpose?: string; priority: number }>;
  obsolete: string[];
  deltaType: PlanDeltaType;
  goalChangeReason?: string;
}

export function buildPrompt(input: ReplanInput): string {
  const { contextText, qualityReport, remaining, currentGoal } = input;

  return `
Review research progress and quality report. You may add up to ${remaining} new sub-questions or obsolete irrelevant ones.
Only add questions that are genuinely needed for completeness, especially to address blockers.
Also classify the nature of changes: are these minor additions, a major new direction, or a goal change?

Research goal: "${currentGoal}"

${contextText}

Quality Report:
- Score: ${(qualityReport.score * 100).toFixed(0)}%
- Ready: ${qualityReport.readyForSynthesis}
- Blockers: ${qualityReport.blockers.join('; ') || 'none'}
- Next Actions: ${qualityReport.nextActions.join('; ') || 'none'}

Return JSON:
{
  "add": [{"text": "...", "purpose": "evidence", "priority": 2}, ...],
  "obsolete": ["q_id1", "q_id2", ...],
  "deltaType": "minor" | "major" | "goal_change",
  "goalChangeReason": "only if deltaType is goal_change: why the goal should change"
}
`.trim();
}

export function parseResponse(raw: string): ReplanOutput {
  const parsed = safeParseJSON(raw);
  return {
    add: Array.isArray(parsed?.add)
      ? (parsed.add as Array<{ text: string; purpose?: string; priority: number }>)
      : [],
    obsolete: Array.isArray(parsed?.obsolete) ? (parsed.obsolete as string[]) : [],
    deltaType: (parsed?.deltaType as PlanDeltaType) || 'minor',
    goalChangeReason: parsed?.goalChangeReason as string | undefined,
  };
}

function safeParseJSON(response: string): Record<string, unknown> | null {
  let cleaned = response.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '');
  cleaned = cleaned.replace(/\s*```\s*$/im, '');
  cleaned = cleaned.replace(/\/\/.*$/gm, '');
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}