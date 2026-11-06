# TUI 插件面板样式与 Installed 列表修复

状态：active · 负责人：codex · 更新：2026-11-04
分支：`codex/tui-plugin-panel-fixes` · worktree：`D:/codex/worktrees/tui-plugin-panel-diagnosis/duya` · base：`7ef8cbd053b5c751729fa8a5ba28f85e3bc48508` · owner：codex

## 目标与边界

修复 TUI `/plugin` 标签栏把 `{inverse}` 画成字面文本，以及 Installed 面板漏掉 `config.toml` 插件清单中未出现在已同步 marketplace catalog 的插件。空列表文案应区分没有条目与搜索无匹配。范围限于 CLI TUI 列表/样式及其回归测试；不主动刷新用户 marketplace 缓存，也不改 Host 插件安装行为。
关联：TUI 插件市场管理计划 [631](630-tui-capabilities-series/631-tui-plugin-market-ui.md)。

## 验收

- 自有 TUI 渲染器正确绘制 `{inverse}`，选中标签不显示 markup 字符。
- Installed 合并 Host 插件清单与 catalog 数据；内置或未同步源里的配置条目可见，启停/卸载按原插件 ID 与 marketplace 写回 Host。
- 无过滤结果时显示适合该 tab 的空状态；有搜索词且无匹配时保留 `no matches`。
- 相关 Vitest、`npm run typecheck:all`、`npm run architecture:check` 与 CLI bundle freshness 检查通过；在当前构建产物上目视 TUI 面板。

## 进度

- [x] 实现并补齐渲染、列表来源、空状态回归用例。
- [x] 运行针对性测试、架构检查、CLI 类型构建与 CLI bundle；全仓检查受共享依赖 junction 权限限制，见验证记录。
- [x] 提交任务切片并创建 draft PR #612；未经授权不合并。

## 发现与决策

- TUI 只使用 own renderer；其 markup 属性表缺 `inverse`，而 RichPanelController 使用该 Blessed 标签绘制 header focus。以自有 ANSI renderer 支持 `inverse` 标签保持预期反显。
- `/v1/local/plugins` 明确是“我有什么”的库存投影，包含 `config.toml` 插件意图及包文件是否可见；Installed 应以它为主，并用 marketplace catalog 补充版本/描述。catalog 空或未同步不应隐藏库存。
- 数据检查（2026-11-04）：默认 `.duya/config.toml` 有 7 个插件键；`plugins/cache/marketplaces` 不存在。当前不执行会修改用户缓存的 refresh。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `7b021a089f052c5b5e80f06c2272f0c73bde275f`（只读基线） | Windows / Node 环境 | 源码与默认配置只读核对 | — | 两个问题的调用路径已定位；验证待实施后记录 |
| `7b021a089f052c5b5e80f06c2272f0c73bde275f` + 本任务改动 | Windows / Node 24.16.0 | Vitest：`own-markup.test.ts`、`tui-rich-panel.test.ts`、`slash/__tests__/plugin.test.ts` | 0 · 67 tests passed | 覆盖 inverse SGR、Installed 库存回退、空态与过滤无匹配 |
| 同上 | Windows / Node 24.16.0 | `npm run architecture:check` | 0 · no new violations | 基线 3192 项全部容许；无新增边界违规 |
| 同上 | Windows / Node 24.16.0 | `npm run typecheck:all` | 1 · blocked at `@duya/web` Vite config temp write | Vite 对共享 junction `apps/web/node_modules/.vite-temp` 返回 EPERM；此前 packages 1–21（含 CLI）构建完成 |
| 同上 | Windows / Node 24.16.0 | `npm run build:cli-bundle`（在共享依赖可读的执行上下文） | 0 · bundle built | `packages/cli/bundle/cli.cjs` 4.69 MB；产物为 ignored 文件 |
| 同上 | Windows / Node 24.16.0 | `npm run build:cli-dev` | 1 · blocked at `bundle:worker` | bundler 无法读取共享 `node_modules` junction；失败时清空的 tracked `packages/host/bundle/` 已按构建前状态恢复 |
| 同上 | Windows / Node 24.16.0 | `git diff --check` | 0 | 无空白错误 |

## 接续 / 结果

改动已实现并通过定向测试、架构检查、CLI workspace tsc 与 CLI bundle。完整 `typecheck:all` 和 worker bundle 受共享 junction 权限限制，完整失败签名已记录。Draft PR #612 已创建，最新 master 的计划索引冲突已通过 rebase 解决；PR 未合并。
回收：未回收；这是当前任务绑定的 managed worktree。
下一步：等待 PR 检查/review；未经授权不合并。
