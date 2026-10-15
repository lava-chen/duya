export { collectRecentImageAttachments, computeCachePlanFingerprint, buildAgentIdentityBlock } from '@duya/agent-core/message/agent-helpers';
import { extractTextFromContent, lastRealUserQuery, lastAssistantTextOf, persistableMessages } from '@duya/agent-core/message/agent-helpers';
export { extractTextFromContent, lastRealUserQuery, lastAssistantTextOf, persistableMessages } from '@duya/agent-core/message/agent-helpers';
/**
 * Pure helpers extracted from DuyaAgent.ts. Each function is self-contained
 * (no `this` dependency) and may be reused by other modules.
 */
import type { AgentProfile } from '@duya/agent-core';
import type { MailboxApplyMode, MailboxRow } from '../worker-mailbox-row.js';
import type {
  FileAttachment,
  Message,
  MessageContent,
  Tool,
} from '../worker-run-contracts.js';
import { adaptAutoContinueContext } from '../worker-context/runtime-context-adapters.js';
import { projectRuntimeContextToProviderMessage } from '@duya/agent-core/message/message-projectors';

/** Empty set used by _resolveTools (no tools discovered yet at startup). */
export const EMPTY_DISCOVERED: ReadonlySet<string> = new Set();

export type RuntimeMailboxDecision =
  | { action: 'continue'; absorbed: boolean }
  | { action: 'soft_stop'; summary: string }
  | { action: 'hard_replace'; replacement: string };

export interface RuntimeMailboxClaim {
  rows: MailboxRow[];
  claimTokens: string[];
}

/**
 * Push a transient AutoContinue directive onto the working message array.
 * Called right after a successful compaction so the next LLM call reads the
 * summary and keeps working instead of stopping or re-summarising. Mirrors
 * grok's `AutoContinue`. The message is excluded from persistence by
 * {@link persistableMessages} (source='auto_continue').
 */
export function appendAutoContinueMessage(messages: Message[]): void {
  messages.push(
    projectRuntimeContextToProviderMessage(
      adaptAutoContinueContext(
        'Context compaction completed — continue working on the active task using the summary context above. Do not stop or summarize; keep making progress toward completing the request.',
      ),
    ),
  );
}

export function chooseMailboxApplyMode(_row: MailboxRow): MailboxApplyMode {
  return 'runtime_instruction';
}
