/**
 * Wiki Agent Prompt System
 * Independent prompt system for WikiAgent with specialized prompts for:
 * - Cheap classifier
 * - Candidate extraction
 * - Merge judge / node rewrite
 */

import type {
  PromptContext,
  PromptSection,
  SystemPrompt,
  PromptBuildContextOptions,
} from '../../prompts/types.js';
import { asSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../prompts/types.js';
import { PromptSystem } from '../../prompts/PromptSystem.js';
import { createPromptCache } from '../../prompts/cache.js';
import type { PromptProfile } from '../../prompts/modes/types.js';
import { DEFAULT_PROMPT_PROFILE } from '../../prompts/modes/index.js';
import { cachedPromptSection, volatilePromptSection } from '../../prompts/constants/promptSections.js';

/**
 * Wiki-specific prompt context
 */
export interface WikiPromptContext extends PromptContext {
  wikiBasePath: string;
  existingNodes: Array<{
    id: string;
    title: string;
    type: string;
    aliases: string[];
  }>;
  sessionId: string;
}

/**
 * Wiki Agent Prompt System
 * Specialized prompt system for wiki memory extraction and management
 */
export class WikiAgentPromptSystem extends PromptSystem {
  constructor(profile?: PromptProfile) {
    super(profile ?? DEFAULT_PROMPT_PROFILE);
  }

  override getName(): string {
    return 'wiki-agent';
  }

  override clearCache(): void {
    this.cache.clear();
  }

  override getCache() {
    return this.cache;
  }

  override getProfile(): PromptProfile {
    return { ...this.profile };
  }

  override setProfile(profile: PromptProfile): void {
    this.profile = profile;
    this.clearCache();
  }

  /**
   * Build wiki-specific prompt context
   */
  override buildContext(options: PromptBuildContextOptions & { wikiBasePath?: string; sessionId?: string }): WikiPromptContext {
    return {
      workingDirectory: options.workingDirectory || process.cwd(),
      wikiBasePath: options.wikiBasePath || options.workingDirectory || process.cwd(),
      sessionId: options.sessionId || `session-${Date.now()}`,
      existingNodes: [],
      platform: process.platform,
      shell: process.env.SHELL || 'bash',
      modelId: options.modelId || 'unknown',
      enabledTools: new Set(),
      sessionStartTime: Date.now(),
    };
  }

  /**
   * Get static sections (cached)
   */
  override getStaticSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    return [
      cachedPromptSection('wiki-intro', () => this.getWikiIntroSection()),
      cachedPromptSection('wiki-task', () => this.getWikiTaskSection()),
      cachedPromptSection('wiki-output-format', () => this.getOutputFormatSection()),
    ];
  }

  /**
   * Get dynamic sections (recomputed every turn)
   */
  override getDynamicSections(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): PromptSection[] {
    const wikiContext = context as WikiPromptContext;

    return [
      volatilePromptSection('wiki-context', () => this.getWikiContextSection(wikiContext), 'Context changes per extraction'),
      volatilePromptSection('wiki-existing-nodes', () => this.getExistingNodesSection(wikiContext), 'Node list changes over time'),
    ];
  }

  /**
   * Build the complete system prompt
   */
  override async buildSystemPrompt(
    context: PromptContext,
    _enabledTools?: Set<string>,
    _mcpServers?: PromptContext['mcpServers'],
  ): Promise<SystemPrompt> {
    const staticSections = this.getStaticSections(context);
    const dynamicSections = this.getDynamicSections(context);

    const { staticContent, dynamicContent } = await this.resolveSections(
      staticSections,
      dynamicSections,
    );

    return asSystemPrompt([
      ...staticContent,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      ...dynamicContent,
    ]);
  }

  /**
   * Get the cheap classifier prompt
   * Used for quick classification of whether content contains extractable knowledge
   */
  getCheapClassifierPrompt(context: WikiPromptContext): string {
    return `You are a fast content classifier for a knowledge extraction system.

Your task: Determine if the provided content contains structured, reusable knowledge worth extracting to a wiki.

Classification rules:
- YES: Content describes concepts, architecture, decisions, APIs, workflows, or patterns
- NO: Content is casual conversation, greetings, or transient operational messages

Respond with ONLY one word: YES or NO`;
  }

  /**
   * Get the candidate extraction prompt
   * Used for extracting structured memory candidates from conversation
   */
  getCandidateExtractionPrompt(context: WikiPromptContext): string {
    const existingNodesList = context.existingNodes
      .map(n => `- "${n.title}" (aliases: ${n.aliases.join(', ') || 'none'})`)
      .join('\n') || 'No existing nodes yet.';

    return `You are a knowledge extraction specialist. Extract structured memory candidates from the conversation.

EXTRACTION RULES:
1. Identify distinct concepts, modules, classes, workflows, or devops knowledge
2. Each candidate MUST include the original context that justifies its extraction
3. Prefer merging with existing nodes over creating duplicates
4. Low-quality or uncertain candidates should be flagged for inbox

EXISTING NODES (check for duplicates):
${existingNodesList}

OUTPUT FORMAT - Respond with JSON:
{
  "candidates": [
    {
      "id": "unique-id",
      "title": "Node Title",
      "type": "concept|module|class|function|workflow|devops",
      "content": "Structured content in markdown",
      "aliases": ["alternative names"],
      "tags": ["relevant", "tags"],
      "originalContext": "The exact conversation context that justifies this extraction",
      "confidence": 0.0-1.0,
      "suggestedAction": "create|merge|inbox",
      "mergeTargetId": "existing-node-id (if suggestedAction is merge)"
    }
  ]
}

QUALITY THRESHOLDS:
- confidence >= 0.8: Suggested for create/merge
- confidence 0.5-0.8: Suggested for inbox
- confidence < 0.5: Skip entirely

For "preferences/" topics, raise the threshold - only high-confidence extractions.`;
  }

  /**
   * Get the merge judge prompt
   * Used for determining if a candidate should merge with an existing node
   */
  getMergeJudgePrompt(context: WikiPromptContext, candidateTitle: string, candidateContent: string, potentialMatches: Array<{ id: string; title: string; content: string }>): string {
    const matchesList = potentialMatches
      .map(m => `\n--- CANDIDATE MATCH: ${m.title} (id: ${m.id}) ---\n${m.content.slice(0, 500)}...`)
      .join('\n');

    return `You are a merge judge for a knowledge management system. Determine if the new candidate should merge with an existing node.

NEW CANDIDATE:
Title: "${candidateTitle}"
Content: ${candidateContent.slice(0, 1000)}

POTENTIAL MATCHES:${matchesList}

MERGE CRITERIA (in order of priority):
1. EXACT MATCH: Same title, slug, or alias → MERGE with confidence 1.0
2. SEMANTIC MATCH: Describes the same concept with high overlap → MERGE with confidence 0.8-0.95
3. RELATED BUT DISTINCT: Related concepts but different scope → SKIP (confidence 0.3-0.6)
4. UNCERTAIN: Cannot determine relationship → UNCERTAIN (confidence 0.0-0.3)

CONSERVATIVE PRINCIPLE:
- When uncertain, prefer NOT merging
- Merging is irreversible; missing a merge is fixable later
- "preferences/" nodes require extra caution

OUTPUT FORMAT - Respond with JSON:
{
  "action": "merge|skip|uncertain",
  "targetNodeId": "id of the node to merge with (if action is merge)",
  "targetNodeTitle": "title of target node (if action is merge)",
  "confidence": 0.0-1.0,
  "reason": "Explanation of the decision"
}`;
  }

  /**
   * Get the node rewrite prompt
   * Used for merging new content into existing nodes
   */
  getNodeRewritePrompt(existingNode: { title: string; content: string; type: string }, newContent: string, originalContext: string): string {
    return `You are a knowledge curator. Merge new information into an existing wiki node while preserving structure.

EXISTING NODE:
Title: ${existingNode.title}
Type: ${existingNode.type}
Current Content:
${existingNode.content}

NEW INFORMATION TO MERGE:
${newContent}

ORIGINAL CONTEXT (why this information matters):
${originalContext}

REWRITE RULES:
1. Preserve the existing structure and organization when possible
2. Integrate new information naturally, avoiding duplication
3. Update timestamps and source references
4. Maintain markdown formatting consistency
5. Ensure the "Original Context" section captures why this knowledge matters

OUTPUT: Provide the complete rewritten node content in markdown format.`;
  }

  // Private section helpers

  private getWikiIntroSection(): string {
    return `You are the WikiAgent, a specialized knowledge extraction and management agent.

Your purpose is to:
1. Extract structured knowledge from conversations
2. Maintain a canonical wiki of concepts, modules, classes, and workflows
3. Prevent duplicate information through conservative merging
4. Track the provenance of all knowledge`;
  }

  private getWikiTaskSection(): string {
    return `TASK GUIDANCE:
- Extract only high-quality, reusable knowledge
- Always preserve original context for traceability
- Prefer merging with existing nodes over creating duplicates
- Use conservative judgment when uncertain
- Write to inbox/ for low-confidence or ambiguous extractions`;
  }

  private getOutputFormatSection(): string {
    return `OUTPUT FORMAT:
Always respond with valid JSON for structured operations.
Use markdown for node content.
Include confidence scores for all extraction decisions.`;
  }

  private getWikiContextSection(context: WikiPromptContext): string {
    return `CURRENT CONTEXT:
- Wiki Base Path: ${context.wikiBasePath}
- Session ID: ${context.sessionId}
- Working Directory: ${context.workingDirectory}`;
  }

  private getExistingNodesSection(context: WikiPromptContext): string {
    if (context.existingNodes.length === 0) {
      return 'EXISTING NODES: None yet. This is a fresh wiki.';
    }

    const nodesList = context.existingNodes
      .map(n => `- ${n.title} (${n.type})`)
      .join('\n');

    return `EXISTING NODES:\n${nodesList}`;
  }
}

/**
 * Factory for creating WikiAgentPromptSystem instances
 */
export const WikiAgentPromptSystemFactory = {
  create(profile?: PromptProfile): WikiAgentPromptSystem {
    return new WikiAgentPromptSystem(profile);
  },
};
