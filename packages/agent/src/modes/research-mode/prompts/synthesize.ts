import type { ResearchPlan, ResearchQuestion, ResearchFinding, QualityReport, HypothesisStatus, EvidenceConflict } from '../types.js';

export const SYNTHESIZE_VERSION = '2.0.0';

export interface SynthesizeContext {
  query: string;
  plan: ResearchPlan | null;
  questions: ResearchQuestion[];
  findings: ResearchFinding[];
  qualityReport: QualityReport;
  hypothesisStatuses?: Array<{
    statement: string;
    verdict: string;
    supportingFindings: string[];
    contradictingFindings: string[];
    confidenceLevel: string;
  }>;
  unresolvedConflicts?: Array<{
    topic: string;
    positionA: string;
    positionB: string;
    findingIds: string[];
  }>;
  confirmedGaps?: string[];
}

export interface SynthesizePromptResult {
  prompt: string;
  structuredSections: string;
  citationList: string;
}

export function parseResponse(raw: string): SynthesizePromptResult {
  return { prompt: raw, structuredSections: '', citationList: '' };
}

export function buildPrompt(ctx: SynthesizeContext): SynthesizePromptResult {
  const { query, plan, questions, findings, qualityReport, hypothesisStatuses, unresolvedConflicts, confirmedGaps } = ctx;

  const questionGroups = new Map<string, ResearchFinding[]>();
  for (const f of findings) {
    for (const qid of f.relatedQuestionIds) {
      if (!questionGroups.has(qid)) questionGroups.set(qid, []);
      questionGroups.get(qid)!.push(f);
    }
  }

  const sections: string[] = [];

  for (const q of questions) {
    const related = questionGroups.get(q.id) || [];
    const supports = related.filter((f) => f.stance === 'supports');
    const contradicts = related.filter((f) => f.stance === 'contradicts');
    const neutrals = related.filter((f) => f.stance === 'neutral');

    let section = `## ${q.text} (purpose: ${q.purpose}, status: ${q.status})\n\n`;

    if (supports.length > 0) {
      section += `### Supporting Evidence\n\n`;
      for (const f of supports) {
        section += `- ${f.citationId || ''} [${f.sourceReliability}, authority: ${f.authorityLevel}] ${f.claim}`;
        if (f.evidence && f.evidence !== f.claim) {
          section += `\n  Evidence: ${f.evidence}`;
        }
        if (f.title) section += `\n  Source: ${f.title}`;
        if (f.limitations.length > 0) {
          section += `\n  Limitations: ${f.limitations.join('; ')}`;
        }
        section += '\n';
      }
    }

    if (contradicts.length > 0) {
      section += `\n### Contradicting Evidence\n\n`;
      for (const f of contradicts) {
        section += `- ${f.citationId || ''} [${f.sourceReliability}] ${f.claim}`;
        if (f.title) section += `\n  Source: ${f.title}`;
        section += '\n';
      }
    }

    if (neutrals.length > 0 && supports.length === 0 && contradicts.length === 0) {
      section += `\n### Findings\n\n`;
      for (const f of neutrals) {
        section += `- ${f.citationId || ''} [${f.sourceReliability}] ${f.claim}`;
        if (f.title) section += `\n  Source: ${f.title}`;
        section += '\n';
      }
    }

    sections.push(section);
  }

  const citations = findings.map(
    (f) => `${f.citationId || ''} ${f.title || 'Untitled'} — ${f.url || f.source} (${f.accessedAt.slice(0, 10)}) [${f.sourceReliability}, ${f.authorityLevel}]`
  );

  const structure = plan?.synthesisPlan.recommendedStructure?.join('\n') ||
    `1. Executive Summary\n2. Key Findings (organized by topic)\n3. Analysis & Synthesis\n4. Contested Points\n5. Gaps & Limitations\n6. Practical Implications\n7. References`;

  const caveats = plan?.synthesisPlan.expectedCaveats || [];
  const caveatLines = caveats.length > 0
    ? `\nKnown caveats from planning:\n${caveats.map((c) => `- ${c}`).join('\n')}`
    : '';

  const hypothesisBlock = hypothesisStatuses && hypothesisStatuses.length > 0
    ? `\n\nHypothesis Verification:\n${hypothesisStatuses.map((h) =>
        `- [${h.verdict}] "${h.statement}" (confidence: ${h.confidenceLevel})${h.supportingFindings.length > 0 ? ' | supported by: ' + h.supportingFindings.join(', ') : ''}${h.contradictingFindings.length > 0 ? ' | contradicted by: ' + h.contradictingFindings.join(', ') : ''}`
      ).join('\n')}\n`
    : '';

  const conflictBlock = unresolvedConflicts && unresolvedConflicts.length > 0
    ? `\n\nUnresolved Conflicts (must be noted in report):\n${unresolvedConflicts.map((c) =>
        `- "${c.topic}": Position A - "${c.positionA}" vs Position B - "${c.positionB}" (findings: ${c.findingIds.join(', ')})`
      ).join('\n')}\n`
    : '';

  const gapsBlock = confirmedGaps && confirmedGaps.length > 0
    ? `\n\nConfirmed Research Gaps (must be in Limitations section):\n${confirmedGaps.map((g) => `- ${g}`).join('\n')}\n`
    : '';

  const prompt = `Research Query: ${query}

You are the synthesis module of a deep research agent.

Write the final answer using ONLY the approved research plan and collected findings below.
DO NOT introduce unsupported facts.
For each major claim, use the strongest available evidence.
Separate clearly:
- Established facts (well-supported, authoritative)
- Likely interpretations (moderate support)
- Contested points (conflicting sources)
- Open questions (no or weak evidence)
- Practical implications

Rules:
- If evidence is weak, say so explicitly
- If sources conflict, present the conflict and explain which source is more reliable and why
- Do NOT overstate certainty
- Follow the recommended structure unless a better structure is clearly justified
- Cite sources using the citationId in brackets (e.g. [1], [2])
- Note source reliability level and authority when relevant
- Include a dedicated section for limitations and unresolved questions

Quality Assessment:
- Overall score: ${(qualityReport.score * 100).toFixed(0)}%
- Blockers: ${qualityReport.blockers.length > 0 ? qualityReport.blockers.join('; ') : 'none'}${caveatLines}${hypothesisBlock}${conflictBlock}${gapsBlock}

Recommended structure:
${structure}

Findings:

${sections.join('\n')}

References:
${citations.map((c) => `- ${c}`).join('\n')}
`.trim();

  return {
    prompt,
    structuredSections: sections.join('\n'),
    citationList: citations.map((c) => `- ${c}`).join('\n'),
  };
}

export const synthesize = { buildPrompt, parseResponse, version: SYNTHESIZE_VERSION };