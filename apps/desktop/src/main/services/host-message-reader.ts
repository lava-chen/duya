import type { HostMessageItem } from '@duya/agent-protocol';
import { getDesktopHostSessionApi } from '../cli/desktop-host-api';
import { hostMessageItemsToIpcMessages, type MessageRow } from '../ipc/core-db-adapters';

/**
 * Read the complete local session projection through Host and retain IPC message semantics.
 *
 * `includeSuperseded: true` is load-bearing here, not a default to be
 * "corrected": it is the chat-history projection (plan 548), which keeps
 * every raw row plus a CompactSummary card at each compaction point so a
 * rebase or a compaction does not make earlier turns vanish from the
 * transcript. The LLM-visible projection (`includeSuperseded: false`, which
 * folds superseded rows out — see `packages/data/src/message-log.ts`) is the
 * correct one for TOKEN ACCOUNTING, not for this view.
 *
 * Anything that sums token usage from these rows must therefore not assume
 * "the rows the desktop shows" equals "the rows the model was sent". The CLI
 * TUI mirrors the same distinction (`packages/cli/src/tui/slash/shared.ts`,
 * `HistoryView`). The desktop token ring currently reads the history
 * projection, which means a rebased session can over-count there — fixing it
 * means splitting the renderer's load in two, which is a renderer change, not
 * a constant flip.
 */
export async function readHostMessageRows(sessionId: string): Promise<MessageRow[]> {
  const api = getDesktopHostSessionApi();
  const items: HostMessageItem[] = [];
  let cursor: string | undefined;

  do {
    const page = await api.readMessages(sessionId, {
      includeSuperseded: true,
      limit: 200,
      ...(cursor === undefined ? {} : { cursor }),
    });
    items.push(...page.messages);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);

  return hostMessageItemsToIpcMessages(sessionId, items);
}
