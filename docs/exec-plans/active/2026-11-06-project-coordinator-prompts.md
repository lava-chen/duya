# Project Coordinator 提示词系统设计

状态：active · 负责人：Codex / chat 01a1b0b5-d6ad-7803-ac4e-c8285d15903e · 更新：2026-11-06
分支：`codex/project-coordinator-prompt-design` · worktree：`D:/codex/worktrees/project-prompt-design/duya` · base：`54dde175170178f030caebeffde2c1f543c40f40`（从初始 `7eaad892` 接到 #621 最新 head）

## 目标与边界

在 624 组合层基础上设计完整 Project Coordinator 提示词系统：职责、写法、角色与数据权威、段结构、注入与刷新、派工、结果处理、记忆、恢复和评估。前两轮交付设计与正文草案；用户于 2026-11-06 授权实施后，当前范围包括生产提示词、可信 Session 上下文、请求前刷新、工具准入与真实链路验证。开工时依赖未合并，第二轮调查中已由外部流程集成，见后文对账。

关联：[Coordinator 主计划](2026-11-02-project-coordinator.md)、[624 组合层](624-agent-composition-layer.md)、[首版合同](../../design-docs/project-coordinator-contract.md)。独占新增设计/参考文件与本计划；索引仅添加本任务入口。

## 验收

- 从本地 Codex clone 固定 SHA 追到提示词选择、消息角色、首次/增量注入、压缩恢复及工具说明的实际源码。
- 核对 Duya 的 Coordinator/Project/Task/Session/Run、工具准入、租约与结果回传；分别记录 624 检出和主检出 dirty 切片，不能混称已集成。
- 设计包含可直接评审的常驻提示词正文、动态上下文形状、事件处理决策、注入生命周期、预算和评估案例。
- 文档相对链接、编码、Git diff 检查通过；提交前执行根要求的类型与架构门禁，记录实际结果。

## 进度

2026-11-06 用户授权开始实施，复用本任务 managed worktree / PR #622。生产切片独占 `worker-prompts` 的 Project 资产/注册、`project/context.ts` / `tool-service.ts` / `identity.ts`、worker 上下文装配与 DB bridge 的必要接线及对应测试。共享检出的连续性/UI/role-policy dirty 成果只读保留，不整体复制。后续沿真实链路扩展本检出的 router：移除 cwd 派生的固定 system 快照，给新上下文请求补可信 attempt 关联；补注册缺失的 session capability（deferred，由 Coordinator 精确 allowlist 提升）。

- [x] 实施：五段正文、work context 行为、工具说明与 Coordinator todo 默认准入修复。
- [x] 实施：通过可信 Session 绑定读取 Coordinator/work 上下文，按模型请求刷新；revision、裁剪与来源诚实呈现。
- [x] 实施：覆盖绑定隔离、裁剪、失效、恢复与真实模型请求装配；重建 worker / Desktop 并跑门禁。
- [x] 实施：提交代码、更新同一 PR 与接续记录；未经授权不合并。

开工基线：`c1191047` / clean，Windows / Node v24.16.0；`npx vitest run` 执行 Project prompt/tool-service/tool-bridge/dispatch/work-session-continuity、agent-composition 与 worker-context：22 files / 143 tests，exit 0。Workspace 工具仍不可调用，按 Git/计划对账。#622 当前 Open/Draft，base=master。

- [x] 核对共享状态；创建独立 managed worktree，基于 624 已提交 head。
- [x] 学习官方提示词/上下文工程方法，核对本地 Codex 实现。
- [x] 追踪 Duya 实际协调与装配路径，区分现状和设计缺口。
- [x] 编写完整设计、英文提示词正文、验收与实施顺序。
- [x] 验证文档、执行门禁并通过 Draft PR 交付。
- [x] 第二轮：补读 Claude 新 Projects 一手体验、技术拆解和缺陷报告，核对最新官方文档。
- [x] 第二轮：把提示词行为绑定到实际工具/action/回执，标出缺失的读、写、唤醒与控制接缝。
- [x] 第二轮：修正设计中超出工具能力的承诺，补充验收并更新同一 Draft PR。

## 发现与决策

- 当前没有可调用的 `workspace_get_context` / workspace activity 工具，使用版本化计划、Git 和源码对账；不创建第二套 workspace 任务记录。
- 624 base `b5c36035`，head `7eaad892`；工作树干净。其计划记载尚未推送、未建 PR、bundle stale，不能作为已发布产品行为。
- 主检出存在另一任务的未提交 Project 连续性与 Runtime 改动；只读核对，不复制、暂存或改写。
- 本地 Codex clone：`E:/cloned-projects/codex`，SHA `fbf5f0d3a716d08c254d3e4941d5b12eaff5afe7`，提交时间 2026-11-03；没有 `.codegraph/`，按目录源码定位，不更新或修改该 clone。
- 交付物：[完整设计](../../design-docs/project-coordinator-prompts.md)、[Codex 与官方写作依据](../../references/codex-prompt-composition.md)。包含五段 Coordinator 正文及 work-context 草案、13 项装配合同和 15 类真实模型用例；未实际调用模型跑质量评估。
- 写作期间依赖状态已变：PR [#621](https://github.com/lava-chen/duya/pull/621) 已发布，最新查询为 Open / 非 Draft，head `54dde175`。相对原 base 仅新增 bundle 重建及 624 计划记录；本任务文档提交保存后接到该 head，PR base 使用该分支，不把 624 源码重复作为本任务 diff。
- `typecheck:all` 只产生 `inline-content.ts` 的换行/mtime 假 M；`git diff --exit-code` 为 0、numstat 为空后，内容中性 `git add` 刷新 index，未产生 staged source diff。本任务不提交生成文件。
- 全索引链接扫描发现一条已有断链：`docs/exec-plans/README.md` 指向缺失的 `active/2026-10-24-dynamic-workflow-package.md`；`git show HEAD:<index>` 与 `git cat-file -e HEAD:<target>` 已在原 base 复现。保留原状，不借本任务修整无关计划；新增文档与新增入口均单独检查。
- 第二轮扩展同一设计与 Claude 参考：读取当前官方正文、3 篇一手体验与 1 篇迁移记录、两份技术分析（含已读逆向）及 5 个具体缺陷报告；把旧 Chat Projects 测量和非本产品的并发基准排除。用户报告区分个人样本、`invalid` 标签与官方确认，未独立复现 Claude 缺陷。
- 新增设计 §12：逐项绑定 5 个 project action、6 个 session action 与 todo，给出回执/失败处理、调用轨迹和 T1–T9 工具验收。明确现有 session get 无全文读面、reply 拒绝活 Run、standalone 回执是 query、project 终态服务没有中途阻塞通知，以及项目设置/受保护用户动作的写面边界。
- todo 风险：现有 capability 的 replace 会删除同 Session 列表的非 `_` Task；Project dispatch 在该 Session 创建 canonical Task。内存 store 配合本检出已构建 TodoTool 复现了删除调用；不触碰真实 DB。建议先将 todo 移出新 Coordinator 默认准入，或先补完整 scoped adapter；本轮仅改设计，没有修改生产白名单或任何 Task。

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
| `21faa618` | Python / UTF-8 | 新文档与新增索引链接、fenced blocks 检查 | 0 | 三份新文档与 4 条新增入口通过；已有无关断链未计为本任务通过 |
| `185a13eb` + 三份文档 dirty | Windows / Node v24.16.0 | `npm run typecheck:all` | 0 | 第二轮重新执行通过；无生产源码修改 |
| 同上 | Windows | `npm run architecture:check` | 0 | 3201 tolerated，无新增违规；baseline 未修改 |
| 同上 | Windows / 已构建本检出 capability | `node docs-local/research/project-coordinator-prompts/todo-scope-repro.mjs` | 0（按预期复现风险） | 内存调用序列为 delete(project-task-1)、create(coord-step-1)，canonicalTaskRemains=false；未连接真实 DB |
| 同上 | Python / UTF-8 / PowerShell | 更新文档链接/fences、`check:encoding`、`git diff --check` | 0 | 三份更新文档无新增断链、编码或 whitespace 问题 |

## 设计阶段交付历史（当前见实施接续）

已交付：无生产改动。[设计](../../design-docs/project-coordinator-prompts.md) 与源码参考已完成；文档提交 `21faa618` 已推送，Draft PR [#622](https://github.com/lava-chen/duya/pull/622)，base=`codex/624-agent-composition` / `54dde175`。后续仅补充本段交付记录；最终 head 以 PR/Git 为准，提交后未提交路径应为空。
第二轮从文档 checkpoint `185a13eb` 接续，更新完整设计 §12、既有 Claude 参考与本计划，仍通过同一 #622 交付；提交后要求三份文档均干净。这一轮纠正的是设计中对工具能力的假设，没有实施接口补齐或 todo 隔离修复。
第二轮正文提交 `2ce49931` 已推送。随后复核发现依赖 #621 在 2026-11-06 20:23:22（Asia/Shanghai）由外部流程合入 `beb0d512`，GitHub 已把 #622 base 改为 master；`git diff --stat 54dde175..origin/master` 为空，代码与已验证基线一致。核对 #622 仍是 Draft，diff 仅 8 份文档；本 agent 未执行依赖或本任务合并。最新 head 以 PR/Git 为准。
外部副作用：创建 managed worktree、本地/远端任务分支、Draft PR、ignored 依赖 junction 与本检出构建产物。未合并、未发布、未修改主检出或 Codex clone。完整类型与架构检查在相同生产源码上通过；接到依赖时只改变已有 bundle 和依赖计划，未重复全量构建。真实模型质量/成本对照与 Desktop 端到端验收属于后续实施，尚未执行。
回收：成果尚未交付和集成，保留检出。
下一步：审阅 #622 的 §12 工具闭环，先裁定并实施 todo 隔离/默认准入、项目范围证据读面与真实唤醒/中途阻塞合同，再按 P1–P5 落地正文和产品验收。未经授权不合并依赖或本任务。


## 实施接续（2026-11-06）

已实现：五段稳定 Project 正文与 work-context 资产；独立 context policy；Coordinator 仅准入 session/project 并显式拒绝 catalog/invoke；generic system 的 hooks 权威说明与无关 Apps/MCP 提示不再混入 Coordinator；修正 session/project description 的 completion/query、reply/取消与跨 Coordinator 授权说明。

上下文：共享 Project service 从可信 Session 查询 coordinator/work 绑定，work 限自己的 Task；worker DB / Desktop / Agent Server 可信 attempt 三段接通。Run 内工具轮次在 prepare 前刷新同一 rail slot；恢复时重读；失败/unbound 显式失效，快照不写 timeline。Host renderer 保留 revision/acceptance、整条记录和裁剪标记，仅返回已展示的来源；旧 cwd 启动快照已移除。没有引入第二持久存储或猜测控制/审批状态。

验证阶段发现并修复三处接缝：Run 装配只一次（刷新必须进 prepare）；新 DB action 未列入可信 attempt 关联；session capability 的 schema/port 已有但 builtin 没注册。真实 Electron 测试已在独立 namespace、当前 dist/worker 下完成 project update_state → 下一请求 revision=1 / 新状态 / 稳定 system 前缀 / session+project 工具表，1/1 passed（loopback Anthropic，模型受控，无真实模型质量结论）。初次 E2E fixture 用错 closeDuya 参数，已修正并核对本任务 namespace 的测试进程，未触碰用户运行实例。

尚未实现的产品能力：Project 范围 transcript/artifact 全文读取、活 Run steer、中途 blocked/approval 事件投影、结构化用户决定/验收/设置写面。提示词按现有 schema 工作，不声称这些能力已提供。端到端测试不等同于真实模型对派工质量、歧义处理与成本的行为评估；B1–B15 仍待评估。


实施验证（基线 `c1191047` + 上述生产/文档/测试切片；Windows / Node v24.16.0 / npm 11.13.0）：

| 命令 / 范围 | 结果 |
| --- | --- |
| 开工相关测试 | 22 files / 143 tests，exit 0 |
| 最终相关 Vitest（Project、prompts、composition、rail、tool census、transport） | 42 files / 280 tests，exit 0；工具集预期随禁用 todo 合同更新，未跳过或放宽行为断言 |
| `npm run electron:build` | exit 0；随后因可信 action 和 session 注册修复，重建 `build-electron.mjs` / `bundle:worker`，均 exit 0 |
| `npx playwright test --config <本地 preview 配置> e2e/turn/project-prompt.spec.ts --project turn` | 1/1 passed，exit 0，14.7s；当前 dist renderer / main / worker，独立 namespace，无 Vite 复用；loopback 模型 |
| `npm run architecture:check` | exit 0，3203 tolerated（含 permitted edges），无新增阻断；未改 baseline |
| `npm run typecheck:all`（最终生产切片） | exit 0；含 4 项 eval recorder 检查；Electron 维持已有 baseline，无新增类型错误 |
| 六份 Project 模板 source / bundle 逐字节比较 | 全部相同 |
| `git -c core.whitespace=cr-at-eol diff --check -- . ':!packages/host/bundle'` | exit 0；保留 router 既有 tracked CRLF。生成 bundle 的 vendor 空白未手改 |

本轮边界：未调用真实供应商模型；未改用户共享检出，未合并或发布，未创建第二事实存储；保留 managed worktree。PR #622 仍 Draft，提交后检查和最终 head 以 Git / PR 为准。现有 whole-repo typecheck 包含 Electron 既有错误 baseline，不能称全仓零错误。


代码交付：`7b492c5c18e65cd054d5d3572fdd6b41a79709ce` 已推送到本任务分支 / PR #622。提交后 worktree clean；`bundle-verify.mjs --json` exit 0 / FRESH / 0 of 1120 inputs changed，worker-entry 与 BashWorker 均 fresh。随后仅补本计划交付记录，最终文档 head 以 PR / Git 为准。

当前下一步：对最新 PR head 执行 review/CI；评估 B1–B15 的真实模型协调质量，再按工具合同拆分后续产品能力。没有用户集成授权，不合并、不回收工作树。本次没有修改主检出的 dirty 项目连续性切片；跨切片集成时应对拍 Session context API 与本实现共享 Project service 的读取路径，保持单一绑定与存储权威。

## PR #622 与当前 master 对齐（2026-11-11，Asia/Shanghai）

- 独立 linked worktree：`.claude/worktrees/project-coordinator-prompt-design-fix`；分支 `codex/project-coordinator-prompt-design`，从 PR #622 head `1a90eed35` 接续。
- 将当前 `master` `96b98221a` 合入任务分支；自动检测到四处冲突，均已处理。源冲突涉及 Coordinator tool allowlist 与对应测试；bundle 冲突由合并后的源码重建解决。
- master 已把 `duya_app` 的 Session 操作拆成 `session_*`，但该层的 `session_spawn` schema 尚不接收 `projectTask`。Coordinator 继续只准入 Host 的规范 `session` capability 与 `project`，该 capability 创建并绑定 canonical Task；新增测试钉住其注册名和 `projectTask` schema。按已记录的 Task 删除风险排除共享 `todo`。
- 验证：`npm run build:packages` exit 0（22 包；含 Web 生产构建）；`npm run bundle:worker` exit 0（worker 5.50 MB，按当前 dirty 源码重建）；Project/Host/dispatch 相关 7 个 Vitest 文件 / 44 tests exit 0（其中最终 allowlist 测试 11/11）；`npm run -w @duya/host typecheck` exit 0；`npm run architecture:check` exit 0，无新增违规。bundle freshness 需在 merge commit 后复核。
- 冲突修复提交：`c166cb6d7874ded8362beb03a61893e0ea257731`（merge master + Coordinator session contract alignment）。提交后 `node scripts/architecture/bundle-verify.mjs --json` 为 FRESH，0/1120 inputs changed。
- 下一步：推送更新后的 PR #622 分支，刷新 `mergeable` 与 CI 状态；review / 必需 CI 通过后再处理 Draft。
