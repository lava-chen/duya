import type { ResearchClassification, ResearchPlan } from '../types.js';

export const GENERATE_PLAN_VERSION = '2.1.0';

// ============================================================================
// Task Types
// ============================================================================

export type TaskType =
  | 'survey'           // Literature/field overview
  | 'comparative'      // Compare alternatives
  | 'replication'      // Reproduce/verify findings
  | 'gap-analysis'     // Identify unknown unknowns
  | 'implementation'   // Technical/how-to
  | 'factual'          // Direct lookup
  | 'analytical';      // Root cause / mechanistic analysis

export type AudienceLevel = 'beginner' | 'intermediate' | 'expert' | 'researcher';

export type QuestionLayer =
  | 'foundational'    // Must answer first (prerequisite knowledge)
  | 'analytical'      // Core investigation questions
  | 'critical'        // Seek failures, limitations, contradictions
  | 'synthetic';      // So-what: what does all evidence imply?

export type HypothesisType = 'central' | 'subsidiary' | 'null';

export type StructureTemplate =
  | 'survey'              // Literature overview
  | 'comparison-matrix'   // Side-by-side comparison
  | 'argument-rebuttal'   // Thesis-antithesis-synthesis
  | 'timeline'            // Historical/evolutionary
  | 'problem-solution'    // Challenge-resolution pairs
  | 'custom';

export type PreprintPolicy = 'prefer-published' | 'allow-recent' | 'include-all';

export type SourceTierLevel = 'tier1' | 'tier2' | 'tier3' | 'avoid';

// ============================================================================
// Schema: Hypothesis
// ============================================================================

export interface Hypothesis {
  statement: string;             // Falsifiable proposition
  type: HypothesisType;
  verificationApproach: string; // How to verify this hypothesis
  expectedEvidence: string;     // What evidence would support it
  falsificationCriteria: string; // What evidence would overturn it
}

// ============================================================================
// Schema: Research Question (Enhanced)
// ============================================================================

export interface ResearchQuestion {
  // Core
  text: string;
  purpose: string;
  uncertaintyResolved?: string;
  requiredEvidenceRationale?: string;
  priority: number;
  dependsOn: string[];

  // NEW: Question layering (required for academic rigor)
  questionLayer: QuestionLayer;
  // Which hypothesis this question tests (optional)
  hypothesisLink?: string;

  // Legacy search queries (general)
  searchQueries: string[];

  // NEW: Academic-specific search queries
  academicSearchQueries?: {
    semantic_scholar?: string[];
    arxiv?: string[];
    general?: string[];
  };

  requiredEvidence: {
    sourceTypes: string[];
    minSources: number;
    needsPrimarySource: boolean;
    needsRecentSource: boolean;
    needsCounterEvidence: boolean;
  };
}

// ============================================================================
// Schema: Evidence Strategy (Enhanced)
// ============================================================================

export interface AcademicTiers {
  tier1: string[];   // e.g. ["Nature", "Science", "NeurIPS", "ICML", "ACL"]
  tier2: string[];   // e.g. ["peer-reviewed conference", "AAAI", "EMNLP", "ICLR"]
  tier3: string[];   // e.g. ["arXiv preprint", "workshop paper", "technical report"]
  avoid: string[];   // e.g. ["blog post without citations", "Wikipedia", "news article"]
}

export interface EvidenceStrategy {
  sourceTypes: string[];
  authorityRules: string[];
  freshnessRequirement: string;
  minIndependentSources: number;
  mustFindPrimarySources: boolean;
  mustFindCounterEvidence: boolean;

  // NEW: Academic evidence tiers
  academicTiers?: AcademicTiers;
  citationThreshold?: number;     // Minimum citations for "classic" papers
  preprintPolicy?: PreprintPolicy;
  conflictResolutionStrategy?: string; // How to resolve conflicting evidence
}

// ============================================================================
// Schema: Gap Analysis
// ============================================================================

export interface GapAnalysis {
  openQuestions: string[];           // Known unknowns in the field
  methodologicalLimitations: string[]; // Why certain questions can't be answered
  dataLimitations: string[];         // Data availability issues
  futureDirections: string[];        // Promising research directions
}

// ============================================================================
// Schema: Scope (Enhanced)
// ============================================================================

export interface Scope {
  included: string[];
  excluded: string[];
  timeRange?: string;
  geography?: string | null;
  domains: string[];
  assumptions: string[];
  clarificationNeeded: boolean;
  blockingQuestions: Array<{ id: string; question: string; type: string; options: string[] }>;
  nonBlockingSuggestions: Array<{ id: string; question: string; type: string; options: string[] }>;

  // NEW: Explicit research boundaries
  knownGaps?: string[];     // Known research gaps in this area
  outOfScope?: string[];    // Topics explicitly excluded with reasons
}

// ============================================================================
// Schema: Synthesis Plan (Enhanced)
// ============================================================================

export interface SynthesisPlan {
  // Legacy
  recommendedStructure: string[];

  // NEW: Dynamic structure based on taskType
  structureTemplate: StructureTemplate;
  comparisonDimensions?: string[];
  expectedCaveats: string[];

  // NEW: Argumentation
  argumentationStrategy?: string;        // How to build the argument
  conflictingEvidenceHandling?: string;  // When sources disagree
}

// ============================================================================
// Input Interface
// ============================================================================

export interface GeneratePlanInput {
  query: string;
  classification: ResearchClassification;
  userAnswers?: Record<string, string>;
}

// ============================================================================
// Main Output Interface
// ============================================================================

export interface LLMPlanOutput {
  intent: {
    taskType: TaskType;
    userGoal: string;
    expectedOutput: string;
    audienceLevel: AudienceLevel;
    // NEW: Academic rigor flag
    academicRigor: boolean;
  };

  // NEW: Hypothesis layer (core of hypothesis-driven research)
  hypotheses?: Hypothesis[];

  scope: Scope;

  researchQuestions: ResearchQuestion[];

  evidenceStrategy: EvidenceStrategy;

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

  // NEW: Gap Analysis block
  gapAnalysis?: GapAnalysis;

  synthesisPlan: SynthesisPlan;
}

export function buildPrompt(input: GeneratePlanInput): string {
  const { query, classification, userAnswers } = input;

  return `You are the planning module of a deep research agent. Your job is to decompose a user query into a concrete, actionable research plan.

USER QUERY: "${query}"

${userAnswers && Object.keys(userAnswers).length > 0 ? 'CLARIFICATION ANSWERS: ' + JSON.stringify(userAnswers) : ''}

CONTEXT:
- Complexity: ${classification.complexity}
- Max iterations: ${classification.maxIterations}
- Freshness: ${classification.freshness}
- Source depth: ${classification.sourceDepth}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULES — Violate these and the plan is useless
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. EVERY research question MUST contain topic-specific entities.
   BAD:  "What are the key approaches?" → generic, applies to anything
   GOOD: "How do Mamba state-space models compare to transformers on long-sequence benchmarks?
          Focus on perplexity, throughput, and memory."
   GOOD: "What concrete performance regressions did Python 3.12 introduce for async workloads,
          and which CPython commits caused them?"

2. Questions must resolve SPECIFIC uncertainty. State exactly what unknown you're addressing.
   BAD:  "Understand the latest developments" → vague
   GOOD: "What is the relationship between semantic compression and hallucination rates in RAG systems,
          and at what compression threshold does quality degrade?"

3. For comparison queries: name the CANDIDATES and the EVALUATION DIMENSIONS.
   BAD:  "Compare alternatives" → alternatives to what? on what axes?
   GOOD: "Compare Bun vs Deno vs Node.js 22 on: cold start time, Docker image size,
          npm ecosystem compatibility, and Web API coverage."

4. For "latest/current state" queries: define the TIME WINDOW explicitly.
   BAD:  "What is the latest in X?" → latest of when?
   GOOD: "What breakthroughs in AI code generation happened in 2025? Focus on
          new architectures, benchmark scores, and production deployments."

5. Include at least ONE counter-evidence or critique question per plan.
   This forces the research to find limitations, not just supporting evidence.

6. The plan must be EXECUTABLE by a web research agent.
   Every question should be answerable by visiting specific websites, docs, papers, or repos.
   If a question requires internal knowledge only, break it down until it has observable answers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Return ONLY valid JSON. Do not include markdown fences, explanations, or extra text.

{
  "intent": {
    "taskType": "analytical|comparative|survey|factual|implementation|gap-analysis",
    "userGoal": "One sentence: what should the final report achieve?",
    "expectedOutput": "structured_report|comparison_table|timeline|problem_solution|literature_review",
    "audienceLevel": "beginner|intermediate|expert|researcher",
    "academicRigor": false
  },
  "scope": {
    "included": ["specific topics to cover — use concrete names"],
    "excluded": ["specific topics to avoid — explain why"],
    "timeRange": "e.g. 2023-2025 or null",
    "domains": ["specific domains, e.g. NLP, compilers, distributed systems"],
    "assumptions": ["working assumptions — be explicit"],
    "clarificationNeeded": false,
    "blockingQuestions": [],
    "nonBlockingSuggestions": []
  },
  "researchQuestions": [
    {
      "text": "Topic-specific research question with named entities/dimensions",
      "purpose": "evidence|comparison|critique|mechanism|trend|definition|implementation",
      "questionLayer": "foundational|analytical|critical|synthetic",
      "uncertaintyResolved": "What specific unknown does this question resolve?",
      "priority": 1,
      "dependsOn": [],
      "searchQueries": ["3-5 specific search queries with concrete terms, NOT generic keywords"],
      "requiredEvidence": {
        "sourceTypes": ["paper", "official_doc", "repo", "benchmark", "news"],
        "minSources": 3,
        "needsPrimarySource": true,
        "needsRecentSource": true,
        "needsCounterEvidence": false
      }
    }
  ],
  "evidenceStrategy": {
    "sourceTypes": ["paper", "official_doc", "repo", "benchmark"],
    "authorityRules": ["e.g. Prefer official docs over blog posts", "Prefer benchmark results over claims"],
    "freshnessRequirement": "latest|recent|any",
    "minIndependentSources": 3,
    "mustFindPrimarySources": true,
    "mustFindCounterEvidence": true
  },
  "searchStrategy": {
    "seedQueries": ["5-10 specific search queries — use exact terms, names, versions"],
    "queryExpansionRules": ["e.g. When finding a paper, search for papers that cited or contradicted it"],
    "priorityOrder": ["e.g. official docs first, then papers, then community discussion"]
  },
  "qualityGates": {
    "coverageThreshold": ${classification.coverageThreshold},
    "requiredFindings": ["2-4 concrete things that MUST be found before synthesis"],
    "stopConditions": ["When to stop searching"],
    "failureConditions": ["When the research has failed"]
  },
  "synthesisPlan": {
    "structureTemplate": "survey|comparison-matrix|argument-rebuttal|timeline|problem-solution",
    "recommendedStructure": ["Section 1", "Section 2", "..."],
    "comparisonDimensions": ["dimension1", "dimension2"],
    "expectedCaveats": ["known limitations of this research approach"]
  }
}

QUESTIONS PER LAYER (minimums):
- foundational: 1 question (prerequisite knowledge, define key concepts with concrete examples)
- analytical: 2-4 questions (core investigation — the meat of the research)
- critical: 1 question (seek limitations, failures, counterarguments)
- synthetic: 1 question (integrate all evidence into a conclusion)

STOP. Before outputting, verify:
□ Every question mentions at least one specific technology, methodology, paper, person, company, benchmark, or measurable dimension
□ None of the questions could apply to a different query with just a search-replace
□ The seed queries contain exact technical terms, version numbers, or proper names
□ At least one question actively seeks counter-evidence or limitations`.trim();
}

export function parseResponse(raw: string): LLMPlanOutput | null {
  const parsed = safeParseJSON(raw);
  if (parsed && typeof parsed === 'object') {
    return parsed as unknown as LLMPlanOutput;
  }
  return null;
}

function safeParseJSON(response: string): Record<string, unknown> | null {
  const trimmed = response.trim();

  // 1. Try direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    // ignore
  }

  // 2. Strip markdown code block markers and try again
  let cleaned = trimmed;
  cleaned = cleaned.replace(/^```(?:json)?\s*/im, '');
  cleaned = cleaned.replace(/\s*```\s*$/im, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    // ignore
  }

  // 3. Fix trailing commas (common LLM mistake) — only outside strings
  const withoutTrailingCommas = cleaned.replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(withoutTrailingCommas);
  } catch {
    // ignore
  }

  // 4. Extract the largest balanced JSON object using brace counting
  const extracted = extractBalancedJSON(withoutTrailingCommas);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // ignore
    }
  }

  return null;
}

function extractBalancedJSON(text: string): string | null {
  let firstBrace = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) {
        firstBrace = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && firstBrace !== -1) {
        return text.slice(firstBrace, i + 1);
      }
    }
  }

  return null;
}

export const generatePlan = { buildPrompt, parseResponse, version: GENERATE_PLAN_VERSION };