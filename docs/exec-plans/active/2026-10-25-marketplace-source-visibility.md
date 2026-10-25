# 插件市场来源：删除与隐藏

状态：active · 负责人：主会话 · 更新：2026-10-25
分支：codex/marketplace-source-visibility · worktree：E:\Projects\duya\.claude\worktrees\marketplace-source-visibility · base：270ba528 · owner：TraeCode 主会话

## 目标与边界

用户能在“市场来源”对话框删除任意来源，包括官方预置来源；删除官方预置来源后在重启后不被 seed 恢复；每个来源可隐藏/取消隐藏，隐藏后它的插件不再出现在插件市场目录，但配置与克隆保留，可随时恢复。

允许修改：`apps/desktop/src/main/plugins/**`、`apps/desktop/src/main/config/schema.ts`、`apps/desktop/src/main/ipc/plugin-handlers.ts`、`apps/desktop/src/preload/index.ts`、`packages/ui/src/lib/plugin-ipc.ts`、`packages/ui/src/components/extensions/MarketplacePage.tsx`、`packages/ui/src/i18n/{zh,en}.ts`、本计划与计划入口。

本次不处理：插件安装/卸载语义、来源编辑、TUI 的插件来源命令。删除仍保留“来源下有已安装插件时拒绝删除”的现有保护。

## 验收

- `npx vitest run apps/desktop/src/main/plugins/catalog.test.ts apps/desktop/src/main/plugins/marketplace/git-source.test.ts`：新增隐藏用例通过，原有市场用例不回归。
- `npm run typecheck:all` 与 `npm run architecture:check` 通过。
- 真实 Electron 路径：来源对话框对官方来源显示可用的隐藏与删除按钮；删除后 `config.toml` 的 `[marketplaces]` 不再出现该键（官方来源留下 `removed = true` 墓碑），重启不再恢复；隐藏后市场卡片与来源分组中不再出现该来源插件，取消隐藏后恢复。

## 进度

- [x] 扩展 marketplace 配置项：`hidden` 与 `removed` 墓碑
- [x] manager：删除官方来源持久化、隐藏/取消隐藏、列表过滤
- [x] catalog：隐藏来源不产出插件条目，墓碑来源完全跳过
- [x] IPC / preload / UI IPC 增加 set-hidden
- [x] 来源对话框：移除按钮对所有来源可用，增加隐藏/取消隐藏与“显示已隐藏”
- [x] i18n 中文/英文键
- [x] 测试与门禁
- [ ] commit 与 PR
- [ ] 真机 Electron 验收（需要重建 Electron 并手动点来源对话框）

## 发现与决策

- 现有 UI 用 `/official$/i` 判断官方来源并禁用删除；`ensureOfficialMarketplace()` 在每次启动时补齐缺失键，所以仅从 config 删除会在下次启动被恢复。删除官方来源必须留下墓碑（`removed = true`）而不是删键。
- `MarketplaceEntry`（`config/schema.ts`）写成嵌套 `source`，与运行时实际写入的扁平结构不一致；本次按实际运行形态修正类型并补两个可选标记。
- 隐藏语义：保留配置与克隆、从目录与分组中移除条目、启动同步跳过；取消隐藏后条目立即从现有克隆恢复，需要新内容时再用刷新。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base 270ba528 + 未提交改动 | Windows 11 / Node 22 | `npx vitest run apps/desktop/src/main/plugins/marketplace/__tests__/manager.test.ts apps/desktop/src/main/plugins/catalog.test.ts` | 0 / 12 passed | 6 个 manager 用例（删除、墓碑、安装保护、隐藏、异常）+ 6 个 catalog 用例 |
| 同上 | 同上 | `npm run typecheck:all` | 0 / 通过 | 9 个基线键收缩提示，无新增类型错误 |
| 同上 | 同上 | `npm run architecture:check` | 0 / 通过 | 无新增边界违规 |
| 同上 | 同上 | 真机 Electron 点击来源对话框 | 未跑 | 需要 `electron:build` 后手动验收，见待办 |

## 接续 / 结果

已实现：配置项 `hidden` / `removed`、manager 删除墓碑与隐藏、catalog 过滤、IPC `plugin:marketplace:set-hidden`、来源对话框隐藏/取消隐藏/显示已隐藏、i18n。
已验证：上述 vitest 12 项、typecheck、architecture check。
已合并：无。PR：未创建。
下一步：review diff 后 commit 并以 PR 交付；如需真机验收，先 `npm run electron:build` 再手动检查来源对话框。

回收：未回收，任务进行中。
