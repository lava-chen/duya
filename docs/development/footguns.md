# Footguns

Traps that have actually cost time on this repo. Each one is a symptom of something
structural — read the "why" before working around it.

- Editing `apps/desktop/src/preload/index.ts` without rebuilding Electron.
- **Main/preload use a type-error ratchet, not a zero-error gate**: `typecheck:all`
  includes `typecheck:electron`; raw main/preload checks still have legacy debt. Main
  changes also require `npm run build:electron` and relevant tests. Current remediation
  is tracked by
  [plan 587 G0](../../docs/exec-plans/active/587-agent-harness-monorepo/01-baseline-and-gates.md);
  historical measurements are reference data.
- Modifying `packages/agent` exports without rebuilding (`npm run build:packages`).
  Note `bundle:agent` bundles the **worker** entry, not the agent package.
- Adding a route to the Web BFF (`apps/web/src/server/web-bff.ts`) without checking its
  CSRF and origin guards.
- Skipping Playwright verification for UI changes.
- Forgetting `npm run typecheck:all` before committing.
- NOT checking active plans before starting work ⚠️.
- `better-sqlite3` **不再**是当年那个 ABI 定时炸弹 ⚠️（实测 2026-10-05）：13.0.3 依赖
  `node-addon-api`,即 **N-API** 插件,自带的预编译文件叫 `prebuilds/<platform>-<arch>.node`,
  **文件名里没有 ABI**。`lib/binding.js` **先读** `prebuilds/`,只有找不到才回退到
  `build/{Debug,Release}/`,而标准 `npm ci` 根本不填 `build/`。实测：同一个
  `prebuilds/win32-x64.node` 在 Node 24.16.0（`modules` 137）和 Electron 44.2.0
  （`modules` 149）下**都能加载**。所以"Node 与 Electron 需要两份不同的构建、来回切换
  二进制"这条只对 ≤ v11 成立,现已失效。`scripts/ensure-sqlite-abi.mjs` 仍挂在 DB 相关
  入口的 `pre-` 钩子上（`pretest*` → node,`preelectron:*` / e2e → electron）,其 marker
  缓存按**全部候选绑定的存在性 + mtime + size** 判定,而不是单条路径（PR #217 修了按
  `build/Release/better_sqlite3.node` 取键时"数据库打不开却报 ABI 绿"的假绿）。真的看到
  `NODE_MODULE_VERSION` 不匹配再跑 `npm run rebuild:node`（node）/ `npm run rebuild`
  （electron）;但**先别假定需要换二进制**——健康安装本来就该没有 `build/Release`,把它当成
  损坏信号会得到一个假红。
- Electron window blank: check DevTools console, verify `http://localhost:3000` reachable.
- The `electron` package ships **no install script** ⚠️ (verified on 44.2.0: no `scripts`
  field in its package.json, and no `hasInstallScript` for it in `package-lock.json`), so its
  ~370 MB binary is downloaded lazily on the first `require('electron')` — a clean `npm ci`
  leaves no `node_modules/electron/dist/` and no `path.txt`, on every OS.
  `scripts/electron-binary.mjs` therefore resolves the binary through `require('electron')`,
  which is also the step that produces it. Expect the first `preelectron:*` / e2e run after
  a clean install to print `Downloading Electron binary...` and take minutes. Do not silence
  that by pre-creating `path.txt` — an unreadable pointer is exactly what the resolver
  exists to survive.
- Renderer E2E may load **another checkout's** Vite ⚠️: `e2e/playwright.config.ts` sets
  `reuseExistingServer: true`, so it silently reuses whatever already answers on `:3000`, and
  `getRendererUrl()` probes a hardcoded 3000–3005 with no env override. From a worktree that
  means the app can render a page served by the primary checkout — where `packages/*` may not
  resolve, so `globals.css` transform throws, React never mounts, and the failure surfaces 15s
  later as a mystery "element not found". `window.electronAPI` looks perfectly healthy
  throughout (the preload is per-webContents, not per-URL), so "wait for the bridge" is not a
  sufficient readiness check. Free port 3000 before running renderer E2E, or assert the app
  actually mounted — `e2e/ipc/session-archive-ui.spec.ts` does both.
- `e2e/helpers.ts` does NOT dismiss onboarding ⚠️: the block is guarded by
  `if (process.env.DUYA_TEST === '1')`, which reads the **Playwright runner** process, while
  `DUYA_TEST=1` is only injected into the **Electron child** env. Nothing exports it in the
  runner, so the block never runs. It is not only a modal: the conversation store stays below
  `isHydrated`, `loadFromDatabase()` is never called, and no thread row renders at all. Seed
  `duya-onboarding-completed` + `duya-conversations` in localStorage and reload, the way
  `e2e/ipc/file-workspace.spec.ts` does. Also note the sidebar's work/bots split is plain
  component state defaulting to `bots`, so session sections only render after switching to
  the Work tab.
- NEVER hand-roll a worktree teardown on Windows ⚠️ — see
  [worktree.md](./worktree.md#安全拆卸fail-closed). GNU rm does not treat NTFS junctions as
  symlinks — it recurses THROUGH them. Worktrees contain junctioned `node_modules`, and npm
  workspaces makes `node_modules/@duya/*` junction back into `packages/*`, so one recursive
  delete of `.claude/worktrees/<name>` wipes every workspace package's sources in the primary
  checkout. This happened twice: 3,471 files on 2026-08-25 and 3,492 on 2026-10-03.
  `rm --` and the recoverable trash launcher are unsafe too — they traverse reparse points
  here. Always use `scripts/remove-worktree.sh <name>`.
  Recovery if it happens anyway: the deletions are unstaged, so `git restore .` in the primary
  checkout restores every tracked file from HEAD.
- Bug hunt: when looking for defects, cross-check new diffs against
  `docs/exec-plans/completed/2026-09-bug-sweep.md` first — it catalogs the recurring shapes
  (async-as-value, non-null assertion, silent API fallthrough, fractional-cell math, port 0,
  etc.) with concrete duya examples and detection rules.
