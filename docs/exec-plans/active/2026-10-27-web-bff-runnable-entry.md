# Web BFF 可运行入口：把 web server 打包成可被纯 Node 加载的产物

状态：merged · PR #527 已合并（`ed473722`）· 负责人：mavis（会话 mvs_2387fca26eb84e6ba038bb6962b10891） · 更新：2026-10-27
base：`a99e1444` · owner：mavis

## 目标与边界

用户可观察的变化：按文档跑 `npm run web-app`（即 `node apps/web/dist/server/main.js`）**不再崩溃**，
浏览器能直接打开 web 客户端并驱动 agent；不再需要额外的 `--import` resolver hook。

允许修改：`apps/web/**`、`scripts/**`（新增 web server 打包脚本）、根 `package.json` 的 web 相关脚本、
`docs/development/build.md`、`docs/architecture/ARCHITECTURE.md`、`apps/web/README.md`、
`docs/README.zh-CN.md`（`build:web-app` → `build:web` 的脚本名滞后）。

本次**不**处理：`packages/plugin-core` 的 `moduleResolution` 语义（见下）；任何 Host / worker / UI 行为改动。

T40b 的浏览器端到端验收（发送→工具→审批→取消→刷新重放）原不在本计划范围内，
后由 [2026-10-27 Web 浏览器验收](2026-10-27-web-browser-acceptance.md) 接手，
并**依赖**本计划的 BFF 入口修复：验收正是以产品方式（无 shim）启动 BFF 来验证它。

关联：610 架构系列 T40a/T40b（`docs/exec-plans/active/610-architecture-series/`）。

## 根因

`apps/web` 的 server 侧产物由 `tsc` 产出（`apps/web/tsconfig.json`，`module: NodeNext`）。
但它运行时依赖 `@duya/host` 的 dist，而 `@duya/host` 的 dist 又依赖 `@duya/plugin-core`。
`packages/plugin-core/tsconfig.json` 用 `moduleResolution: bundler`，其 `tsc` 产物是
**无扩展名相对导入 + 目录导入**（如 `from './error-wrapper'`、`from './workflows'`）。
纯 Node ESM 没有这套回退，于是：

```
node apps/web/dist/server/main.js
→ Error [ERR_MODULE_NOT_FOUND]: .../packages/plugin-core/dist/error-wrapper
```

仓库自己知道这件事：`apps/web/tests/fixtures/register-dist-resolver.mjs` 就是用
`module.registerHooks` 补这层回退的，验收夹具 `browser-host.mjs` 靠 `--import` 挂它。
也就是说**产品入口没有挂这个 hook，只有测试夹具挂了**——这就是缺陷本身。

## 方案选择

候选 A：改 `packages/plugin-core/tsconfig.json` 的 `moduleResolution`（改 `NodeNext`）。
→ 否决。plugin-core 同时被 Vite 浏览器侧消费（`@duya/ui` 的依赖闭包），
改模块解析语义会牵动 renderer/Electron 构建，且要改的是共享包，超出本次边界。

候选 B：把 web server 整体用 esbuild 打成单文件 bundle（从源码编译）。
→ 采纳，但**不能整体打**：`@duya/host/local-host` 会把整个 Host 拖进模块图
（data 层、SQLite、几十个 store）。bundle 会臃肿且引入原生模块风险。

最终方案 = B 的收窄版：
1. **新增 `packages/host/src/host-runtime.ts`**：把描述符的形状与读取逻辑
   （`LocalHostRuntime` / `readLocalHostRuntimeFrom`）从 `local-host.ts` 抽出成零运行时依赖的模块。
   `local-host.ts` 改为 re-export，既有消费方（CLI 的 4 处）接口不变。
   web server 改从 `@duya/host/host-runtime` 读取描述符。
   → web server 的模块图里不再有 `local-host` 这条通往 data 层的重边。
2. **`@duya/host/http-client` 的导入全是 type-only**，运行时零外部依赖——
   这一点让 web server 的运行时依赖收敛到「host-runtime（零依赖）+ http-client（零依赖）」。
3. **新增 `scripts/build-web-server-bundle.mjs`**：用 esbuild + `workspacePublicSources()`
   从**源码**编译 server，产出 `apps/web/dist/server/main.js`（ESM，自包含 115KB）。
   与 `build-cli-bundle.mjs` / `build-host-worker-bundle.mjs` 同套路。

验证过 CLI 不受影响：`packages/cli/bundle/cli.cjs` 已完全内联 plugin-core
（`require("@duya/...")` 零命中），只有 web 的 tsc 产物落在纯 Node ESM 上。

产物形态：`apps/web/dist/server/main.js`（ESM，与 `apps/web/package.json` 的 `"type": "module"` 一致），
保留 `main.ts` 里 `import.meta.url` 推导 `../client/` 静态目录的逻辑。

## 验收

1. `npm run build:web` 后，`node apps/web/dist/server/main.js`（**不带** `--import`）能打印
   `Duya web BFF listening at http://127.0.0.1:<port> (serving browser build)`，退出码 0。
2. 该 BFF 能服务真实 Host：`/api/handshake` 的 `provides` 含 `agent_run_execution`；
   `POST /api/runs/start` 返回 `accepted: true`；`GET /api/runs/:id/events` 收到 SSE 事件。
3. `npm run typecheck:all` 退出 0；`npm run architecture:check` 退出 0。
4. `apps/web` 既有测试（`vitest run apps/web`）不回归。

## 进度

- [x] 定位根因（plugin-core 的 bundler 解析语义 vs 纯 Node ESM）
- [x] 选型（抽出轻量 host-runtime + esbuild bundle，弃 plugin-core tsconfig 改动）
- [x] 实现 `packages/host/src/host-runtime.ts` 与 `scripts/build-web-server-bundle.mjs`
- [x] 接入 `apps/web` 的 `build` 脚本与根 `build:web`
- [x] 验收 1–4
- [x] 文档同步（build.md / ARCHITECTURE.md / apps/web/README.md / README.zh-CN.md）
- [x] commit + PR（#527 已合并）

## 发现与决策

- `docs/architecture/ARCHITECTURE.md:188` 与 `docs/README.zh-CN.md:87,137` 写的
  `npm run build:web-app` **在根 package.json 里不存在**（实际是 `build:web`）。
  属脚本改名后的文档滞后，本任务顺手修（AGENTS.md：同一工作范围内的过期文档一并修）。
- `apps/web/tests/fixtures/register-dist-resolver.mjs` 在产品入口修好后**仍然要保留**：
  它服务的 `browser-host.mjs` 夹具直接 `import('@duya/host/local-host')`（走 dist），
  且测试进程自身也走 dist 链。保留它比改测试更省事、风险更低。
- 现有 `apps/web` 的 `typecheck` 用 `tsc -p tsconfig.json --noEmit`，与 bundle 无关，保留。
- `scripts/build-web-server-bundle.mjs` 的注释里不能出现 `packages/*/src` 这类字面量：
  `*/` 会提前终止块注释，把后面的内容变成代码（第一次构建就踩到，SyntaxError）。
- `workspacePublicSources()` 默认以 `process.cwd()` 为仓库根，但 `npm run -w @duya/web build`
  的 cwd 是 `apps/web`。脚本改用自身位置推导仓库根。
- `packages/capabilities/src/ModuleTool/inline-content.ts` 在构建后显示为 modified，
  但 `git diff --raw` / `--numstat` 均无输出——只是行尾归一化，非本任务成果，不提交。
  它**是** worker bundle 的输入，所以留着会让 `bundle:verify` 一直红，必须还原。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `a99e1444`（主检出，read-only 复现） | Windows / Node 24.16.0 | `node apps/web/dist/server/main.js` | 非 0，ERR_MODULE_NOT_FOUND | 复现坑 1 |
| `a99e1444`（主检出，read-only 复现） | Windows / Node 24.16.0 | `node --import .../register-dist-resolver.mjs apps/web/dist/server/main.js` | 0，`Duya web BFF listening at http://127.0.0.1:5177` | 绕过可用的证据 |
| `a99e1444`（主检出，read-only 实测） | Windows / Node 24.16.0 | BFF → `POST /api/runs/start` → `GET /api/runs/:id/events` | accepted:true，SSE 收到 run.started/turn.started/assistant.thinking_delta | 链路本身是通的，缺的只是入口可运行 |
| `a99e1444` + 本任务改动（worktree，dirty） | Windows / Node 24.16.0 | `npm run build:web` | 0，18 包构建完成；server bundle 115.3 KB | 构建通过 |
| 同上 | Windows / Node 24.16.0 | `node dist/server/main.js`（**无 `--import`**） | 0，`Duya web BFF listening at http://127.0.0.1:5179 (serving browser build)` | **验收 1 通过** |
| 同上 | Windows / Node 24.16.0 | `GET /` + `/api/handshake` + `POST /api/runs/start` | 200 / ok=true 且 provides 含 `agent_run_execution` / accepted=true | 验收 2 前半 |
| 同上 | Windows / Node 24.16.0 | `GET /api/runs/:id/events?afterSeq=0` | 186 事件，类型含 run.started→turn.started→assistant.thinking_delta→tool.call_started→tool.call_completed→turn.completed→assistant.message_finalized→run.completed | **验收 2 通过（真实模型 + 工具调用）** |
| 同上 | Windows / Node 24.16.0 | `npm run typecheck:all` | 0 | 验收 3 |
| 同上 | Windows / Node 24.16.0 | `npm run architecture:check` | 0，`OK — no new boundary violations` | 验收 3 |
| 同上 | Windows / Node 24.16.0 | `npx vitest run apps/web` | 0，12 文件 / 107 用例通过 | 验收 4 |
| 同上 | Windows / Node 24.16.0 | `npx vitest run packages/host/tests/host-runtime.test.ts` | 0，5 用例通过 | 新模块单测 |
| 同上 | Windows / Node 24.16.0 | `npm run check:encoding` / `check:no-ts-suppress` / `check:manifest-keys` | 均 0 | 其余门禁 |
| `3ab822e3`（PR #527 首次 push） | GitHub Actions / ubuntu 22.x | CI `architecture` job | **失败**：步骤 18 `Worker bundle freshness (bundle:verify)` | 改了 `packages/host/src/` 但没重建已跟踪的 worker bundle |
| `3ab822e3`（本地复现） | Windows / Node 24.16.0 | `npm run bundle:verify` | 1，`STALE 2/992 bundle inputs changed after the bundle commit` | 确认是同一原因 |
| `3907cc78`（重建并提交 bundle 后） | Windows / Node 24.16.0 | `npm run bundle:worker` → `npm run bundle:verify` | 0 / 0，`FRESH 0/993 bundle inputs changed` | 门禁恢复 |
| `3907cc78` | Windows / Node 24.16.0 | `architecture:slice-graph` / `boundaries` / `client-closure` / `browser-closure` / `bot-boundary` | 均 0 | 其余架构子门禁 |

## 接续 / 结果

实现完成，验收 1–4 全过。PR #527 已合并（merge commit `ed473722`）。

CI 首轮失败于 `bundle:verify`（改 `packages/host/src/` 后已跟踪的 worker bundle 过期），
已重建并提交（`3907cc78`），本地复验 FRESH。

合并后复验（master `dcec5c15`，含 #527）：`npm run build:web` 通过；
`node apps/web/dist/server/main.js`（无 `--import`）正常启动——由
[浏览器验收](2026-10-27-web-browser-acceptance.md) 夹具以产品方式拉起 BFF 覆盖。
分支 `codex/web-bff-esm` 与 worktree 均已回收。
