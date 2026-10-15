import type { HostMessageItem } from '@duya/agent-protocol';
import { getDesktopHostSessionApi } from '../cli/desktop-host-api';
import { hostMessageItemsToIpcMessages, type MessageRow } from '../ipc/core-db-adapters';

/** Read the complete local session projection through Host and retain IPC message semantics. */
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
