# 233 - Conductor Multi-Canvas Management

> **Status**: In progress | **Priority**: P0 | **Created**: 2026-07-17
>
> **Depends on**: [221-conductor-main-agent-injection](./221-conductor-main-agent-injection.md)

## Goal

Give the main Agent explicit awareness of the canvas bound to its session and
safe tools to list, create, switch, and rename canvases. A switch must update
the durable session binding and the visible sidebar target, not only one tool
call.

## Checklist

- [x] Add one compact canvas-management tool with current/list/create/switch/rename/delete operations. `delete` was added in plan 240; plan 233 originally landed get_current / list / create / switch / rename.
- [x] Keep the active canvas ID in shared tool-call state so later calls in the same turn use the switched target. `CanvasTargetState.canvasId` is mutated in `CanvasManageTool.executor.execute` after each switch.
- [x] Persist target changes to `chat_sessions.conductor_canvas_id`. `ConductorExecutorProxy.bindSessionToCanvas` writes the `conductor_canvas_id` extension on switch / create.
- [x] Notify the renderer so the conversation store and visible Conductor panel follow Agent switches. `CanvasManagementChangedFn` + `useCanvasManagement` hook (plan 240) wires `conductor:canvas:changed` into `useConductorStore`.
- [x] Add multi-canvas management rules to the Conductor prompt.
- [x] Add tool, prompt, executor, and UI regression coverage. `electron/conductor/executor-proxy.test.ts` (27 tests) covers create / switch / rename / delete + project-binding guard + name addressing. `packages/agent/src/tool/CanvasConductor/CanvasManageTool.test.ts` (16 tests, new) covers payload assembly for all six actions.
- [x] Update `ARCHITECTURE.md` and run the required verification gates. Section "Conductor multi-canvas target contract (Plan 233)" now lists all six actions and documents `canvasId` / `name` addressing with `INVALID_INPUT` / `NOT_FOUND` / `AMBIGUOUS_TARGET` / `PROJECT_HAS_CANVAS` error codes.

## Plan 233 follow-up changes

This plan originally landed the five core actions; plan 240 added `delete`. The follow-up commits in this plan add three behavior improvements that surfaced after the original roll-out:

1. **Per-action payload validation** (`CanvasManageTool.executor.execute`). The earlier code used four sequential `if` blocks that all re-assembled the same payload object — that made the `canvasId` vs `name` rules ambiguous and let `delete` slip past the action enum. Replaced with a `switch (action)` block: each action declares exactly which fields it accepts and which are mutually exclusive. `rename` no longer accepts `name` as a lookup key (the field is overloaded: `name` is the *new* label, target addressing is `canvasId`-only).
2. **`canvasId` / `name` addressing for switch / delete** (and `canvasId`-only for `rename`). Previously the tool only accepted `canvasId`, forcing a separate `list` round-trip to discover the id. New behavior: `switch` and `delete` accept either; when both are supplied `canvasId` wins.
3. **`PROJECT_HAS_CANVAS` error for `create`**. Project-bound canvases are 1:1 with a project path, so `createCanvas` in the DB layer silently returns the existing project canvas when one is bound — from the agent's perspective that looked like a successful no-op with the wrong name. The executor now returns a clear `PROJECT_HAS_CANVAS` error pointing at the existing canvas.

### Verification

- `npx vitest run electron/conductor/executor-proxy.test.ts` — 27 / 27 passing (10 new tests added for project-binding guard + name addressing).
- `npx vitest run packages/agent/src/tool/CanvasConductor/CanvasManageTool.test.ts` — 16 / 16 passing (new file).
- `npm run typecheck:all` — the single pre-existing baseline failure (`MarketplacePage.tsx:266` `displayName_zh` missing) is in unrelated user-tree work and not caused by this plan.

## Plan 233 prompt follow-up (Pre-Drawing Canvas Check)

Original plan 233 + plan 240 fixed the *protocol*: every `canvas_manage`
action now has unambiguous `canvasId` / `name` semantics, the create-vs-project-bound
guard returns `PROJECT_HAS_CANVAS`, and the LLM-side enum cannot drift.
This follow-up makes the model actually *use* the new affordances before
the first element tool call in a turn, in `packages/agent/src/tool/CanvasConductor/prompt.ts`,
by adding a "Pre-Drawing Canvas Check" section that:

1. Calls `canvas_manage action=get_current` to read the current canvas
   name + description. A generic name ("Untitled", "Workbench", "新建画布")
   is treated as a signal to `rename` or proceed carefully.
2. Calls `canvas_get_context` or `canvas_list_elements` to inspect the
   layout. `canvas_find_empty_space` is offered as the one-call shortcut
   when only an empty spot is needed.
3. Applies a three-way rule to decide where to draw:
   - **Stay** on the current canvas when the content shares topic / audience / deliverable.
   - **Switch** to a different existing canvas when another canvas already matches.
   - **Create** a new canvas (with a concise purpose-based name) when none matches.
4. Narrates the chosen canvas in one user-facing line so the user sees
   where new elements will land.

The new section explicitly warns about the `switchTo=false` footgun: if the
model deliberately disables auto-switch on create, it must follow up with
`canvas_manage action=switch` before drawing. The Quick Reference line in
"Available Tools" was updated to spell out the default and the override.

The section is framed as a precondition of the existing "no overlap" rule:
without the check, the model cannot know what is already on the canvas
and so cannot honor overlap avoidance.

### Prompt guard tests

`packages/agent/src/tool/CanvasConductor/prompt.test.ts` (new, 9 tests)
asserts that the prompt retains:
- the section heading;
- the get_current + layout-inspection first steps;
- the three bold verbs (Stay / Switch / Create);
- the `switchTo=false` follow-up warning;
- the user-facing narration directive;
- the precondition framing.

Tests catch drift: editing the prompt to remove the `switchTo=false`
warning or to drop one of the three verbs fails the suite, forcing a
deliberate decision.
