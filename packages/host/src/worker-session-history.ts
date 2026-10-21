export interface WorkerSessionHistoryLoad<Row, ParsedDocument extends { readonly message_id: string }> {
  readonly messages: readonly Row[];
  readonly parsedDocuments?: readonly ParsedDocument[];
}

export interface WorkerSessionHistoryRepairResult {
  readonly success?: boolean;
  readonly reason?: string;
}

export interface WorkerSessionHistoryPorts<
  Row,
  Attachment,
  ParsedDocument extends { readonly message_id: string },
  Message,
> {
  readonly load: (sessionId: string) => Promise<WorkerSessionHistoryLoad<Row, ParsedDocument>>;
  readonly loadAttachments: (sessionId: string) => Map<string, Attachment[]> | Promise<Map<string, Attachment[]>>;
  readonly toMessage: (
    row: Row,
    attachments: Map<string, Attachment[]> | undefined,
    parsedDocuments: Map<string, ParsedDocument[]> | undefined,
  ) => Message;
  readonly validate: (messages: Message[]) => Message[];
  readonly messageId: (message: Message) => string | undefined;
  readonly replace: (
    sessionId: string,
    messages: readonly Message[],
    generation: number,
  ) => Promise<WorkerSessionHistoryRepairResult>;
  readonly checkpointIdSuffix: string;
}

export interface WorkerSessionHistory<Message> {
  readonly rowCount: number;
  readonly messages: Message[];
  readonly repairAttempted: boolean;
  readonly repairResult?: WorkerSessionHistoryRepairResult;
}

/**
 * Load a worker session's history, restore attachment context, and persist any
 * validated repair before returning messages to the executor. The message
 * vocabulary remains supplied by the worker adapter; Host owns the ordering
 * and persistence boundary without importing the legacy Agent model types.
 */
export async function hydrateWorkerSessionHistory<
  Row,
  Attachment,
  ParsedDocument extends { readonly message_id: string },
  Message,
>(
  sessionId: string,
  ports: WorkerSessionHistoryPorts<Row, Attachment, ParsedDocument, Message>,
): Promise<WorkerSessionHistory<Message>> {
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
