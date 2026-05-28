export const DESCRIPTION = `Manage DUYA automation cron jobs from agent conversations.

Supported actions:
- status: show summarized scheduler/job stats
- list: list cron jobs
- add/create: create a cron job. Required fields: name, schedule, prompt, model. The model must match an available model from the active LLM provider (ask user or check config).
  - schedule must have kind ("at" | "every" | "cron"):
    * kind="at": { kind: "at", at: "ISO8601 datetime" }
    * kind="every": { kind: "every", everyMs: <milliseconds> }
    * kind="cron": { kind: "cron", cronExpr: "<cron expression>" }
  - Example: cron({ action: "create", cron: { name: "daily-news", schedule: { kind: "cron", cronExpr: "0 7 * * *" }, prompt: "Collect morning news", model: "gpt-4o", enabled: true } })
- update: update a cron job. Requires id/jobId/cronId + patch payload
- remove/delete: delete a cron job. Requires id/jobId/cronId
- run: manually run a cron job now. Requires id/jobId/cronId
- runs: list run history for a cron job. Requires id/jobId/cronId

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
