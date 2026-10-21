# 构建职责收口：worker bundle 改名、agent 退出构建图、desktop 依赖闭包

状态：active · 负责人：build-surface-ownership 会话 · 更新：2026-10-21
分支：codex/build-surface-ownership · worktree：.claude/worktrees/build-surface-ownership · base：5b12f721（origin/master，PR #333 合并后）· owner：本会话

## 目标与边界

用户目标（对应 610 系列 handoff 的"退役剩余构建元数据"步骤）：

1. `packages/agent`（@duya/agent，已退役）不再出现在任何构建路径：从 `scripts/build-packages.mjs` 的 BUILD_ORDER 移除，删除根 scripts 里所有 `*:agent` 构建入口（`build:agent`、`rebuild:agent`、`typecheck:agent`、`typecheck:agent:prepared`），删除 `packages/agent/package.json` 的 build/dev/clean scripts。
2. worker bundle 命名归位：`scripts/build-agent-bundle.mjs` → `scripts/build-host-worker-bundle.mjs`，script `bundle:agent` → `bundle:worker`，且不再前置全量 `build:packages`（esbuild 经 workspacePublicSources 插件直接从源码打包，输出本就是 `packages/host/bundle/worker-entry.js`）。
3. dev/build 分离：`electron:dev` 不再触发全量 tsc 构建（只跑 bundle:worker + cli-bundle + build-electron，三者均为 esbuild-from-source）；生产 `electron:build` 才跑新增的 `build:desktop:deps`（`build-packages --target @duya/desktop` 依赖闭包）。
4. desktop 依赖闭包声明：`apps/desktop/package.json` 声明其真实 import 的 workspace 包（main 进程 import 的 ai/agent-core/agent-protocol/capabilities/computer-use/connectors/memory/plugin-core/sandbox/voice），使 `--target @duya/desktop` 闭包覆盖 typecheck:electron 门禁与 electron-builder 资源（voice/computer-use dist）。
5. web 命名归位：`build:web` 收敛为 web app 构建（吸收 `build:web-app`），新增 `dev:web`；根 `build` 保持为 desktop renderer。
6. 同步所有引用：package.json scripts、check-packaged-artifacts(.test).ts、after-pack.js、eval-agent.mjs、diagnose-env.mjs（顺带修正其检查的过期路径）、build-electron.mjs 注释、build-packages.mjs 头注释、scripts/README.md、docs/development/build.md、ARCHITECTURE(.MAP).md、architecture-policy.yaml 注释、release.yml、packages/agent/AGENTS.md、packages/agent 测试内 skip 文案。

不做：删除 `packages/agent` 目录（610 coordinator 最终步骤）；改 electron-builder 资源目标路径（`resources/agent/skills` 等运行时耦合）；重命名 `typecheck:web`（typecheck 命名不在本次范围）；vitest plugin-core/connectors 的 dist alias 调整。

关联：[610 协调文档](./12-agent-retirement-coordination.md)（本任务完成其 handoff 表中构建元数据部分）；前置对话为一次丢失的 Codex 会话（分支 codex/agent-retirement 未提交即丢弃），本计划按同一目标重新设计实现，不逐字复刻。

## 验收

1. `npm run bundle:worker` 产出 `packages/host/bundle/worker-entry.js`（+ BashWorker.js），不再先跑全量 build:packages。
2. `node scripts/build-packages.mjs --target @duya/desktop` 成功且闭包不含 @duya/agent、不含 @duya/web、不含 @duya/ui（ui 无 dist 产物，renderer 由 vite 从源码构建）。
3. `npm run electron:dev` 链路（bundle:worker && build:cli-bundle && build-electron）不触发任何包 tsc 构建。
4. `npm run typecheck:all` 通过（含 typecheck:electron 门禁）；`npm run architecture:check` 通过；`npm run check:packaged-artifacts` 通过；`npm run bundle:verify` 通过。
5. `npm test` 的 pretest 仍提供完整 dist（CI build_scope=skip 时 vitest 的 plugin-core/connectors dist alias 依赖它），pretest 不再构建 @duya/agent。
6. grep 全仓 `bundle:agent|build-agent-bundle|typecheck:agent|rebuild:agent|build:agent`（除 agent-retirement-gate 自身正则与其测试 fixture）零残留。

## 进度

- [x] 调查：消费方、门禁、CI 语义、tsconfig 映射、esbuild 插件源码解析（见发现）
- [x] worktree 分配 + junction 依赖
- [x] 计划文档（本文件）
- [x] package.json scripts 重排 + scripts 改名 + 引用同步
- [x] BUILD_ORDER 移除 @duya/agent + packages/agent scripts 清理
- [x] apps/desktop 依赖闭包 + lock 同步
- [x] CI/release/文档更新
- [ ] 验证（验收 1-6）
- [ ] commit + PR

## 发现与决策（补充，实施期）

- **BashWorker 入口缺插件是"bundle:agent 必须前置 build:packages"的真正原因**：`build-agent-bundle.mjs` 的主入口（worker-entry）挂了 `workspacePublicSources` 插件（源码解析），但 BashWorker 第二入口没挂，靠 node_modules 解析到 `dist/*.js`。本次给第二入口也挂上插件，两个入口真正 dist-independent（见发现 1），`bundle:worker` 不再需要任何前置构建。
- **`--target @duya/desktop` 扩展**：`selectBuildOrder` 原来只接受 BUILD_ORDER 成员。现在 app target（manifest 存在但不在 BUILD_ORDER）允许作为闭包根——只选依赖，app 本身不由此脚本构建。desktop 闭包实测 15 包（host→agent-runtime→ai/agent-core/capabilities/plugin-core/connectors/memory/data/protocol/sandbox/tooling/input-completion/command-catalog/computer-use），不含 @duya/web、@duya/ui、@duya/agent。
- **evals 报告 schema 字段 `agentBundle`/`agentBundleSha256` 保留旧名**（run-suite.ts、suite.ts 与历史 baseline 兼容），只修正其指向的路径为 `packages/host/bundle/worker-entry.js`。schema 改名留给 610 收尾的 rename sweep。
- **`cli-api-server.cjs` 是死产物**：610 迁移后无任何脚本产出它，cli-control-plane 集成套件本就只能 HarnessUnavailable。harness 提示语改为如实陈述（"legacy artifact; no script produces it any more"），8 个测试头注同步。
- **`check-manifest-keys` / `test.yml` 无需改动**：不含旧名引用。`release.yml` 删除独立的 "Build workspace packages" 步骤（`electron:build` 自含闭包），worker 校验步骤改名。
- **worker bundle 需同提交**：error-messages.ts 是 bundle 输入，bundle:verify STALE 判定 1/1083 输入未提交——符合 ARCHITECTURE.md 的"源码与 bundle 同一变更提交"规则；提交后转 fresh。重建后的 metafile 证明 bundle 不含任何 packages/agent 源（gate 检查通过）。
- **历史计划文档（587/474 等）中的旧命令名不改写**——它们是当时的执行记录。

## 发现与决策

- **esbuild 三脚本全部从源码打包**：`scripts/workspace-public-sources.mjs` 把 `@duya/*` 的 `./dist/*.js` 映射回 `src/*.ts`，因此 build-agent-bundle / build-electron / build-cli-bundle 均不需要任何包先 tsc（build-packages.mjs:22-35 的头注释已过期，需改写）。
- **pretest 必须保留全量 build:packages**：CI test job 在 build_scope=skip 时跳过 typecheck:all（test.yml:367），此时 dist 全靠 pretest 提供；vitest.config.ts:164-170 将 @duya/plugin-core、@duya/connectors alias 到 dist。与丢失会话的"pretest 只留 bundle:worker"不同——那会在 test-only PR 上大规模假红。
- **agent-retirement-gate 无冲突**：门禁检查的 `bundle:agent`、`build-agent-bundle` 字样是"仍存在旧名"的 selector（非 blocking）；改名直接减少 selector 计数，与门禁意图同向。不改正则本身（迁移期内仍需检测旧名）。其测试用 fixture 数据，不受影响。
- **desktop 闭包 vs ui**：typecheck:electron 门禁经 tsconfig.main 映射读 9 个包 dist（data/host/sandbox/agent-protocol/agent-core/capabilities/plugin-core/connectors/memory），全部经 manifest 传递闭包覆盖；ui/conductor 由 root tsc 读源码，不进 desktop 闭包。丢失会话把 ui 也声明进去了（21 包），本方案刻意更瘦（约 17 包）。
- **build:cli-dev 保留 bundle:worker**：`packages/cli/src/worker-path.ts:9` dev 解析到 `packages/host/bundle/worker-entry.js`，TUI/chat 需要 worker。
- **diagnose-env.mjs 已过期**：检查 `packages/agent/dist/.../agent-process-entry.js` 与 `packages/agent/bundle/`（均不存在），实际运行时入口是 `packages/host/bundle/worker-entry.js`（packages/host/src/worker-manager.ts:257 + apps/desktop dev resolver）。本次顺带修正。
- **release.yml** 的 "Build workspace packages"（build:agent && build:gateway）步骤在 electron:build 自含闭包后成为冗余，删除；"Verify agent-bundle" 步骤改名为 worker bundle。
- **lock 同步**：apps/desktop 加 workspace 依赖后需 `npm install --package-lock-only --ignore-scripts`（不写 node_modules，遵守 junction 规则）。#336（vite bump）同时改 lock，若先合并会有小冲突，可 rebase 解决。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| （待填） | | | | |

## 接续 / 结果

进行中。下一步：按"进度"实施 package.json 与 scripts 改动。
