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

## Seam requests (policy owners)

- `architecture-policy.yaml`: declare the `pkg:ui` module with the renderer's
  historical dependency set (`agent-protocol`, `ai`, `conductor/renderer`,
  `connectors`, `plugin-core`, `input-completion`, `command-catalog`).
- `.architecture-baseline.json`: absorb the relocated `pkg:ui -> pkg:*` edges
  and the `src-renderer -> pkg:ui` adapter edges listed above (relocation, not
  new coupling). Owner lane only; not done here.

## Progress

- [x] Migration direction and source-of-truth ownership recorded.
- [x] Inventory and baseline captured (825 renderer files relocated with zero
      drops; 15 new seam/entry files; verification baseline recorded above).
- [x] Complete renderer moved under `packages/ui`; Desktop imports its public App/styles.
- [x] Minimal service/platform contract frozen and communicated to Web lane.
- [ ] Web switched to shared Root and competing implementation removed (Web lane).
- [ ] Gates and visual/browser verification complete (Electron runtime and
      Playwright visual comparison still pending).

