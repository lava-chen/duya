# TUI 输入框透明背景

状态：completed · 更新：2026-11-03

实现分支：`codex/tui-transparent-composer` · 实现提交：`c5d032c681be3324b41ede2d3d4404f0488d1258` · 起始 base：`550b664b07444ed9fc52698e1a3ad9f703ebc2ed`
归档更新分支：`codex/archive-tui-transparent-plan` · base：`cccab45e852c2e3402c8d64e2536873100db2063`

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
- [x] 门禁通过；提交并创建 PR #595（初始为 Draft）。
- [x] PR #595 最新 head 的五项 CI 全部通过，并经用户授权以 merge commit 合并。
- [x] 拉取合并后的 master，构建并安装临时 CLI；PowerShell/CMD 均可从用户 PATH 调用。

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
| PR #595 head `cef3eed4` | GitHub Actions | `architecture`, `build`, `test`, `test scope`, `typecheck` | 全部通过 | PR 状态为 MERGED；merge commit `cccab45e852c2e3402c8d64e2536873100db2063` |
| master `cccab45e` | Windows 11 / Node 24.16.0 | `npm run build:cli-dev`; `node scripts/package-cli-release.mjs` | 0 | 临时包 `0.0.0-master.cccab45-transparent` 构建成功；打包 Node 可加载 `better-sqlite3` |
| package `0.0.0-master.cccab45-transparent` | Windows 11 / PowerShell + CMD | 将 `%LOCALAPPDATA%\duya\master-cli\0.0.0-master.cccab45-transparent\bin` 放在 PATH 首位后运行 `duya --version` | 0 in both shells | 两个 shell 均解析到该 master 包并输出对应版本；用户 PATH 已将其置于旧安装之前 |

## 接续 / 结果

本机透明安装：`%LOCALAPPDATA%\duya\master-cli\0.0.0-master.cccab45-transparent`；其 PowerShell/CMD 启动器为 TUI 设置透明背景并恢复调用 shell 的环境。用户 PATH 已将该包的 `bin` 置于旧安装之前；已有终端/Codex 进程仍持有更新前的 PATH，需重启进程后才能通过裸命令名解析到新版本。

实现提交：`c5d032c681be3324b41ede2d3d4404f0488d1258`；PR：<https://github.com/lava-chen/duya/pull/595>；合并提交：`cccab45e852c2e3402c8d64e2536873100db2063`。五项 GitHub Actions 检查全部通过。当前 master 与该合并提交一致。

最新临时安装版本：`0.0.0-master.cccab45-transparent`。新启动的 PowerShell/CMD 会按用户 PATH 优先解析它；本次检查的 Codex 子进程继承了旧 PATH，验证时显式刷新进程 PATH 后两种 shell 均正确解析。用户重启已有终端/Codex 后可直接运行 `duya tui`。
