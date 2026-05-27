/**
 * Wiki Candidate Extractor
 * Extracts structured memory candidates from conversation content
 */

import type { MemoryCandidate, WikiNodeType } from './types.js';
import type { WikiPromptContext } from './prompts/WikiAgentPromptSystem.js';

/**
 * Extraction result with candidates and metadata
 */
export interface ExtractionResult {
  candidates: MemoryCandidate[];
  lowQualityCount: number;
  skippedCount: number;
}

/**
 * Extraction options
 */
export interface ExtractionOptions {
  /** Minimum confidence for create/merge actions */
  highConfidenceThreshold: number;
  /** Minimum confidence for inbox action */
  inboxThreshold: number;
  /** Higher threshold for preferences topics */
  preferencesThreshold: number;
  /** Current session ID for tracking */
  sessionId: string;
}

/**
 * Default extraction options
 */
const DEFAULT_OPTIONS: ExtractionOptions = {
  highConfidenceThreshold: 0.8,
  inboxThreshold: 0.5,
  preferencesThreshold: 0.9,
  sessionId: 'unknown',
};

/**
 * Wiki Candidate Extractor
 * Handles extraction of memory candidates from conversation
 */
export class WikiCandidateExtractor {
  private options: ExtractionOptions;

  constructor(options: Partial<ExtractionOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Extract candidates from raw content
   * This is the main entry point for extraction
   */
  extractCandidates(
    content: string,
    context: WikiPromptContext,
    rawLLMResponse?: unknown,
  ): ExtractionResult {
    const candidates = this.parseLLMResponse(rawLLMResponse);
    const processedCandidates = this.processCandidates(candidates, content);

    let lowQualityCount = 0;
    let skippedCount = 0;

    for (const candidate of processedCandidates) {
      // Apply quality thresholds
      const threshold = this.isPreferencesTopic(candidate)
        ? this.options.preferencesThreshold
        : this.options.highConfidenceThreshold;

      if (candidate.confidence < this.options.inboxThreshold) {
        // Skip entirely - too low quality
        skippedCount++;
        continue;
      }

      if (candidate.confidence < threshold) {
        // Downgrade to inbox
        candidate.suggestedAction = 'inbox';
        lowQualityCount++;
      }

      // Ensure original context is present
      if (!candidate.originalContext || candidate.originalContext.trim().length === 0) {
        candidate.originalContext = this.extractOriginalContext(content, candidate);
      }

      // Set session tracking
      candidate.id = this.generateCandidateId(candidate);
    }

    // Filter out skipped candidates
    const validCandidates = processedCandidates.filter(
      c => c.confidence >= this.options.inboxThreshold,
    );

    return {
      candidates: validCandidates,
      lowQualityCount,
      skippedCount,
    };
  }

  /**
   * Parse LLM response into memory candidates
   */
  private parseLLMResponse(rawResponse: unknown): Array<Partial<MemoryCandidate>> {
    if (!rawResponse) {
      return [];
    }

    // Handle string response (try to parse JSON)
    if (typeof rawResponse === 'string') {
      const jsonText = this.extractJsonPayload(rawResponse);
      try {
        const parsed = JSON.parse(jsonText);
        return this.parseLLMResponse(parsed);
      } catch {
        return [];
      }
    }

    // Handle object with candidates array
    if (typeof rawResponse === 'object' && rawResponse !== null) {
      const obj = rawResponse as Record<string, unknown>;
      if (Array.isArray(obj.candidates)) {
        return obj.candidates as Array<Partial<MemoryCandidate>>;
      }
    }

    return [];
  }

  private extractJsonPayload(rawResponse: string): string {
    const trimmed = rawResponse.trim();
    const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fencedMatch?.[1]) {
      return fencedMatch[1].trim();
    }

    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return trimmed.slice(firstBrace, lastBrace + 1);
    }

    return trimmed;
  }

  /**
   * Process and validate candidates
   */
  private processCandidates(
    partials: Array<Partial<MemoryCandidate>>,
    sourceContent: string,
  ): MemoryCandidate[] {
    return partials
      .map(p => this.normalizeCandidate(p, sourceContent))
      .filter((c): c is MemoryCandidate => c !== null);
  }

  /**
   * Normalize a partial candidate into a full MemoryCandidate
   */
  private normalizeCandidate(
    partial: Partial<MemoryCandidate>,
    sourceContent: string,
  ): MemoryCandidate | null {
    // Validate required fields
    if (!partial.title || typeof partial.title !== 'string') {
      return null;
    }

    const title = partial.title.trim();
    if (title.length === 0 || title.length > 200) {
      return null;
    }

    // Determine type
    const type = this.validateType(partial.type);

    // Normalize confidence
    let confidence = typeof partial.confidence === 'number'
      ? Math.max(0, Math.min(1, partial.confidence))
      : 0.5;

    // Determine suggested action
    let suggestedAction: 'create' | 'merge' | 'inbox' = 'inbox';
    if (partial.suggestedAction === 'create' || partial.suggestedAction === 'merge') {
      suggestedAction = partial.suggestedAction;
    }

    // Build original context
    let originalContext = partial.originalContext || '';
    if (!originalContext || originalContext.trim().length === 0) {
      originalContext = this.extractOriginalContext(sourceContent, { title, content: partial.content || '' });
    }

    return {
      id: partial.id || this.generateCandidateId({ title, type } as MemoryCandidate),
      title,
      type,
      content: this.normalizeContent(partial.content),
      aliases: this.normalizeStringArray(partial.aliases),
      tags: this.normalizeStringArray(partial.tags),
      originalContext,
      confidence,
      suggestedAction,
      mergeTargetId: partial.mergeTargetId,
    };
  }

  /**
   * Validate and normalize node type
   */
  private validateType(type: unknown): WikiNodeType {
    const validTypes: WikiNodeType[] = [
      'person',
      'project',
      'knowledge',
      'event',
      'file',
      'self',
      'todo',
      'concept',
      'module',
      'class',
      'function',
      'workflow',
      'devops',
      'inbox',
    ];

    if (typeof type === 'string' && validTypes.includes(type as WikiNodeType)) {
      return type as WikiNodeType;
    }

    return 'concept';
  }

  /**
   * Normalize content string
   */
  private normalizeContent(content: unknown): string {
    if (typeof content !== 'string') {
      return '';
    }
    return content.trim();
  }

  /**
   * Normalize string array
   */
  private normalizeStringArray(arr: unknown): string[] {
    if (!Array.isArray(arr)) {
      return [];
    }
    return arr
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(item => item.length > 0);
  }

  /**
   * Extract original context from source content
   */
  private extractOriginalContext(
    sourceContent: string,
    candidate: { title: string; content?: string },
  ): string {
    // Try to find relevant context around the candidate title
    const lines = sourceContent.split('\n');
    const titleIndex = lines.findIndex(line =>
      line.toLowerCase().includes(candidate.title.toLowerCase()),
    );

    if (titleIndex === -1) {
      // Return first few lines as fallback
      return lines.slice(0, 5).join('\n').slice(0, 500);
    }

    // Extract context window around the match
    const contextStart = Math.max(0, titleIndex - 3);
    const contextEnd = Math.min(lines.length, titleIndex + 5);
    return lines.slice(contextStart, contextEnd).join('\n');
  }

  /**
   * Generate a unique candidate ID
   */
  private generateCandidateId(candidate: { title: string; type?: WikiNodeType }): string {
    const timestamp = Date.now();
    const slug = candidate.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 30);
    return `candidate-${slug}-${timestamp}`;
  }

  /**
   * Check if candidate is a preferences topic
   */
  private isPreferencesTopic(candidate: MemoryCandidate): boolean {
    const preferencesIndicators = [
      'preference',
      'setting',
      'config',
      'option',
      'like',
      'dislike',
      'prefer',
      'favorite',
    ];

    const textToCheck = `${candidate.title} ${candidate.content} ${candidate.tags.join(' ')}`.toLowerCase();
    return preferencesIndicators.some(indicator => textToCheck.includes(indicator));
  }

  /**
   * Update extraction options
   */
  updateOptions(options: Partial<ExtractionOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options
   */
  getOptions(): ExtractionOptions {
    return { ...this.options };
  }
}

/**
 * Create a default extractor instance
 */
export function createCandidateExtractor(options?: Partial<ExtractionOptions>): WikiCandidateExtractor {
  return new WikiCandidateExtractor(options);
}
