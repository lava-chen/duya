/** Raw rows received through the existing worker mailbox IPC bridge. */
export type MailboxKind = 'queued' | 'followup' | 'background_notification' | 'agent_dm';
export type MailboxStatus = 'pending' | 'observed' | 'applied' | 'cancelled';
export type MailboxApplyMode = 'promote_to_user_message' | 'runtime_instruction' | 'tool_guard'
  | 'permission_context' | 'interrupt_signal' | 'deferred_to_next_turn';

export interface MailboxRow {
  id: string;
  session_id: string;
  submitted_during_run_id: string;
  content: string;
  kind: MailboxKind;
  status: MailboxStatus;
  priority: number;
  constraints_json: string | null;
  attachments_json: string | null;
  source: string;
  client_msg_id: string | null;
  created_at: number;
  claim_token: string | null;
  claim_expires_at: number | null;
  observed_at: number | null;
  observed_at_checkpoint: string | null;
  observed_by_run_id: string | null;
  injected_run_id: string | null;
  claim_attempts: number;
  last_claim_error: string | null;
  edit_locked_at: number | null;
  apply_mode: MailboxApplyMode | null;
  applied_at: number | null;
  applied_at_checkpoint: string | null;
  applied_summary: string | null;
  resulting_user_msg_id: string | null;
  failure_reason: string | null;
  edit_history_json: string | null;
  cancelled_at: number | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
}
