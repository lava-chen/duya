# TUI 输入框透明背景

状态：active · 负责人：Codex · 更新：2026-11-03

分支：`codex/tui-transparent-composer` · worktree：`D:\codex\worktrees\latest-master-cli\duya` · base：`550b664b07444ed9fc52698e1a3ad9f703ebc2ed`

## 目标与边界

允许 TUI composer 省略背景填充，让终端自身背景透出，同时保留输入框文字、占位提示与 reasoning 边框。`DUYA_TUI_COMPOSER_BG=transparent` 开启；未设置时保持当前主题色块。验证后将该选项设给本机的 master 测试安装。

关联：master 中的 TUI composer 背景实现（PR #567）。

## 验收

- 全屏模式不向 input region 写背景 SGR；inline 模式不生成背景标签和填充空格。
- 默认主题与现有行为不变，环境变量打开透明模式后两种模式均透明。
- 相关 TUI 测试、CLI typecheck、`npm run typecheck:all` 与 `npm run architecture:check` 通过。
- master 测试安装的 PowerShell 与 CMD `duya tui` 启动器均默认打开透明模式，`duya --version` 可运行。

## 进度

- [x] 复现并定位：当前 shell 没有 `COLORFGBG`，主题回退到 dark，composer 绘制 `236-bg`。
- [x] 增加透明背景解析与全屏/inline 渲染覆盖。
- [x] 更新本机 CLI 包并验证 PowerShell/CMD 解析与版本输出。
- [x] 门禁、提交并创建 Draft PR #595。
- [ ] 等待最新 PR head 的 CI 与 review；未经授权不合并。

## 发现与决策

- `RegionPatch.background` 已支持省略；inline composer 只需跳过背景标签和行尾填充。
- 保留默认 opaque 配色，使用单独的环境变量控制透明度，避免主题推断和 composer 表面选择互相耦合。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `550b664b`; pre-change | Windows 11 / Node 24.16.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/tui-codex-surface.test.ts` | 0; 14 passed | 既有行为基线 |
| dirty `codex/tui-transparent-composer` | Windows 11 / Node 24.16.0 | 同上 | 0; 19 passed | 新增透明主题解析、全屏清除和 inline 无底色断言 |
| dirty `codex/tui-transparent-composer` | Windows 11 / Node 24.16.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` | 1; 1377 passed, 1 failed, 1 expected fail | 唯一失败是未改动的 `slash/__tests__/presets.test.ts:20` POSIX mode bits 断言（Windows 返回 54） |
| dirty `codex/tui-transparent-composer` | Windows 11 / Node 24.16.0 | `npm run typecheck:all` | 完成；所有阶段通过 | Electron gate 无新增类型错误，CLI typecheck 与 eval check 通过；构建有既有 Rollup 注释/chunk 警告 |
| dirty `codex/tui-transparent-composer` | Windows 11 / Node 24.16.0 | `npm run architecture:check` | 0 | `OK — no new boundary violations` |
| dirty `codex/tui-transparent-composer` | Windows 11 / Node 24.16.0 | `npm run build:cli-dev`; `DUYA_CLI_VERSION=0.0.0-master.550b664-transparent node scripts/package-cli-release.mjs --output try-install/duya-cli-transparent` | 0 | 4.13 MB CLI bundle; standalone Windows package built |
| package `0.0.0-master.550b664-transparent` | Windows 11 / PowerShell + CMD | Set `DUYA_TUI_COMPOSER_BG=transparent` in package launchers, install under `%LOCALAPPDATA%\duya\master-cli\0.0.0-master.550b664-transparent`, add its `bin` first in user `PATH`; run `duya --version` | 0 in both shells | Both resolve to the new `duya.ps1` / `duya.cmd` and print the new version; previous installs remain on PATH |
| `c5d032c6` | GitHub | Push `codex/tui-transparent-composer`; open Draft PR #595 | Created | <https://github.com/lava-chen/duya/pull/595>; initial check snapshot had no statuses yet |

## 接续 / 结果

本机透明安装：`%LOCALAPPDATA%\duya\master-cli\0.0.0-master.550b664-transparent`；其 PowerShell/CMD 启动器为 TUI 设置透明背景并恢复调用 shell 的环境；用户 PATH 将新版 bin 放在首位，旧包装器和前一个 master 包仍保留。

当前源码提交：`c5d032c681be3324b41ede2d3d4404f0488d1258`；PR：<https://github.com/lava-chen/duya/pull/595>（Draft，初始 checks 尚未出现）。

下一步：检查 PR head 上的必需 CI 与 review；继续保留 Draft 和 worktree，获授权集成前不合并。
