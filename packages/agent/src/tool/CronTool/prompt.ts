export const DESCRIPTION = `Manage DUYA automation cron jobs from agent conversations.

Supported actions:
- status: show summarized scheduler/job stats
- list: list cron jobs
- add/create: create a cron job
- update: update a cron job
- remove/delete: delete a cron job
- run: manually run a cron job now
- runs: list run history for a cron job

Notes:
- Phase 1 only supports isolated session execution.
- Delivery mode is fixed to none (run history only).
- OpenClaw-style inputs are accepted for add/update:
  - schedule.cron or schedule.expr -> schedule.cronExpr
  - payload.message/payload.text -> prompt
`;

export function getPrompt(): string {
  return DESCRIPTION;
}
