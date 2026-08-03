import type { Message, MessageContent, TokenUsage } from '../types.js';

export type AgentMessageContent = string | MessageContent[];

export type AgentMessagePersistence = 'durable' | 'transient';

export type AgentMessageVisibility = 'visible' | 'hidden';

export interface AgentMessageBase {
  id: string;
  createdAt: number;
  persistence: AgentMessagePersistence;
  visibility: AgentMessageVisibility;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface UserAgentMessage extends AgentMessageBase {
  kind: 'user';
  content: AgentMessageContent;
  displayContent?: AgentMessageContent;
  attachments?: readonly unknown[];
}

export interface AssistantAgentMessage extends AgentMessageBase {
  kind: 'assistant';
  content: AgentMessageContent;
  providerId?: string;
  model?: string;
  tokenUsage?: TokenUsage;
  stopReason?: string;
}

export interface ToolResultAgentMessage extends AgentMessageBase {
  kind: 'tool_result';
  toolCallId: string;
  toolName: string;
  content: AgentMessageContent;
  isError: boolean;
}

export type RuntimeContextSource =
  | 'agents_md'
  | 'attachment'
  | 'background_notification'
  | 'mailbox'
  | 'memory'
  | 'mode'
  | 'system'
  | 'custom';

export interface RuntimeContextAgentMessage extends AgentMessageBase {
  kind: 'runtime_context';
  source: RuntimeContextSource;
  content: AgentMessageContent;
  includeInModel: boolean;
}

export interface CompactionSummaryAgentMessage extends AgentMessageBase {
  kind: 'compaction_summary';
  summary: string;
  compactionEntryId: string;
  tokensBefore: number;
  tokensAfter?: number;
}

/**
 * Applications may extend the framework without widening the provider Message type.
 *
 * @example
 * type ArtifactMessage = AgentCustomMessage<'artifact', { path: string }>;
 * type AppMessage = AgentMessage<ArtifactMessage>;
 */
export interface AgentCustomMessage<
  TKind extends string = string,
  TPayload = unknown,
> extends AgentMessageBase {
  kind: `custom:${TKind}`;
  payload: TPayload;
  includeInModel: boolean;
}

export type CoreAgentMessage =
  | UserAgentMessage
  | AssistantAgentMessage
  | ToolResultAgentMessage
  | RuntimeContextAgentMessage
  | CompactionSummaryAgentMessage;

export type AgentMessage<TCustom extends AgentCustomMessage = never> =
  | CoreAgentMessage
  | TCustom;

export interface MessageEntry<TCustom extends AgentCustomMessage = never> {
  type: 'message';
  id: string;
  parentId: string | null;
  createdAt: number;
  message: AgentMessage<TCustom>;
}

export interface CompactionEntry {
  type: 'compaction';
  id: string;
  parentId: string | null;
  createdAt: number;
  summary: string;
  firstKeptMessageId: string;
  compactedMessageIds: readonly string[];
  tokensBefore: number;
  tokensAfter?: number;
  strategy: string;
  previousCompactionId?: string;
}

export type MessageTimelineEntry<TCustom extends AgentCustomMessage = never> =
  | MessageEntry<TCustom>
  | CompactionEntry;

export interface AgentContextProjection<TCustom extends AgentCustomMessage = never> {
  messages: AgentMessage<TCustom>[];
  compaction?: CompactionEntry;
  warnings: string[];
}

export type ContextContributionTarget =
  | 'system'
  | 'messages'
  | 'metadata'
  | 'tools';

export type ContextContributionPlacement =
  | 'stable-prefix'
  | 'history-prefix'
  | 'before-current-user'
  | 'tail';

export type ContextCacheScope =
  | 'global'
  | 'project'
  | 'session'
  | 'turn'
  | 'none';

interface ContextContributionBase {
  readonly id: string;
  readonly placement: ContextContributionPlacement;
  readonly cacheScope: ContextCacheScope;
  readonly fingerprint: string;
  readonly order?: number;
}

export interface SystemContextContribution extends ContextContributionBase {
  readonly target: 'system';
  readonly content: AgentMessageContent;
}

export interface MessageContextContribution<
  TCustom extends AgentCustomMessage = never,
> extends ContextContributionBase {
  readonly target: 'messages';
  readonly messages: readonly AgentMessage<TCustom>[];
}

export interface MetadataContextContribution extends ContextContributionBase {
  readonly target: 'metadata';
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type ToolSurfaceSource =
  | 'builtin'
  | 'mcp'
  | 'discovered'
  | 'mode'
  | 'custom';

export interface ToolSurfaceItem<TTool = unknown> {
  readonly id: string;
  readonly source: ToolSurfaceSource;
  readonly fingerprint: string;
  readonly definition: TTool;
  readonly order?: number;
}

export interface ToolContextContribution<TTool = unknown>
  extends ContextContributionBase {
  readonly target: 'tools';
  readonly tools: readonly ToolSurfaceItem<TTool>[];
}

export type ContextContribution<
  TCustom extends AgentCustomMessage = never,
  TTool = unknown,
> =
  | SystemContextContribution
  | MessageContextContribution<TCustom>
  | MetadataContextContribution
  | ToolContextContribution<TTool>;

export interface ContextContributorRequest<
  TCustom extends AgentCustomMessage = never,
  TContext = unknown,
> {
  readonly requestId: string;
  readonly projection: Readonly<{
    messages: readonly AgentMessage<TCustom>[];
    compaction?: CompactionEntry;
    warnings: readonly string[];
  }>;
  readonly context: TContext;
}

export interface ContextContributor<
  TCustom extends AgentCustomMessage = never,
  TTool = unknown,
  TContext = unknown,
> {
  readonly id: string;
  readonly order?: number;
  collect(
    request: Readonly<ContextContributorRequest<TCustom, TContext>>,
  ):
    | readonly ContextContribution<TCustom, TTool>[]
    | Promise<readonly ContextContribution<TCustom, TTool>[]>;
}

export interface AppliedContextContribution {
  readonly key: string;
  readonly contributorId: string;
  readonly contributionId: string;
  readonly target: ContextContributionTarget;
  readonly placement: ContextContributionPlacement;
  readonly cacheScope: ContextCacheScope;
  readonly fingerprint: string;
  readonly contributorOrder: number;
  readonly order: number;
}

export interface CachePlanEntry extends AppliedContextContribution {
  readonly cacheKey: string;
}

export interface CachePlan {
  readonly version: 1;
  readonly fingerprint: string;
  readonly stablePrefixFingerprint?: string;
  readonly entries: readonly CachePlanEntry[];
}

export interface PromptSegment {
  readonly id: string;
  readonly contributorId: string;
  readonly placement: ContextContributionPlacement;
  readonly content: string | readonly MessageContent[];
}

export interface MetadataSegment {
  readonly id: string;
  readonly contributorId: string;
  readonly placement: ContextContributionPlacement;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ToolSurfaceSnapshot<TTool = unknown> {
  readonly items: readonly ToolSurfaceItem<TTool>[];
}

export type ModelContextWarningCode =
  | 'projection-warning'
  | 'contributor-failed'
  | 'duplicate-contribution'
  | 'duplicate-tool';

export interface ModelContextWarning {
  readonly code: ModelContextWarningCode;
  readonly message: string;
  readonly contributorId?: string;
}

export interface ModelContextSnapshot<
  TCustom extends AgentCustomMessage = never,
  TTool = unknown,
> {
  readonly requestId: string;
  readonly systemSegments: readonly PromptSegment[];
  readonly messages: readonly AgentMessage<TCustom>[];
  readonly metadataSegments: readonly MetadataSegment[];
  readonly tools: ToolSurfaceSnapshot<TTool>;
  readonly cachePlan: CachePlan;
  readonly appliedContributions: readonly AppliedContextContribution[];
  readonly warnings: readonly ModelContextWarning[];
  readonly compaction?: CompactionEntry;
}

export interface BuildModelContextOptions<TContext = unknown> {
  readonly requestId: string;
  readonly context: TContext;
}

interface CollectedContextContribution<
  TCustom extends AgentCustomMessage = never,
  TTool = unknown,
> {
  contributorId: string;
  contributorOrder: number;
  contribution: ContextContribution<TCustom, TTool>;
}

export type CustomMessageProjector<TCustom extends AgentCustomMessage> = (
  message: TCustom,
) => Message | readonly Message[] | null;

function isCustomAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): message is AgentCustomMessage {
  return message.kind.startsWith('custom:');
}

export function isDurableAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): boolean {
  return message.persistence === 'durable';
}

export function isVisibleAgentMessage(
  message: AgentMessage<AgentCustomMessage>,
): boolean {
  return message.visibility === 'visible';
}

export function findSafeCompactionBoundary<
  TCustom extends AgentCustomMessage = never,
>(
  messages: readonly AgentMessage<TCustom>[],
  proposedFirstKeptIndex: number,
): { firstKeptIndex: number; firstKeptMessageId?: string } {
  if (messages.length === 0) {
    return { firstKeptIndex: 0 };
  }

  const proposedIndex = Math.max(
    0,
    Math.min(Math.trunc(proposedFirstKeptIndex), messages.length - 1),
  );

  for (let index = proposedIndex; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'user') {
      return { firstKeptIndex: index, firstKeptMessageId: message.id };
    }
  }

  return {
    firstKeptIndex: 0,
    firstKeptMessageId: messages[0]?.id,
  };
}

export function buildAgentContext<TCustom extends AgentCustomMessage = never>(
  entries: readonly MessageTimelineEntry<TCustom>[],
): AgentContextProjection<TCustom> {
  const messageEntries = entries.filter(
    (entry): entry is MessageEntry<TCustom> => entry.type === 'message',
  );
  const latestCompaction = [...entries]
    .reverse()
    .find((entry): entry is CompactionEntry => entry.type === 'compaction');

  if (!latestCompaction) {
    return {
      messages: messageEntries.map((entry) => entry.message),
      warnings: [],
    };
  }

  const compactionIndex = entries.findIndex(
    (entry) => entry.id === latestCompaction.id,
  );
  const firstKeptIndex = entries.findIndex(
    (entry) =>
      entry.type === 'message' &&
      entry.message.id === latestCompaction.firstKeptMessageId,
  );

  if (firstKeptIndex < 0 || firstKeptIndex > compactionIndex) {
    return {
      messages: messageEntries.map((entry) => entry.message),
      compaction: latestCompaction,
      warnings: [
        `Compaction ${latestCompaction.id} references missing boundary ${latestCompaction.firstKeptMessageId}; full history retained`,
      ],
    };
  }

  const retainedMessages = entries
    .slice(firstKeptIndex)
    .filter((entry): entry is MessageEntry<TCustom> => entry.type === 'message')
    .map((entry) => entry.message);

  const summaryMessage: CompactionSummaryAgentMessage = {
    kind: 'compaction_summary',
    id: `${latestCompaction.id}:summary`,
    createdAt: latestCompaction.createdAt,
    persistence: 'transient',
    visibility: 'visible',
    summary: latestCompaction.summary,
    compactionEntryId: latestCompaction.id,
    tokensBefore: latestCompaction.tokensBefore,
    tokensAfter: latestCompaction.tokensAfter,
  };

  return {
    messages: [summaryMessage, ...retainedMessages],
    compaction: latestCompaction,
    warnings: [],
  };
}

const PLACEMENT_ORDER: Readonly<Record<ContextContributionPlacement, number>> = {
  'stable-prefix': 0,
  'history-prefix': 1,
  'before-current-user': 2,
  tail: 3,
};

const TARGET_ORDER: Readonly<Record<ContextContributionTarget, number>> = {
  system: 0,
  messages: 1,
  metadata: 2,
  tools: 3,
};

const TOOL_SOURCE_ORDER: Readonly<Record<ToolSurfaceSource, number>> = {
  builtin: 0,
  mcp: 1,
  discovered: 2,
  mode: 3,
  custom: 4,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareAppliedContributions(
  left: AppliedContextContribution,
  right: AppliedContextContribution,
): number {
  return (
    PLACEMENT_ORDER[left.placement] - PLACEMENT_ORDER[right.placement] ||
    TARGET_ORDER[left.target] - TARGET_ORDER[right.target] ||
    left.contributorOrder - right.contributorOrder ||
    left.order - right.order ||
    compareText(left.contributorId, right.contributorId) ||
    compareText(left.contributionId, right.contributionId) ||
    compareText(left.fingerprint, right.fingerprint)
  );
}

function compareCollectedContributions<
  TCustom extends AgentCustomMessage,
  TTool,
>(
  left: CollectedContextContribution<TCustom, TTool>,
  right: CollectedContextContribution<TCustom, TTool>,
): number {
  const leftContribution = left.contribution;
  const rightContribution = right.contribution;
  return (
    PLACEMENT_ORDER[leftContribution.placement] -
      PLACEMENT_ORDER[rightContribution.placement] ||
    TARGET_ORDER[leftContribution.target] - TARGET_ORDER[rightContribution.target] ||
    left.contributorOrder - right.contributorOrder ||
    (leftContribution.order ?? 0) - (rightContribution.order ?? 0) ||
    compareText(left.contributorId, right.contributorId) ||
    compareText(leftContribution.id, rightContribution.id) ||
    compareText(leftContribution.fingerprint, rightContribution.fingerprint)
  );
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

function toAppliedContribution<
  TCustom extends AgentCustomMessage,
  TTool,
>(
  collected: CollectedContextContribution<TCustom, TTool>,
): AppliedContextContribution {
  const { contributorId, contributorOrder, contribution } = collected;
  return Object.freeze({
    key: `${contributorId}:${contribution.id}`,
    contributorId,
    contributionId: contribution.id,
    target: contribution.target,
    placement: contribution.placement,
    cacheScope: contribution.cacheScope,
    fingerprint: contribution.fingerprint,
    contributorOrder,
    order: contribution.order ?? 0,
  });
}

export function buildCachePlan(
  contributions: readonly AppliedContextContribution[],
): CachePlan {
  const entries = contributions
    .filter((contribution) => contribution.cacheScope !== 'none')
    .sort(compareAppliedContributions)
    .map((contribution): CachePlanEntry => {
      const cacheKey = [
        contribution.cacheScope,
        contribution.target,
        contribution.placement,
        contribution.key,
        contribution.fingerprint,
      ].join(':');
      return Object.freeze({ ...contribution, cacheKey });
    });

  const planSource = entries.map((entry) => entry.cacheKey).join('|');
  const stablePrefixSource = entries
    .filter((entry) => entry.placement === 'stable-prefix')
    .map((entry) => entry.cacheKey)
    .join('|');

  return Object.freeze({
    version: 1,
    fingerprint: `cache-v1-${stableFingerprint(planSource)}`,
    stablePrefixFingerprint: stablePrefixSource
      ? `cache-v1-${stableFingerprint(stablePrefixSource)}`
      : undefined,
    entries: freezeArray(entries),
  });
}

function placeContextMessages<TCustom extends AgentCustomMessage, TTool>(
  history: readonly AgentMessage<TCustom>[],
  contributions: readonly CollectedContextContribution<TCustom, TTool>[],
): readonly AgentMessage<TCustom>[] {
  const messageBuckets: Record<
    ContextContributionPlacement,
    AgentMessage<TCustom>[]
  > = {
    'stable-prefix': [],
    'history-prefix': [],
    'before-current-user': [],
    tail: [],
  };

  for (const collected of contributions) {
    const contribution = collected.contribution;
    if (contribution.target === 'messages') {
      messageBuckets[contribution.placement].push(...contribution.messages);
    }
  }

  let currentUserIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.kind === 'user') {
      currentUserIndex = index;
      break;
    }
  }

  const historyBeforeCurrentUser = currentUserIndex >= 0
    ? history.slice(0, currentUserIndex)
    : history;
  const currentUserAndSuffix = currentUserIndex >= 0
    ? history.slice(currentUserIndex)
    : [];

  return freezeArray([
    ...messageBuckets['stable-prefix'],
    ...messageBuckets['history-prefix'],
    ...historyBeforeCurrentUser,
    ...messageBuckets['before-current-user'],
    ...currentUserAndSuffix,
    ...messageBuckets.tail,
  ]);
}

function formatContributorError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function buildModelContextSnapshot<
  TCustom extends AgentCustomMessage = never,
  TTool = unknown,
  TContext = unknown,
>(
  projection: AgentContextProjection<TCustom>,
  contributors: readonly ContextContributor<TCustom, TTool, TContext>[],
  options: BuildModelContextOptions<TContext>,
): Promise<ModelContextSnapshot<TCustom, TTool>> {
  const warnings: ModelContextWarning[] = projection.warnings.map((message) =>
    Object.freeze({ code: 'projection-warning' as const, message }),
  );
  const collectedContributions: CollectedContextContribution<TCustom, TTool>[] = [];
  const request: Readonly<ContextContributorRequest<TCustom, TContext>> =
    Object.freeze({
      requestId: options.requestId,
      projection: Object.freeze({
        messages: freezeArray(projection.messages),
        compaction: projection.compaction,
        warnings: freezeArray(projection.warnings),
      }),
      context: options.context,
    });
  const orderedContributors = [...contributors].sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || compareText(left.id, right.id),
  );

  for (const contributor of orderedContributors) {
    try {
      const contributions = await contributor.collect(request);
      for (const contribution of contributions) {
        collectedContributions.push({
          contributorId: contributor.id,
          contributorOrder: contributor.order ?? 0,
          contribution,
        });
      }
    } catch (error) {
      warnings.push(Object.freeze({
        code: 'contributor-failed',
        contributorId: contributor.id,
        message: `Context contributor ${contributor.id} failed: ${formatContributorError(error)}`,
      }));
    }
  }

  collectedContributions.sort(compareCollectedContributions);

  const uniqueContributions: CollectedContextContribution<TCustom, TTool>[] = [];
  const contributionKeys = new Set<string>();
  for (const collected of collectedContributions) {
    const key = `${collected.contributorId}:${collected.contribution.id}`;
    if (contributionKeys.has(key)) {
      warnings.push(Object.freeze({
        code: 'duplicate-contribution',
        contributorId: collected.contributorId,
        message: `Duplicate context contribution ignored: ${key}`,
      }));
      continue;
    }
    contributionKeys.add(key);
    uniqueContributions.push(collected);
  }

  const systemSegments: PromptSegment[] = [];
  const metadataSegments: MetadataSegment[] = [];
  const toolItems: ToolSurfaceItem<TTool>[] = [];
  const toolIds = new Set<string>();

  for (const collected of uniqueContributions) {
    const contribution = collected.contribution;
    if (contribution.target === 'system') {
      systemSegments.push(Object.freeze({
        id: contribution.id,
        contributorId: collected.contributorId,
        placement: contribution.placement,
        content: Array.isArray(contribution.content)
          ? freezeArray(contribution.content)
          : contribution.content,
      }));
      continue;
    }
    if (contribution.target === 'metadata') {
      metadataSegments.push(Object.freeze({
        id: contribution.id,
        contributorId: collected.contributorId,
        placement: contribution.placement,
        metadata: Object.freeze({ ...contribution.metadata }),
      }));
      continue;
    }
    if (contribution.target !== 'tools') {
      continue;
    }

    const orderedTools = [...contribution.tools].sort(
      (left, right) =>
        (left.order ?? 0) - (right.order ?? 0) ||
        TOOL_SOURCE_ORDER[left.source] - TOOL_SOURCE_ORDER[right.source] ||
        compareText(left.id, right.id) ||
        compareText(left.fingerprint, right.fingerprint),
    );
    for (const tool of orderedTools) {
      if (toolIds.has(tool.id)) {
        warnings.push(Object.freeze({
          code: 'duplicate-tool',
          contributorId: collected.contributorId,
          message: `Duplicate tool surface item ignored: ${tool.id}`,
        }));
        continue;
      }
      toolIds.add(tool.id);
      toolItems.push(Object.freeze({ ...tool }));
    }
  }

  const appliedContributions = freezeArray(
    uniqueContributions.map(toAppliedContribution),
  );
  const snapshot: ModelContextSnapshot<TCustom, TTool> = {
    requestId: options.requestId,
    systemSegments: freezeArray(systemSegments),
    messages: placeContextMessages(projection.messages, uniqueContributions),
    metadataSegments: freezeArray(metadataSegments),
    tools: Object.freeze({ items: freezeArray(toolItems) }),
    cachePlan: buildCachePlan(appliedContributions),
    appliedContributions,
    warnings: freezeArray(warnings),
    compaction: projection.compaction,
  };

  return Object.freeze(snapshot);
}

export function toModelMessages<TCustom extends AgentCustomMessage = never>(
  messages: readonly AgentMessage<TCustom>[],
  projectCustom?: CustomMessageProjector<TCustom>,
): Message[] {
  const result: Message[] = [];

  for (const message of messages) {
    if (message.kind === 'user') {
      result.push({
        id: message.id,
        role: 'user',
        content: message.content,
        displayContent: message.displayContent,
        attachments: message.attachments ? [...message.attachments] : undefined,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'assistant') {
      result.push({
        id: message.id,
        role: 'assistant',
        content: message.content,
        providerId: message.providerId,
        model: message.model,
        tokenUsage: message.tokenUsage,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'tool_result') {
      result.push({
        id: message.id,
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: message.toolCallId,
          content: message.content,
          is_error: message.isError,
        }],
        name: message.toolName,
        tool_call_id: message.toolCallId,
        timestamp: message.createdAt,
      });
      continue;
    }

    if (message.kind === 'runtime_context') {
      if (message.includeInModel) {
        result.push({
          id: message.id,
          role: 'user',
          content: message.content,
          timestamp: message.createdAt,
          metadata: {
            runtimeContext: true,
            source: message.source,
          },
        });
      }
      continue;
    }

    if (message.kind === 'compaction_summary') {
      result.push({
        id: message.id,
        role: 'user',
        content: [
          'Another agent continued this task and produced the following context summary.',
          'Use it as prior context without repeating completed work.',
          '',
          message.summary,
        ].join('\n'),
        timestamp: message.createdAt,
        isCompactSummary: true,
        compactBoundaryId: message.compactionEntryId,
      });
      continue;
    }

    const customMessage = message as TCustom;
    if (!isCustomAgentMessage(customMessage) || !customMessage.includeInModel) {
      continue;
    }
    if (!projectCustom) {
      continue;
    }

    const projected = projectCustom(customMessage);
    if (Array.isArray(projected)) {
      result.push(...projected);
    } else if (projected) {
      result.push(projected as Message);
    }
  }

  return result;
}

export class MessageTimeline<TCustom extends AgentCustomMessage = never> {
  private readonly timeline: MessageTimelineEntry<TCustom>[];
  private readonly entryIds: Set<string>;
  private readonly messageIds: Set<string>;

  constructor(entries: readonly MessageTimelineEntry<TCustom>[] = []) {
    this.timeline = [];
    this.entryIds = new Set();
    this.messageIds = new Set();
    for (const entry of entries) {
      this.appendEntry(entry);
    }
  }

  appendMessage(entry: MessageEntry<TCustom>): void {
    this.appendEntry(entry);
  }

  appendCompaction(entry: CompactionEntry): void {
    this.appendEntry(entry);
  }

  snapshot(): readonly MessageTimelineEntry<TCustom>[] {
    return [...this.timeline];
  }

  buildContext(): AgentContextProjection<TCustom> {
    return buildAgentContext(this.timeline);
  }

  private appendEntry(entry: MessageTimelineEntry<TCustom>): void {
    if (this.entryIds.has(entry.id)) {
      throw new Error(`Duplicate timeline entry id: ${entry.id}`);
    }
    if (entry.type === 'message' && this.messageIds.has(entry.message.id)) {
      throw new Error(`Duplicate agent message id: ${entry.message.id}`);
    }

    this.timeline.push(entry);
    this.entryIds.add(entry.id);
    if (entry.type === 'message') {
      this.messageIds.add(entry.message.id);
    }
  }
}
