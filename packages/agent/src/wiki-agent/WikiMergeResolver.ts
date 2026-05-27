/**
 * Wiki Merge Resolver
 * Handles conservative merge decisions for wiki memory candidates
 */

import type { MemoryCandidate, MergeDecision, WikiNode, ChangeLogEntry } from './types.js';
import type { WikiNodeStore } from './WikiNodeStore.js';

/**
 * Merge resolver options
 */
export interface MergeResolverOptions {
  /** Exact match threshold */
  exactMatchThreshold: number;
  /** High confidence semantic match threshold */
  highConfidenceThreshold: number;
  /** Minimum threshold for any merge consideration */
  minimumMergeThreshold: number;
  /** Current session ID for tracking */
  sessionId: string;
}

/**
 * Default merge resolver options
 */
const DEFAULT_OPTIONS: MergeResolverOptions = {
  exactMatchThreshold: 1.0,
  highConfidenceThreshold: 0.85,
  minimumMergeThreshold: 0.6,
  sessionId: 'unknown',
};

/**
 * Merge result with decision and metadata
 */
export interface MergeResult {
  decision: MergeDecision;
  candidate: MemoryCandidate;
  changeLogEntry?: ChangeLogEntry;
}

/**
 * Wiki Merge Resolver
 * Implements conservative merge strategy:
 * - Exact alias/title/slug match: auto merge
 * - High-confidence semantic match: auto merge
 * - Uncertain: do not merge
 */
export class WikiMergeResolver {
  private options: MergeResolverOptions;
  private nodeStore: WikiNodeStore;
  private changeLog: ChangeLogEntry[] = [];

  constructor(nodeStore: WikiNodeStore, options: Partial<MergeResolverOptions> = {}) {
    this.nodeStore = nodeStore;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Resolve merge for a single candidate
   * Main entry point for merge decisions
   */
  resolveMerge(candidate: MemoryCandidate): MergeResult {
    // Get all existing nodes for comparison
    const existingNodes = this.getExistingNodes();

    // Check for exact matches first
    const exactMatch = this.findExactMatch(candidate, existingNodes);
    if (exactMatch) {
      const decision: MergeDecision = {
        action: 'merge',
        targetNodeId: exactMatch.id,
        targetNodeTitle: exactMatch.title,
        confidence: 1.0,
        reason: `Exact match: ${this.getMatchReason(candidate, exactMatch)}`,
      };

      return {
        decision,
        candidate,
        changeLogEntry: this.createChangeLogEntry(candidate, decision),
      };
    }

    // Check for high-confidence semantic matches
    const semanticMatch = this.findSemanticMatch(candidate, existingNodes);
    if (semanticMatch && semanticMatch.confidence >= this.options.highConfidenceThreshold) {
      const decision: MergeDecision = {
        action: 'merge',
        targetNodeId: semanticMatch.node.id,
        targetNodeTitle: semanticMatch.node.title,
        confidence: semanticMatch.confidence,
        reason: `High-confidence semantic match: ${semanticMatch.reason}`,
      };

      return {
        decision,
        candidate,
        changeLogEntry: this.createChangeLogEntry(candidate, decision),
      };
    }

    // Check for uncertain matches
    if (semanticMatch && semanticMatch.confidence >= this.options.minimumMergeThreshold) {
      return {
        decision: {
          action: 'uncertain',
          confidence: semanticMatch.confidence,
          reason: `Potential match found but confidence too low: ${semanticMatch.reason}`,
        },
        candidate,
      };
    }

    // No match found
    return {
      decision: {
        action: 'skip',
        confidence: 0,
        reason: 'No matching existing node found',
      },
      candidate,
    };
  }

  /**
   * Resolve merges for multiple candidates
   */
  resolveMerges(candidates: MemoryCandidate[]): MergeResult[] {
    return candidates.map(candidate => this.resolveMerge(candidate));
  }

  /**
   * Apply merge to node
   * Updates the target node with candidate content
   */
  applyMerge(candidate: MemoryCandidate, targetNode: WikiNode): WikiNode {
    // Update content (merge intelligently)
    const mergedContent = this.mergeContent(targetNode.content, candidate.content, candidate.originalContext);

    // Update metadata
    const updatedNode: WikiNode = {
      ...targetNode,
      content: mergedContent,
      aliases: this.mergeAliases(targetNode.aliases, candidate.aliases),
      tags: this.mergeTags(targetNode.tags, candidate.tags),
      updatedAt: Date.now(),
      sourceSessions: this.mergeSourceSessions(targetNode.sourceSessions || [], this.options.sessionId),
      lastObservedAt: Date.now(),
    };

    return updatedNode;
  }

  /**
   * Get all change log entries
   */
  getChangeLog(): ChangeLogEntry[] {
    return [...this.changeLog];
  }

  /**
   * Clear change log
   */
  clearChangeLog(): void {
    this.changeLog = [];
  }

  /**
   * Update resolver options
   */
  updateOptions(options: Partial<MergeResolverOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * Get current options
   */
  getOptions(): MergeResolverOptions {
    return { ...this.options };
  }

  // Private helper methods

  /**
   * Get all existing nodes from the store
   */
  private getExistingNodes(): WikiNode[] {
    try {
      const entries = this.nodeStore.listAllNodes();
      return entries.map(entry => {
        try {
          const fullPath = this.nodeStore.getNodeFullPath(entry.path);
          return this.nodeStore.readNode(fullPath);
        } catch {
          return null;
        }
      }).filter((node): node is WikiNode => node !== null);
    } catch {
      return [];
    }
  }

  /**
   * Find exact match for candidate
   */
  private findExactMatch(candidate: MemoryCandidate, nodes: WikiNode[]): WikiNode | null {
    const candidateSlug = this.slugify(candidate.title);

    for (const node of nodes) {
      // Exact title match
      if (this.normalizeString(node.title) === this.normalizeString(candidate.title)) {
        return node;
      }

      // Exact alias match
      if (candidate.aliases.some(alias =>
        node.aliases.some(nodeAlias =>
          this.normalizeString(nodeAlias) === this.normalizeString(alias),
        ),
      )) {
        return node;
      }

      // Slug match
      if (this.slugify(node.title) === candidateSlug) {
        return node;
      }

      // Alias slug match
      if (candidate.aliases.some(alias =>
        node.aliases.some(nodeAlias =>
          this.slugify(nodeAlias) === this.slugify(alias),
        ),
      )) {
        return node;
      }
    }

    return null;
  }

  /**
   * Find semantic match for candidate
   */
  private findSemanticMatch(
    candidate: MemoryCandidate,
    nodes: WikiNode[],
  ): { node: WikiNode; confidence: number; reason: string } | null {
    let bestMatch: { node: WikiNode; confidence: number; reason: string } | null = null;

    for (const node of nodes) {
      const similarity = this.calculateSimilarity(candidate, node);

      if (similarity.confidence > (bestMatch?.confidence ?? 0)) {
        bestMatch = { node, ...similarity };
      }
    }

    return bestMatch;
  }

  /**
   * Calculate similarity between candidate and existing node
   */
  private calculateSimilarity(
    candidate: MemoryCandidate,
    node: WikiNode,
  ): { confidence: number; reason: string } {
    let score = 0;
    const reasons: string[] = [];

    // Title similarity
    const titleSim = this.stringSimilarity(
      this.normalizeString(candidate.title),
      this.normalizeString(node.title),
    );
    if (titleSim > 0.8) {
      score += titleSim * 0.4;
      reasons.push(`title similarity ${titleSim.toFixed(2)}`);
    }

    // Alias overlap
    const candidateTerms = new Set([
      ...candidate.aliases.map(a => this.normalizeString(a)),
      this.normalizeString(candidate.title),
    ]);
    const nodeTerms = new Set([
      ...node.aliases.map(a => this.normalizeString(a)),
      this.normalizeString(node.title),
    ]);
    const overlap = [...candidateTerms].filter(t => nodeTerms.has(t)).length;
    const aliasScore = overlap / Math.max(candidateTerms.size, nodeTerms.size);
    if (aliasScore > 0) {
      score += aliasScore * 0.3;
      reasons.push(`alias overlap ${aliasScore.toFixed(2)}`);
    }

    // Tag overlap
    const tagOverlap = candidate.tags.filter(t => node.tags.includes(t)).length;
    const tagScore = tagOverlap / Math.max(candidate.tags.length, node.tags.length, 1);
    if (tagScore > 0) {
      score += tagScore * 0.2;
      reasons.push(`tag overlap ${tagScore.toFixed(2)}`);
    }

    // Content similarity (first 200 chars)
    const contentSim = this.stringSimilarity(
      this.normalizeString(candidate.content.slice(0, 200)),
      this.normalizeString(node.content.slice(0, 200)),
    );
    if (contentSim > 0.7) {
      score += contentSim * 0.1;
      reasons.push(`content similarity ${contentSim.toFixed(2)}`);
    }

    return {
      confidence: Math.min(1, score),
      reason: reasons.join(', ') || 'low similarity across all dimensions',
    };
  }

  /**
   * Calculate string similarity (Jaccard index on word sets)
   */
  private stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const wordsA = new Set(a.split(/\s+/));
    const wordsB = new Set(b.split(/\s+/));

    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = wordsA.size + wordsB.size - intersection;

    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Get reason for exact match
   */
  private getMatchReason(candidate: MemoryCandidate, node: WikiNode): string {
    if (this.normalizeString(node.title) === this.normalizeString(candidate.title)) {
      return 'title match';
    }

    const matchingAlias = candidate.aliases.find(alias =>
      node.aliases.some(nodeAlias =>
        this.normalizeString(nodeAlias) === this.normalizeString(alias),
      ),
    );
    if (matchingAlias) {
      return `alias match: "${matchingAlias}"`;
    }

    if (this.slugify(node.title) === this.slugify(candidate.title)) {
      return 'slug match';
    }

    return 'exact match';
  }

  /**
   * Merge content intelligently
   */
  private mergeContent(existingContent: string, newContent: string, originalContext: string): string {
    const existingDoc = this.parseSections(existingContent);
    const incomingDoc = this.parseSections(newContent);

    const mergedPreamble = this.mergeTextBlocks(existingDoc.preamble, incomingDoc.preamble);
    const mergedSections = existingDoc.sections.map(section => ({ ...section }));

    for (const incoming of incomingDoc.sections) {
      if (this.isOriginalContextHeading(incoming.heading)) {
        continue;
      }

      const existingIndex = mergedSections.findIndex(
        section => this.normalizeSectionTitle(section.heading) === this.normalizeSectionTitle(incoming.heading),
      );

      if (existingIndex === -1) {
        mergedSections.push({ ...incoming });
        continue;
      }

      mergedSections[existingIndex] = {
        ...mergedSections[existingIndex],
        body: this.mergeTextBlocks(mergedSections[existingIndex].body, incoming.body),
      };
    }

    const existingContext = this.getSectionBody(existingDoc.sections, 'Original Context');
    const incomingContextSection = this.getSectionBody(incomingDoc.sections, 'Original Context');
    const mergedContext = this.mergeTextBlocks(
      this.mergeTextBlocks(existingContext, incomingContextSection),
      originalContext,
    );

    if (mergedContext.length > 0) {
      this.upsertSection(mergedSections, 'Original Context', mergedContext);
    }

    const rebuilt = this.renderDocument({
      preamble: mergedPreamble,
      sections: mergedSections,
    });

    return rebuilt.length > 0 ? rebuilt : existingContent;
  }

  /**
   * Merge aliases (union without duplicates)
   */
  private mergeAliases(existing: string[], newAliases: string[]): string[] {
    const normalized = new Set(existing.map(a => this.normalizeString(a)));
    const result = [...existing];

    for (const alias of newAliases) {
      if (!normalized.has(this.normalizeString(alias))) {
        result.push(alias);
        normalized.add(this.normalizeString(alias));
      }
    }

    return result;
  }

  /**
   * Merge tags (union without duplicates)
   */
  private mergeTags(existing: string[], newTags: string[]): string[] {
    const tagSet = new Set([...existing, ...newTags]);
    return [...tagSet];
  }

  /**
   * Merge source sessions (track all sessions that contributed)
   */
  private mergeSourceSessions(existing: string[], newSessionId: string): string[] {
    const sessionSet = new Set([...existing, newSessionId]);
    return [...sessionSet];
  }

  /**
   * Create change log entry
   */
  private createChangeLogEntry(candidate: MemoryCandidate, decision: MergeDecision): ChangeLogEntry {
    const entry: ChangeLogEntry = {
      timestamp: Date.now(),
      sessionId: this.options.sessionId,
      operation: decision.action === 'merge' ? 'merge' : 'create',
      nodeId: decision.targetNodeId || candidate.id,
      nodeTitle: decision.targetNodeTitle || candidate.title,
      details: decision.reason,
    };

    this.changeLog.push(entry);
    return entry;
  }

  /**
   * Normalize string for comparison
   */
  private normalizeString(str: string): string {
    return str.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  /**
   * Create URL-friendly slug from string
   */
  private slugify(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 100);
  }

  private parseSections(content: string): { preamble: string; sections: { heading: string; body: string }[] } {
    const normalized = content.replace(/\r\n/g, '\n').trim();
    if (!normalized) {
      return { preamble: '', sections: [] };
    }

    const headingRegex = /^##+\s+.+$/gm;
    const matches = [...normalized.matchAll(headingRegex)];
    if (matches.length === 0) {
      return { preamble: normalized, sections: [] };
    }

    const sections: { heading: string; body: string }[] = [];
    const preamble = normalized.slice(0, matches[0].index).trim();

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index ?? 0;
      const end = i + 1 < matches.length ? (matches[i + 1].index ?? normalized.length) : normalized.length;
      const sectionRaw = normalized.slice(start, end).trim();
      const lines = sectionRaw.split('\n');
      const heading = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      sections.push({ heading, body });
    }

    return { preamble, sections };
  }

  private renderDocument(doc: { preamble: string; sections: { heading: string; body: string }[] }): string {
    const parts: string[] = [];

    if (doc.preamble.trim().length > 0) {
      parts.push(doc.preamble.trim());
    }

    for (const section of doc.sections) {
      const heading = section.heading.trim();
      if (!heading) {
        continue;
      }
      const body = section.body.trim();
      parts.push(body.length > 0 ? `${heading}\n\n${body}` : heading);
    }

    return parts.join('\n\n').trim();
  }

  private mergeTextBlocks(existing: string, incoming: string): string {
    const existingTrimmed = existing.trim();
    const incomingTrimmed = incoming.trim();
    if (!existingTrimmed) return incomingTrimmed;
    if (!incomingTrimmed) return existingTrimmed;

    const normalizeBlock = (text: string): string =>
      this.normalizeString(text).replace(/\s+/g, ' ');
    const existingBlocks = existingTrimmed.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
    const incomingBlocks = incomingTrimmed.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
    const existingSignatures = new Set(existingBlocks.map(normalizeBlock));

    const merged = [...existingBlocks];
    for (const block of incomingBlocks) {
      const signature = normalizeBlock(block);
      if (!existingSignatures.has(signature)) {
        merged.push(block);
        existingSignatures.add(signature);
      }
    }

    return merged.join('\n\n');
  }

  private normalizeSectionTitle(heading: string): string {
    return this.normalizeString(heading.replace(/^#+\s*/, ''));
  }

  private isOriginalContextHeading(heading: string): boolean {
    return this.normalizeSectionTitle(heading) === this.normalizeSectionTitle('Original Context');
  }

  private getSectionBody(
    sections: { heading: string; body: string }[],
    headingName: string,
  ): string {
    const section = sections.find(
      candidate => this.normalizeSectionTitle(candidate.heading) === this.normalizeSectionTitle(headingName),
    );
    return section?.body ?? '';
  }

  private upsertSection(
    sections: { heading: string; body: string }[],
    headingName: string,
    body: string,
  ): void {
    const targetIndex = sections.findIndex(
      section => this.normalizeSectionTitle(section.heading) === this.normalizeSectionTitle(headingName),
    );

    if (targetIndex === -1) {
      sections.push({
        heading: `## ${headingName}`,
        body,
      });
      return;
    }

    sections[targetIndex] = {
      ...sections[targetIndex],
      body,
    };
  }
}

/**
 * Create a default merge resolver instance
 */
export function createMergeResolver(
  nodeStore: WikiNodeStore,
  options?: Partial<MergeResolverOptions>,
): WikiMergeResolver {
  return new WikiMergeResolver(nodeStore, options);
}
