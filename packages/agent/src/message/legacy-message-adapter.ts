import type { Message, MessageContent, ToolResultContent } from '../types.js';
import type {
  AgentCustomMessage,
  AgentMessage,
  AgentMessageContent,
  RuntimeContextSource,
} from './message-framework.js';

/**
 * Lossless bridge for the incremental migration from the legacy provider
 * `Message` record to the Agent message domain.
 *
 * Each adapted message keeps a private, cloned legacy envelope in a
 * non-enumerable module-private Symbol sidecar.
 * `agentMessageToLegacyMessage()` restores from that envelope instead of
 * rebuilding from the reduced Agent shape. This deliberately preserves fields
 * the new domain does not model yet, including provider response state and
 * unknown metadata. Messages not created by this adapter cannot be restored
 * losslessly and are rejected rather than silently degraded.
 */

const LEGACY_ENVELOPE = Symbol('duya.legacy-message-adapter');

type LegacyMessageSnapshot = Readonly<Message & Record<string, unknown>>;

interface LegacyMessageEnvelope {
  readonly version: 1;
  readonly message: LegacyMessageSnapshot;
}

interface LegacySystemPayload {
  readonly content: AgentMessageContent;
  readonly name?: string;
}

interface LegacyCompactionBoundaryPayload {
  readonly compactBoundaryId?: string;
}

interface LegacyUnknownRolePayload {
  readonly role: string;
  readonly content: AgentMessageContent;
}

export type LegacySystemAgentMessage = AgentCustomMessage<
  'legacy-system',
  LegacySystemPayload
>;

export type LegacyCompactionBoundaryAgentMessage = AgentCustomMessage<
  'legacy-compaction-boundary',
  LegacyCompactionBoundaryPayload
>;

export type LegacyUnknownRoleAgentMessage = AgentCustomMessage<
  'legacy-unknown-role',
  LegacyUnknownRolePayload
>;

export type LegacyCustomAgentMessage =
  | LegacySystemAgentMessage
  | LegacyCompactionBoundaryAgentMessage
  | LegacyUnknownRoleAgentMessage;

export type LegacyAgentMessage = AgentMessage<LegacyCustomAgentMessage>;

export interface LegacyMessageAdapterOptions {
  /**
   * Used only to derive stable synthetic Agent ids for legacy rows that do not
   * have an id. It never changes the restored legacy record.
   */
  readonly index?: number;
}

interface AgentMessageBaseFields {
  id: string;
  createdAt: number;
  visibility: 'visible' | 'hidden';
  metadata: Readonly<Record<string, unknown>>;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function snapshotLegacyMessage(message: Message): LegacyMessageSnapshot {
  return cloneValue(message) as LegacyMessageSnapshot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getEnvelope(value: unknown): LegacyMessageEnvelope | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.message)) {
    return undefined;
  }

  return value as unknown as LegacyMessageEnvelope;
}

function getLegacyEnvelope(message: LegacyAgentMessage): LegacyMessageEnvelope | undefined {
  return getEnvelope((message as unknown as Record<PropertyKey, unknown>)[LEGACY_ENVELOPE]);
}

/**
 * Brand predicate: true when the message carries a legacy adapter envelope.
 * Used by message-projectors to distinguish adapter-produced messages.
 */
export function hasLegacyEnvelope(message: unknown): message is LegacyAgentMessage {
  return getEnvelope((message as unknown as Record<PropertyKey, unknown>)[LEGACY_ENVELOPE]) !== undefined;
}

function isRuntimeMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.runtimeContext === true;
}

function runtimeSource(message: Message): RuntimeContextSource | undefined {
  const type = message.msg_type?.toLowerCase();
  if (type === 'mailbox' || type === 'runtime_context') return 'mailbox';
  if (type === 'task-notification' || type === 'task_notification') {
    return 'background_notification';
  }
  if (type === 'attachment') return 'attachment';
  if (type === 'mode' || type === 'mode_changed') return 'mode';
  if (type === 'memory') return 'memory';
  if (isRuntimeMetadata(message.metadata)) return 'custom';
  return undefined;
}

function contentToText(content: AgentMessageContent): string {
  if (typeof content === 'string') return content;

  return content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return block.thinking;
    if (block.type === 'tool_result') {
      return contentToText(block.content);
    }
    return JSON.stringify(block);
  }).join('\n');
}

function findToolResult(content: AgentMessageContent): ToolResultContent | undefined {
  if (!Array.isArray(content)) return undefined;
  return content.find((block): block is ToolResultContent => block.type === 'tool_result');
}

function adapterMetadata(message: Message): Readonly<Record<string, unknown>> {
  const metadata = message.metadata ? cloneValue(message.metadata) : {};
  return Object.freeze({ ...metadata });
}

function baseFields(
  message: Message,
  index: number,
): AgentMessageBaseFields {
  const source = runtimeSource(message);
  return {
    id: message.id || `legacy-message-${index}`,
    createdAt: message.timestamp ?? 0,
    visibility: source === 'mailbox' || source === 'background_notification' || source === 'attachment'
      ? 'hidden'
      : 'visible',
    metadata: adapterMetadata(message),
  };
}

function createSystemMessage(
  base: AgentMessageBaseFields,
  message: Message,
  content: AgentMessageContent,
): LegacySystemAgentMessage {
  return {
    ...base,
    kind: 'custom:legacy-system',
    payload: {
      content,
      name: message.name,
    },
  };
}

function createCompactionBoundaryMessage(
  base: AgentMessageBaseFields,
  message: Message,
): LegacyCompactionBoundaryAgentMessage {
  return {
    ...base,
    kind: 'custom:legacy-compaction-boundary',
    payload: { compactBoundaryId: message.compactBoundaryId },
  };
}

function createUnknownRoleMessage(
  base: AgentMessageBaseFields,
  message: Message,
  content: AgentMessageContent,
): LegacyUnknownRoleAgentMessage {
  return {
    ...base,
    kind: 'custom:legacy-unknown-role',
    payload: {
      role: String((message as Message & Record<string, unknown>).role),
      content,
    },
  };
}

function attachLegacyEnvelope<T extends LegacyAgentMessage>(
  message: T,
  envelope: LegacyMessageEnvelope,
): T {
  Object.defineProperty(message, LEGACY_ENVELOPE, {
    value: envelope,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return message;
}

/**
 * Converts one legacy Message to a semantically useful AgentMessage while
 * retaining a lossless legacy envelope for reverse conversion.
 */
export function legacyMessageToAgentMessage(
  message: Message,
  options: LegacyMessageAdapterOptions = {},
): LegacyAgentMessage {
  const index = options.index ?? 0;
  const envelope: LegacyMessageEnvelope = Object.freeze({
    version: 1,
    message: snapshotLegacyMessage(message),
  });
  const base = baseFields(message, index);
  const content = cloneValue(message.content);

  if (message.isCompactBoundary) {
    return attachLegacyEnvelope(createCompactionBoundaryMessage(base, message), envelope);
  }

  if (message.isCompactSummary) {
    return attachLegacyEnvelope({
      ...base,
      kind: 'compaction_summary',
      summary: contentToText(content),
      compactionEntryId: message.compactBoundaryId ?? base.id,
      tokensBefore: message.compactedMessageCount ?? 0,
    }, envelope);
  }

  if (message.role === 'system') {
    return attachLegacyEnvelope(createSystemMessage(base, message, content), envelope);
  }

  const source = runtimeSource(message);
  if (source) {
    return attachLegacyEnvelope({
      ...base,
      kind: 'runtime_context',
      source,
      content,
    }, envelope);
  }

  if (message.role === 'user') {
    return attachLegacyEnvelope({
      ...base,
      kind: 'user',
      content,
      displayContent: message.displayContent !== undefined
        ? cloneValue(message.displayContent)
        : undefined,
      attachments: message.attachments ? cloneValue(message.attachments) : undefined,
    }, envelope);
  }

  if (message.role === 'assistant') {
    const record = message as Message & Record<string, unknown>;
    return attachLegacyEnvelope({
      ...base,
      kind: 'assistant',
      content,
      providerId: message.providerId,
      model: message.model,
      tokenUsage: message.tokenUsage ? cloneValue(message.tokenUsage) : undefined,
      stopReason: typeof record.stopReason === 'string' ? record.stopReason : undefined,
    }, envelope);
  }

  if (message.role === 'tool') {
    const toolResult = findToolResult(content);
    return attachLegacyEnvelope({
      ...base,
      kind: 'tool_result',
      toolCallId: message.tool_call_id ?? toolResult?.tool_use_id ?? `legacy-tool-call-${index}`,
      toolName: message.name ?? message.tool_name ?? 'legacy-tool',
      content: toolResult ? cloneValue(toolResult.content) : content,
      isError: toolResult?.is_error === true || message.status === 'error',
    }, envelope);
  }

  return attachLegacyEnvelope(createUnknownRoleMessage(base, message, content), envelope);
}

/**
 * Converts a legacy history without mutating either the input array or any
 * input message. Missing legacy ids receive deterministic, index-based Agent
 * ids solely for the duration of the migration.
 */
export function legacyMessagesToAgentMessages(
  messages: readonly Message[],
): LegacyAgentMessage[] {
  return messages.map((message, index) => legacyMessageToAgentMessage(message, { index }));
}

/**
 * Restores the exact legacy record from an adapter-produced AgentMessage.
 *
 * This throws for a native AgentMessage because there is no original legacy
 * record to restore; silently reconstructing one would violate the adapter's
 * lossless round-trip contract.
 */
export function agentMessageToLegacyMessage(message: LegacyAgentMessage): Message {
  const envelope = getLegacyEnvelope(message);
  if (!envelope) {
    throw new Error('Cannot losslessly restore a legacy Message without an adapter envelope');
  }

  return cloneValue(envelope.message) as Message;
}

export function agentMessagesToLegacyMessages(
  messages: readonly LegacyAgentMessage[],
): Message[] {
  return messages.map(agentMessageToLegacyMessage);
}
