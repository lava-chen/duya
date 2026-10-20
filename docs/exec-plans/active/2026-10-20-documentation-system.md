# 精简文档入口与长程开发接续

状态：待 draft PR / 基线门禁修复 · 负责人：会话 `01a15907-e31a-7d13-b232-d6e88fde95b5`
分支：`codex/docs-pr-worktree-policy` · worktree：managed `docs-pr-worktree-policy` · PR 基线：`8a01159c`

## 目标与边界

让新会话从短入口找到本次任务、验收条件和下一步；让新文档有明确归属。
只改文档与文档忽略规则，保留已有代码、CI、安全脚本及 `CLAUDE.md` 的暂存删除。
原有未提交文档包含根 AGENTS、计划索引、496 和 development 目录；在其基础上整理。

## 验收

入口链接能在新检出解析；规则、操作流程、执行状态各有一个维护位置。
所有旧计划仍可定位；本地材料移动前后内容哈希一致，并保留路径映射。
文档检查、编码检查与适用仓库门禁记录命令、退出码和范围；不把文档契约当成功能实现。

## 进度

- [x] 阅读当前入口、已有改动与引用对话；对话回答正文不可用。
- [x] 查阅 Claude Code 官方指南、Anthropic 长程 harness 博客与 OpenAI ExecPlan。
- [x] 精简根入口，明确文档归属、写作规范和计划模板。
- [x] 分离计划路由、完整目录与历史，修正 worktree / 接续流程。
- [x] 整理本地档案，核对链接、Git 可见性与内容保留情况。
- [x] 记录验证结果和剩余限制。
- [ ] 文档范围外的既有门禁失败处理后，重新验证再考虑提交。

## 决策

- 保持现有 active/backlog 计划路径，避免破坏实现注释和外部引用。
- 新完成计划进入可跟踪的 archive；旧 completed 保留，避免把数百份本地历史意外纳入 Git。
- 不重建 CLAUDE.md；延续用户已有删除。文档入口统一到 AGENTS.md。

## 验证记录（2026-10-20）

环境：Windows / PowerShell，HEAD `8a01159c`；共享检出有并发的脚本、CI 和其他改动，未作为本任务成果纳入。

| 检查 | 退出码 / 结果 |
| --- | --- |
| 临时 Python 扫描本次入口与流程的 Markdown 链接、anchor、Git 忽略状态及活动计划覆盖 | exit 0；21 份文档、134 个链接，无遗漏入口 |
| 本地迁移 SHA256 对比 | exit 0；165 个原文件保持内容，research 原路径保留；散落 UI 调研另校验 1 份 |
| 本次文档 UTF-8 / 无 BOM 检查 | exit 0 |
| `git -c core.whitespace=cr-at-eol diff --check -- AGENTS.md .gitignore docs` | exit 0 |
| `npm run typecheck:all` | exit 1，首个 check:encoding 报 `packages/ui/src/contracts/git.ts` 第 10 / 125 行 gbk-em-dash；后续类型检查未运行 |
| `npm run architecture:check` | exit 1，`packages/host/tests/worker-product-runtime/gate-run-approval-reachability.test.ts` 深导入 `@duya/agent-runtime/engine/ports`，managed 模块不允许 |
| `git diff --quiet HEAD -- <上述两个失败文件>` | exit 0；两个失败源文件与 HEAD 一致，本任务未修改 |

原始扫描报告保存在本机临时验证目录；核心结果已在本表保存。未重新执行全量测试或 UI 验证：本次没有生产代码或 UI 行为改动。
Workspace context 工具本会话不可用，接续以版本化计划与 Git 对账。

## 接续

### 第二轮：逐篇精简与常驻规则（2026-10-20）

用户要求逐篇审查 development，并让自动加载的 AGENTS 直接承载关键约束。
本轮已检查并修订全部 10 篇，根规则增至 89 行，直接写关键动作与专题读取条件。
仅改文档，保留其他会话新增的 scripts 规则与所有无关改动。
逐篇结果（含空行）：README 17 行；build 69→29；code-review 30→22；documentation-style 31→30；
engineering-loop 48→30；footguns 68→17；logging 22→16；release 138→32；testing 62→30；worktree 79→72。
发布旧文档重复三遍流程且混用 PATCH / MINOR；现改为一次流程与明确候选版本，不在整理中另定发布策略。
构建依赖核对过实际 build 脚本，改为引用权威清单；E2E 环境核对过当前 config / helpers。
worktree 保留回收前置条件、dry-run 局限、ignored 备份与部分摘链后的对账，不为减行删除恢复语义。

本轮验证：根 / docs AGENTS 与全部 development 指南的 UTF-8、链接目标、anchor 与 Git 可见性检查通过；
`git -c core.whitespace=cr-at-eol diff --check -- AGENTS.md docs` 通过。
上一轮记录的两个整仓门禁失败本轮未重跑，不作为本轮验证结果；本轮仅改文档，无 UI 或生产行为变化。

### 第三轮：收敛顶层目录（2026-10-20）

本轮起点 HEAD `d226a74dc3f0e90eaadf3d81f788aae4666899a3`，保留共享检出其他修改。
移除 recovered 顶层目录：479 的来源、历史契约与不可直接复用的限制合入原计划；
3 份旧原件移至本地 archive，并保留可从上述 Git 提交读取的路径，未改动生产实现。
Claude Desktop UI 报告与 4 张截图归并到被忽略的本地 research 主题目录；8 个移动原件逐一验证 SHA256。
更新根 / docs AGENTS、文档地图、历史引用说明及忽略规则，禁止重建此类顶层分类。
本轮验证：20 份入口文档、139 个本地链接及 Git 可见性通过；8 个移动原件 SHA256 一致；
3 份恢复材料与保留提交的内容一致（排除 checkout 的 CRLF / LF 差异）；本次 diff 空白检查通过。

文档整理已落盘；先前三轮未暂存、提交、创建 PR 或合并；第四轮状态见下文。前轮门禁结果见对应记录，不作为当前 HEAD 的重新验证。
下一步：在独立任务中确认并处理上表两处基线失败，再重跑根门禁；不要为文档整理扩大生产修改或重录架构 baseline。
本任务路径为根 AGENTS / 文档忽略规则及文档入口、流程和计划；496 原有改动、脚本和 CI 均非本任务实现。
本地归档有路径与哈希 manifest；旧目录移除，原文件内容保留。文档契约不代表自动 lease / journal / 恢复功能已实现。


## 第四轮：强制每个 agent 隔离并经 PR 交付（2026-10-20）

此前在共享检出修改违反用户明确的隔离要求；现已创建并绑定独立 managed worktree，后续只写此检出。
30 个文档 / 配置文件复制后逐一校验 SHA256，恢复目录删除作为本任务切片带入；共享源文件和 index 保持原样。
未带入其他会话的 CI、E2E、Host、安全拆卸脚本、496 修订和 CLAUDE 的暂存删除。
新规则直接写在根 AGENTS：所有 agent、文档和小改均使用独立 worktree，所有变更经 PR，不直推 master/main，不自行合并。
分配、依赖、修改、验证、commit、PR、授权集成、合并后重验、安全回收和回收后清单核对逐段规定产出。

创建时基于本地 `d226a74d`；发现其包含其他会话两个脚本提交，最终文档分支会排除它们，以远端 `8a01159c` 为基线。
依赖经 junction-worktree dry-run 后配置了 62 个链接；没有通过共享 node_modules 安装依赖。
独立检出已重跑 typecheck:all 与 architecture:check，仍分别失败于 UI 契约编码和 Host 测试 deep-import；不改基线或生产代码掩盖失败。
这些失败源文件、对应检查器及架构策略与 PR 基线一致，基线对比证据另行记录。

原始 TUI slash 调研保留在本 worktree 的 ignored research，未提升为版本化 references。
独立文档检查：20 个入口、136 个本地链接（去除原始调研入口后）、UTF-8 与 Git 可见性通过；暂存范围仅文档和忽略规则。
失败源文件与检查器相对 origin/master 的 diff exit 0，证明基线对比成立。

当前成果供 draft PR 审阅，禁止作为全绿集成。尚未获得合并授权，worktree 和分支必须保留。
下一动作：核对文档链接和切片、提交并创建 draft PR；之后由集成者处理已记录基线失败，review/CI 通过且获授权后合并与重验。
回收由创建本检出的管理工具执行；合并前不归档，ignored 验证产物先决定是否保留，结束后核对 worktree 清单与成果可达性。
