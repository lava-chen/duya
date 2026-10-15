# Agent retirement consumers

Snapshot: 2026-10-13, migration worktree. The retirement gate reports **OPEN**: the legacy directory is present, with 382 confirmed old-package reference hits, 113 unresolved artifact/build selectors, and 6 selectors whose source text names a Host producer. It scanned 3,008 active source/config files. The grouped appendix below is the finite file-level checklist for this snapshot; run the gate again for current counts and lines as migration proceeds.

Evidence counts are hits, not unique imports or runtime call paths. One import can produce both an import finding and a package-path finding. The gate omits documentation and the body of `packages/agent`; it includes tests, evaluations, active configuration, packaging scripts, and lockfiles. Only the gate test’s explicitly bracketed synthetic fixture regions are nonblocking. A closed static scan still does not prove the worker builds or runs with `packages/agent` absent.

## Retirement sequence

1. **Move production worker ownership and artifact production to Host.** Close the Desktop process-pool/server callers in the production-source appendix and the worker lookups in `packages/cli/src/chat.ts` and `packages/cli/src/index.ts`. Verify each real entry and its bundled assets resolve from Host. Keep compatibility artifact names only after the Host producer and every package/resource selector are mapped. The standalone CLI and Desktop must execute the same Host-owned run engine; a renamed copy of the Agent worker does not close this item.

2. **Migrate remaining Desktop production consumers by owner.** The production-source appendix identifies the exact files for automation/config, channel and wake delivery, skills/workflows, conductor, DB/events, capability management, updater, and user-facing errors. Move each API to its owning package and exercise its production caller. Old-package path strings in census/divergence metadata are data rather than import edges, but still need an explicit update or disposition before the package source can disappear.

3. **Close build and package consumers.** Root-owned files are listed under active configuration/build tooling: root and Desktop manifests/lockfile, TypeScript aliases, `electron-builder.yml`, CI/release workflows, after-pack and packaged-artifact checks, package build order, bundle producers, and architecture classification/audit scripts. Retarget the producer and resource source paths to Host, then verify packaged output contents. Do not use a broad text rename to make artifact names disappear.

4. **Resolve tests and evaluations according to their role.** Test-target references remain blockers when a maintained test imports the package or reads its old source/dist output. Move behavioral tests with the owning code or rewrite them against the new production contract. Review the older H8-2/eval/headless retirement tests as likely stale migration probes, but remove them only after their behavioral coverage is accounted for. `evals/agent/matrix/rows.ts` is an active evaluation target, not historical prose; preserve its behavioral baselines while routing it through the Host-backed harness. Do not add skips or weaken existing baselines.

5. **OS-context extraction is cut over.** Desktop production callers now import `@duya/host/worker-os-context` and pass Main’s `getLogger()`: `apps/desktop/src/main/ipc/computer-use.ts`, `apps/desktop/src/main/services/computer-use-backend.ts`, `computer-use-guard.ts`, `orb-insert-tab.ts`, `orb-wakeless-chat.ts`, `wake.ts`; the Orb unit mock now targets the Host subpath in `apps/desktop/src/main/services/__tests__/orb-insert-tab.test.ts`. Recheck this cut if package exports or logger contracts change.

6. **Accept retirement only after runtime and static gates both close.** The old package directory must be absent. Build and load the real Host worker with that directory unavailable, and run focused production-path verification for multi-turn tool calls, tool errors, approvals, cancellation, durable terminal state, child agents, and workflows. Exercise standalone CLI turns/resume and the Electron Desktop-to-Host bridge when their paths change. Then run required typecheck, architecture/self-tests, relevant tests/evals without skipped coverage, and packaged-resource checks. The static gate’s `CLOSED` result alone is not runtime proof.

## Gate classification

- **Confirmed old-package blocker:** direct `@duya/agent` imports/package references, deep relative imports, explicit `packages/agent/{src,dist,bundle,skills}` paths, and paths assembled from `'packages'`, `'agent'` segments. These appear in all four scopes below and block strict closure.
- **Artifact/build selector:** `agent-bundle`, `agent-process-entry.js`, `BashTool/BashWorker.js`, `agent/skills`, and legacy build-script aliases. A selector alone is not proof that the old package produces it. It is reported as Host-mapped only when that file also names a `packages/host/{src,dist,bundle}` producer path; otherwise it remains unverified and strict mode fails.
- **Scope:** production source, build tooling, active config, and test/eval targets remain separate in the output. Historical docs are not scanned. The counts below exclude bounded synthetic fixture text in the gate’s own test.
- **Runtime limit:** the gate is a literal-reference scan. Computed paths and runtime behavior require the worker build/load and application checks above.

## Exact external file inventory

The list is generated from the live gate at authoring time, grouped by scope. Each row gives detector-hit count, blocker/selector classification, source lines, and finding kinds. Use `node scripts/architecture/agent-retirement-gate.mjs --json` for the full excerpt-level report.


### production-source — 108 hits across 33 files

- [ ] `apps/desktop/src/main/agents/process-pool/process-manager.ts` — 8 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 6); lines 79, 82, 85, 91, 94; split-package-path, worker-artifact.
- [ ] `apps/desktop/src/main/agents/server/interagent-router.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 7; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/agents/server/router.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 27; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/agents/server/worker-manager.ts` — 8 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 6); lines 20, 23, 26, 32, 35; split-package-path, worker-artifact.
- [ ] `apps/desktop/src/main/agents/server/workflow-runtime-manager.ts` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 30, 31; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/automation/compact-config.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 15; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/automation/provider-config.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 14; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/automation/routine-wake.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 17; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/cli/handlers/extra.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 27; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/cli/handlers/providers.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 16; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/cli/handlers/skills.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 23; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/cli/handlers/skillWrite.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 19; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/conductor/db-service.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 38; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/config/groups.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 23; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/index.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 55; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/ipc/db-handlers.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 139; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/ipc/recorder-handlers.ts` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 50, 51; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/ipc/skills-handlers.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 17; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/ipc/workflow-handlers.ts` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 24, 29; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/plugins/catalog.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 587; split-package-path.
- [ ] `apps/desktop/src/main/services/capability-management/capability-management-service.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 98; source-or-dist-path.
- [ ] `apps/desktop/src/main/services/capability-management/cross-source.ts` — 6 hits (blocking 6, Host-mapped selectors 0, unresolved selectors 0); lines 48, 49, 50; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/services/capability-management/mcp-runtime-store.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 30; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/services/capability-management/types.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 144; source-or-dist-path.
- [ ] `apps/desktop/src/main/services/updater.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 11; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/wake/wake-dispatcher.ts` — 8 hits (blocking 8, Host-mapped selectors 0, unresolved selectors 0); lines 44, 46, 47, 48; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/renderer/lib/capability-management-types.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 161; source-or-dist-path.
- [ ] `packages/agent-protocol/src/transcript/classification.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 327; source-or-dist-path.
- [ ] `packages/agent-runtime/src/control-plane-census.ts` — 9 hits (blocking 9, Host-mapped selectors 0, unresolved selectors 0); lines 101, 115, 162, 285, 288, 296, 299, 361, 362; source-or-dist-path.
- [ ] `packages/cli/src/chat.ts` — 4 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 2); lines 624, 626; split-package-path, worker-artifact.
- [ ] `packages/cli/src/index.ts` — 4 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 2); lines 54, 56; split-package-path, worker-artifact.
- [ ] `packages/host/src/run-orchestrator.ts` — 11 hits (blocking 11, Host-mapped selectors 0, unresolved selectors 0); lines 1008, 1034, 1042, 1043, 1045, 1127, 1128, 1216, 1219, 1220, 1224; source-or-dist-path.
- [ ] `packages/plugin-core/src/mcp/error-messages.ts` — 1 hits (blocking 0, Host-mapped selectors 0, unresolved selectors 1); lines 111; legacy-agent-script.


### build-tooling — 159 hits across 21 files

- [ ] `scripts/_cleanup-prompt.cjs` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 2; source-or-dist-path.
- [ ] `scripts/after-pack.js` — 19 hits (blocking 5, Host-mapped selectors 0, unresolved selectors 14); lines 155, 358, 359, 366, 367, 381, 382, 384, 401, 403, 408, 412, 422, 423, 433, 440; legacy-agent-script, source-or-dist-path, split-package-path, worker-artifact.
- [ ] `scripts/architecture/audit-modules.mjs` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 25, 168; source-or-dist-path.
- [ ] `scripts/architecture/boundary-gates-baseline.json` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 5, 6, 16; package-reference, source-or-dist-path.
- [ ] `scripts/architecture/boundary-gates.mjs` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 72, 193; package-reference, source-or-dist-path.
- [ ] `scripts/architecture/mutation-proof-a1.mjs` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 41, 118, 119, 182; source-or-dist-path, split-package-path.
- [ ] `scripts/architecture/slice-classification.ts` — 52 hits (blocking 51, Host-mapped selectors 0, unresolved selectors 1); lines 152, 157, 160, 165, 170, 175, 180, 185, 187, 190, 209, 214, 219, 224, 229, 234, 239, 244, 249, 254, 259, 264, 269, 309, 314, 319, 324, 329, 334, 339, 344, 349, 354, 359, 364, 369, 374, 439, 466, 528, 558, 560, 561, 563, 565, 566, 595, 623, 724, 730, 754; package-reference, skill-asset, source-or-dist-path.
- [ ] `scripts/architecture/slice-cut-list.ts` — 3 hits (blocking 3, Host-mapped selectors 0, unresolved selectors 0); lines 185, 193; source-or-dist-path.
- [ ] `scripts/build-agent-bundle.mjs` — 10 hits (blocking 4, Host-mapped selectors 6, unresolved selectors 0); lines 5, 6, 25, 94, 107, 123, 126, 129, 131, 132; source-or-dist-path, split-package-path, worker-artifact.
- [ ] `scripts/build-electron.mjs` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 159, 163; source-or-dist-path.
- [ ] `scripts/build-packages.mjs` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 148; package-reference.
- [ ] `scripts/bundle-cli-server.mjs` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 26; split-package-path.
- [ ] `scripts/check-no-ts-suppress.mjs` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 52; source-or-dist-path.
- [ ] `scripts/check-packaged-artifacts.mjs` — 26 hits (blocking 7, Host-mapped selectors 0, unresolved selectors 19); lines 90, 97, 129, 146, 147, 151, 153, 154, 178, 609, 626, 656, 680, 695, 696, 719, 722, 729, 751, 933, 958, 1045; legacy-agent-script, source-or-dist-path, split-package-path, worker-artifact.
- [ ] `scripts/diagnose-env.mjs` — 18 hits (blocking 6, Host-mapped selectors 0, unresolved selectors 12); lines 121, 122, 124, 125, 187, 201, 223, 238, 239; skill-asset, source-or-dist-path, split-package-path, worker-artifact.
- [ ] `scripts/eval-agent.mjs` — 3 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 2); lines 71, 74; legacy-agent-script, split-package-path, worker-artifact.
- [ ] `scripts/inspect-curation-failures.ps1` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 50, 51; source-or-dist-path.
- [ ] `scripts/junction-workspace-pkgs.bat` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 2; source-or-dist-path.
- [ ] `scripts/recorder-smoke.cjs` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 28; relative-package-import, source-or-dist-path.
- [ ] `scripts/test-probe.cjs` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 16; relative-package-import, source-or-dist-path.
- [ ] `scripts/verify-packaged-parity.mjs` — 3 hits (blocking 0, Host-mapped selectors 0, unresolved selectors 3); lines 90, 93; skill-asset, worker-artifact.


### active-config — 49 hits across 12 files

- [ ] `.github/workflows/release.yml` — 10 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 6); lines 70, 80, 89, 90, 91, 92, 96; legacy-agent-script, source-or-dist-path, worker-artifact.
- [ ] `.github/workflows/test.yml` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 473; source-or-dist-path.
- [ ] `.gitignore` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 129, 135; source-or-dist-path.
- [ ] `apps/desktop/tsconfig.main.json` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 16; package-reference, source-or-dist-path.
- [ ] `apps/desktop/tsconfig.preload.json` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 17; package-reference, source-or-dist-path.
- [ ] `apps/desktop/tsconfig.renderer.json` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 19; package-reference, source-or-dist-path.
- [ ] `architecture-policy.yaml` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 297; source-or-dist-path.
- [ ] `electron-builder.yml` — 5 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 3); lines 59, 60, 105, 106; skill-asset, source-or-dist-path, worker-artifact.
- [ ] `package-lock.json` — 7 hits (blocking 7, Host-mapped selectors 0, unresolved selectors 0); lines 801, 802, 22326, 22327, 22403, 22413, 22423; package-reference, source-or-dist-path.
- [ ] `package.json` — 15 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 14); lines 22, 28, 31, 38, 39, 40, 49, 60, 65, 73, 81, 82; legacy-agent-script, package-reference, worker-artifact.
- [ ] `vite.config.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 180; source-or-dist-path.
- [ ] `vitest.config.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 52; source-or-dist-path.


### test-target — 185 hits across 46 files

- [ ] `apps/desktop/src/main/__tests__/eval-legacy-loop.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 357; source-or-dist-path.
- [ ] `apps/desktop/src/main/__tests__/eval-legacy-loop.ts` — 5 hits (blocking 3, Host-mapped selectors 0, unresolved selectors 2); lines 59, 585, 587; package-reference, source-or-dist-path, split-package-path, worker-artifact.
- [ ] `apps/desktop/src/main/__tests__/eval-legacy-worker.ts` — 1 hits (blocking 0, Host-mapped selectors 0, unresolved selectors 1); lines 115; legacy-agent-script.
- [ ] `apps/desktop/src/main/__tests__/h8-2-consumer-inventory.test.ts` — 18 hits (blocking 18, Host-mapped selectors 0, unresolved selectors 0); lines 196, 374, 382, 391, 399, 407, 422, 428, 448, 454, 460, 466, 472, 484, 690, 704, 724, 727; source-or-dist-path.
- [ ] `apps/desktop/src/main/__tests__/h8-2-worker-run-channel-seam.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 416, 428; source-or-dist-path.
- [ ] `apps/desktop/src/main/__tests__/headless-retirement.test.ts` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 34, 103, 117, 162; source-or-dist-path.
- [ ] `apps/desktop/src/main/__tests__/run-entry-single-dispatch.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 349; source-or-dist-path.
- [ ] `apps/desktop/src/main/agents/server/__tests__/workflow-runtime-manager.test.ts` — 2 hits (blocking 0, Host-mapped selectors 0, unresolved selectors 2); lines 109, 166; worker-artifact.
- [ ] `apps/desktop/src/main/automation/__tests__/routine-wake.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 12; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/channels/__tests__/connector-runtime.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 29; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/channels/__tests__/connector-secret-store.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 105; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/channels/__tests__/telegram-connector.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 18; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/db/core/__tests__/apply-rebases.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 18; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/emit-rebase-new-messages.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 22; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/legacy-import.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 6; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/message-log-portability.test.ts` — 4 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 0); lines 25, 26; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/message-log-source-filter.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 23; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/message-log.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 6; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/message-repair.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 9; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/rollout-events.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 25; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/session-fork.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 49; package-import, package-reference.
- [ ] `apps/desktop/src/main/db/core/__tests__/workflow-store.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 19; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/ipc/__tests__/recorder-handlers.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 14; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/memory-state/__tests__/projectResolver.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 128, 130; source-or-dist-path.
- [ ] `apps/desktop/src/main/memory/__tests__/curation_integration.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 24; source-or-dist-path.
- [ ] `apps/desktop/src/main/memory/__tests__/memory-worker.curation.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 14; source-or-dist-path.
- [ ] `apps/desktop/src/main/memory/memory-worker.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 21, 54; source-or-dist-path.
- [ ] `apps/desktop/src/main/memory/shadow-mode.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 23; source-or-dist-path.
- [ ] `apps/desktop/src/main/services/app-connections/__tests__/security.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 45; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/wake/__tests__/channel-ack-redrive.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 28; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/main/wake/__tests__/channel-envelope-persistence.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 75; relative-package-import, source-or-dist-path.
- [ ] `apps/desktop/src/renderer/components/chat/tools/rows/SubAgentToolRow.test.tsx` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 139, 155; source-or-dist-path.
- [ ] `apps/desktop/src/renderer/lib/mcp-inventory-ipc.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 12; source-or-dist-path.
- [ ] `evals/agent/evaluators/families.test.ts` — 2 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 1); lines 58; source-or-dist-path, worker-artifact.
- [ ] `evals/agent/matrix/rows.ts` — 48 hits (blocking 48, Host-mapped selectors 0, unresolved selectors 0); lines 178, 231, 263, 282, 287, 315, 320, 335, 340, 354, 359, 374, 447, 452, 466, 480, 485, 499, 513, 527, 532, 549, 555, 565, 570, 584, 589, 603, 617, 622, 636, 641, 655, 691, 696, 710, 715, 730, 735, 750, 767, 772, 789, 794, 799, 813, 828, 847; source-or-dist-path.
- [ ] `packages/agent-protocol/test/14-producer-inventory-drift.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 47; split-package-path.
- [ ] `packages/agent-protocol/test/extract-worker-fields.mjs` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 44; source-or-dist-path.
- [ ] `packages/agent-protocol/test/permission-naming.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 59; source-or-dist-path.
- [ ] `packages/agent-runtime/test/control-plane-census.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 247; source-or-dist-path.
- [ ] `packages/host/tests/skills/skillService.test.ts` — 2 hits (blocking 0, Host-mapped selectors 0, unresolved selectors 2); lines 129, 133; skill-asset.
- [ ] `packages/memory/tests/package-boundary.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 223, 233; source-or-dist-path.
- [ ] `scripts/__tests__/memory-search-hooks-json.test.ts` — 3 hits (blocking 3, Host-mapped selectors 0, unresolved selectors 0); lines 12, 16; relative-package-import, source-or-dist-path, split-package-path.
- [ ] `scripts/__tests__/memory-search-skill.test.ts` — 1 hits (blocking 1, Host-mapped selectors 0, unresolved selectors 0); lines 27; split-package-path.
- [ ] `scripts/architecture/boundary-gates.test.ts` — 21 hits (blocking 21, Host-mapped selectors 0, unresolved selectors 0); lines 273, 286, 297, 345, 592, 646, 803, 823, 851, 912, 913, 914, 1655, 1656, 1664, 1670, 1674, 1676, 1677, 1760; package-reference, relative-package-import, source-or-dist-path.
- [ ] `scripts/architecture/import-graph.test.ts` — 2 hits (blocking 2, Host-mapped selectors 0, unresolved selectors 0); lines 176, 187; source-or-dist-path.
- [ ] `scripts/check-packaged-artifacts.test.ts` — 18 hits (blocking 4, Host-mapped selectors 0, unresolved selectors 14); lines 39, 86, 118, 123, 125, 261, 262, 275, 317, 318, 324, 325, 328, 343, 344; source-or-dist-path, worker-artifact.
