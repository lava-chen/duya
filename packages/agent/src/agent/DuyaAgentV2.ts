/**
 * DuyaAgentV2 - 从零重建的 AI Agent 核心类（MVP：纯核心流）
 *
 * 设计参考 pi 的 coding-agent：AgentSession 是薄编排层，沉重的 LLM 流式、
 * 工具执行、重试循环委托给底层原语（duya 里即 MessageTimeline +
 * llmClient.streamChat + StreamingToolExecutor）。本类只做编排与事件消费。
 *
 * MVP 范围：构造函数 + 消息访问 + streamChat 核心循环。
 * 暂缓：compaction、modes、MCP、视觉、mailbox、权限、conductor、AGENTS.md 注入。
 *
 * 消息持久化直接采用 plan 315 的 MessageTimeline 作为单一事实源。
 * 与 legacy DuyaAgent.ts 独立并存，新 API，逐步迁移。
 */

import type { AgentOptions, Message, SessionInfo } from '../types.js';
import { createAIClient, createAIClientWithRetry, inferProvider, resolveDefaultBaseURL } from '@duya/ai';
import type { AIClient, AIClientOptions, RetryConfig, ThinkingLevel } from '@duya/ai';
import { resolveLlmClientDiscriminator } from '@duya/ai';
import { MessageTimeline } from '../message/message-framework.js';
import { ingestMessage } from '../message/message-factories.js';
import { projectTimelinePersistenceMessages } from '../message/message-projectors.js';

export class DuyaAgentV2 {
  // === LLM 客户端 ===
  private llmClient: AIClient;
  private apiKey: string;
  private baseURL?: string;
  private authStyle?: 'api_key' | 'auth_token';
  private provider: 'anthropic' | 'openai' | 'ollama';
  private enableRetry: boolean;
  private retryConfig?: Partial<RetryConfig>;

  // === 运行中热改（参考 pi 的 AgentSession） ===
  /** 思考程度。每次 streamChat 调用时读取，映射为该 provider 的原生 effort/reasoning 参数。 */
  private _thinkingLevel: ThinkingLevel = 'medium';
  get thinkingLevel(): ThinkingLevel {
    return this._thinkingLevel;
  }
  set thinkingLevel(level: ThinkingLevel) {
    this._thinkingLevel = level;
  }

  // === 会话配置 ===
  private sessionInfo: SessionInfo;
  private sessionId?: string;
  private workingDirectory?: string;
  private defaultWorkspaceDirectory?: string;
  private language?: string;
  readonly runtimeConfig?: AgentOptions['runtimeConfig'];

  // === 消息域（plan 315，单一事实源） ===
  /** Append-only message timeline. The runtime authority for history. */
  private timeline = new MessageTimeline();
  /** O(1) dedup for messages already appended to timeline. */
  private syncedMessageIds: Set<string> = new Set();

  /** Durable persistence projection of the timeline, for legacy callers. */
  get messages(): Message[] {
    return projectTimelinePersistenceMessages(this.timeline.snapshot());
  }

  // === 中断 ===
  private abortController: AbortController | null = null;

  private _model!: string;
  get model(): string {
    return this._model;
  }
  set model(value: string) {
    this._model = value;
  }

  constructor(options: AgentOptions) {
    // Provider 解析：优先 runtimeConfig.apiFormat，其次 options.provider，最后按 baseURL 嗅探。
    let provider: 'anthropic' | 'openai' | 'ollama';
    if (options.runtimeConfig) {
      provider = resolveLlmClientDiscriminator(options.runtimeConfig.apiFormat);
    } else {
      provider = options.provider || inferProvider(options.baseURL || '');
    }
    this.provider = provider;
    this.sessionId = options.sessionId;

    if (!options.model) {
      throw new Error(
        `Model is required. Please specify a model in your provider settings. ` +
          `Provider: ${provider}, BaseURL: ${options.baseURL || 'not provided'}`,
      );
    }

    this.apiKey = options.apiKey;
    this.baseURL = options.baseURL;
    this.authStyle = options.authStyle;
    this.enableRetry = options.enableRetry !== false;
    this.retryConfig = options.retryConfig;
    this.workingDirectory = options.workingDirectory;
    this.defaultWorkspaceDirectory = options.defaultWorkspaceDirectory;
    this.runtimeConfig = options.runtimeConfig;
    this.language = options.language;
    this._model = options.model;
    this.llmClient = this._buildLLMClient(options.model);
    this.sessionInfo = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    };
  }

  /**
   * 用给定 model 构建（或重建）底层 AIClient。
   * model 是 createAIClient 的构造参数，streamChat 每次调用无法覆盖，
   * 因此热改模型 = 用新 model 重建 client（懒加载，开销可忽略）。
   */
  private _buildLLMClient(model: string): AIClient {
    const apiFormat =
      this.runtimeConfig?.apiFormat ??
      (this.provider === 'ollama'
        ? 'ollama'
        : this.provider === 'anthropic'
          ? 'anthropic'
          : 'openai-chat');
    const llmClientOptions: AIClientOptions = {
      apiKey: this.apiKey,
      baseURL: this.baseURL || resolveDefaultBaseURL(this.provider),
      model,
      authStyle: this.authStyle,
      apiFormat,
      providerId: this.runtimeConfig?.providerId ?? this.provider,
      modelCapabilities: this.runtimeConfig?.modelCompat,
    };

    return this.enableRetry
      ? createAIClientWithRetry({
          ...llmClientOptions,
          retryConfig: this.retryConfig,
        })
      : createAIClient(llmClientOptions);
  }

  /** 运行中热改模型：更新 model 并重建底层 AIClient。 */
  setModel(model: string): void {
    this._model = model;
    this.llmClient = this._buildLLMClient(model);
  }

  // === 中断 ===

  interrupt(): void {
    this.abortController?.abort();
  }

  // === 消息访问 ===

  /** 获取持久化消息（legacy 形状），隐藏的 runtime context 已被投影排除。 */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /** 从持久化重建消息历史，逐条转成 timeline entries。 */
  setMessages(messages: Message[]): void {
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
    for (const [index, message] of messages.entries()) {
      const adapted = ingestMessage(message, { index });
      this.timeline.appendMessage({
        type: 'message',
        id: `${crypto.randomUUID()}:${index}`,
        parentId: null,
        createdAt: adapted.timestamp ?? 0,
        message: adapted,
      });
      if (message.id) this.syncedMessageIds.add(message.id);
    }
    this.sessionInfo.messageCount = this.messages.length;
    this.sessionInfo.updatedAt = Date.now();
  }

  clearMessages(): void {
    this.timeline = new MessageTimeline();
    this.syncedMessageIds = new Set();
    this.sessionInfo.updatedAt = Date.now();
  }

  getSessionInfo(): SessionInfo {
    return this.sessionInfo;
  }
}