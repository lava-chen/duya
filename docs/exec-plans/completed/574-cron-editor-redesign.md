# Plan 574: Cron Editor Redesign (ZCode-style detail view)

Date: 2026-09-28
Status: In Progress

## Goal

Redesign the cronjob detail editor (`AutomationView` → `CronEditModal`) to match
the reference screenshots (ZCode-style scheduled-task composer):

1. Form layout: 任务标题 input / 调度 row / 指令 textarea / composer bottom bar.
2. Schedule row: preset dropdown menu (每小时/每天/每工作日/每周/每月/自定义/仅一次)
   + "于 [time]" + GMT offset label + friendly summary + trash affordance.
3. 自定义 repeat dialog: N + unit stepper (分钟/小时/天/周) + end-repeat radio
   (永不结束 / 指定日期 + date input) + 取消/确认.
4. Bottom bar: workspace folder chip / permission-mode chip / model selector /
   reasoning-effort chip.

## Design decisions

- **New draft model, not a reshape**: `CronEditorScheduleDraft` lives beside the
  existing `ScheduleDraft` (bot routines' `CronScheduleCard` keeps the legacy
  shape — no regression on that surface). Pure functions in `cron-schedule.ts`.
- **Custom repeat mapping**: 分钟 → `*/N * * * *`; 小时 → `M */N * * *`;
  天 → `M H */N * *`; 周 → `every {N}w` (5-field cron cannot express week steps).
- **Raw preservation**: schedules that don't map structurally (e.g.
  `*/7 8-18 * * 1,3,5`, `every 90m`) round-trip untouched via
  `rawSchedule` until the user commits a structured repeat in the dialog.
- **Trash in the schedule row** = delete the whole job (edit mode only, with
  confirm). duya requires schedule-or-event-triggers, so "remove schedule only"
  is not a valid standalone state.
- **Per-cron `permissionMode` + `effort`** (new optional fields end to end):
  - vocabulary: session profile strings `default | auto | full_access`
    (worker `profileToAgentMode` maps `full_access` → bypassPermissions);
  - persisted as `permission_mode` / `effort` in cronjob.toml;
  - `createCronSessionRow` writes it into the session row (default `auto`,
    preserving today's hard-coded behavior for legacy jobs);
  - `runCronInSession` passes `effort` through `ChatRunOptions` (legacy default
    `off`); `''` (自动) maps to `off` at run time.
- Bottom-bar labels reuse composer i18n (手动审批/自动审批/完全访问, effort 低/中/高/最大).

## Phases

- [x] Phase 1: `cron-schedule.ts` editor draft model + round-trip mappers +
      summary/tz helpers
- [x] Phase 2: types (renderer mirror + electron) + `cron-file.ts` persistence
      + `agent-run.ts`/Scheduler pass-through
- [x] Phase 3: `CronEditorModal.tsx` (schedule row, custom-repeat dialog, bottom
      bar) + `AutomationView` swap
- [x] Phase 4: i18n keys (zh/en)
- [x] Phase 5: tests (editor draft round-trips) + `typecheck:all` + vitest

## Verification

- `npx vitest run src/components/automation` — green.
- `npm run typecheck:all` — green.
- Manual Electron smoke pending (open automation → edit a cron → exercise
  presets, custom dialog, save; run-now flow unchanged).
