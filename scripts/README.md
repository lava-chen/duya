# scripts/

仓库级自动化脚本。**不属于产品运行时**，也不属于任何 `packages/*` 的源码。
判断某个代码该放这里的唯一标准：**它服务于"开发和验证仓库"这件事本身**——
构建、门禁、诊断、打包钩子、worktree 运维。

## 三条硬规矩

1. **新脚本必须先在根 `package.json` 登记 `npm run` 入口**，否则不进 `scripts/`。
   没有入口的脚本会静默腐烂：路径漂移、依赖变更、无人调用，都不会报错。
   本目录的历史已经证明这一点——`check-design-tokens.mjs` 曾因前端目录迁移
   （`src/` → `packages/ui/src/`）而静默失效半年，无人发现。

2. **一次性脚本用完即删。**
   确需保留的：一次性数据迁移/回填这类脚本，写完即删，
   不要留在仓库里；确需长期存在的，放在对应 `packages/*` 里，不要寄居在 `scripts/`。
   本目录不应出现"One-shot""一次性"字样的脚本。

3. **不新增平台专用脚本。**
   本仓库全栈是 Node/Electron，跨平台逻辑一律用 Node 脚本（`.mjs`）。
   现存 `.sh` / `.bat` / `.ps1` 均为历史遗留：
   - `remove-worktree.sh` — AGENTS.md 强制流程，**勿删**
   - `reset-mac-tcc.sh`、`build-ax-helper.sh` — macOS 专用，已在文档中登记
   - 其余 `.bat` 是 `junction-worktree.mjs` 的调用目标

### 例外：被外部系统调用的脚本

下列脚本没有 npm 入口，但有明确的外部调用方，属于合规：

| 脚本 | 调用方 |
| --- | --- |
| `after-pack.js` / `after-sign.js` | `electron-builder.yml` 的 `afterPack` / `afterSign` |
| `create-basic-plugin.mjs` / `validate-plugin.mjs` | `packages/*/skills/.system/plugin-mcp-builder/SKILL.md` |
| `memory-rag-hook.mjs` / `memory-rag-lib.mjs` | 同上，`memory-search` skill 的脚本源 |
| `migrate-projects-paths.ts` | `apps/desktop/src/main/memory-state/pathsMigration.ts` |
| `reconcile-memory-projections.mjs` | `apps/desktop/src/main/memory/__tests__/` |
| `inline-modules.mjs` / `workspace-public-sources.mjs` / `duya-data-root.cjs` | 被本目录其他脚本 import |

## 索引

### 构建与打包

| 脚本 | 入口 |
| --- | --- |
| `build-packages.mjs` | `npm run build:packages` |
| `build-electron.mjs` | `npm run build:electron` |
| `build-agent-bundle.mjs` | `npm run bundle:agent` |
| `build-cli-bundle.mjs` | `npm run build:cli-bundle` |
| `build-gateway-bundle.mjs` | `npm run bundle:gateway` |
| `pack-extension.mjs` | `npm run pack:extension` |
| `fetch-ripgrep.mjs` | `npm run fetch:ripgrep` |
| `ensure-sqlite-abi.mjs` | `npm run rebuild:node` + `pre*` 钩子 |
| `electron-binary.mjs` | 被 `ensure-sqlite-abi.mjs` 调用 |
| `inline-modules.mjs` / `workspace-public-sources.mjs` | 被构建脚本调用 |
| `after-pack.js` / `after-sign.js` | `electron-builder.yml` |
| `build-ax-helper.sh` | macOS Swift helper，被 `mac-gate.mjs` 调用 |

### 门禁与校验

| 脚本 | 入口 | 说明 |
| --- | --- | --- |
| `check-text-encoding.mjs` | `npm run check:encoding` | |
| `check-manifest-keys.mjs` | `npm run check:manifest-keys` | |
| `check-no-ts-suppress.mjs` | `npm run check:no-ts-suppress` | |
| `check-test-coverage.mjs` | `npm run check:test-coverage` | |
| `check-packaged-artifacts.mjs` | `npm run check:packaged-artifacts` | |
| `typecheck-electron-gate.mjs` | `npm run typecheck:electron` | |
| `verify-packaged-parity.mjs` | `npm run electron:verify:packaged` | |
| `check-design-tokens.mjs` | `npm run check:design-tokens` | ⚠️ **当前为红**，见下 |
| `verify-design-tokens-compiled.mjs` | `npm run check:design-tokens-compiled` | ⚠️ **当前为红**，见下 |
| `ipc-contract-census.mjs` | — | renderer↔main 契约漂移，登记于 `apps/desktop/AGENTS.md` |

> ⚠️ **design token 门禁现状**：`packages/ui/src/styles/globals.css` 的 `@theme`
> 只注册了 9 个颜色 token，而代码里用到了 `bg-muted`、`bg-surface`、`bg-chip`、
> `bg-surface-hover`、`bg-success`、`bg-primary` 等**未注册**的语义类——
> Tailwind v4 不会为它们生成任何 CSS，元素只是默默继承级联里的其它样式。
> 两个脚本把这个存量问题量化到了具体行号，但**尚未接入 CI**：
> 存量约 170 处违规，接入即红。修完再把它挂进 `typecheck:all`。

### 诊断与环境

| 脚本 | 入口 |
| --- | --- |
| `check-db-health.js` | `npm run check:db-health` |
| `diagnose-env.mjs` | `npm run diagnose:env` |
| `mac-gate.mjs` | — （macOS 原生能力门禁，登记于 `ARCHITECTURE.md`） |
| `preview-cli-tui.mjs` | — （plan 611 进行中） |
| `sqlite-compat-probe.mjs` / `.electron.cjs` | — （plan 610 sqlite 迁移进行中） |

### worktree 运维

| 脚本 | 说明 |
| --- | --- |
| `junction-worktree.mjs` (+ `junction-worktree.bat`) | worktree 依赖 junction 建立 |
| `junction-workspace-pkgs.bat` | 被 `junction-worktree.mjs` 调用 |
| `remove-worktree.sh` | **AGENTS.md 强制**：Windows 拆卸唯一入口，禁止手工 `rm -rf` |

### 子目录

| 目录 | 用途 |
| --- | --- |
| `architecture/` | 架构门禁（46 个文件）：层次纯度、边界、闭环、bundle 校验 |
| `ci/` | CI 契约（退出码协议、summary 守卫） |
| `showcase/` | 演示录制与 GIF 合成 |
| `__tests__/` | `scripts/` 下脚本自身的测试 |

### 基线文件

`packaged-artifact-baseline.json`、`test-coverage-baseline.json`、
`text-encoding-baseline.json`、`typecheck-electron-baseline.txt`
—— 门禁的比对基线，**不要手改**，由对应脚本的 `--write` 模式生成。

## 测试

脚本的测试与被测脚本**同目录**（`check-text-encoding.test.ts`），
只有共享的 fixture 型测试才放 `__tests__/`。`vitest.config.ts` 已包含
`scripts/**/*.test.ts`，新增测试无需改配置。
