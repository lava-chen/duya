/**
 * Restoring a session's history.
 *
 * ## What moved and why
 *
 * This used to be `packages/host/src/worker-session-history.ts`. The
 * implementation was already port-shaped — it took a set of operations and
 * never touched a database — so the only thing keeping it in the Host was the
 * name.
 *
 * The name was the problem. "Worker" is the name of the PROCESS that used to
 * host this, not the name of the thing being restored. There is one history
 * per session, and the process that happens to restore it (a worker today, a
 * headless runner tomorrow) is an implementation detail of the restore. A
 * second history vocabulary would be a second authority, which is the exact
 * outcome this migration is removing.
 *
 * ## The behaviour is unchanged, deliberately
 *
 * Two branches below look wrong and are not. They are preserved verbatim
 * because they encode decisions that were made for reasons the code around
 * them no longer shows:
 *
 * - A failed attachment read is swallowed. The bytes of an image are not the
 *   text of the conversation; losing an attachment must not lose the turn
 *   that referenced it.
 * - Compaction checkpoint markers are excluded from the repair write-back.
 *   They are carried inline by their rebase event, so persisting one creates
 *   a duplicate row on the next load.
 *
 * Both were true before the move and both are still true. A migration that
 * quietly fixes a bug in the same diff is a migration whose failure is
 * impossible to attribute.
 */

import type {
  SessionHistory,
  SessionHistoryPorts,
  SessionHistoryRepairResult,
} from './ports.js';

/**
 * Load a session's history, restore attachment context, and persist any
 * validated repair before returning the messages to the executor.
 *
 * The message vocabulary remains supplied by the caller; the ORDERING and the
 * repair boundary belong here.
 */
export async function hydrateSessionHistory<
  Row,
  Attachment,
  ParsedDocument extends { readonly message_id: string },
  Message,
>(
  sessionId: string,
  ports: SessionHistoryPorts<Row, Attachment, ParsedDocument, Message>,
): Promise<SessionHistory<Message>> {
  const loaded = await ports.load(sessionId);
  if (loaded.messages.length === 0) {
    return { rowCount: 0, messages: [], repairAttempted: false };
  }

  let attachments: Map<string, Attachment[]> | undefined;
  try {
    attachments = await ports.loadAttachments(sessionId);
  } catch {
    // Keep legacy behavior: a failure to load attachment bytes must not prevent
    // the text/history rows from being restored.
  }

  let parsedDocuments: Map<string, ParsedDocument[]> | undefined;
  if (loaded.parsedDocuments?.length) {
    parsedDocuments = new Map<string, ParsedDocument[]>();
    for (const document of loaded.parsedDocuments) {
      const grouped = parsedDocuments.get(document.message_id) ?? [];
      grouped.push(document);
      parsedDocuments.set(document.message_id, grouped);
    }
  }

  const messages = loaded.messages.map((row) => ports.toMessage(row, attachments, parsedDocuments));
  const validated = ports.validate(messages);
  if (validated === messages) {
    return { rowCount: loaded.messages.length, messages: validated, repairAttempted: false };
  }

  // Projection-synthesized compaction checkpoint markers are already carried
  // inline by their rebase event. Re-persisting one creates a duplicate row on
  // the next load, so keep it in memory while excluding it from the replace.
  const persistable = validated.filter((message) =>
    !(ports.messageId(message) ?? '').endsWith(ports.checkpointIdSuffix),
  );
  const repairResult = await ports.replace(sessionId, persistable, 0);
  return {
    rowCount: loaded.messages.length,
    messages: validated,
    repairAttempted: true,
    repairResult,
  };
}
