import type { ApprovalLedger } from './TurnContext.js';

/** Only the turn assembly inputs, without provider or product service options. */
export interface TurnAssemblyOptions {
  turnId?: string | null | undefined;
  approvedAlwaysAllowTools?: readonly string[] | undefined;
  consumeApprovedEffect?: ApprovalLedger['consumeApprovedEffect'] | undefined;
  mentionedProviders?: string | string[] | undefined;
  mentionedSkills?: readonly string[] | undefined;
  mentionedPlugins?: readonly { name: string }[] | undefined;
}
