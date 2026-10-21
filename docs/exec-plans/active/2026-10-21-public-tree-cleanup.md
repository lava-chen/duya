# Public repository tree cleanup

状态：active（draft PR #340）· 更新：2026-10-21
分支：`codex/public-tree-cleanup-review` · worktree：`/workspace/duya-pr340-review` · PR：[PR #340](https://github.com/lava-chen/duya/pull/340) · 最新 master：`16ee9dda`（含 #343）

## 目标与边界

让 GitHub `master` 根目录只保留仓库入口、配置和产品源码；将机器本地工具、一次性实验/诊断材料移出公开树；将中文入口与架构资料放到有明确职责的文档位置。保留打包必需配置及其行为。只整理当前树，不重写 Git 历史、不合并 PR。

本次复核对象：`.codex/skills/visual-component-verify/`、`.codegraph/`、`.demo-stage/`、`build/`、`.tui-pty-smoke.mjs`、根文档及共享检出里的未跟踪文件。共享检出的 `.e2e-diff.ps1`、`.vitest-diff.ps1`、`docs/references/tui-slash-command-survey.md` 不进入此 worktree。

## 验收

- 根目录不再展示本地 Codex/CodeGraph 状态、废弃设计原型或一次性 PTY smoke 脚本；可复用产品资源与测试仍在原职责目录。
- 中文 README 与架构资料迁入 `docs/`；根 README/AGENTS/贡献入口及相关链接可到达新位置。
- `build/` 不再承载产品打包配置；Electron entitlements 仍被打包配置正确引用。
- 逐项检查删除/迁移候选的跟踪状态、生产引用、历史依赖和内容保留；本地未跟踪材料不进入提交。
- 按适用的文档链接/编码/diff 检查和仓库打包门禁验证；记录命令、退出码与限制。

## 进度

- [x] 只读核对：本地 `master` 与 `origin/master` 均为 `c8df0e0`；根目录清单、忽略规则、候选引用和打包 entitlement 路径已检查。
- [x] 完成候选文件的归属决策。
- [x] 在本 worktree 实施整理与链接更新。
- [x] 验证文档链接、文件可见性、打包引用和根目录清单，审查 diff。
- [x] 提交并创建 draft PR；不合并。

## 发现与决策

- `build/` 中实际只有两份 macOS Electron entitlements；`electron-builder.yml` 明确引用它们，不能直接删除。迁入 `resources/packaging/` 并更新配置。
- `.codegraph/.gitignore` 只是为了显示 CodeGraph 私有索引目录的哨兵文件，而根 `.gitignore` 已忽略 `.codegraph/`。
- `.codex/skills/visual-component-verify/SKILL.md` 是仍可复用的仓库级 Codex Harness 技能；审计后恢复跟踪，仅豁免该技能文件及其父目录于 `.gitignore`，`.codex` 其余内容仍忽略。
- `.demo-stage/` 是三份临时 UI 副本；当前源码未发现其路径引用。`.tui-pty-smoke.mjs` 固定了 `E:/Projects/duya` 并向 `E:/tmp` 写日志，未发现其他引用，作为一次性脚本删除。
- `vitest.config.501.mts` 明确标注为临时 SQLite ABI workaround，但没有任何 package script、CI、测试或文档入口调用它，也没有脚本生成其 `node_modules/.bs3-node` 目标。当前 `scripts/ensure-sqlite-abi.mjs` 已由测试/Electron 生命周期钩子调用并负责切换原生绑定，因此该旧配置可删除。
- `README_CN.md`、`ARCHITECTURE.md`、`ARCHITECTURE_MAP.md`、`ARCHITECTURE_AUDIT.md`、`RUN_TURN_INPUT_CONTRACT.md` 均有明确的 `docs/` 归属。架构资料迁入 `docs/architecture/`，中文入口迁为 `docs/README.zh-CN.md`；根 README 加语言入口，文档地图和可点击入链随之更新。
- `MONOREPO_RFC.md` 根文件只有一个指向 plan 587 reference 的 5 行指针，原件已在计划目录，删除冗余指针。
- `design-qa.md` 含本机截图/临时输出路径，记录的若干结论仍为 blocked、没有可复用截图证据，且无活跃入口引用；从公开根目录删除，发布说明移除失效链接。未声称迁移到本地目录。
- 当前检出中的三份未跟踪文件属于共享状态；本次不复制、不改名、不删除。
- `npm run electron:build` 实际只构建 Electron bundle，不读取 `electron-builder.yml`；本次用 YAML 解析与文件存在性检查验证 macOS entitlements 引用。完整 macOS target 应由 macOS 主机/CI 构建验证。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `c8df0e0`; task slice dirty | Windows / PowerShell; Node 24.16.0 | changed Markdown links | 0 | 163 local links across 19 changed documents; 0 broken |
| `c8df0e0`; task slice dirty | Windows / PowerShell; Node 24.16.0 | `npm run typecheck:all` (final tree; run twice) | 0 | no new type errors; gate reported 231 known across 111 keys; embedded recorder check 4/4 passed |
| `c8df0e0`; task slice dirty | Windows / PowerShell; Node 24.16.0 | `npm run architecture:check` | 0 | no new boundary violations after root config allowlist update |
| `c8df0e0`; task slice dirty | Windows / PowerShell; Node 24.16.0 | parse `electron-builder.yml` and assert both `mac` entitlement paths exist | 0 | both paths resolve under `resources/packaging/`; full macOS packaging not run on Windows |
| `c8df0e0`; task slice dirty | Windows / PowerShell; Node 24.16.0 | `git diff --check` | 0 | no whitespace errors |
| `c1887b9`; clean committed worktree | Windows / PowerShell | compare branch with current `origin/master` (`5b12f72`) | 0 | 1 task commit ahead, 4 upstream commits ahead; no changed-path overlap; GitHub reports PR mergeable |

## #343 合并后的复核

- 已把 `origin/master`（#343 合并后 `16ee9dda`）合入独立 worktree；PR #341 仍未合并。PR #340 当前保持 Draft。
- 相对最新 master 的清理变更初始有 9 个文件删除；恢复 Codex Harness 技能后，净删除为 8 个文件。七项文档/配置迁移包含五份文档和两份 entitlements。
- `electron-builder.yml` 的 macOS entitlements 指向 `resources/packaging/entitlements.mac.plist` 与 `.inherit.plist`；文件存在且内容与原文件一致。Linux 上无法验证实际 macOS 签名/打包产物，需等待 PR CI 的 macOS package job 并检查产物权限。
- 架构检查、全仓类型检查、规则测试和 packaged-artifact 静态门禁已通过；类型检查使用 4 GiB Node heap。完整跨平台 CI 尚待本次 head 推送后运行。
- 本地安装使用 `npm ci --ignore-scripts`，因此未运行依赖原生 postinstall 的 Electron/macOS 打包。

## 接续 / 结果

历史记录：初始实现提交为 `c1887b9`。本次接续新增 master 同步合并与审计修正；完成 macOS 产物和 CI 验证前，继续保留 Draft，不合并。
