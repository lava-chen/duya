# Project Coordinator 提示词系统设计

状态：active · 负责人：Codex / chat 01a1b0b5-d6ad-7803-ac4e-c8285d15903e · 更新：2026-11-06
分支：`codex/project-coordinator-prompt-design` · worktree：`D:/codex/worktrees/project-prompt-design/duya` · base：`54dde175170178f030caebeffde2c1f543c40f40`（从初始 `7eaad892` 接到 #621 最新 head）

## 目标与边界

在未合并的 624 组合层基础上设计完整 Project Coordinator 提示词系统：职责、写法、角色与数据权威、段结构、注入与刷新、派工、结果处理、记忆、恢复和评估。先交付可审阅设计与提示词正文草案，不在本轮改生产 Runtime 或替其他任务合并 624。

关联：[Coordinator 主计划](2026-11-02-project-coordinator.md)、[624 组合层](624-agent-composition-layer.md)、[首版合同](../../design-docs/project-coordinator-contract.md)。独占新增设计/参考文件与本计划；索引仅添加本任务入口。

## 验收

- 从本地 Codex clone 固定 SHA 追到提示词选择、消息角色、首次/增量注入、压缩恢复及工具说明的实际源码。
- 核对 Duya 的 Coordinator/Project/Task/Session/Run、工具准入、租约与结果回传；分别记录 624 检出和主检出 dirty 切片，不能混称已集成。
- 设计包含可直接评审的常驻提示词正文、动态上下文形状、事件处理决策、注入生命周期、预算和评估案例。
- 文档相对链接、编码、Git diff 检查通过；提交前执行根要求的类型与架构门禁，记录实际结果。

## 进度

- [x] 核对共享状态；创建独立 managed worktree，基于 624 已提交 head。
- [x] 学习官方提示词/上下文工程方法，核对本地 Codex 实现。
- [x] 追踪 Duya 实际协调与装配路径，区分现状和设计缺口。
- [x] 编写完整设计、英文提示词正文、验收与实施顺序。
- [ ] 验证文档、执行门禁并通过 Draft PR 交付。

## 发现与决策

- 当前没有可调用的 `workspace_get_context` / workspace activity 工具，使用版本化计划、Git 和源码对账；不创建第二套 workspace 任务记录。
- 624 base `b5c36035`，head `7eaad892`；工作树干净。其计划记载尚未推送、未建 PR、bundle stale，不能作为已发布产品行为。
- 主检出存在另一任务的未提交 Project 连续性与 Runtime 改动；只读核对，不复制、暂存或改写。
- 本地 Codex clone：`E:/cloned-projects/codex`，SHA `fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7`，提交时间 2026-11-03；没有 `.codegraph/`，按目录源码定位，不更新或修改该 clone。
- 交付物：[完整设计](../../design-docs/project-coordinator-prompts.md)、[Codex 与官方写作依据](../../references/codex-prompt-composition.md)。包含五段 Coordinator 正文及 work-context 草案、13 项装配合同和 15 类真实模型用例；未实际调用模型跑质量评估。
- 写作期间依赖状态已变：PR [#621](https://github.com/lava-chen/duya/pull/621) 已发布，最新查询为 Open / 非 Draft，head `54dde175`。相对原 base 仅新增 bundle 重建及 624 计划记录；本任务文档提交保存后接到该 head，PR base 使用该分支，不把 624 源码重复作为本任务 diff。
- `typecheck:all` 只产生 `inline-content.ts` 的换行/mtime 假 M；`git diff --exit-code` 为 0、numstat 为空后，内容中性 `git add` 刷新 index，未产生 staged source diff。本任务不提交生成文件。
- 全索引链接扫描发现一条已有断链：`docs/exec-plans/README.md` 指向缺失的 `active/2026-10-24-dynamic-workflow-package.md`；`git show HEAD:<index>` 与 `git cat-file -e HEAD:<target>` 已在原 base 复现。保留原状，不借本任务修整无关计划；新增文档与新增入口均单独检查。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `7eaad892`，本计划 | Windows / PowerShell | managed worktree 创建；`git switch -c codex/project-coordinator-prompt-design` | 0 | 独立检出，无生产修改 |
| `7eaad892` + 新增设计文档 | Windows / Node v24.16.0 / npm 11.13.0 | `npm run typecheck:all` | 0 | 全包构建、类型门禁及 4 项 eval recorder 检查通过；无生产源码修改 |
| 同上 | Windows | `npm run architecture:check` | 0 | 3201 项既有 tolerated，无新增违规；未改 baseline |
| 三份新增文档 | Python / UTF-8 | 相对链接和代码块检查 | 0 | 无断链；正文 text 块共 1452 English words，含 work brief/work-context |
| `226339c4`（文档 checkpoint）/ base `54dde175` | Windows | `git rebase --onto origin/codex/624-agent-composition 7eaad892` | 0 | 仅重放本任务文档提交；对依赖 diff 为 7 份文档，无源码 |
| 同上 | Windows | `node scripts/architecture/bundle-verify.mjs --json` | 0 | FRESH，0/1119 inputs changed；本轮未重建 worker |
| 文档切片 | Windows | `npm run check:encoding`、`git diff --check` | 0 | 无新增编码或 whitespace 违规 |

## 接续 / 结果

已实现：无生产改动。[设计](../../design-docs/project-coordinator-prompts.md) 与源码参考已完成；本任务文档 checkpoint `226339c4`，后续仅补充验证/交付记录，最新 head 以 Git 与 PR 为准。未提交路径：当前仅本设计与计划的交付记录，提交前逐项复核。
外部副作用：创建 managed worktree、本地分支、ignored 依赖 junction 与本检出构建产物；尚无推送/本任务 PR/合并。完整类型与架构检查在相同生产源码上通过；接到依赖时只改变已有 bundle 和依赖计划，未重复全量构建。真实模型质量/成本对照与 Desktop 端到端验收属于后续实施，尚未执行。
回收：成果尚未交付和集成，保留检出。
下一步：提交交付记录，创建以 `codex/624-agent-composition` 为 base 的文档 Draft PR；不合并依赖或本任务。
