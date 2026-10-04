# 587 — Agent Harness / Monorepo 架构重构主计划

> Status: Active — R1 与 T3 完成；R2、M5、C6、D7 全部切片已合并但各有自评 partial 余项；E4 停在 E4.4（四条都有证据，无一条验收）；H8.1 在 PR #178 **未合并**。G0 的门禁债仍在收敛，测试门禁按设计仍然红。
> Created: 2026-10-03. Priority: P0. 唯一执行队列：本文件。
> Current task: **合并 PR #178（H8.1 headless CLI 走共享 Run API）**——它是 H8 的唯一 Ready 切片，且它的退出条件里就写着"没有 packaged host smoke"。在它落地前，其余阶段只剩各 PR 自评 partial 的余项，**没有一条可以宣称完成**。
> **本表的证据基准**：`origin/master` = `55384c55`，合并 PR #138–#195（#165/#170 closed-unmerged，#178 open）。状态与 PR 的对应逐条列在下表"完成证据"列；CI 数字只取 master push 的已结束 run。
> **R1 与 T3 已完成**：R1 四个接缝修复、串行写队列与终态 barrier、typed receipt 与 CAS 对账、结果面区分"无活动"与"未实现"（注入 delay 的有界退避 25ms 翻倍、每 run 500ms 上限，按毫秒设界，因为 `settle` 要等写队列才发布终态）。T3 单一词汇 owner、单一 emit 入口、seq/cursor/replay、coalescing、三 transport。
> **R2/M5/C6/D7 是"切片全合并、余项自评 partial"，不是 Done**：#153 第4项（运行期 catalog 刷新）、#154 第3a/4项（预算抢占、在跑工具）、#155 第5项（cancel 关审批/唯一 deadline）、#169"跨 run start/terminal owner"、#171 S3（CLI contract）、#175（自述"头部迁移未做"）都由交付 PR 自己标注 partial，见各阶段文件的逐条理由。
> **E4.4 四条都有证据、都没有验收**：第1条真实 Electron turn 成立，但 `e2e/turn/electron-turn.spec.ts` 两条陈旧断言仍开着（#188 之后该文件未再被修改）；第2条 **unsupported**（无 live provider key，离线 provider 按本文件规定不能替代 P6）；第3条 macOS CI **真的产出过 electron-builder 包**且 `afterPack` 校验了包内 agent-bundle 与 BashWorker，但打包应用**从未被运行**，`check:packaged-artifacts --packaged` 每次仍打印 `UNVERIFIED`；第4条 #195 三个状态 + 主题共 4 个测试全绿走真实 Electron 桥。
> 已知待决：`better-sqlite3@13` 随 tarball 附带 N-API prebuild → V8-ABI swap 路径可能大部分冗余。
> 本次交付为**计划状态对齐**（只改本目录文档）；不代表运行时修复或架构迁移已经完成。

## 1. 执行 agent 从这里开始

1. 读仓库 `AGENTS.md`、[项目索引](../../README.md) 的 Verified baseline、`ARCHITECTURE.md`。
2. 读本文件、[合同](00-contracts.md)、当前任务对应阶段文件；无需逐篇读历史方案。
3. 核对当前源码、Git/PR、测试与共享状态。文档中的已落地记录不是当前正确性的替代证据。
4. 领取下表唯一 Ready 阶段的第一个未完成任务；跨阶段接口以 00 为准。遇到已有工作先衔接，不能另写同一修复。
5. 实施前写窄范围变更清单；大型/跨模块迁移按仓库 worktree → PR 流程，避免覆盖脏主检出。
6. 完成任务后更新阶段 checkbox 和 [执行日志](11-execution-log.md)，附 commit、验证命令/结果、限制、下一任务；阶段门槛满足才推进主表。

任何 agent 都不应从历史文件的旧 M/PP/C 编号自行排期。历史文件保留取证，**587 的编号、合同和阶段门槛接管实施**。修改合同需更新受影响测试与接管映射。

## 2. 交付目标与边界

交付能够被 Desktop、CLI、automation/workflow 及 evals 共同消费的 run 引擎：输入与身份明确，执行有唯一控制入口，预算/取消/审批可靠，持久化结果可信，可在声明支持的边界恢复，工具副作用可对账。

本主线接管 429、550、583、584、585、586 与 Workspace Phase 0；整合 MONOREPO_RFC 和 architecture 系列的重构规划。已实现代码保留，未验收事项不沿用旧勾选。独立产品计划通过 [依赖与接管表](10-legacy-crosswalk.md) 协调；不把 UI/Bot 功能混进拆包提交。

不提前建立通用 tools/memory/storage/ui 包，不整体改名 conductor，不把 Session 改成外部 Channel，不重建 Project identity，不承诺任意外部工具 exactly-once，不开放未实现 capability。

## 3. 主阶段与唯一 Next action

| 阶段 | 状态 | 前置 | 本阶段下一任务 | 完成证据 |
| --- | --- | --- | --- | --- |
| G0 [基线与治理](01-baseline-and-gates.md) | **In progress** | — | G0.2 合同/迁移测试独立 job（`.github/workflows/test.yml` 现只有 `architecture`/`test`/`build`）；随后才谈 required checks | 可重复基线 #138、文档事实 #139、CI 接线 #140、构建次序 #143、跨平台门禁 #146、G0.3/G0.4 收尾 #148、electron 二进制 #151；CI 债波 A #183–#187、波 B #189/#192、inventory 断言 #193 |
| R1 [Run 结果与存储](02-run-correctness.md)  | **Done**（R1.1–R1.4） | G0 | 无。#168 自评 "closes phase R1" | #147 R1.1、#149 R1.2、#162 R1.3、#168 R1.4 |
| R2 [真实 worker 控制](03-worker-control.md) | **In progress**（R2.1–R2.4 已合并） | R1 | 四条自评 partial：manifest 运行期 catalog 刷新（#153-4）、预算抢占 + 在跑工具（#154-3a/4）、cancel 关审批/唯一 deadline（#155-5） | #150 R2.1、#153 R2.2、#154 R2.3、#155 R2.4 |
| T3 [协议与事件传输](04-protocol-and-streams.md)  | **Done**（T3.1–T3.5） | R2 | 无。**例外**：T3.1 的"可验证兼容发布窗口"对 `private: true` 包不成立，shim 退出条件只能是消费者归零（#156 明确拒绝声称有窗口） | #156 T3.1、#157 T3.2、#158 T3.3、#159 T3.4、#161 T3.5 |
| E4 [行为基准与 evals](05-behavior-and-evals.md)  | **In progress**（E4.1–E4.3 已合并；E4.4 四条均有证据、均未验收） | R2；传输比较需T3 | E4.4 第1条已裁定：`:384` 末帧那条**测试错**（`title_generated` 是合法的终态后 host 帧，规格 :278/:313）已改为断言不变量；`:430` 那条**断言对、产品缺**——`assistant.message_finalized` 无任何路径产出，**不得**改到 `assistant.text_block`，缺口已入 census `NOT YET WIRED` 行并加门禁。补齐需扩 worker wire | E4.1 #160、E4.3 #163、E4.2 #164、对账 #179、打包门禁 #180/#191、真实 turn #181/#188、namespace 隔离 #190、三状态+主题 #195 |
| M5 [包与 host 迁移](06-package-and-host-migration.md)  | **In progress**（M5.1–M5.5 已合并） | G0、T3、E4 | M5.2-S3 CLI contract 拆分（#171 自评 not done）；M5.3 纯岛四项一项未迁；M5.4 头部迁移（#175 自述"not done"） | M5.1 #166、M5.2 #171、M5.5 #172、M5.3 纯度门禁 #173、M5.4 #175；分类更正 #174 |
| C6 [ControlPlane / Workspace](07-control-plane-and-workspace.md)  | **In progress**（C6.1–C6.2 已合并） | R2、E4；整体替换需M5 | C6.1 跨 run start/terminal 单一 owner（#169 自评 partial，只有 HostMap）；C6.3 resolver 五条未开始 | C6.1 #169、C6.2 #176 |
| D7 [恢复与长期工作](08-recovery-and-long-running.md) | **In progress**（D7.1 已合并；D7.2–D7.4 未开始） | T3、C6 | D7.2 lease/fence/recovery attempt——`#177` 只交付 D7.1，resume/determinism/pause 仍显式 unsupported | #177 |
| H8 [多 host 与退役](09-headless-and-retirement.md) | **In progress**（H8.1 **未合并**；H8.2 在飞未推） | M5、C6、D7 | 审并合并 PR #178（`feat/587-h8-1-headless-run-api`，5 项中 4 项 done，evals runner 共享组合自评 partial） | **无 merged PR。** H8.1 证据只存在于分支与 open PR #178 |

### 3.1 表内数字的实测口径

- **CI（唯一可与历史比较的口径，取 master push 的已结束 run）**：`#192`（`1ffabfc9`，run `37194425248`）三OS **collect 完全相同**（1096 文件 / 13016 测试）——ubuntu **19 失败文件 / 42 失败测试**、macos **28 / 80**、windows **13 / 34**。对照 `5dc45fcf`（587 之前，ubuntu 72 / 216）与 `#190`（ubuntu 37 / 66、macos 47 / 105）：**macOS 始终是最差的一条腿**，只在 ubuntu 上验证会少算。`#192` 之后没有已结束的 run，`#195` 的 run `37199119040` 写作时仍在跑。
- **架构门禁（本文件写作时在 `55384c55` 亲自跑，纯 `node` 脚本、不需要 `node_modules`）**：`architecture:self-test` exit 0，460 / 227 / 0 / 146 / 25 / 16 / 0；`architecture:check` exit 0，total **874** = tolerated **874**、baseline **811**、**131** 条基线指纹不再触发。与执行日志在 #191 记录的数字**逐项一致**，没有漂移。
- **未跑的**：`npm run architecture:baseline --write` **从未运行**，本切片也没有运行。`typecheck:all` / `npm test` / `npm run electron:build` **本切片未跑**（本切片是纯文档，不安装依赖）。`electron:pack` **本机从未跑过**（磁盘），但**CI 的 macOS `build` job 真的跑过**——见 [05 阶段文件](05-behavior-and-evals.md) E4.4 第3条。

设计、夹具和无冲突的纯叶子预备工作可以提前准备；**前置没有通过时不切换生产路径，也不把阶段标成完成**。E4 的运行行为测试可以在 T3 完成前启动。C6 的纯 resolver/模型设计可与 M5 的无交集切片交错，不并行修改同一 owner。

```mermaid
flowchart LR
  G0 --> R1 --> R2 --> T3 --> M5 --> H8
  R2 --> E4 --> M5
  E4 --> C6 --> D7 --> H8
  T3 --> D7
  M5 --> H8
```

## 4. 阶段实现文件与支持资料

- [00 合同与已定决策](00-contracts.md)：包/进程边界、状态与取消、Workspace、审批、seq、secret、兼容策略。
- [迁移映射](migration-map.md)：旧 agent 全模块、Electron 区域和目标职责；每个切片的端口与退出条件。
- [接管映射](10-legacy-crosswalk.md)：旧 PP/M/C、550 子任务、583 ISS、429 和关联计划的唯一归属。
- [执行日志](11-execution-log.md)：阶段证据、阻塞与handoff模板。下一步必须可执行。
- [历史资料索引](reference/README.md)：旧设计和评审，仅用于证据；不能覆盖合同。
- [旧计划索引](history/README.md)：原文完整保留，状态 superseded，不表示旧任务全部完成。

## 5. 统一 PR 与验收纪律

一个 PR 一个逻辑切片；不把类型移动、协议行为变更、schema收缩混在一批。每个 PR 都写明旧调用 → 新调用、真实消费者、回退开关、旧 shim 删除条件。

共用检查：`npm run typecheck:all`、`npm run architecture:check`、针对变更的有意义测试。审计 resolver 改动补 `architecture:self-test` 并审查 baseline diff；main/preload 改动补 `npm run build:electron` 和桥接测试；模块/打包边界改动在 push 前 `npm run electron:build`。UI 改动必须 Playwright，preload行为必须真实Electron。

完整测试存在既有失败。G0 记录路径/测试名/错误签名，后续比较集合；新增失败不能称作历史债。不要用总数相同证明没有回归，不将跳过或取消记为通过。类型检查暖构建、干净检出、跨平台CI分别记录。

合同断言使用代码和故障注入，不测试文档自己的说法。纯移动采用原有行为夹具；provider实测只作额外smoke，不拿它替代确定的离线回归。

## 6. 恢复、回退和删除

迁移期只有一个执行 owner，观察 shadow 可以存在，第二个 executor 不可以。新路径先 feature switch，旧 adapter保留明确期限；开关不得绕权限。数据库 additive expand/contract，旧reader兼容窗口和备份先验证，不能把git revert当数据回滚。

阶段日志记录“路由回退后存储如何读”“已经发生的外部动作如何对账”。审批、外部写入和已提交终态不因代码回退消失。legacy exports 删除必须满足消费者归零、打包/hostsmoke和兼容窗口证据。

## 7. 完成定义

- [ ] R1/R2：一个真实 run 有唯一 ID/dispatch/终态，读取不改变执行，取消/预算/审批生效。
- [ ] T3/E4：三种adapter共享行为合同，重连与慢消费者正确，真实worker回归和Electron证据完整。
- [ ] M5：core无外部IO、runtime无Electron/renderer；迁移清单逐项完成，旧包仅兼容且最终删除。
- [ ] C6/D7：跨run协调、Workspace/Project兼容、checkpoint及副作用恢复经过故障注入。
- [ ] H8：多host共用API，cleanCI和packagedsmoke有证据，unsupported能力仍关闭。
- [ ] 全部旧任务有完成证据或明确非阻塞后续归属，没有第二套执行队列。
- [ ] 更新ARCHITECTURE及项目索引；计划目录整体移入completed，主Active row删除，所有入口同步。

本文件当前只完成计划收敛；上面各项由后续执行agent逐项验收。
