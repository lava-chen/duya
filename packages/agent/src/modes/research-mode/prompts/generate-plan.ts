import type { ResearchClassification, ResearchPlan } from '../types.js';

export const GENERATE_PLAN_VERSION = '1.0.0';

export interface GeneratePlanInput {
  query: string;
  classification: ResearchClassification;
  userAnswers?: Record<string, string>;
}

export interface LLMPlanOutput {
  intent: {
    taskType: string;
    userGoal: string;
    expectedOutput: string;
    audienceLevel: string;
  };
  scope: {
    included: string[];
    excluded: string[];
    timeRange?: string;
    geography?: string | null;
    domains: string[];
    assumptions: string[];
    clarificationNeeded: boolean;
    blockingQuestions: Array<{ id: string; question: string; type: string; options: string[] }>;
    nonBlockingSuggestions: Array<{ id: string; question: string; type: string; options: string[] }>;
  };
  researchQuestions: Array<{
    text: string;
    purpose: string;
    uncertaintyResolved?: string;
    requiredEvidenceRationale?: string;
    priority: number;
    dependsOn: string[];
    searchQueries: string[];
    requiredEvidence: {
      sourceTypes: string[];
      minSources: number;
      needsPrimarySource: boolean;
      needsRecentSource: boolean;
      needsCounterEvidence: boolean;
    };
  }>;
  evidenceStrategy: {
    sourceTypes: string[];
    authorityRules: string[];
    freshnessRequirement: string;
    minIndependentSources: number;
    mustFindPrimarySources: boolean;
    mustFindCounterEvidence: boolean;
  };
  searchStrategy: {
    seedQueries: string[];
    queryExpansionRules: string[];
    priorityOrder: string[];
  };
  qualityGates: {
    coverageThreshold: number;
    requiredFindings: string[];
    stopConditions: string[];
    failureConditions: string[];
  };
  synthesisPlan: {
    recommendedStructure: string[];
    comparisonDimensions: string[];
    expectedCaveats: string[];
  };
}

export function buildPrompt(input: GeneratePlanInput): string {
  const { query, classification, userAnswers } = input;

  return `
You are the planning module of a deep research agent.

Your job is NOT to answer the user directly. Your job is to transform the user's query into an executable research plan that another research agent can follow.

Original user query:
"${query}"

${userAnswers && Object.keys(userAnswers).length > 0 ? 'Clarification answers: ' + JSON.stringify(userAnswers) : ''}

Classified complexity: ${classification.complexity}
Max iterations: ${classification.maxIterations}
Freshness requirement: ${classification.freshness}
Source depth: ${classification.sourceDepth}

You must produce a structured research plan with:
1. The user's likely research intent (taskType, userGoal, expectedOutput, audienceLevel)
2. The expected final output type
3. Scope boundaries: what to include, what to exclude, assumptions, and whether clarification is necessary
4. A set of research questions (3-8). Each question must have a purpose, priority, dependencies, search queries, and evidence requirements
5. A source strategy: what types of sources should be trusted most, what sources are weak, and whether primary sources are required
6. A counter-evidence strategy: what claims need verification, what alternative explanations or objections should be checked
7. Quality gates: what must be true before synthesis can begin
8. A synthesis outline for the final answer

Important rules:
- Do NOT create generic sub-questions like "What is X?" unless a definition is genuinely needed
- Prefer task-specific questions that directly reduce uncertainty
- Avoid generic survey questions that could apply to any AI topic
- Every research question must contain topic-specific concepts, candidate entities, or evaluation dimensions
- For every question, state the uncertainty it resolves and what evidence is required to resolve it
- Separate factual lookup questions from analytical interpretation questions
- Include at least one question that searches for limitations, failures, controversies, or counterexamples when the task is analytical, comparative, or conceptual
- If the query requires recent or fast-changing information, set freshnessRequirement as "latest"
- If the query concerns academic research, prioritize peer-reviewed papers, preprints, official datasets, benchmark repositories, and authoritative survey papers
- If the query concerns implementation, include documentation, source code, issue discussions, and changelogs as source types
- If clarification is necessary (hard blocker), set clarificationNeeded=true and add blockingQuestions
- If clarification would be helpful but NOT necessary, add them to nonBlockingSuggestions instead
- Proceed with explicit assumptions when clarification is not essential

Question purposes:
- definition: Define key terms or concepts
- mechanism: Explain how something works
- evidence: Gather factual evidence or data
- comparison: Compare alternatives or approaches
- critique: Find limitations, failures, or counterarguments
- trend: Identify patterns or trajectory over time
- implementation: Technical details, code, architecture
- decision: Information needed to make a decision

Return ONLY valid JSON matching this schema:
{
  "intent": {
    "taskType": "analytical",
    "userGoal": "Summarize the current state and challenges...",
    "expectedOutput": "structured_report",
    "audienceLevel": "expert"
  },
  "scope": {
    "included": ["key topics to cover"],
    "excluded": ["topics to explicitly avoid"],
    "timeRange": "2020-2025",
    "geography": null,
    "domains": ["domain1", "domain2"],
    "assumptions": ["assumptions made"],
    "clarificationNeeded": false,
    "blockingQuestions": [],
    "nonBlockingSuggestions": []
  },
  "researchQuestions": [
    {
      "text": "question text",
      "purpose": "evidence",
      "uncertaintyResolved": "what unknown this question resolves",
      "requiredEvidenceRationale": "why this evidence is required",
      "priority": 1,
      "dependsOn": [],
      "searchQueries": ["specific search query 1", "specific search query 2"],
      "requiredEvidence": {
        "sourceTypes": ["paper", "official"],
        "minSources": 3,
        "needsPrimarySource": true,
        "needsRecentSource": true,
        "needsCounterEvidence": false
      }
    }
  ],
  "evidenceStrategy": {
    "sourceTypes": ["paper", "review", "official", "code"],
    "authorityRules": ["Prefer peer-reviewed journals", "Official docs > blog posts"],
    "freshnessRequirement": "recent",
    "minIndependentSources": 3,
    "mustFindPrimarySources": true,
    "mustFindCounterEvidence": true
  },
  "searchStrategy": {
    "seedQueries": ["seed query 1", "seed query 2"],
    "queryExpansionRules": ["When finding papers, search related papers by same authors"],
    "priorityOrder": ["official docs first", "then papers", "then news"]
  },
  "qualityGates": {
    "coverageThreshold": ${classification.coverageThreshold},
    "requiredFindings": ["finding description 1"],
    "stopConditions": ["All questions have authoritative sources"],
    "failureConditions": ["No peer-reviewed sources found after 3 iterations"]
  },
  "synthesisPlan": {
    "recommendedStructure": ["Executive Summary", "Background", "Key Findings", "Analysis", "Limitations", "References"],
    "comparisonDimensions": ["dim1", "dim2"],
    "expectedCaveats": ["Some data may be preliminary", "Results may be sensitive to methodology"]
  }
}
`.trim();
}

export function parseResponse(raw: string): LLMPlanOutput | null {
  const parsed = safeParseJSON(raw);
  if (parsed && typeof parsed === 'object') {
    return parsed as LLMPlanOutput;
  }
  return null;
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