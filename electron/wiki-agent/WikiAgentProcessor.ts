import * as fs from 'fs';
import * as path from 'path';
import {
  createRetryableLLMClient,
  type LLMClient,
} from '../../packages/agent/src/llm/index.js';
import type { Message, TokenUsage } from '../../packages/agent/src/types.js';
import { createCandidateExtractor } from '../../packages/agent/src/wiki-agent/WikiCandidateExtractor.js';
import { createMergeResolver } from '../../packages/agent/src/wiki-agent/WikiMergeResolver.js';
import type { WikiNode } from '../../packages/agent/src/wiki-agent/types.js';
import { WikiAgentPromptSystem } from '../../packages/agent/src/wiki-agent/prompts/WikiAgentPromptSystem.js';
import { getConfigManager, toLLMProvider, type ApiProvider } from '../config/manager.js';
import { getJsonSetting } from '../db/queries/settings.js';
import { getLogger, LogComponent } from '../logging/logger.js';
import { getMainWikiNodeStore } from './node-store.js';
import type {
  ChatDonePayload,
  WikiAgentActivityEvent,
  WikiAgentJob,
} from './types.js';

const logger = getLogger();

type EmitActivity = (
  payload: ChatDonePayload,
  phase: WikiAgentActivityEvent['phase'],
  message: string,
  details?: Record<string, unknown>,
) => void;

export class WikiAgentProcessor {
  constructor(private readonly emitActivity: EmitActivity) {}

  async process(job: WikiAgentJob): Promise<void> {
    const payload = job.payload;
    const sourceText = payload.conversationText?.trim() || payload.finalContent.trim();
    if (!sourceText) {
      this.emitActivity(payload, 'completed', 'Skipped empty turn');
      return;
    }
    const explicitSignal = this.detectExplicitMemorySignal(sourceText);

    const store = getMainWikiNodeStore();
    const modelSelection = this.resolveModelSelection();
    const client = this.createClient(modelSelection.provider, modelSelection.model);
    const existingNodes = store.listAllNodes().map((node) => ({
      id: node.id,
      title: node.title,
      type: node.type,
      aliases: node.aliases,
    }));

    const promptSystem = new WikiAgentPromptSystem();
    const modelId = modelSelection.model;
    const context = promptSystem.buildContext({
      workingDirectory: store.getRootPath(),
      wikiBasePath: store.getRootPath(),
      sessionId: payload.sessionId,
      modelId,
    });
    context.existingNodes = existingNodes;

    this.emitActivity(
      payload,
      'classifying',
      explicitSignal
        ? 'Explicit memory signal detected, prioritizing extraction'
        : 'Classifying turn for extractable memory',
    );
    const shouldExtract = explicitSignal
      ? true
      : await this.shouldExtract(client, promptSystem, context, sourceText);
    if (!shouldExtract) {
      this.emitActivity(payload, 'completed', 'No durable memory detected');
      return;
    }

    this.emitActivity(payload, 'extracting', 'Extracting memory candidates');
    const extractionRaw = await this.runPrompt(
      client,
      promptSystem.getCandidateExtractionPrompt(context),
      sourceText,
      2000,
    );
    const extractor = createCandidateExtractor({ sessionId: payload.sessionId });
    const extraction = extractor.extractCandidates(sourceText, context, extractionRaw);
    if (explicitSignal && extraction.candidates.length === 0) {
      extraction.candidates.push(this.buildFallbackCandidate(sourceText, payload));
    }
    if (extraction.candidates.length === 0) {
      this.emitActivity(payload, 'completed', 'No valid candidates extracted');
      return;
    }

    const mergeResolver = createMergeResolver(store, { sessionId: payload.sessionId });
    const mergeResults = mergeResolver.resolveMerges(extraction.candidates);

    let created = 0;
    let merged = 0;
    let inboxed = 0;

    for (const result of mergeResults) {
      const candidate = result.candidate;
      if (result.decision.action === 'merge' && result.decision.targetNodeId) {
        this.emitActivity(payload, 'merging', `Merging into ${result.decision.targetNodeTitle || result.decision.targetNodeId}`);
        const target = this.findNodeById(store, result.decision.targetNodeId);
        if (!target) {
          this.writeInboxDraft(store.getRootPath(), candidate, payload, 'merge target missing');
          inboxed++;
          continue;
        }

        const mergedNode = mergeResolver.applyMerge(candidate, target);
        store.writeNode(mergedNode);
        store.appendLog({
          timestamp: Date.now(),
          operation: 'merge',
          details: {
            message: `Merged ${candidate.title} into ${mergedNode.title}`,
            sessionId: payload.sessionId,
            turnId: payload.turnId,
          },
        });
        merged++;
        continue;
      }

      if (candidate.suggestedAction === 'inbox' || result.decision.action === 'uncertain') {
        this.emitActivity(payload, 'writing', `Writing draft for ${candidate.title}`);
        this.writeInboxDraft(
          store.getRootPath(),
          candidate,
          payload,
          result.decision.reason,
        );
        store.appendLog({
          timestamp: Date.now(),
          operation: 'inbox',
          details: {
            message: `Drafted ${candidate.title} to inbox`,
            sessionId: payload.sessionId,
            turnId: payload.turnId,
          },
        });
        inboxed++;
        continue;
      }

      this.emitActivity(payload, 'writing', `Creating node ${candidate.title}`);
      const createdNode = this.createNode(candidate, payload);
      store.writeNode(createdNode);
      store.appendLog({
        timestamp: Date.now(),
        operation: 'create',
        details: {
          message: `Created ${candidate.title}`,
          sessionId: payload.sessionId,
          turnId: payload.turnId,
        },
      });
      created++;
    }

    const rebuiltIndex = store.listAllNodes().map((entry) => ({
      ...entry,
      summary: entry.summary || undefined,
    }));
    store.writeIndex(rebuiltIndex);

    this.emitActivity(
      payload,
      'completed',
      `WikiAgent updated memory: ${created} created, ${merged} merged, ${inboxed} inbox`,
      { created, merged, inboxed, extracted: extraction.candidates.length },
    );
  }

  private createClient(provider: ApiProvider, model: string): LLMClient {
    if (!provider) {
      throw new Error('WikiAgent requires an active provider');
    }

    if (!model) {
      throw new Error('WikiAgent requires a resolved model name');
    }

    return createRetryableLLMClient(
      toLLMProvider(provider.providerType, provider.baseUrl),
      {
        apiKey: provider.apiKey,
        baseURL: provider.baseUrl,
        model,
      },
    );
  }

  private resolveModelSelection(): { provider: ApiProvider; model: string } {
    const configManager = getConfigManager();
    const activeProvider = configManager.getActiveProvider();
    const configuredModel = getJsonSetting<string>('wikiAgentModel', '')
      || getJsonSetting<{ wikiAgentModel?: string }>('modelSelection', {}).wikiAgentModel
      || '';

    if (configuredModel) {
      const parsed = this.parseProviderModelSelection(configuredModel);
      if (parsed.providerId) {
        const provider = configManager.getAllProviders()[parsed.providerId];
        if (provider && parsed.model) {
          return { provider, model: parsed.model };
        }
      }
    }

    if (!activeProvider) {
      throw new Error('WikiAgent requires an active provider');
    }

    return {
      provider: activeProvider,
      model: this.resolveModel(activeProvider),
    };
  }

  private resolveModel(
    provider: ApiProvider | undefined,
  ): string {
    if (!provider) {
      return '';
    }

    const options = provider.options || {};
    const candidates = [
      options.defaultModel,
      options.model,
      Array.isArray(options.enabled_models) ? options.enabled_models[0] : undefined,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value;
      }
    }

    return '';
  }

  private parseProviderModelSelection(value: string): { providerId: string; model: string } {
    const parts = value.split(':');
    if (parts.length >= 2) {
      return {
        providerId: parts[0],
        model: parts.slice(1).join(':'),
      };
    }

    return {
      providerId: '',
      model: value,
    };
  }

  private async shouldExtract(
    client: LLMClient,
    promptSystem: WikiAgentPromptSystem,
    context: Parameters<WikiAgentPromptSystem['getCheapClassifierPrompt']>[0],
    sourceText: string,
  ): Promise<boolean> {
    const result = await this.runPrompt(
      client,
      promptSystem.getCheapClassifierPrompt(context),
      sourceText,
      32,
    );

    return result.trim().toUpperCase().startsWith('YES');
  }

  private async runPrompt(
    client: LLMClient,
    systemPrompt: string,
    content: string,
    maxTokens: number,
  ): Promise<string> {
    const messages: Message[] = [
      {
        role: 'user',
        content,
      },
    ];
    const chunks: string[] = [];
    const stream = client.streamChat(messages, {
      systemPrompt,
      maxTokens,
      temperature: 0.1,
      disableThinking: true,
    });

    for await (const event of stream) {
      if (event.type === 'text') {
        chunks.push(event.data);
        continue;
      }

      if (event.type === 'error') {
        throw new Error(event.data);
      }

      if (event.type === 'done') {
        break;
      }

      if (event.type === 'result') {
        const usage = event.data as TokenUsage;
        logger.debug(
          'WikiAgent LLM usage',
          {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
          },
          LogComponent.Main,
        );
      }
    }

    return chunks.join('').trim();
  }

  private detectExplicitMemorySignal(sourceText: string): boolean {
    const userText = this.extractUserContent(sourceText).join('\n').toLowerCase();
    const signalPatterns = [
      /remember this/,
      /save this/,
      /save .*wiki/,
      /keep this in memory/,
      /long-term preference/,
      /project decision/,
      /project constraint/,
      /from now on/,
      /default to /,
      /\u8bb0\u4f4f\u8fd9\u4e2a/,
      /\u8bb0\u4f4f\u8fd9\u4ef6\u4e8b/,
      /\u8bb0\u4e0b\u6765/,
      /\u4fdd\u5b58\u5230\s*wiki/,
      /\u4fdd\u5b58\u8fdb\s*wiki/,
      /\u957f\u671f\u504f\u597d/,
      /\u9879\u76ee\u51b3\u5b9a/,
      /\u9879\u76ee\u7ea6\u675f/,
      /\u4ee5\u540e\u9ed8\u8ba4/,
      /\u4ee5\u540e\u90fd/,
      /\u4e0d\u60f3\u7528\s*rag/,
    ];

    return signalPatterns.some((pattern) => pattern.test(userText));
  }
  private extractUserContent(sourceText: string): string[] {
    return sourceText
      .split(/\n{2,}/)
      .filter((block) => block.startsWith('[USER]'))
      .map((block) => block.replace(/^\[USER\]\s*/i, '').trim())
      .filter(Boolean);
  }

  private buildFallbackCandidate(sourceText: string, payload: ChatDonePayload): {
    id: string;
    title: string;
    type: string;
    content: string;
    aliases: string[];
    tags: string[];
    originalContext: string;
    confidence: number;
    suggestedAction: 'inbox';
  } {
    const userBlocks = this.extractUserContent(sourceText);
    const primaryStatement = userBlocks[userBlocks.length - 1] || payload.finalContent || 'Remembered decision';
    const normalizedStatement = primaryStatement
      .replace(/^(\u8bb0\u4f4f\u8fd9\u4e2a|\u8bb0\u4f4f\u8fd9\u4ef6\u4e8b|\u8bb0\u4e0b\u6765|\u4fdd\u5b58\u5230\s*wiki|\u4fdd\u5b58\u8fdb\s*wiki)[:\uff1a]?\s*/i, '')
      .replace(/^(remember this|save this|save this to wiki)[:\uff1a]?\s*/i, '')
      .trim();
    const title = normalizedStatement.slice(0, 80) || 'Explicit memory request';

    return {
      id: this.slugify(`fallback-${title}-${payload.turnId}`),
      title,
      type: this.inferFallbackType(normalizedStatement),
      content: normalizedStatement,
      aliases: [],
      tags: ['explicit-memory-request'],
      originalContext: sourceText,
      confidence: 0.72,
      suggestedAction: 'inbox',
    };
  }

  private inferFallbackType(statement: string): string {
    const lower = statement.toLowerCase();
    if (/[a-z]:\\|\/|~\/|\.md|\.docx|\.pdf|\.py|\.ts|\.tsx/.test(statement)) {
      return 'file';
    }
    if (/\u6211\u8981|\u6253\u7b97|\u9700\u8981/.test(statement)) {
      return 'todo';
    }
    if (/\u9879\u76ee|duya|wiki agent/i.test(statement)) {
      return 'project';
    }
    if (/\u4ee5\u540e|\u9ed8\u8ba4|\u4e0d\u60f3/.test(statement)) {
      return 'self';
    }
    if (lower.includes('todo') || lower.includes('plan') || lower.includes('need to')) {
      return 'todo';
    }
    if (lower.includes('project') || lower.includes('duya') || lower.includes('wiki agent')) {
      return 'project';
    }
    if (lower.includes('prefer') || lower.includes('preference')) {
      return 'self';
    }
    return 'knowledge';
  }

  private findNodeById(
    store: ReturnType<typeof getMainWikiNodeStore>,
    id: string,
  ): WikiNode | null {
    const entry = store.listAllNodes().find((node) => node.id === id);
    if (!entry) {
      return null;
    }

    return store.readNode(store.getNodeFullPath(entry.path));
  }

  private createNode(
    candidate: {
      id: string;
      title: string;
      type: string;
      content: string;
      aliases: string[];
      tags: string[];
      originalContext: string;
    },
    payload: ChatDonePayload,
  ): WikiNode {
    const timestamp = Date.now();
    return {
      id: candidate.id,
      title: candidate.title,
      type: candidate.type as WikiNode['type'],
      path: '',
      content: this.buildNodeContent(candidate, payload),
      aliases: candidate.aliases,
      tags: candidate.tags,
      createdAt: timestamp,
      updatedAt: timestamp,
      backlinks: [],
      sourceSessions: [payload.sessionId],
      lastObservedAt: timestamp,
    };
  }

  private buildNodeContent(
    candidate: {
      title?: string;
      type?: string;
      content: string;
      originalContext: string;
    },
    payload: ChatDonePayload,
  ): string {
    const type = candidate.type || 'knowledge';
    return [
      '## Recall Hook',
      '',
      this.buildRecallHook(candidate),
      '',
      '## Current Understanding',
      '',
      candidate.content || 'Pending refinement.',
      '',
      '## Original Context',
      '',
      candidate.originalContext || payload.conversationText || payload.finalContent,
      '',
      '## Change Log',
      '',
      `- ${new Date(payload.timestamp).toISOString()} observed from session ${payload.sessionId}`,
      '',
      ...this.initialAppendOnlySections(type),
    ].join('\n');
  }

  private buildRecallHook(candidate: { title?: string; type?: string }): string {
    const title = candidate.title || 'this memory';
    switch (candidate.type) {
      case 'person':
        return `Recall this when the user mentions ${title}, related people, relationships, meetings, or updates involving this person.`;
      case 'project':
        return `Recall this when the user discusses ${title}, project decisions, architecture, progress, problems, ideas, or constraints.`;
      case 'file':
        return `Recall this when the user mentions ${title}, related files, paths, documents, or actions involving this file.`;
      case 'todo':
        return `Recall this when the user discusses planned work, follow-up tasks, or completion status related to ${title}.`;
      case 'self':
        return `Recall this when the user mentions their preferences, status, habits, plans, or personal timeline related to ${title}.`;
      case 'event':
        return `Recall this when the user mentions this event, its date, participants, or follow-up context.`;
      case 'knowledge':
      default:
        return `Recall this when the user discusses ${title}, related concepts, learned knowledge, news, or decisions.`;
    }
  }

  private initialAppendOnlySections(type: string): string[] {
    if (type === 'project') {
      return ['## Progress', '', '## Ideas', '', '## Problems', ''];
    }
    if (type === 'person' || type === 'self' || type === 'event') {
      return ['## Timeline', ''];
    }
    if (type === 'todo') {
      return ['## Tasks', ''];
    }
    return [];
  }

  private writeInboxDraft(
    rootPath: string,
    candidate: {
      id: string;
      title: string;
      type: string;
      content: string;
      originalContext: string;
      confidence: number;
    },
    payload: ChatDonePayload,
    reason: string,
  ): void {
    const filename = `${this.slugify(candidate.title)}-${Date.now()}.md`;
    const filePath = path.join(rootPath, 'inbox', filename);
    const body = [
      '---',
      `id: ${candidate.id}`,
      `title: ${candidate.title}`,
      `type: ${candidate.type}`,
      `confidence: ${candidate.confidence}`,
      `sessionId: ${payload.sessionId}`,
      `turnId: ${payload.turnId}`,
      '---',
      '',
      `# ${candidate.title}`,
      '',
      '## Reason',
      '',
      reason,
      '',
      '## Current Understanding',
      '',
      candidate.content,
      '',
      '## Original Context',
      '',
      candidate.originalContext || payload.conversationText || payload.finalContent,
      '',
    ].join('\n');

    fs.writeFileSync(filePath, body, 'utf-8');
  }

  private slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'node';
  }
}
