# Public repository tree cleanup

状态：active（draft PR #340）· 负责人：本会话 · 更新：2026-10-21
分支：`codex/public-tree-cleanup` · worktree：managed `public-tree-cleanup` · 原始 base：`c8df0e0192b7a4b55e74e78431417c71e9114df0` · PR：[PR #340](https://github.com/lava-chen/duya/pull/340)

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
- `.codex/skills/visual-component-verify/SKILL.md` 是本地 agent 工具，不是产品源码；从公开树移除，并同步加入 Git 与 ZCode 忽略规则。
- `.demo-stage/` 是三份临时 UI 副本；当前源码未发现其路径引用。`.tui-pty-smoke.mjs` 固定了 `E:/Projects/duya` 并向 `E:/tmp` 写日志，未发现其他引用，作为一次性脚本删除。
- `vitest.config.501.mts` 明确标注为临时 SQLite ABI workaround；全仓只有根配置清单引用，本机 `.bs3-node` 备用目录不存在。将其保留在被忽略的 `.codex/` 本地工具区，并从公开根目录门禁清单移除。
- `README_CN.md`、`ARCHITECTURE.md`、`ARCHITECTURE_MAP.md`、`ARCHITECTURE_AUDIT.md`、`RUN_TURN_INPUT_CONTRACT.md` 均有明确的 `docs/` 归属。架构资料迁入 `docs/architecture/`，中文入口迁为 `docs/README.zh-CN.md`；根 README 加语言入口，文档地图和可点击入链随之更新。
- `MONOREPO_RFC.md` 根文件只有一个指向 plan 587 reference 的 5 行指针，原件已在计划目录，删除冗余指针。
- `design-qa.md` 含本机临时截图/输出路径，按原始 QA 记录迁入被忽略的 `docs-local/research/`；发布说明移除指向该报告的失效条目。
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

## 接续 / 结果

实现提交 `c1887b9`，计划状态已另行提交并推送。draft PR [#340](https://github.com/lava-chen/duya/pull/340) 未合并。2026-10-21 检查时，PR head 为 `2ba27ce`、目标 `master` 为 `5b12f72`；两侧自原始 base 以来修改的路径无交集，GitHub 报告可合并；该 head 的 `Test` workflow 正在运行。继续前先核对 PR 最新 head、必需 review 与 CI；由获授权的集成者决定是否合并。保留 managed worktree 与本地 ignored 材料。
