# Plan 559 — Prompt asset cleanup (bot → .hbs + dead-code sweep)

> 2026-09-21 status note: this plan subsumes the "prompt module migrate to .hbs"
> follow-ups that landed in plan 558 phase 2. The phase-2 commit
> (`6588e7d8`) is recorded here as the single landing point rather than a
> standalone plan, since the asset surgery is best reasoned about together
> with the bot-section rewrite that motivated it.

**Status**: active
**Created**: 2026-09-21
**Origin**: The prompts/ tree had accumulated structural debt — 6
orphan `.hbs` files whose corresponding section entries were gone,
zero-consumer helpers like `language-guidance.ts`, a `gateway` config
that no longer matched any current product surface, and a `bot/` directory
that still shipped legacy TS renderers for sections that had long since
moved to `.hbs` (plan 558 phase 1 already wired the framework). User
decision: do the full sweep in one batch (A: dead code + B: migrate to
.hbs), defer directory-naming restructure to plan 560.

## Problem summary

Working in `packages/agent/src/prompts/` had become a scavenger hunt:

- `language.hbs`, `output-style.hbs`, `session-search.hbs` — their
  section entries were gone from `generalConfig.sections`; the templates
  only existed on disk because nothing was cleaning them up.
- `modules/gateway-role.hbs`, `intro.hbs`, `project.hbs` — replaced by
  the unified `sections` array (plan 557), still on disk because nothing was
  cleaning them up.
- `modules/mappers/gatewayIntro.ts` — mapper for the deleted `gateway`
  config; no consumer after the config was retired.
- `configs/gateway.ts` + `gatewayConfig.test.ts` + the `gateway`
  registry entry — gateway product surface is gone, but the config and
  its tests were still being registered.
- `language-guidance.ts` — sole import was a dead dangling reference
  inside `HbsPromptSystem.ts` (plan 559 A-set found this via grep).
- `bot/` directory still shipped inline-TS section renderers for
  channels / comms / delegation / identity — these are bot-only and
  the framework's `prepare` hook (plan 558 phase 1) gave them a
  one-liner path to `.hbs`, but they hadn't been migrated yet.
- `identity.hbs` carried `{{outputStyleClause}}` — the variable had no
  provider; this was a long-standing dangling reference that only
  surfaced when the unrelated bot identity refactor caused the template
  to render through a partial ctx.

## Sweep boundaries (per user scope decision)

The questionnaire confirmed A (dead code) + B (migrate bot/*.ts to .hbs)
in full. D (directory-naming restructure: `basicPrompt.ts` →
`basicPromptLoader.ts`, flatten `bot/memory/`, rename `modules/mappers/`)
was deferred to plan 560 — orthogonal to the asset surgery and
large enough to deserve its own reasoning.

C (rename in `registry.ts` keys to drop redundant suffixes) was
implicitly handled: nothing changed needed, the names already line up
with their `.hbs` paths.

## Phases landed

1. **`e5938728` — A-set 1: delete dead `language-guidance.ts`**.
   Verified zero consumers via grep before deleting.
3. **`59b2b95b` — A-set 2: drop bot placeholder slots with no data
   source**. `bot/userIdentity.ts`, `bot/mcp.ts`, `bot/remoteBox.ts`
   were guard stubs (`if (!x) return null`) rendering empty sections.
   `bot/catalog.ts` exports trimmed to the four real sections.
4. **`c04c25ce` — B-set: migrate bot roster and automations to .hbs**.
   `bot/roster.ts` + `bot/automations.ts` collapsed into
   `bot/__tests__/framework.test.ts` extension; their bodies moved to
   `assets/bot/roster.hbs` and `assets/bot/automations.hbs`.
5. **`6588e7d8` — phase 2 + follow-up**. Landed as a single atomic
   commit because every piece in it was a precondition for at least
   one of the others (no point splitting):
   - **`BotSectionDef.prepare(ctx)`**: new optional hook on the framework.
     Bot sections pre-format data into the template-friendly shape
     (e.g. `ChannelSnapshot[]` → bullet array the .hbs iterates) and
     return a clone of the ctx so the framework can decide if it is
     worth rendering. A `null` return aborts without falling through.
   - **4 bot sections migrated**: `channels`, `commsRules`,
     `delegation`, `identity`. Each `prepare` is a small guard; the
     prose is in `assets/bot/*.hbs`. `renderX()` legacy functions kept
     as deprecated wrappers around the same `HbsPromptSystem` for
     pre-phase-1 sync tests.
   - **`hbsCompat.ts`** — `identityHbsSentinel` + `makeBotTemplateHbs()`
     so the deprecated wrappers can render through the same renderer
     without dragging in host-side `PromptContext` fields.
   - **Asset deletion**: 6 stale `.hbs` files removed (the ones in
     problem summary). Removed `gateway` config + test + registry entry +
     `gatewayIntro` mapper.
   - **`modules/registry.ts`**: dropped `gateway-role`, `intro`,
     `project` (replaced by separate `projectContinuity` /
     `projectInstructions` entries in `sections`).
   - **Identity template cleanup**: dropped the dangling
     `{{outputStyleClause}}` interpolation.
   - **`HbsPromptSystem.ts`**: dropped the dead `buildLanguageGuidance`
     import that survived `language-guidance.ts` deletion.
   - **`environment.ts` defensive guards**: `getMarketingNameForModel`,
     `getKnowledgeCutoff`, `getShellInfoLine` now tolerate `undefined`
     inputs. The mapper eagerly computes `env_items` even for templates
     that don't use them; partial ctx (bot identity tests, the
     non-bot memory regression test) used to crash on
     `.includes(undefined)`.
   - **Test alignment** for the new shape:
     - `configs/__tests__/botConfig.test.ts` — uses unified `sections`
       (the test had referenced the deprecated `staticModules` /
       `dynamicSections` fields).
     - `tests/unit/prompts/hbs/hbs-prompt-system.test.ts` — drops
       `language` / `outputStyle` from the general-purpose parity list
       (modules are gone).
     - `tests/unit/prompts/modules/module-registry.test.ts` — accepts
       `dynamic/*` paths in addition to `modules/*` (the registry now
       holds both authored and context-fed modules) and uses
       `getAllSections` instead of the retired `getStaticSections`.
     - `tests/unit/prompts/modules/project-modules.test.ts` — drops
       the composite `project` module reference (gateway config lists
       `projectContinuity` / `projectInstructions` separately).
     - `tests/unit/prompts/omitAgentsMdPreBuildHook.test.ts` —
       `initializeAgentsMd` takes a second optional `projectHome` arg
       (plan 525 / 408 follow-up).
     - `tests/unit/prompts/projectContinuity.test.ts` — SessionSearch
       guidance now inline in `recent-sessions.hbs`, not a standalone
       `session-search.hbs`.
     - `tests/unit/prompts/languageAndProgressGuidance.test.ts`,
       `tests/unit/prompts/gateway/GatewayPromptSystem.test.ts` —
       deleted; their fixtures referenced the deleted modules / config.
   - **Recent-sessions .hbs alignment**: `{{same_project_block}}` /
     `{{other_project_block}}` / `{{messaging_guidance}}` (the
     variables the mapper already provides), so the
     byte-level parity test renders through the mapper no-touch.

## Verification

- `npx vitest run packages/agent/src/prompts/
  packages/agent/tests/unit/prompts/` → **30/30 files passing**.
- `npx tsc -p packages/agent --noEmit` → clean.
- `npm run bundle:agent` → `packages/agent/bundle/agent-process-entry.js`
  rebuilt; deleted templates absent from
  `packages/agent/bundle/assets/dynamic/` and the new bot /
  roster / automations hbs present in `packages/agent/bundle/assets/bot/`.

## Deferred to plan 560

- Directory-naming restructure: `basicPrompt.ts` →
  `basicPromptLoader.ts`, flatten `bot/memory/`, rename
  `modules/mappers/` (the mapper files already have a coherent purpose,
  the rename would clarify rather than shrink). Orthogonal to asset
  surgery; user explicitly deferred.

## Lessons (cross-plan reference)

The reason this kind of bug took half a day to find (see also
`docs/exec-plans/active/557-prompt-gating-consolidation.md`) is the
absence of a structural rule that says: *"every `.hbs` asset must have
exactly one section entry that references it, and every section entry
must reference exactly one `.hbs`"* — with a CI check or at least a
test that fails when the invariant breaks. The next plan (560) should
codify that rule so the next sweep is mechanical, not exploratory.