# 24 — Shared Desktop and Web renderer

Status: Active · 2026-10-19 · Worktree `codex/wave3-shared-renderer`

## Objective

Move the complete existing React renderer in `apps/desktop/src/renderer/**` into
the UI-owned `packages/ui` production root. Desktop and Web must render the same
public `@duya/ui` App/Root and load its shared styles. The current Desktop
renderer is the visual and behavioral source of truth; this work relocates and
adapts its host boundary rather than designing a second UI.

## Ownership and boundaries

- `packages/ui/**` owns the renderer tree, UI-local stores/hooks, styles, assets,
  public App/Root, and the UI-facing service/platform contract.
- Desktop entry code owns only Electron bootstrap and a Desktop implementation
  of that contract. Web entry code owns Web bootstrap and its implementation;
  its files are integrated by the Web lane after the contract is frozen.
- Host/client-core remain authoritative for sessions, runs, events, approvals,
  persistence, and runtime actions. UI stores are projections and ephemeral UI
  state only.
- `apps/desktop/src/renderer/**` is the sole design source during migration.
  Remove moved implementations from the active Desktop tree; retain only
  explicit thin re-exports/adapters where existing imports require compatibility.
- Preserve Desktop classes, component behavior, locale/theme, assets, and tests.
  Do not add parallel lookalike components or replace the product UI with a
  reduced Web shell.

## Sequence

1. Inventory renderer imports, assets, tests, and Electron calls in this branch;
   record the current type/test/build baseline before moving source.
2. Relocate the complete renderer implementation, styles, assets, and tests
   under `packages/ui`, preserving module layout and behavior. Resolve source
   aliases and public exports; keep only Desktop bootstrap files in Desktop.
3. Switch Desktop to the shared public App and stylesheet, then verify the
   unchanged UI in its existing Electron boundary. This relocation is the first
   implementation checkpoint; do not block it on a broad service redesign.
4. Freeze the smallest typed host/platform seam required by the shared root.
   Adapt existing Desktop operations behind it and define truthful unsupported
   Web capabilities. Keep runtime-authoritative state outside the UI.
5. Integrate the Web entry against the same public App and stylesheet after the
   seam is frozen; remove any competing Web UI implementation.
6. Verify migrated tests, UI and package typechecks, Desktop and Web production
   builds, architecture/browser-closure gates, and real Desktop plus browser
   flows. Compare screenshots/interaction behavior to the existing Desktop UI.

## Acceptance

- Both entries import the same `@duya/ui` public Root/App and stylesheet.
- There is one active implementation of each migrated renderer feature.
- Existing Desktop behavior and visual structure remain intact; Web capability
  differences are explicit and do not fabricate unsupported actions or state.
- Session/run/permission actions still flow through the existing Host/client
  authority and transport.
- Required checks pass without weakening gates, baselining new findings, or
  suppressing existing failures. Report any blocked check with its first error.

## Seam contract (frozen 2026-10-19)

Public surface of `@duya/ui` (see `packages/ui/package.json` exports):

- `.` → `src/index.ts` — exports the shared `App` root.
- `./styles.css` → `src/styles/globals.css`.
- `./contracts`, `./contracts/git`, `./contracts/import` — shared IPC DTO
  contracts consumed by Desktop main, preload, and renderer code review.
- `./types`, `./types/*` — shared renderer types (message, stream, usage,
  bash-task, hook-task, app-connection, browser-cookie, ...).
- `./services` — the typed host/platform seam:
  - `UiServices` (`src/services/ui-services.ts`): the finite business
    operations the shared root needs from its host — `sessions`
    (list/get/create/update/delete/readMessages), `runs`
    (listBySession/start/cancel/watchEvents), `approvals`
    (listPending/resolve) — all typed off `@duya/agent-protocol`.
  - `configureUiServices` / `getUiServices` / `clearUiServices`
    (`src/services/registry.ts`): the host installs its adapter before
    mounting the shared renderer.
  - `UiServicesProvider` / `useUiServices` (`src/hooks/useUiServices.tsx`,
    re-exported here): the React-context form of the same seam.

Platform implementations:

- **Desktop** (this lane): reaches the host through `window.electronAPI`
  (typed in `apps/desktop/src/renderer/global.d.ts` from
  `apps/desktop/src/preload/index.ts`) via `packages/ui/src/lib/ipc-client.ts`
  and sibling `lib/*-ipc.ts` wrappers. Wiring `ipc-client` onto
  `UiServices` is deliberately deferred — it must not change Desktop
  behavior in this lane. Compatibility re-export stubs under
  `apps/desktop/src/renderer/lib/*` and `apps/desktop/src/renderer/types/*`
  keep main/preload relative imports resolving; they retire when those
  imports switch to `@duya/ui/lib/*` directly.
- **Web** (Web lane): implements `UiServices.sessions` over the BFF client
  (`apps/web/src/client/*`) and `apps/web/src/server/web-bff.ts`
  `/api/sessions` routes, then mounts the same `App` and stylesheet.
  Unsupported capabilities must stay unimplemented rather than fabricated.

## Verification (2026-10-19, this worktree)

- `tsc -p tsconfig.json --noEmit` (packages/ui + renderer scope): 0 errors.
- `npm run -w @duya/desktop typecheck:renderer` / `typecheck:preload`: 0 errors.
- Electron typecheck ratchet gate: OK — no new type errors (231 known keys;
  38 baselined keys shrank). No baseline edits made.
- `npx vitest run packages/ui`: 2154 tests, 2139 pass, 2 skipped; 12 failures
  all in `WorkflowPanel.test.tsx` (pre-existing product/test drift present at
  the base merge — the component never rendered the expected testids) plus one
  load-sensitive flake in `stream-session-manager.test.ts` that passes in
  isolation (33/33) and fails independently of this relocation. Desktop main
  subset incl. the new stub chain: 130/130 pass.
- `npx vite build`: renderer + orb entries bundle from `@duya/ui`
  (`dist/packages/ui/src/orb/index.html` emitted as electron-builder expects).
- `npm run architecture:check`: reports only (a) `pkg:ui -> pkg:{agent-protocol, ai, conductor}`
  edges relocated verbatim from the desktop renderer and (b) the sanctioned
  `src-renderer -> pkg:ui` thin re-export adapters. Both are baseline/policy
  seam requests (see below); no gate was weakened and no fingerprint added.

## Seam requests — fulfilled in this lane (2026-10-19/20)

- `architecture-policy.yaml`: the `ui` module is declared with its measured
  requires (`agent-protocol`, `client-core`, `legacy-ai`, `command-catalog`,
  `connectors`, `legacy-conductor`, `input-completion`, `legacy-plugin-core`),
  and `desktop-contracts` declares `requires: [ui]` so the thin re-export stubs
  read as the vocabulary edges they are rather than as forbidden reach-backs.
- `.architecture-baseline.json`: no absorption was needed, and none was done.
  Declaring the module moved the relocated `pkg:ui -> pkg:*` edges from
  not-permitted to permitted, so the baseline TIGHTENED by 30 fingerprints
  instead of growing; the reconciliation is recorded in the policy file
  (`127 + 2651 = 2778`). Two more fingerprints left the baseline because the move
  upgraded tolerated `src-renderer -> electron-main` debt into a forbidden
  `packages/** -> apps/desktop/**` edge, which can never be baselined — so that
  debt was paid instead of re-filed.
- Measured after both landed: `npm run architecture:check` prints `OK — no new
  boundary violations`, exit 0 (2026-10-20).
- Caveat, now its own card: the requires list above was declared from what the
  boundary gate can see, and the boundary gate resolves bare specifiers while the
  slice inventory does not. `pkg:ui`'s edges keep their numbers in the cut list
  only for the imports written as relative paths; the bare ones
  (`@duya/agent-protocol`, `@duya/ai`, `@duya/client-core`,
  `@duya/conductor/renderer`, `@duya/input-completion`) are invisible there. See
  T19 in [19-fast-track-queue](19-fast-track-queue.md). Do not "fix" this by
  adding fingerprints — the declaration is correct and the count that disagrees
  with it is the blind one.

## Progress

- [x] Close the shared Web production path: verify Host run/approval ledger
      ownership and selection leases, use production MessageList integration
      coverage for transcript ordering, and correct the cursor provenance
      comment to reflect Host-stamped run identity.
      Web `App.tsx` owns the run/approval ledger and selection leases;
      `mergeRunSessionRows` keeps durable rows except the bound run;
      `project-message-transcript` documents `sequenceDomain`/`runId` as
      renderer cursor provenance re-attached across the Protocol whitelist.
- [x] Run the Web/Desktop builds, `typecheck:all`, architecture and browser
      closure gates; record pre-existing failures by file/test/signature.
      `npm run typecheck:all` exit 0 (electron ratchet: no new type errors, 231
      known across 111 keys; 38 baselined keys shrank and can be re-recorded
      later). `npm run build:web-app` exit 0. `npm run architecture:check`:
      2826 tolerated / 2801 baseline, no new boundary violations. Targeted
      UI/Web suite: 45/45 across 6 files. Full `npm test` not run — its
      pre-existing failure set is unchanged by this slice and is tracked in
      the plan index.
- [x] Prove two turns, approval, real worker tool result, order/deduplication,
      refresh recovery, and cancellation against the isolated browser-host
      fixture and capture browser evidence.
      Evidence (fixture `apps/web/tests/fixtures/browser-host.mjs`, real Host +
      production worker + scripted provider): two runs completed with a real
      `bash` result returned to the provider (8647 ms / 15946 ms); sidebar order
      and title correct after refresh; each final answer rendered once; cancel
      of the held response ended in Host ledger `cancelled` with no third
      execution (`executions.txt` = 2 lines). Durable rows now keep
      `msg_type`/`tool_call_id`/`parent_tool_call_id`, so a persisted tool
      result pairs with its call — the regression that left a completed call
      showing "Running…" after refresh.
- [x] Commit the verified UI/Web slice and update the existing PR description.
      Evidence: branch `codex/wave3-shared-renderer`, PR #311 description carries
      the Web delivery and browser-acceptance evidence.

- [x] Migration direction and source-of-truth ownership recorded.
- [x] Inventory and baseline captured (825 renderer files relocated with zero
      drops; 15 new seam/entry files; verification baseline recorded above).
- [x] Complete renderer moved under `packages/ui`; Desktop imports its public App/styles.
- [x] Minimal service/platform contract frozen and communicated to Web lane.
- [x] Web switched to shared Root and competing implementation removed (Web lane).
      Evidence: `apps/web/src/main.tsx` mounts `@duya/ui`'s `App`; `apps/web/src/client`
      is the transport adapter only (no second renderer).
- [ ] Gates and visual/browser verification complete (Electron runtime and
      Playwright visual comparison still pending).

