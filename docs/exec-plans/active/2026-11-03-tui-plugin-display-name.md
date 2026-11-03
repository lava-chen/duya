# TUI /plugin 与 @ 补全显示插件真名

状态：active · 负责人：本会话（lava-chen P1 授权） · 更新：2026-11-03
分支：`codex/tui-plugin-display-name` · worktree：`E:/Projects/duya/.claude/worktrees/tui-plugin-display-name` · base：`cbb3a761` · owner：本会话

## 目标与边界

用户观察到的变化：`/plugin` 面板显示的是包里登记的 id（`com.duya.pdf`、`com.duya.spreadsheets`），而不是插件自己声明的名字（`PDF`、`Spreadsheets`）。本计划让用户读到的位置改用 manifest 的 `interface` 文本：

1. Host 清单投影增加可选 `displayName` / `shortDescription` / `longDescription`，来源是 `.duya-plugin/plugin.json` 的 `interface` 块；`name`（登记名/id）保持不变，凭据、路径、manifest 本体仍不出 Host。
2. TUI `/plugin` 的列表行、静态回退面板、详情页标题与正文优先使用 `displayName` / `shortDescription` / `longDescription`；旧 Host 不带这些字段时回退到现有 `name`，不报错。
3. TUI `@` 插件补全的行标签与 mention 摘要 `name` 使用 `displayName`；候选 `value`、`pluginId` 和提交改写使用的 mention token 仍是插件 id。

本次不处理：codex 的 Tab 启停、安装/卸载、多 marketplace 标签页，以及任何 Host 写操作。禁用插件仍按既有约定不遍历其包目录（`worker-db-bridge-plugin-registry.test.ts` 钉住），因此其显示名回退为登记名，与它缺失的其他包事实一致。

关联：[TUI 插件查看与 mention](2026-10-25-tui-plugin-view-and-mention.md)（本计划只补其中的显示名）；codex 对照见 [Codex TUI 对照](../archive/2026-11-03-codex-tui-alignment-survey.md)。

## 验收

- `npx vitest run packages/host/tests/plugin-inventory-http.test.ts packages/cli/src/tui/slash/__tests__/plugin.test.ts packages/cli/src/tui/slash/__tests__/interactive-list.test.ts packages/cli/src/tui/__tests__/plugin-candidates.test.ts` 全绿。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0。
- 回退路径有断言：不带 `displayName` 的旧 Host 仍显示 `name`；详情标题、列表行与 `@` 行标签均优先显示名，`value`/`pluginId` 仍为 id。
- 基线：本 worktree `cbb3a761` 上四个测试文件在改动前均为绿（host 文件需先构建本检出 `plugin-core`/`connectors` 的 `dist`，见验证记录）。

## 进度

- [x] 扩展 `HostPluginInventoryEntry` 与 `HostPluginRegistryEntry`：读 `interface.displayName/shortDescription/longDescription`，经 `toInventoryEntry` 投影
- [x] `/plugin`：列表、静态回退、详情改用显示名/短描述/长描述，mention token 保持 id
- [x] `@` 补全：行标签与 mention `name` 改用显示名，候选值保持 id
- [x] 测试：host 清单、`/plugin` 静态回退、交互列表、`@` 补全覆盖显示名与回退
- [x] 提交、推送任务分支、开 PR（`aec144fa`，[PR #598](https://github.com/lava-chen/duya/pull/598)）；未合并

## 发现与决策

- 根因在 `local-plugin-registry-api.ts`：`readPluginRegistry` 直接写 `name: id`，`readPluginPackageFacts` 只读顶层 `description` / `components.appConnections` / skills，从不读 `interface`。内置插件 manifest（如 `packages/plugin-core/src/plugins/builtin/zotero/.duya-plugin/plugin.json`）已带 `interface.displayName/shortDescription/longDescription`。
- 选择新增独立 `displayName` 字段而不是把 `name` 改成显示名：`name` 是登记身份，`@` mention 与 worker 消费的 `pluginId` 都以 id 为准；显示名只影响人读到的文本。
- 禁用插件保持不遍历包目录的既有不变量，因此没有 `displayName`；TUI 统一走 `displayName ?? name`，行为与现有 description/组件事实一致。
- worktree 的 `vitest.config.ts` 把 `@duya/plugin-core`、`@duya/connectors` 别名到本检出 `dist`；新 worktree 没有构建产物，host 测试会报 `Cannot find package '@duya/plugin-core/apps/declarations'`。先跑 `node scripts/build-packages.mjs --target @duya/plugin-core --target @duya/connectors` 即恢复，不是产品缺陷。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `cbb3a761` + 本次改动（dirty） | win32 / Node v24.18.0 / worktree | `node scripts/build-packages.mjs --target @duya/plugin-core --target @duya/connectors` | 0，built 2 package(s) | 补 worktree 本检出 dist，供 vitest 别名解析 |
| 同上 | 同 | `npx vitest run packages/host/tests/plugin-inventory-http.test.ts packages/cli/src/tui/slash/__tests__/plugin.test.ts packages/cli/src/tui/slash/__tests__/interactive-list.test.ts packages/cli/src/tui/__tests__/plugin-candidates.test.ts` | 0，4 files / 23 tests passed | 显示名投影、列表/详情、`@` 标签与旧 Host 回退 |
| 同上 | 同 | `npm run typecheck:all` | 首跑 134（`@duya/ui` 的 `tsc` OOM：本机当时仅约 1 GB 可用内存）；内存释放后以 `NODE_OPTIONS=--max-old-space-size=6144` 重跑，0 通过 | 10 条 electron-gate baseline 收缩，未 `--write` |
| 同上 | 同 | `npm run architecture:check` | 0，OK — no new boundary violations | 18 条 baseline 指纹不再触发，未 `--write` |
| PR #598 首轮 CI | ubuntu / Node 22 | `npm run bundle:verify`（architecture job） | 1，STALE：3 个 Host 输入晚于 bundle 提交 | CI 要求同一变更内重建 worker bundle |
| 同上 + `6b584883` | win32 / Node v24.18.0 / worktree | `npm run bundle:worker` → `npm run bundle:verify` | 0，FRESH 0/1059 inputs changed | 只提交了 `worker-entry.js` / `worker-metafile.json` 的内容差异 |

## 接续 / 结果

已实现：协议字段、Host 投影、TUI `/plugin` 与 `@` 补全显示名、四组测试。
已提交并推送：`aec144fa`（功能）→ `0795267a`（计划记录）→ `6b584883`（worker bundle 重建），[PR #598](https://github.com/lava-chen/duya/pull/598)，未合并。
工作树残留：无。构建/打包曾产生行尾过滤差异，已确认 `git diff` 为空并还原。
回收：worktree 保留至 PR 集成。
下一步：等 PR #598 的 CI 重跑与 review，通过后由获授权集成者合并；真机冒烟需运行带内置插件的 Host，观察 `/plugin` 是否显示 `PDF`/`Zotero` 等显示名。
