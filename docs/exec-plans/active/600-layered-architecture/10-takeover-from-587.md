# 10 — 接管 587

> 587 是**被引用的历史决策**,不再是独立执行队列。
> 本文件记录:继承什么、推翻什么、587 剩下的债归谁。

---

## 1. 继承的成果(已合并,不复工)

| 587 阶段 | 成果 | 在本系列的落点 |
| --- | --- | --- |
| R1 | 串行写队列、终态 CAS、typed receipt、结果面区分 | 保留,见 [00 §D](00-contracts.md#d-run-生命周期与结果) |
| T3 | 单一 seq owner、`RunEventEmitter`、replay/codec/coalescing 模块 | 保留,但 **S3 Step 3 才接入生产流** |
| R2 部分 | Desktop 单一 dispatch、规范 runId、manifest 校验 | 保留,S3 收尾 |
| C6.2 | `workspace-store.ts`(Workspace 身份) | **位置已正确**,归 S2 |
| M5.1 | 文件分类器 `slice-classification.ts` | 复用,扩展为 G1 |
| M5.2 | `pkg:agent → electron-main` 归零 | 已完成 |
| M5.5 | `ProcessScope`(spawn/timer/kill 的单一 owner) | 保留,迁入 runtime |
| 13 号评审 | F01–F09 缺陷清单 | **全部转为 S0–S5 的门禁**,见 §3 |

---

## 2. 推翻的决策(2026-10-04)

| 587 原文 | 本系列 | 理由 |
| --- | --- | --- |
| §2「不提前建立通用 tools/memory/storage/ui 包」 | **推翻** | 用户决策:六个包全建。codex-rs 170+ crate 证明可行 |
| §B「`sessionId` 是 durable conversation」 | **推翻** | 用户决策:Session 降级为投影。见 [00 §C](00-contracts.md#c-session-降级为投影覆盖-587-b) |
| `migration-map.md:31`「不为了树形对称造空包」 | **部分推翻** | 树形对称不是目标,但六个包**必须有真实迁入**(门禁 G25) |
| M5.1 分类快照(path hash + 数量) | **改为属性断言** | 587 §F09:快照漂移导致 11 条假红,已由 #193 改过一次,不再回退 |

---

## 3. F01–F09 → 门禁映射

13 号评审(`13-progress-review-2026-10-04.md`)的缺陷清单**全部转为可执行门禁**,不再只是文字记录:

| 编号 | 缺陷 | 门禁 | 阶段 |
| --- | --- | --- | --- |
| **F01** P0 | C6.1 破坏 DB bridge 读写契约(`{ok,state,runId}` 被当 `RunWriteReceipt` 解析) | G30 | S2 |
| **F02** P1 | 生产审批在 durable refusal 后继续发 allow | **G17** | S3 Step 5 |
| **F03** P1 | 事件流丢 durable,reader 分抢(1024 无条件 shift) | **G15** | S3 Step 3 |
| **F04** P1 | non-SSE 断连把仍执行的 run 记成 cancelled | G31 | S3 |
| **F05** P1 | native envelope 绕过预算与关键事件处理 | **G14** | S3 Step 2 |
| **F06** P1 | 公共 terminal 早于 durable barrier | **G16** | S3 Step 4 |
| **F07** P2 | 三 transport 是测试夹具,不是通用 adapter | G32 | S3 |
| **F08** P2 | service/repository/HostMap 未形成生产 owner;LRU 踢掉 live run | G33 | S2 |
| **F09** P2 | 治理快照与纯度 scanner 应收敛 | **G21** | S4 |

**F01 是 P0**,它让每个 `run:create` 都读成 `unreadable`,worker 起来了却收不到 `chat:start`,整个 Desktop chat turn 被静默丢弃。**S2 必须先修它。**

---

## 4. 587 剩余债的归属

| 587 未完成项 | 归属 |
| --- | --- |
| M5.2-S3 CLI contract 拆分 | **S5 tooling** + S7 共享 Run API |
| M5.3 纯岛四项(一项未迁) | **S4** |
| M5.4 头部迁移(#175 自述 not done) | **S3** |
| C6.1 跨 run start/terminal 单一 owner | **S2** |
| C6.3 resolver 五条未开始 | **S2** |
| D7.2 lease/fence/recovery | **S2 checkpoints** |
| D7.3–D7.4 | S2 |
| H8.1 headless CLI(PR #178) | **S3** |
| H8.2 多 host | S3 之后 |
| E4.4 四条未验收 | S0 之后单独跟进 |

---

## 5. 587 目录状态

保留为证据。**不删除,不排期。**

- `587-agent-harness-monorepo/00-contracts.md` — 被本系列 [00](00-contracts.md) 接管
- `13-progress-review-2026-10-04.md` — F01–F09 已转为门禁,原文保留
- `reference/` — 历史设计,仅作取证
- `history/` — 旧计划原文,superseded
- `11-execution-log.md` — 历史执行证据

**读法:** 需要历史取证时读 587;需要当前职责边界时读本系列。**不从 587 的旧编号排期。**
