import type { HostLocalImageAttachment, HostLocalParsedDocument } from '@duya/agent-protocol/session-api';
import type { WorkerSubagentMessageRow } from '../worker-subagents/transcript.js';

/** Main-worker transcript fields consumed by messageRowToMessage. */
export type WorkerSessionMessageRow = Pick<
  WorkerSubagentMessageRow,
  | 'id'
  | 'role'
  | 'content'
  | 'display_content'
  | 'name'
  | 'tool_call_id'
  | 'token_usage'
  | 'msg_type'
  | 'thinking'
  | 'tool_name'
  | 'tool_input'
  | 'parent_tool_call_id'
  | 'viz_spec'
  | 'status'
  | 'seq_index'
  | 'duration_ms'
  | 'sub_agent_id'
  | 'attachments'
  | 'created_at'
  | 'reply_to_id'
  | 'branched'
>;

/** Local Host attachment projections consumed when restoring worker history. */
export type WorkerSessionParsedDocumentRow = HostLocalParsedDocument;
export type WorkerSessionImageAttachmentRow = HostLocalImageAttachment;
