# 让独立 Host 读到插件安装路径，恢复插件技能与 MCP

状态：active · 负责人：mavis 会话 `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-25
分支：`codex/host-plugin-install-path` · worktree：`E:\Projects\duya\.claude\worktrees\plugin-install-path` · base：`3a687e41` · owner：mavis

## 目标与边界

用户可观察到的变化：独立 Host（CLI / TUI）里，已启用的插件重新贡献技能目录与 MCP server，
不再因为注册表条目没有 `installPath` 而被静默丢弃。

允许修改的路径：

- `packages/host/src/plugin-install-paths.ts`（新增：安装路径探测）
- `packages/host/src/local-plugin-registry-api.ts`（条目补 `installPath` 与 `manifest`）
- `packages/host/tests/**`（新增测试）

本次不做：Desktop 侧的安装布局改造（把 `installed/` 迁进 data root）、plugin-core 的 manifest
reader 下沉、`dataPath` / `plugins-data` 的读写。

关联：PR #433（config 写侧下沉，已合并 `f59767f1`）。本计划是 Host 能力收口线的后续一条。

## 验收

1. `npm run typecheck:all` 退出码 0。
2. `npm run architecture:check` 退出码 0，不新增 tolerated。
3. `npm run bundle:verify` 为 `FRESH`（改了 `packages/host/src/**` 后必须同变更重建 bundle）。
4. `packages/host` 相关测试全绿，断言只覆盖不变量，不设耗时阈值。
5. 新增测试覆盖：`installed` 符号链接解析到真实目录、builtin cache 取最新版本、
   路径不存在时条目仍返回但不带 `installPath`、`manifest.capabilities.mcpServers` 取自插件目录。

## 进度

- [x] 查明插件安装布局与 Host 侧缺口
- [x] 确认可复用 `plugin-core` 的 `discoverAllCapabilities`，不必新写 manifest 解析
- [x] `packages/host/src/plugin-install-paths.ts`
- [x] `local-plugin-registry-api.ts` 带上 `installPath` 与 `manifest`
- [x] 测试（新增 8 条 + 注册表 10 条）
- [x] 门禁：typecheck exit 0、architecture exit 0、bundle 重建 + `bundle:verify` FRESH 0/930
- [ ] 开 PR

## 发现与决策

- **缺口不是「没接 action」**：`plugin:registry:list` 早已在 Host bridge 里
  （`packages/host/src/worker-db-bridge.ts:1080`），条目来自 `config.toml` 的 `[plugins]`。
  真正缺的是 `installPath` —— worker 的技能发现（`worker-process-entry.ts:2551`）与 MCP
  收集（`plugin-core/src/mcp/collect.ts:87`）都要求它。
- **安装布局（Desktop 侧）**：`<userData>/plugins/installed/<id>` 是指向
  `<userData>/plugins/cache/<marketplace>/<id>/<version>` 的符号链接，
  `resolveInstalledSymlink` 返回 realpath（`apps/desktop/src/main/plugins/cache/layout.ts:60-117`）。
  builtin 插件例外：直接落在 `~/.duya/plugins/cache/builtin/<id>/<version>/`，无符号链接
  （`apps/desktop/src/main/plugins/catalog.ts:846`）。
- **userData 从不指向 `~/.duya`**：`~/.duya` 是 data root，装的是 `config.toml` 与数据库；
  插件包装在 Electron userData 下。CLI 侧已有成熟的候选探测
  （`packages/cli/src/api/runtime-config.ts:92-126`：环境变量覆盖 → data root → 平台
  userData → `duya-dev`），Host 侧按同一形状实现（Host 不能反向依赖 CLI）。
- **不需要新写 manifest 解析**：`plugin-core` 的 `discoverAllCapabilities(pluginDir)` 已从
  `<pluginDir>/mcp/servers.json`（或 Agent Plugins 的 `mcp.json`）读出 MCP 声明，其
  `McpServerCapability` 形状与 collector 需要的 `manifest.capabilities.mcpServers` 一致
  （`packages/plugin-core/src/plugins/loader/capability-discovery.ts:86-102`）。
  Desktop 的 manifest reader 用的也是它，两边不会漂移。
- **manifest 只带最小形状**：collector 只要 `capabilities.mcpServers`，
  不需要 Desktop 的 `PluginManifest` 全类型，也就不必把 renderer 类型搬进 packages。
- **探测根要分「明确指定」与「猜测」两种**：传了 config root 就只用它 —— 它点名一个目录，
  再去别处找就可能读到另一份安装；没传才按 data root → 平台 userData → `duya-dev` 的顺序探测。
- **test 模式只探测 data root**（`DUYA_TEST=1`），否则 CI 会读到跑测机器上的真实插件。
- **禁用的插件不查盘**：worker 本来就不加载它，没必要为它走一次目录扫描。
- **builtin 版本目录按字符串排序取最新**，与 Desktop 的 `listCachedVersions` 同规则，两边选同一版本。
- **只要 MCP 声明就别走全量能力发现**：`discoverAllCapabilities` 还会扫 commands / agents /
  skills / hooks / workflows，而 `plugin:registry:list` 在每次会话启动都会调。
  因此在 plugin-core 抽出 `discoverPluginMcpServers`（native `mcp/servers.json` 优先，
  Agent Plugins `mcp.json` 兜底），`discoverAllCapabilities` 改为调用它 —— fallback 逻辑仍只有一份。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 3a687e41（clean） | Windows / Node 24.16 | `npm run bundle:verify`（主检出，合并 #433 后） | 0 | FRESH 0/928 |
| 3a687e41（clean） | Windows / Node 24.16 | `npm run architecture:check`（主检出） | 0 | total 2682 = tolerated 2682 |
| 3a687e41（clean） | Windows / Node 24.16 | `npm run typecheck:all`（主检出） | 0 | 无新增类型错误 |
| dirty（packages/host） | Windows / Node 24.16 | `npx vitest run packages/host/tests/plugin-install-paths.test.ts packages/host/tests/worker-db-bridge-plugin-registry.test.ts` | 0 | 2 文件 18 断言全过 |
| dirty（packages/host） | Windows / Node 24.16 | `npx vitest run --changed=origin/master --maxWorkers=2` | 0 | 108 文件 / 905 passed / 6 skipped |
| dirty（packages/host） | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 无新增类型错误 |
| dirty（packages/host） | Windows / Node 24.16 | `npm run architecture:check` | 0 | total 2684 = tolerated 2684，baseline size 2530 未变 |
| e8932dbb（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH 0/930，bundle commit = e8932dbb |
| b8d0a3ba（clean，merged master `c426d029`） | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 无新增类型错误 |
| b8d0a3ba（clean） | Windows / Node 24.16 | `npm run architecture:check` | 0 | total 2684 = tolerated 2684，baseline size 2530 未变 |
| b8d0a3ba（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH 0/931，bundle commit = b8d0a3ba |
| b8d0a3ba（clean） | Windows / Node 24.16 | `npx vitest run --changed=origin/master --maxWorkers=2` | 0 | 108 文件 / 905 passed / 6 skipped |
| 112ff9c7（clean） | Windows / Node 24.16 | `npx vitest run packages/host/tests/plugin-install-paths.test.ts packages/host/tests/worker-db-bridge-plugin-registry.test.ts packages/plugin-core` | 0 | 23 文件 / 384 断言全过 |
| cf962d85（clean） | Windows / Node 24.16 | `npm run architecture:check` | 0 | total 2684 = tolerated 2684，baseline size 2530 未变 |
| cf962d85（clean） | Windows / Node 24.16 | `npm run typecheck:all` | 0 | 无新增类型错误 |
| cf962d85（clean） | Windows / Node 24.16 | `npm run bundle:verify` | 0 | FRESH 0/931，bundle commit = cf962d85 |

## 接续 / 结果

已实现：`packages/host/src/plugin-install-paths.ts`（安装路径探测）、注册表条目带上
`installPath` / `dataPath` / 最小 `manifest`（MCP 声明）。
已验证：18 条新增断言全过，受影响集 108 文件 905 断言全绿，三门禁（typecheck /
architecture / bundle:verify FRESH 0/930）全绿。
PR：未开。

分支：`codex/host-plugin-install-path`（worktree `E:\Projects\duya\.claude\worktrees\plugin-install-path`，
base `3a687e41`）。提交序列：`567cbc45` 源码 + 测试 → `e8932dbb` 重建 bundle →
`31198be5` 计划记录 → `541c4b86` 合 master → `b8d0a3ba` 重建 bundle →
`112ff9c7` 窄 MCP 发现入口 → `cf962d85` 重建 bundle → `1c6ca164` 计划记录 →
`4e619f96` 合 master `51014d67` → `2b1e26fd` 重建 bundle。

合并时冲突只在受版本控制的 bundle 产物上（`worker-entry.js` / `worker-metafile.json`）——
bundle 不能手工解，取一边让 merge 落地，再按合并后的源码重建。

未提交路径：无。
副作用：无外部副作用。
阻塞：无。

下一步：push 并开 PR（base `master`）；CI 五个 job 全绿后向用户申请合并授权。
