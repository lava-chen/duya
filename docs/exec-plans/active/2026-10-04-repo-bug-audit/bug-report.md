# 全仓库缺陷审计 — 2026-10-04

范围：`apps/desktop`（主进程 699 + 渲染层 819）、`packages/agent`（929 src）、其余 `packages/*`（约 930），共 4080 个受版本控制的文件。
目标：功能逻辑 bug、功能重复实现 bug、参数传递 bug。
基线快照：`5b1b447f`（Merge PR #174）。方法：12 个互不重叠切片并行只读审计 + 主控侧 5 项机械对账。
性质：**源码级审计，未运行产品测试或构建**，未修改任何产品代码。

标注：`[逻辑]` 功能逻辑 bug，`[重复]` 功能重复实现 bug，`[参数]` 参数传递 bug。
`✔已核` = 主控在当前 HEAD 上独立复核过源码，结论属实（共 9 条）。

---

## 修复状态（2026-10-04 收尾）

本节是修复阶段的结论。**正文各条缺陷的原始分析与证据保持原样不改**，便于对照修复前后的判断。

### 总体

170 条缺陷全部处理完毕。修复分 5 波并行执行，每波结束后集中跑门禁并与基线 worktree（detach 于 `5b1b447f`）做失败集合差分，确认没有引入新失败。

### 逐条核对结论

修复完成后，用三个互不重叠的只读切片对照当前工作树**逐条复核**（不采信"文件被改过就算修好"）：

| 优先级 | 实际条目 | 已修 | 有意保留 | 论证后不改 | 部分修 |
| --- | --- | --- | --- | --- | --- |
| P0 | 16 | **16** | 0 | 0 | 0 |
| P1 | 60 | **56** | 3 | 0 | 1 |
| P2 | 96 | **88** | 5 | 2 | 1 |

唯一的 P1「部分修」是 provider 编辑保存时的自定义标签：本次删掉了那个**永不执行**的
`...(existingDto?.tags ? …)` 分支并让注释直说标签暂不可编辑，因为两个调用点都不传
`tags`、只扩展 DTO 也不会让它活起来。标签要真正往返保存，需 DTO 与两个调用点一起改，
那是比本条大得多的改动，故未搭车。

### 计数差异（需要说明）

本报告表头标称 **P1 61 条、P2 93 条**，与正文实际行项数不符：

- §2 标题写「30 条」但列出 P1-1…P1-32；§9 实际 18 行项；§13 实际 10 行项 → **P1 合计 60 行项**
- §3 表头写 57 实际 59 行项；§10 实际 17 行项；§14 表头写 19 实际 20 行项 → **P2 合计 96 行项**

复核按**实际行项**全量进行（60 + 96 + 16 = 172 项），未遗漏任何一行。上表「实际条目」列即以此为准。

### 有意保留（附决策依据）

这些重复实现**仍然存在于仓库中**，但经复核确认合并会引入禁止的变更，故保留并补写了决策凭证：

| 条目 | 保留理由 |
| --- | --- |
| P1-2 三个注入依赖 | `@deprecated` + 决策号 06e5617a，测试文件已记录移除决定 |
| 补-7 `session/db.ts` IPC 分支 | 死分支已删，但改走 IPC 会把附件行移出活跃读取器之下，等 plan 329 |
| 补-13 `defaultShell` 的 ComSpec 判断 | 注释明确说明该判断是死代码，「修正」会把所有 Windows 用户交给 cmd.exe |
| §3-31 `message_search` 只写不读 | 测试钉住该表；与 R4 非修决定一致 |
| §3-36 `done_change` 问而不读 | 测试固定题集；删除会丢掉「无进展」信号 |
| §3-41 两份 face 引擎 | `git --follow` 证明 `agent-face` 是较新且逐字移植的一份；两边 duya 侧已向相反方向分叉，合并只会得到无法与上游 diff 的超集。**已补写 README 决策凭证** |
| §3-51 三处 `normalizePath` | 实为三种不同操作（对象归一／去尾斜杠／换分隔符），各留一份 |
| §14-4 gui 步骤只插值 text | 源码已注明「Deliberate, not an oversight」 |
| §14-17 遗留 bezier 覆盖层 | 与 native 路径互斥，注释已说明 |

### 论证后不改（附依据）

这两条经取证后判定**当前不应变更**，而非遗漏：

- **§3-49 preload 缺 22 个通道封装**：`preload/index.ts` 全部 398 处 `invoke` 均为字面量字符串，不存在动态通道逃逸口。但 `db:goal:*`、`db:channel:*`、`db:lock:renew`、`plugin:security:*`、`gateway:status` 在渲染层的调用数**全为 0** —— 加 22 个封装等于新增 22 个无人调用、无测试的方法。`db:lock:renew` 并非两份实现，而是同一能力（`db-bridge.ts` 的 `lock:renew`）的两个入口，渲染层没有续锁生命周期可驱动。正确做法是随第一个真实调用方一起加，或删除无人调用的 handler。
- **§3-56 入站 IM 两份消费实现**：`message-bus.ts`（gateway 子进程经 IPC 喂入）与 `connector-runtime.ts`（connector `onInbound` 进程内喂入）虽汇入同一队列，但有四处实质差异：传输源、会话解析方式、校验路径（gateway 走模块级 `wakeForInbound` 刻意跳过 channel store，connector 走 `ChannelBackgroundWakes` 方法会校验平台配置）、以及响应与广播。合并会导致网关侧合法流量被丢弃或绕过平台校验。已在两处互相注明「非重复」及依据。

### 修复过程中新发现并修掉的问题（不在原 170 条内）

审计未覆盖、但在本轮修复与门禁过程中暴露的真实缺陷：

1. **research 家族跨进程形状分叉（审计漏掉的静默 `undefined`）** —— audit 未覆盖，但比多数 P1 更隐蔽。`session/db.ts` 里 activities / events / sources / citations / reports 五个子族的 IPC 分支返回主进程 camelCase DTO，本地分支直接返回 `SELECT *` 得到的 snake_case 行，两者被同一个类型断言强行合并。因此 `event_type`/`payload_json`/`created_at` 在 IPC 模式下**全部静默为 `undefined`**，而类型系统完全无感。已逐字段比对确认无字段缺失或多余（除 casing 外仅 `visibility`、`allowed_by_policy` 两处真实类型分歧），并在 `db-client.ts` 的边界处完成归一化 —— 选客户端而非主进程，是因为客户端的 namespace **就是**边界，调用方无从遗漏，11 处 `as unknown as …Row` 断言随之消失。顺带发现第二个同源缺陷：`sendDbRequest` 是 `async`，导致多个「同步」包装器返回 **Promise 被断言成数组**；该家族在 agent 内零代码消费者，改为 `async` 的影响半径为零。
2. **`bash-task-store.test.ts` 的 `withTempDir` 竞态** —— `finally` 不等 `fn` 的 Promise resolve 就删临时目录，而 `rehydrate()` 恰在 `await readFile` 处让出控制权，ENOENT 被 catch 吞成 `[]`。满负载下必现，是那两次「同一文件反复失败」的真因，不是抖动。
3. **`app-connection-service.test.ts` 的顺序依赖 mock** —— 用 `mockResolvedValueOnce`/`mockRejectedValueOnce` 绑定调用顺序，而 `r-good`/`r-bad` 同为 error 行，谁先出循环只是 SQLite 行序细节。已改为按 `connectionId` 分派，两种顺序都成立。
4. **`catalogSync.ts` 漏适配 `list()` 封顶（本次修复自身引入的回归）** —— `SessionStore.list()` 新增默认 100 条封顶后，5 个聚合型调用方改了 4 个，漏掉 `syncAllFromMainDb`，导致老会话不再 tombstone、`rollout_catalog.source_status` 永久停在 `active` —— 正是那段注释声称已修的 bug。
5. **误导性注释 4 处** —— `StreamingToolExecutor` 的 JSDoc 被抽取方法截胡（原属 `executeTool` 的注释留在 `checkToolPermission` 上）；注释引用不存在的 `checkToolPermissions`；`TERMINAL_EVENT_TYPES` 声称自己是「唯一声明处」但仍有三处字面量；`getSessionStatus` 指向本次已删除的 `SessionStatus` 类型。
6. **行尾噪声** —— 一个修复把 `dto-mappers.ts` 写成了纯 LF 而自称保留了 CRLF；纠正过程中又反向制造了 81 行噪音（HEAD blob 本身即混合行尾）。已用字节级比对逐文件核验全仓 0 噪音。
7. **死代码与死接口面** —— 删除 `WorkflowEngine`/`WorkflowManager`、两个零挂载点的设置组件（含其专属 `VisionModelSelector`）、14 个无生产者的 `db-client` action、21 个无生产者的 `chat:research_*` converter case、`AgentSSEClient` 零外部调用副本（886→240 行）、44 处死 enum 值。

### 新发现、尚未修复（留给后续）

- **research 会话与计划步两个子族仍有同样的形状分叉**：`researchSessionDb`（6 处断言、17 字段）与 `researchPlanStepDb`（3 处断言）。前者被 run 生命周期状态机真实消费，后者不是机械 casing —— `internal_question_ids` 是 JSON 文本而 `internalQuestionIds` 是解析后的数组，需要先做契约决策再转换。两者都应有各自的 diff，不宜搭车。
- **`preload` 22 个通道无渲染层封装** —— 见上文「论证后不改」，待产品决策。
- **`pruneTrailingFailures` 全仓零调用者**（仅 `node-runner.ts:388` 的注释提及），已改为诚实返回未裁剪，但函数本身是否还应保留待定。
- **`clearPendingAnswer` 无调用者**：审批被拒后未重试的 tool-input override 会残留，与现有 `pendingAnswers` 行为一致。
- ~~**AGENTS.md 声明的预发布产物与构建脚本不一致**~~ —— **已由 upstream 修复，本条作废。** 我在旧基线（`5b1b447f`）上实测 `bundle:agent` 后发现 `packages/agent/bundle/BashTool/BashWorker.js` 并不存在，而 AGENTS.md 要求它存在。合并 `origin/master` 后查明：upstream 的 PR #191（`fix/587-bashworker-artifact`，提交 `701e0011`）已给 `scripts/build-agent-bundle.mjs` 增加第二个 esbuild entry（`BashTool/BashWorker.ts`），并新增 `scripts/check-packaged-artifacts.mjs` 门禁与 `packaged-artifact-baseline.json`。该修复已随 auto-merge 进入本分支。**教训：任何基于旧基线的"既有偏差"结论，在合入前都必须重新核实 —— 本次审计中"21 个 `chat:research_*` case 无生产者"也是同类情况，upstream 的 `router.ts` 已为其建立 `worker → sse-frame-codec → router` 完整链路，删掉反而会破坏新功能。**


### 合并到当前 master（重要）

本修复最初落在 `5b1b447f` 上。收尾核对时发现 `origin/master` 已推进到 `7b6c7f38`
（merge base 仍是 `5b1b447f`）—— **领先 102 个提交**，其中 56 个是 test、10 个 fix、
3 个 feat（主要是 587 计划：H8.1 抽出 `sse-frame-codec.ts`、M5.4 重写依赖图为
`PathFootprint`、`849b46df` 废弃计数式分类门禁、PR #191 补上 BashWorker 产物）。

因此上述所有门禁结论最初都是**针对旧基线**的，已全部在合并结果上重跑。
合并产生 8 个冲突 hunk、集中在 4 个文件，逐个解决如下：

| 文件 | 冲突 | 解决方式 |
| --- | --- | --- |
| `DependencyGraphOrchestrator.ts` | 5 处，均为 upstream 把 `writePathsFor`/`waveWritePaths` 重构为 `PathFootprint`/`footprintsConflict`/`waveFootprints` | 采用 upstream 设计。并额外清掉两个 git auto-merge 漏掉的死声明（`readPathsFor`/`conflictsWith`，零调用、`noUnusedLocals` 下会炸）。本次对 `extractReadPaths` 的修复已被 upstream 在 `footprintFor` 热路径上实质取代，且 upstream 更严格（刻意分离 unknownRead/unknownWrite 以保留读并行） |
| `agent-process-entry.ts` | 1 处：upstream 抽出 207 行的内联 `convertSSEToAgentMessage`，而本分支仍带着它 | 采用 upstream 结构，import 共享 codec；本分支的 4 项修复（视觉阶段 abort、审批改参、defer 守卫、compact 排空队列）全部在 hunk 之外，已存活 |
| `db-bridge.ts` | 1 处：双方**修了同一个 P0-13**，本分支从 `serveWire` 侧修、upstream 在 bridge 侧加 `receipt.outcome === 'rejected'` | 保留 `serveWire`。upstream 那段是照 `serve` 写的、读 `CommandReceipt` 字段，而 `serveWire` 返回 wire reply，这些字段根本不存在，双重不可达；其**行为**已由 `serveWire` 内部承担 |
| `slice-classification.test.ts` | 1 处：本分支重录了 `EXPECTED` 计数表，upstream 已把它当"跑步机"删除，换成冻结的 per-file census + `RULE_TABLE_FINGERPRINT` | 采用 upstream 门禁。本分支的删除通过 upstream 自己的 `RECORDED_LOSSES` 逐条记录（6 个文件，各附理由），而不是恢复计数表 |

### 合并后新查出的 2 项真回归，1 项 upstream 自带测试漂移

冲突解决完、门禁在合并结果上跑起来之后，失败文件从旧基线的 44 降到 11。其中 **2 项是本次合并
自身引入的真回归**（都是"本分支的修复与 upstream 的结构相撞"），1 项是 upstream 自带测试的清单
漂移。逐个处理如下。

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `run-create-ack-real-bridge.test.ts` 报 `Database not initialized` | 本分支为打破循环把 `db-bridge.ts` 的 `getDatabase` 导入从 `../ipc/db-handlers` 改成 `../db/index`（`db-handlers` 反向 import `db-bridge`，成环），而该测试仍 `vi.mock('../ipc/db-handlers', ...)` —— double 挂不上，被测代码走了真实 `getDatabase()` | 改测试的 mock 路径为 `../db/index`，**不改回导入**（那会把循环重新引回来）。8/8 通过 |
| `h8-2-consumer-inventory.test.ts` 4/8 失败 | 该文件按行号 pin 住 `.streamChat(` 清单，而 upstream 的 H8.1 把 CLI 的 3 个 turn 站点抽进了 `headless-run-host.ts`，行号整体漂移；另有若干未记录站点 | 逐条复测后：4 条是行号漂移，1 条是 abort-signal 落到了既有调用上（不是新增），1 条是字符串字面量里的散文（look-alike）；真正新增的是 `headless-run-host.ts:251`（host executor，CLI 三个入口现已全部收敛到它）。非 CP turn 4→2、cli 3→1、`NOT_TURN_ENTRIES` 7→8。8/8 通过 |
| `headless-retirement.test.ts` 一直是绿的 | 它本身坏了 —— 见下一节 | 修门禁 + 改 registry。7/7 通过 |

### 一个不会失败的门禁

`headless-retirement.test.ts` 的第一个用例叫「re-derives the consumer count from the source」，
文件头也写着 "re-derives the CONSUMER COUNT from the source and fails if the registry's number
disagrees"。但它的期望值是用 `measured.length` **自己**拼出来的：

```ts
expect({ count: registry.remainingConsumers, sites: sites, measured: measured.length })
  .toEqual({ count: sites, sites, measured: measured.length });
//                                          ^^^^^^^^^^^^^^^^^^^^ 两侧同一个表达式，恒等
```

`measured` 这个键在两侧是同一个表达式，`sites` 两侧也是同一个表达式，只有 `count === sites` 是
真检查。**所以这个门禁在 registry 声称 7、scanner 实测 3 的状态下一直是绿的** —— 它拦不住任何东西，
包括它自己声称要拦的那件事。

把期望值改成拿 `measured` 与 registry 比之后，它立刻失败，并牵出 registry 本身两处不实：

1. **scanner 的口径和 registry 自述的口径不是一回事。** scanner 用 `/\b(agent|subAgent|this)\.streamChat\(/`
   过滤接收者；registry 的 rationale 却写「seven call sites on a duyaAgent/subAgent receiver …
   excluding @duya/ai client calls」。实测 7 个里有 5 个是 `@duya/ai` 的 `AIClient` 调用
   （`llmClient` / `compactClient` / 构造时 bind 到 extractor 上的 `streamChat`），**同一句话里
   "是 agent receiver" 和 "排除 client 调用" 两半互相否定**。
2. **按真实口径实测是 9 个，registry 只列了 7 个。** 真实口径 = `packages/agent/src` 内除注释行、
   除 headless host 之外的全部 `.streamChat(`。漏掉的是 `visual-analysis.ts`（`visionClient`）与
   `SessionSearchTool.ts`（自建 `AIClient` 做检索结果摘要）—— 两者都因为接收者名字不叫
   `agent`/`subAgent`/`this` 而被旧 scanner 滤掉，于是从清单里一并消失。

处理：registry 按真实口径改写为 9（每个站点标注性质，2 个真 turn / 7 个一次性 model 调用，后者
全部走 `@duya/ai` 而非 shim），scanner 同步到该口径，并**新增一条按多重集比对的用例**——只比数量
不够，文件数对、文件错了同样会过。清单里的 `:line` 全部去掉：registry 里的行号是任何一次上方编辑
都会打脸的断言（原本 `DuyaAgent.ts:4426` 已经漂到 4526），而这里不需要行号就足够可审计。7/7 通过。

### 门禁跑起来之后，又查出 3 项

这三项都不是"跑不过"，是**跑过了但结论不可信**，或**只在合并后才成立**。它们的共同点是：只看
"失败文件数"会全部漏掉。

| 现象 | 真实归属 | 处理 |
| --- | --- | --- |
| `ProviderManagement.test.tsx` 挂 1 项 | **本分支引入**。本分支删掉了 `ProviderManagement` 监听 `duya:provider-delete` 的代码（改由 `ProviderEditView` 直接调 mutation），而 upstream 的 102 个提交新增的测试正是测这个 window 事件。逐字搜索确认合并后**全仓已无任何生产代码派发该事件** | 该用例的前提在本分支上已反转。改为断言"该事件无人响应"（防止有人只把监听加回来），并把删代码时一起删掉的覆盖补到 `ProviderEditView.test.tsx`（删除成功 / 用户取消两条）。12/12 通过 |
| `13-citation-drift.test.ts` 从挂 1 项变成挂 3 项 | **本机工作区产物**，非代码缺陷。该测试索引 `REPO_ROOT` 下的文件并按 basename 建表，而工作区里 gitignore 的 `.tmp-validation/` 存着整棵 checkout 的副本（**312,826 个文件**），于是每个 bare basename 都变成"2 个候选"，20 条原本唯一的引用被判 `ambiguous`，`resolved` 变 `null` 后又被逐条排除在 anchor 检查之外，连带把覆盖下限也拖垮 | `SKIP_DIRS` 补上 `.tmp-validation` / `.tmp-test`（该文件本就 skip `.claude`，同一性质；两者都被 `.gitignore` 声明，CI 上根本不存在）。补完后反而**多暴露出 5 条真实失效引用** |
| 上述 5 条 + 1 条越界引用 | **1 条是本分支造成，5 条是 upstream 造成**。本分支把 `agent-sse-client.ts` 从 886 行删到 240 行 —— 删的是 `AgentSSEClient`，它是 `agent-http-client.ts` 里 `AgentServerClient` 的**无调用者弱化副本**（事件去重规则更差），删除本身有据；但 `sse-event.ts` 里指向它 452-453 行的引用就此越界。另 5 条是 102 个提交把 `router.ts` 等文件挪动后失效的旧行号 | 逐条实测新行号后重指：`let seqNum = 0` 1329→1574、replay 写 `eventId` 2412-2423→2986-2997、`handleDeleteChat` 1670→2067、`isRetryable` 177→190、`data.content` 461-465→455-462，以及 `DuyaAgent.ts:2394` 那条**门禁结构上看不见但语义已失效**的引用（该行无反引号锚点 → `anchor` 为 `null` → 被排除），改指 2443。6/6 通过 |

第一条尤其值得记：**我把一段代码删对了，却忘了 upstream 会在同一个协议上新增测试。**
判定归属的方法是干净的 —— 在 `7b6c7f38` 建一个干净 worktree 跑同一个测试（7/7 通过），
再全仓 grep 确认该事件已无生产者。两个独立证据都指向"是本分支的改动让 upstream 的新测试失真"，
而不是"upstream 自己坏了"。`useDeleteProviderMutation` 本身已处理 Plan 209 的默认服务商清理，
所以直连 mutation 没有丢掉任何行为 —— 这也是为什么改测试而不是回滚代码是对的。

### 两条基于旧基线的结论，在合并后被证明是错的

这是本次收尾最值得记下的教训 —— **修复 campaign 会在旧基线上形成"事实"，而那些事实可能已被 upstream 推翻**：

1. **"AGENTS.md 要求的 `BashTool/BashWorker.js` 不存在"** —— 我在旧基线上实测 `bundle:agent` 后判定为构建脚本缺陷。upstream 的 PR #191 已给 `build-agent-bundle.mjs` 增加第二个 esbuild entry 并新增 `check-packaged-artifacts.mjs` 门禁。**该条已作废。**
2. **"21 个 `chat:research_*` case 无生产者，可删"** —— 合并后发现 upstream 已在 `router.ts:586-596` 建立 `worker → sse-frame-codec → router` 的完整路由链路。**当初若坚持删除，反而会破坏 upstream 的 research 功能。** 冲突解决时它们随 codec 一并保留，是正确的。

同理，upstream 已将 `EXPECTED` 视为需要淘汰的跑步机，若我坚持"重录数字"就是逆向而行 —— 该判断由解决冲突的 agent 提出并纠正了我。

### 门禁结果

**合并前**（对照旧基线 `5b1b447f`）：

| 门禁 | 基线（`5b1b447f`） | 修复后 | 结论 |
| --- | --- | --- | --- |
| `npm run typecheck:all` | 303 known / 148 keys | 299 known / 147 keys | **0 新增**，并已 `--write` 收紧 baseline（3 删 0 增，全为本次顺带修掉的既有欠债） |
| `npx vitest run` | 44 个失败文件 | 40 个失败文件 | **0 新增**，且修好 4 个（`eval-legacy-loop`、`eval-baseline-comparison`、`run-suite`、`GrepTool`） |
| 全仓行尾一致性 | — | 0 噪音 | 每个文件比对 `--numstat` 与 `--ignore-cr-at-eol --numstat` |

**合并后**（在最终 merge 结果 `4ad23b9e` = `b40fa596` + `d20e31ae` 上重跑，这才是有意义的数字）：

| 门禁 | 结果 | 结论 |
| --- | --- | --- |
| `npm run typecheck:all` | exit 0，299 known / 147 keys | 0 新增 |
| `npm run architecture:check` | exit 0，cycle 16，total 879，tolerated 879 | 0 新增边界违规 |
| `npm run bundle:agent` | exit 0，`agent-process-entry.js` + `BashTool/BashWorker.js` 均产出 | 印证旧基线上"BashWorker 缺失"那条结论已作废 |
| `npx vitest run` | 1099 文件：1083 通过 / **8 失败** / 8 跳过 | **0 回归**（见下） |

**8 个失败文件 / 24 个失败用例的甄别**：

差分方法：把两次 run 输出里所有失败用例名（`✗ <suite> > <case>`）取集合差，得
`24（合并后） vs 27（基线同文件集）`。差集里"新增失败 4 项"逐个隔离复跑：

| 用例 | 隔离复跑 | 判定 |
| --- | --- | --- |
| `envelope-frame-parity` 的 3 项 F05 token-ceiling | 6/6 通过 | 满负载时序抖动。该文件此刻**还是未跟踪的新文件**（另一条工作线正在写），双方分支均未触碰 |
| `runAgentSync > should return error when no API key` | 通过 | 满负载顺序依赖，依赖环境变量 |
| `os-context/watcher > debounces rapid writes` | 6/6 通过 | 满负载 debounce 时序抖动，双方分支均未触碰 |

→ **真实回归 0**。其余失败文件（`workflow-store`、`WorkflowPanel`、`sync-protection`、
`DuyaAgent.plan315`、`DuyaAgent.plan486`、`permissions-gate`、`AgentTool`）在基线 worktree
上同样失败，确认为既有欠债。旧基线是 44 个失败文件。

顺带修好的 7 项里，6 项是 upstream 自己在其 102+9 个提交里修好的（`AgentTool` 的
`getSubagentToolDefinition` 系列），1 项是本次订正的 citation 引用。

> ⚠️ **一处方法论缺陷，如实记录**：上表的集合差分把"基线那次跑里根本没跑到的文件"也算成
> "基线通过"。`F05` 那一组就是因此被误列为回归的 —— 它在基线时还不存在于 git 里。
> 差分只在**两次运行覆盖同一批文件**时有效，跨批次的"新增失败"必须先确认该文件当时是否被跑到。

### 满负载下会抖、但判定为非回归的测试

差分阶段有两个文件只在**全量并发**下偶发失败、隔离复跑全部通过，且**都未被本次修复触碰**：

- `packages/agent-runtime/test/transport-equivalence.test.ts` —— 断言 `chunksRead > 1`（`fragmentBytes: 1` 逐字节投递），满负载下统计早于全部 chunk 到达而读到 1。隔离 3/3 通过。属既有时序脆弱性，未修（修它需要改 transport 的 chunk 统计时机，超出本次范围）。
- `packages/agent-runtime/test/run-resource-growth.test.ts` —— 用 `process._getActiveHandles()` 断言存在 `Timeout` 句柄，而 unref'd timer 可能已从列表消失；测试自己的注释已承认看不见这类 timer。隔离 3/3 通过。
- `packages/agent-runtime/test/coalescing-throughput.test.ts` —— 吞吐基准测试，满负载下 13 个用例偶尔超时。隔离 3/3 通过。

另有 `bash-task-store.test.ts` 曾多次在满负载下失败，**不是**抖动 —— 其 `withTempDir` 的 `finally` 不等 Promise resolve 即删临时目录，已按真缺陷修复（见上文第 2 条）。这条区分是本轮门禁中最有价值的一步：前两次曾把它误判为抖动，第三次才定位到真因。

---

### 收尾时 origin/master 又前进了 9 个提交 —— 我丢掉了自己的一半修复

第一次合并落地（`b40fa596`，基线 `7b6c7f38`）之后核对分叉，发现 `origin/master` 已推进到
`d20e31ae`，比我合入的基线**又多 9 个提交**（PR #199 / #200 / #201）。合入它们时产生 3 处冲突，
而这 3 处**恰好全在我上一轮刚改过的文件上**：

| upstream 提交 | 内容 |
| --- | --- |
| `b310313f` | `test(h8): anchor the H8.2 inventory instead of pinning line numbers` |
| `6a936784` | `fix(h8): make the retirement test hold the registry to its claim` |

也就是说，**我上一轮独立发现的"重言式门禁"，upstream 同时也发现了并修了**。其文件注释写的
是"the registry sat at `7` while the tree held `2` facade call sites"——与我实测出的
"声明 7、实测 3"指向同一个缺陷。三处冲突因此**全部采用 upstream 版本**，我在这 3 个文件上的
修复被严格取代。逐项对比后确认 upstream 的方案更优：

1. **识别"伪装的 facade 调用"用了正向证据。** `Stage1Extractor.streamChat` 是
   `llmClient.streamChat.bind(llmClient)` 绑上去的 `@duya/ai` 方法，签名和 facade 调用一模一样。
   upstream 用"该文件出现 `AIClient['streamChat']` 绑定"来排除，而不是像我那样按接收者名过滤 ——
   后者会把未来某个 `DuyaAgent` 子类里真实的 `this.streamChat` 一起漏掉。
2. **registry 收窄为 2 而非我改的 9。** upstream 把"一次性 model 调用"正确地排除在
   `consumers` 之外（它们本来就不是 shim 的调用者，删掉 shim 不会影响它们），rationale 因此恢复自洽；
   我则把口径扩大到"全部 `.streamChat(`"并把 7 改成 9。两种解法各自自洽，但 upstream 的更贴合这条
   entry 的主题（"duyaAgent.streamChat 作为 CLI TURN 入口"），且不虚增退役阻塞项。
3. **h8-2 改成锚定而非按行号 pin。** 我上一轮正是用"把记录的行号从 1137 改到 1150"绕过漂移的 ——
   那恰恰是这种脆弱性本身。upstream 直接消除了它。

**教训**：两处独立团队在同一个门禁上撞出同一个缺陷时，先做的那一份很可能不如后做的那份，
而"我已经修过了"不是保留它的理由。可验证的做法就是逐项比设计，而不是比谁先提交。
剩下 4 项修复（`run-create-ack` 的 mock 路径、`ProviderManagement` 的事件用例、
`13-citation-drift` 的非 hermetic、6 条失效引用）不在这 3 个文件里，全部存活。

## 0. 结论摘要

共 **170 条**已定位缺陷：**P0 16 条、P1 61 条、P2 93 条**。另有 7 条 587 计划既有发现（F01–F09）在当前 HEAD 复核后确认**仍然存在**。

方法：5 波共 **20 个互不重叠切片**并行只读审计（4 并发），覆盖全部主目录；主控侧另做 5 项机械对账，并对 **21 条发现做了独立源码复核（全部属实）**。

16 条 P0 归为五个根因家族：

**A. 权限/安全闸门本身失效（2 条）**
- `permissions/policy.ts:1094` 工作区**父目录**（及无工作区时的整个 `~/.duya`）被当作允许根 → 同级目录与 DUYA 自配置目录静默放行。
- `permissions.ts:377` 内部工具放行闸门位于 deny 规则查询之前 → 用户的 `alwaysDenyRules` 被静默忽略。

**B. 终态之后仍在产生副作用 / 重复执行（3 条）**
- `DuyaAgent.ts:2349` `turnCommitted` 值拷贝恒为 `false` → 流重放重跑已派发工具。
- `dwf/runtime.ts:436` `wf.map` 的兄弟 worker 在 run 已终止后继续执行工具。
- `agent-runtime/src/controller.ts:1177` `run.failed` 被推入事件流两次 → 终态信封重复。

**C. 跨进程/跨组件边界的值被截断、拷贝或误判为重复（4 条）**
- `db-bridge.ts:734` `goal:create` 读 `p.sessionId` 而客户端发 `session_id`。
- `agent-http-client.ts:757` 去重键把同一次调用的所有 `tool_use_delta` 分片当重复丢弃。
- `agent-http-client.ts:325` 三个 SSE mapper 都不复制 `data.metadata`。
- `db-bridge.ts:340` 回执无 `ok` 字段，orchestrator 把成功 create 判为 `unreadable`。

**D. 路径上的动作/回调断链，消息彻底丢失（2 条）**
- `gateway/feishu/index.ts:499` 带 `thread_id` 的文本路由到从未注册的回调 → 飞书话题/引用消息全丢。
- `ProviderEditView.tsx:415` 删除供应商派发给未挂载的监听者 → 破坏性操作静默失效。

**E. 不可自愈的失败与承诺失效（5 条）**
- `db/schema.ts:2236` 迁移 45 无条件复制旧行进收紧 CHECK 的新表 → **永久无法启动**。
- `cli/build-control-plane.ts:118` 五个 backup 标志未转发 → 向用户承诺的 `--dry-run` 写真实归档。
- `eval-legacy-loop.ts:273` eval 直调 dispatcher，结构上看不见 P0-C 组的断裂。
- `services/recorder/service.ts:271` 启动失败后状态永久停在 `starting`。
- `services/browser/daemon.ts:711` EADDRINUSE 恢复无上限递归且两条重试链争抢同一端口。

**重复实现类**高度集中在四处：主进程与 agent 进程之间的能力双写（47 个 `db:*`，已在 `goal:create` 上分叉）、CLI 两个派发器各构造一份 options bag（`backup --dry-run` 等一批标志在此丢失）、渲染层同一能力的多份拷贝（SSE mapper、SSE 客户端、face 引擎、时长格式化、basename、connector 覆盖层、元素 schema）、以及权限判定与路径包含判定的多处独立实现。

---

## 1. P0（第一部分 7 条；全报告共 16 条，见 §0 与 §8、§12）

### P0-1 [逻辑] 流重放守卫是死代码，工具会被重复执行 ✔已核
`packages/agent/src/agent/DuyaAgent.ts:2349`

```ts
// :2058  let doneEventHandled = false;
turnCommitted: doneEventHandled,      // :2349  ← 此刻仍为 false
// :2548  doneEventHandled = true;      ← 在消费循环里才置真
```

`runTurnStream({...})` 在 `:2338` **一次性构造**，`for await (const event of streamGenerator)` 到 `:2377` 才开始消费。`TurnStreamRunner.ts:159` 把该值再拷贝一次进重试上下文，`stream-retry.ts:54` 的 `if (ctx.turnCommitted) return false` 因此永远读到 `false`。

该字段唯一用途见 `:2329-2330` 注释：「Post-`done` failures propagate unchanged via the turnCommitted guard」。实际相反：`done` 之后的传输故障触发整轮重放，`onRetryReset` 清空累加器、第二个 `done` 在 `:2544` 被丢弃，但 `:2477` 的 `executor.addTool` 已把调用重新入队 → 副作用重复执行 + 产生 `tool_call_id` 无对应 `tool_use` 的孤儿 `tool_result` 行。

修复：改为 getter（`turnCommitted: () => doneEventHandled`），每次 attempt 求值。

### P0-2 [参数] `tool_use_delta` 分片被去重键整体丢弃，实时预览永远只有首帧 ✔已核
`apps/desktop/src/renderer/lib/agent-http-client.ts:757`

```ts
const rawId = eventData?.id as string | undefined;
if (rawId) {
  const dedupKey = `${event.type}:${rawId}`;
  if (ids.has(dedupKey)) { console.log('Skipping duplicate event:', dedupKey); return; }
```

生产者 `packages/ai/src/api/emit-sse.ts:94` 注释明写：`toolcall_delta` **每个 token 一帧**，`data.id` 恒为同一 `block.id`，且「consumers accumulate per tool_use id and parse leniently」。

于是一次工具调用的所有后续分片全部命中 `tool_use_delta:<block.id>` 被丢弃，`stream-session-manager.ts:2811` 的 `raw + delta.delta` 累加只收到一个片段。

修复：流式/分片类事件排除出去重集合，或改用单调序号做键。

### P0-3 [参数] 三个 SSE mapper 均不复制 `data.metadata`，富工具行永久降级 ✔已核
`apps/desktop/src/renderer/lib/agent-http-client.ts:325`（另见 `:436`、`:589`）

`worker-protocol.ts:303-305` 明确注释 `metadata` 是「forwarded for rich renderer tool rows」，`router.ts:522` 确实转发（`data: { id, result, error, duration_ms, metadata }`）；但 mapper 只取 `result`/`error`/`content`，且 `AgentEvent` 类型本身没有 `metadata` 字段——`agent-http-client.ts` 全文 `metadata` **零出现**。`stream-session-manager.ts:2121` 读到的恒为 `undefined` → `BrowserToolRow.tsx:156` 的 `tool.metadata.browserResults` 永不渲染。

修复：`AgentEvent` 补 `metadata?: Record<string, unknown>`，三个 mapper 一并复制。

### P0-4 [参数] `goal:create` 幂等守卫读错字段名，恒不命中 ✔已核
`apps/desktop/src/main/agents/db-bridge.ts:734`

```ts
const existing = goals.get(p.sessionId as string);   // camel
if (existing) return coreGoalToIpcRow(existing);
const goal = goals.create({
  id: p.id as string,
  sessionId: p.session_id as string,                 // snake —— 同一块里两种写法
```

生产者 `packages/agent/src/ipc/db-client.ts:395` 发 `{ id, session_id, goal_text, token_budget }`（全 snake）。`goals.get(undefined)` 使 UNIQUE(`session_id`) 守卫永不命中，重复 create 直接撞 `stores.ts:621` 约束——正是 `:729-733` 注释声称要避免的「noisy ERROR spam in the worker」。触发路径明确：worker 重启后会话无消息历史但有持久化 goal 行。

两个独立审计切片各自独立定位到同一条，可信度高。

修复：`goals.get(p.session_id as string)`。

### P0-5 [逻辑] 生命周期违规的 `run.failed` 被推入事件流两次
`packages/agent-runtime/src/controller.ts:1177`

```ts
const emitted = active.emitter.emit({ type: 'run.failed', … });
if (!emitted.ok) throw new Error(emitted.message);
envelope = emitted.envelope;
} catch { … }
active.stream.push(envelope);   // emitter 已在 #mint 里推过一次
```

`event-emitter.ts:353` 的 `#mint` 是唯一发布点，`controller.ts:1177` 又推一次 → 任何 `events()` reader 都看到同 `seq` 的重复终态信封。

修复：删掉 `:1177`。

### P0-6 [逻辑] 飞书话题/引用消息全部路由到未注册的回调，彻底丢失
`packages/gateway/src/adapters/feishu/index.ts:499`

```ts
if (threadId) { await this._options.onThreadMessage?.(threadId, chatId, userId, richText.content, message.message_id); }
else { await this._options.onMessage(...) }
```

`index.ts:1245-1264` 的 options 对象只定义 `onMessage, onImage/File/Audio/Post/Card`，**没有** `onThreadMessage`。凡带 `thread_id‖root_id‖parent_id` 的文本（`index.ts:457` 归一化）都走可选链的 `undefined` 分支，静默丢弃。引入于 `a44d41b6`。

其余 5 个适配器（weixin/telegram/qq/whatsapp/discord）的身份映射经核对均正确。

修复：所有文本统一调 `onMessage(chatId, userId, text, messageId, threadId, mentions)`。

### P0-7 [逻辑] 编辑页删除供应商静默失效，破坏性操作无任何反馈 ✔已核
`apps/desktop/src/renderer/components/providers/ProviderEditView.tsx:415`

```tsx
window.dispatchEvent(new CustomEvent('duya:provider-delete', { detail: { id: editProvider.id } }));
clearProviderEdit();
setSettingsTab('providers');
```

全仓唯一监听者在 `ProviderManagement.tsx:97`，该组件只在 `ProvidersSection.tsx:67` 内挂载；编辑页位于另一分支（`ProviderManagement.tsx:87-89` 注释自承「rendered elsewhere … doesn't have a direct prop path」）。编辑页显示时 `ProviderManagement` 未挂载 → 事件无人接收 → 导航回列表，供应商仍在。

第二处独立缺陷叠加：监听 effect `:90-100` 依赖数组为 `[]`（带 eslint-disable），捕获的 `doDelete` 持有挂载时的 `providers`；若此时列表尚未加载，`:127` 的 `if (!target) return` 也会静默返回。

修复：删除变更改为 prop/store action 直传，或把监听上提到 tab 切换之上；同时去掉 `[]` 依赖。

---

## 2. P1（30 条）

### 参数传递

**P1-1** `packages/agent/src/tool/StreamingToolExecutor.ts:1680` [参数] 工具重试绕过权限与超时闸门。异常后走 `retryExecutor.executeWithRetry` → `toolRegistry.execute`，后者直接调 `executor.execute`，不经 `canUseTool`/`checkPermissions`/`maxExecutionTimeMs` 竞态（闸门在 `:1233`、`:1256-1265`）。重试即等于一次未授权调用。

**P1-2** `packages/agent/src/tool/ToolInvokeTool/dispatcherFromRegistry.ts:28` [参数] 三个注入依赖（`getLoadedSchemaRevision`/`getLoadedSchemaRound`/`getCurrentRound`）由 `DuyaAgent.ts:1369-1371` 注入但从不读取，其守护逻辑根本不存在；`tests/unit/tool-catalog.test.ts:261-262` 已记录为未决。

**P1-3** `packages/agent/src/modes/computer-use-mode.ts:199` [参数] ✔已核 session 级 `onExit` 从未被调用。全仓 `hooks?.onExit?.()` 只有 `apply-modes.ts:132` 一个调用点且被 `kind === 'message'` 过滤，而该模式注册为 `kind: 'session'`。后果：`OSContextBridge.disable()` 不执行，粘滞触发器永不清除。

**P1-4** `packages/agent/src/modes/engine/coordinator.ts:394` [参数] ✔已核 `ModeCoordinator.filterTools` 无任何生产调用点。`apply-modes.ts:81-82` 的 `overrideFilter` 分支只做 `[...baseTools, ...injectedTools]`，把各 mode 声明的 `tools.block`/`allowed` 全部丢弃（`goal-mode.ts:92` 正靠它）。安全性未失守（调用期仍被 `coordinator.ts:448` 拦住），但 goal + plan-task 同开时 `bash/edit/write` 仍被宣告给模型。

**P1-5** `packages/agent/src/modes/computer-use-mode.ts:189` [参数] 写入的 `toolUseContextPatch` 无人消费：`DuyaAgent.ts:2005` 只读 `conductorCanvasId`，`modeResult.toolUseContext` 在 `:1551-1552` 被丢弃。

**P1-6** `apps/desktop/src/main/agents/db-bridge.ts:966` [参数] 持久化审批记录未按会话隔离。`permission-decision-record.ts:110` 发 `sessionId`，`db-bridge.ts:959` 从不读取，`resolveToolApproval(db, id, decision)` 无 session 参数 → 任何得知该 id 的会话都能认领他人提示，与 `router.ts:2193` 自身给出的 B4 理由矛盾。

**P1-7** `apps/desktop/src/main/agents/db-bridge.ts:340` [参数] bridge 只回写回执、丢弃 `receipt.result`，`run:get`/`run:events`/`run:list-session` 三个读动作恒返回 `unreadable`（经 `run-receipt.ts:296,300`）。当前 `packages/` 无调用方，属潜伏缺陷。

**P1-8** `apps/desktop/src/main/agents/db-bridge.ts:2182` [参数] `researchActivity:create`/`researchEvent:create` 读 `p.run_id`，而同族读侧（`getByRunId`/`getMaxSequence`/`deleteByRunId`）读 `p.runId` → 同一次运行的写入与读取使用互不相交的键名。`db-client.ts:743` 与 `:749` 各自形状正确，但 create 侧是异类。

**P1-9** `apps/desktop/src/renderer/lib/agent-http-client.ts:436` [重复] 崩溃重试用的 mapper 是主 mapper 的过期拷贝，缺 `groupId`/`progressTitle`/`progressSource`（主 mapper 在 `:332-334`）→ Agent Server 端口变更触发重试后，本 turn 剩余的工具分组与标题全部消失。

**P1-10** `apps/desktop/src/renderer/lib/providers/hooks/useProviderEditSave.ts:212` [参数] 供应商编辑保存重建 `meta`，`createdAt` 被重置为当前时间且 `tags` 只有新增分支会设 → 每次保存都改写创建时间并剥掉标签，与自身注释「preserve `meta` … across edits」矛盾。

**P1-11** `apps/desktop/src/renderer/lib/providers/hooks/useProviderEditSave.ts:50` [参数] `notes` 与 `extra_env` 声明并发送但 `save()` 从不读取 → Notes 字段被丢弃，新建供应商丢失 preset 的 `defaultEnvOverrides`。

**P1-12** `apps/desktop/src/renderer/components/automation/CronEditorModal.tsx:679` [参数] 模型选择器只存 `.raw` 丢弃 provider 绑定（对比 `use-bot-contact-form.ts:96-98` 保留 `providerId`）→ 跨供应商同名模型下 `Scheduler.ts:178` 的 `resolveCronProvider` 会解析到错误供应商。

**P1-13** `packages/cli/src/program/build-control-plane.ts:199` [参数] 默认子命令自动派发构造的 options bag 不含 `--watch`/`--interval` 等 `subStatus` 声明的选项，而选项注册在子 `Command` 上 → `duya status --watch` 报未知选项。`commands/status.ts:70` 与 `channel.ts:505,514` 都读这些字段。

**P1-14** `packages/cli/src/program/build-agent-runner.ts:253` [参数] 进程内（agent tool）派发器漏掉 `text` 与 `file`，而 `channel.ts:514` 会回退成 `''` → 经 `duya_cli` 工具执行 `channel send --text hi --file a.pdf` 发出空消息且无附件。

**P1-15** `packages/ai/src/api/openai-completions.ts:796` [参数] `toolChoice`（`'auto'|'any'|{type:'tool',name}`）在共享 `AIClient.streamChat` 选项里声明并注明「forward[s] the native tool_choice shape」，但两条 OpenAI 路由（`openai-completions.ts:787`、`openai-responses.ts:693`）都静默丢弃，只有 Anthropic 路由 `anthropic-messages.ts:2052` 转发。

### 功能逻辑

**P1-16** `packages/agent/src/agent/SessionFinalizer.ts:322` [逻辑] 中断修复路径不可达。先 `cleanupIncompleteToolUse` 删掉尾部含 `tool_use` 的 assistant 消息，紧接着 `:326-327` 的 `injectSyntheticToolResults` 只对 `tool_use` 块注入 "Interrupted by user" → 循环体永不执行，违反其 `:301-304` 契约第 6 步。

**P1-17** `packages/agent/src/agent/DuyaAgent.ts:3309` [逻辑] 流中途 Stop 走 `finalizeStreamError`，不派发 Stop/SessionEnd（turn 之间 abort 走 `:3322` 才有）→ 常见取消路径下 mode 退出、后台任务拆卸的 hook 消费者全部静默不执行。

**P1-18** `packages/agent/src/agent/DuyaAgent.ts:2661` [逻辑] max_tokens fail-fast 生成的 tool_result 绕过 `_pushDurable`（唯一通往 timeline 与 Journal 的桥梁），而 assistant 的 `tool_use` 已在 `:2634` 落库 → 持久化历史出现无配对 `tool_result` 的 `tool_use` → 重载后下一轮 provider 严格校验 400。

**P1-19** `apps/desktop/src/main/automation/agent-run.ts:219` [逻辑] cron 超时只 `reject`，不销毁 `req`/`res` → `Scheduler.executeCron` catch 后 30s 重试，旧 HTTP 流继续执行，同一条 cron 并发跑。

**P1-20** `apps/desktop/src/main/gateway/lifecycle.ts:174` [逻辑] 每次崩溃重启都调 `startGatewayProcess`，其中 `backoffMs = RESTART_DELAY_MS` 把 `:131` 算出的指数退避重置 → 退避永不升级。

**P1-21** `packages/agent/src/tool/SendToAgentTool/SendToAgentTool.ts:182` [逻辑] 「可用 agent」提示恒含发送者自身：过滤用裸 roster key 与 `bot:` 前缀的 `fromAgentId` 比较；同文件 `:158`/`:176` 已正确归一化，只有 `:182` 漏掉。另 `:164` 自发送拒绝返回 `error: false`，模型会重试循环。

**P1-22** `apps/desktop/src/main/channels/telegram-connector.ts:436` [参数] 白名单按含数字 id 的 sender 判定，发出的信封 `:463` 却丢掉数字 id → 同一条消息在两个身份下被判定与归属。

**P1-23** `apps/desktop/src/main/memory/memory-worker.ts:717` [逻辑] `succeeded_no_output` 被计入产出量，重置 5 分钟冷却并触发 LLM 整备周期 → 刻意无记忆产出的轮次仍烧一次整备。

**P1-24** `apps/desktop/src/renderer/components/settings/MCPSection.tsx:399` [逻辑] 编辑 MCP 服务商会用 7 字段对象整体替换条目，静默丢掉 `transport`/`url`/`headers`/`nameOverride`/`startupTimeoutSec`/`toolTimeoutSec`/`toolTimeouts`；`validateForm` 又强制要求 `command` → HTTP/streamable 服务根本无法从该面板保存。

**P1-25** `apps/desktop/src/renderer/components/settings/ProvidersSection.tsx:240` [重复] 与 `ModelSelectionSection.tsx:251` 是两套并存的模型选择 UI，写不同 store、provider 语义不同（`name` 小写 vs `providerType`），回读匹配器各认自己那套 → 在 A 面板选的视觉模型在 B 面板显示为空或错值。

**P1-26** `apps/desktop/src/renderer/components/settings/ModelSelectionSection.tsx:204` [逻辑] 保存提示成功但视觉模型根本没写入：值为 `custom:<model>` 时 `providers.find` 落空、`if (provider)` 整块不执行，但 `:258` 仍 `setOriginalVisionModel` 清 dirty → 保存按钮变灰，模型静默未变。

**P1-27** `apps/desktop/src/renderer/components/chat/MessageItem.tsx:732` [逻辑] ✔已核 关闭 hook 开关后已持久化的 hook 行永不消失：`showHookInvocations` 在 memo 内被读取却不在依赖数组中。

**P1-28** `apps/desktop/src/renderer/hooks/useStreamingActions.ts:180` [逻辑] `flush` 闭包捕获过期的 `showHookInvocations`，订阅回调只随 `[sessionId]` 重注册 → 流中途切换开关无效，`:142` 注释声称的行为未实现。

**P1-29** `packages/gateway/src/adapters/weixin/index.ts:543` [逻辑] 微信长轮询游标在批次内任何消息被处理**之前**就推进并落盘（`setSyncBuf` → `state-store.ts:104-109` persist），且单条失败只 `console.error` → 崩溃或单条失败即永久丢消息，永不重投。

**P1-30** `packages/plugin-core/src/mcp/resolve.ts:453` [逻辑] 插件路径穿越防护用裸字符串前缀，`…/plugins/foo-evil/x.js` 可通过根为 `…/plugins/foo` 的包含判定；正确的 `relative()` 版 `isWithin` 就在 `capability-discovery.ts:215-218`。

**P1-31** `apps/desktop/src/main/db/core/message-log.ts:1255` [逻辑] 崩溃恢复 `scan()` 的 INSERT 漏掉 `generation` 列 → 恢复行一律取默认值 0，而多文件读取器 `listBySessionMultiFile`（`:845`）按 `generation` 解析文件 → 读错归档。同样的漏写在 `:2521`、`:2072`。

**P1-32** `apps/desktop/src/main/db/core/message-log.ts:2286` [逻辑] `getCurrentGeneration` 从最大 `seq` 的行取 generation，但 seq 是跨代 `MAX(seq)+1` 分配的，而 `rewriteSession:2096` 会从 1 重新编号 → 重写后末行不是最新代，新行继承过期 generation，`resolveFile` 指向归档文件。

---

## 3. P2（57 条）

### 工具执行与重试（packages/agent）
| 位置 | 类别 | 问题 |
|---|---|---|
| `ToolRetryExecutor.ts:91` | 参数 | 错误串 `''` 为 falsy，重试后失败被当成成功的空 `tool_result` 上报 |
| `ToolRetryExecutor.ts:254` | 参数 ✔已核 | `read` 回退构造 `{ filePath }`，而 `ReadTool.input_schema` 要求 `file_path` → 回退必然校验失败 |
| `ToolRetryExecutor.ts:85` | 逻辑 | 无策略匹配时仍会再执行一次，非幂等工具可能重复施加副作用（`idempotentOnly` 在第二次之后才判断） |
| `WriteTool.ts:138` / `ReadTool.ts:255` | 参数 ✔已核 | 两个提取器都读 `input.path`，schema 字段是 `file_path` → 恒返回 `UNKNOWN_PATHS`，写并行度失效（被 `StreamingToolExecutor.ts:824` 拒绝混批掩盖） |
| `DependencyGraphOrchestrator.ts:126` | 逻辑 | `extractReadPaths` 全链路贯通后无人读取，read/write 串行化是静默空操作 |
| `GetTaskOutputTool.ts:161` | 参数 | 合成状态 `'not_found'` 强转进不含它的封闭联合 `TaskStatus`，且不在 `:38` 终态集合内 → 计数永远停在 `0/1` |
| `AgentManagementTool.ts:183` | 逻辑 | agent 不存在时按成功结果返回（缺第三个参数 `true`） |
| `runAgent.ts:591` | 逻辑 | abort 分支 `break` 前未关闭子 agent 流迭代器（stall 分支 `:548-552` 有关闭） |
| `continueParentWork.ts:50` | 逻辑 | 两分支都塌缩为 `blobHasExec(last)`，`blobIsDelegate` 是死条件 → 纯委派型请求得到错误 CTA |
| `DuyaAgent.ts:2343` | 参数 | 有 `modelCapabilities.maxOutputTokens` 时调用方 `maxTokens` 被完全忽略（provider 侧无 `min()`），而渲染层确实在发 `maxTokens` |
| `DuyaAgent.ts:3052` | 逻辑 | token trace 的 `prev` 在 `:3040` 已被重新赋值后才取值，恒等于 candidate，诊断失效 |
| `visual-analysis.ts:93` | 参数 | 视觉流拿不到 abort signal，图像分析期间的 Stop 无法取消 provider 请求 |
| `session/task-store.ts:146` | 参数 | `updateTask` 发 camelCase 的 `activeForm`/`blockedBy`，主进程适配器 `core-db-adapters.ts:850,853` 只读 `active_form`/`blocked_by` → 静默丢弃；`createTask` 同丢 `blocks`/`blockedBy`/`metadata` |
| `memory-rollout/writer.ts:143` | 逻辑 | 文件名冲突分支是死代码（拿刚推导出的文件名比同一个 shortid）→ 真冲突会静默覆盖他轮摘要 |
| `decisions/service.ts:101` | 逻辑 | 校准记录 `Object.values(distribution)[0]`（首个声明项）而非最可能项，`policy.ts:60` 的 `topCandidates` 就在旁边未被使用 |
| `lifecycle/BackgroundAgentLifecycle.ts:466` | 逻辑 | `killAll` 只 abort 不强制终态；子生成器吞掉 abort 时记录永远停在 `running`，父级 keep-alive 不释放 |

### 运行时、协议与 provider
| 位置 | 类别 | 问题 |
|---|---|---|
| `agent-runtime/src/controller.ts:637` | 参数 | inbound-envelope 分支丢弃 `requiresTerminal` → 保留命名空间的未知事件只记 diagnostic，run 继续走到 `completed`；frame 路径在 `:842-854` 明确拒绝 |
| `agent-core/src/run-outcome.ts:35` | 重复 | 终态事件集合被独立声明三次（此处、`event-emitter.ts:62`、`run-ledger.ts:153`），新增终态要改三处，而 emitter 引用的普查测试只覆盖两处 |
| `ai/src/api/openai-completions.ts:790` | 逻辑 | 注释承诺 reasoning 模型用 `max_completion_tokens`，代码无条件发 `max_tokens`，该分支不存在 |
| `ai/src/api/anthropic-messages.ts:2047` | 参数 | `compat.fixedTemperature` 只被 `openai-responses.ts:701` 遵守，Anthropic 与 openai-chat 两条 builder 直读 `chatOptions.temperature` → 声明固定温度的模型仍收到调用方值（目前仅 openai-responses 声明，故潜伏） |
| `ai/src/api/anthropic-messages.ts:2311` | 重复 | 同一文件两套 `maxTokens` 解析：流式路径四级回退 + MiniMax clamp，`chat()` 用 `?? 1024` 裸值 |
| `scripts/architecture/layer-purity.ts:159-160` | 逻辑 | 纯度扫描器是 `strip-comments.mjs` 的正则拷贝且对字符串不敏感。**实跑探针**：`const label = "//"; const r = fetch(url);` 被剥成 `const label = "`，`IO_PRIMITIVES` 报 false。`:156-157` 注释「never a false negative」被证伪，而 `layer-purity.test.ts:123` 这道「THE assertion」门禁一直绿 |

### 主进程：配置、通道、调度
| 位置 | 类别 | 问题 |
|---|---|---|
| `cli/handlers/crons.ts:299` | 参数 | 线协议枚举含 `'queue'`，但 `automation/types.ts:11` 与 `Scheduler.ts:259` 都不支持 → 传 `'queue'` 得到无界并发 |
| `automation/cron-file.ts:326` vs `:276` | 重复 | `dedupeCrons` 去重键是 `(name, schedule, workspace)`，`createCron` 匹配键额外含 `event_triggers` 与 `agent` → CLI `cron dedupe` 会误删合法例程 |
| `services/orb-wakeless-chat.ts:529` | 参数 | `getSetting('workspaceDir')` 读原始 `settings.value`，而渲染层 `useSettings.ts:361/363` 对非字符串走 `setJson` → 同一键的读写路径不一致，JSON 化过的值会带引号传给 worker |
| `db/core/stores.ts:109` | 参数 | `TaskStore.create` 在 VALUES 里硬编码 `blocks='[]' blocked_by='[]' metadata='{}'` 而不绑定 → `TaskCreateInput` 无法播种，而紧随其后的 `task:block` 依赖这些边可写 |
| `db/core/stores.ts:390` | 逻辑 | `permission:resolve` 用 truthy 判断，空数组/空对象与「未提供」无法区分（审计方自评低置信，未找到实际传空值的调用方） |
| `db/core/session-store.ts:465` | 逻辑 | `search()` 的 `limit` 无上限（同族 `listSummaries`/`listByPrefix` 都走 `clampLimit`） |
| `db/core/session-store.ts:494` vs `:524` | 重复 | 三个「列会话」方法用两种排序键：`listSummaries` 按 `recency_at`，`listByPrefix`/`search` 按 `updated_at` → Plan 582 拆分时间戳后未同步迁移，cron 历史会因 housekeeping 写入而重排 |
| `db/core/session-store.ts:304` | 逻辑 | `create()` 在 INSERT 后 `return this.get(input.id)!`；`GoalStore.create:659`、`SpawnEdgeStore.record:943` 同款 → 写入失败表现为下游 `TypeError` |
| `db/core/message-log.ts:418` | 重复 | `message_search` 表每次 append 都写（`:1355`、`:1327`）却从无读取方（`searchText:1373` 直接扫 rollout 文件）→ 白付每次写入的索引重建成本 |
| `packages/conductor/src/renderer/elements/widget-sanitizer.ts:283` | 参数 | CDN 白名单是子串测试，`https://cdn.jsdelivr.net.evil.com/a.js` 通过；目前仅靠 `:326` 的 per-document CSP 兜住 |
| `packages/plugin-core/src/plugins/loader/capability-discovery.ts:159` | 参数 | `collect.ts:57` 声明的 `envPassthrough`/`useShell` 两条发现路径都不填充，且 Agent-Plugins 路径还丢掉 native 路径保留的 `nameOverride`/超时 → 同一 server 在两条路径下得到不同的 provider tool 名 |
| `packages/plugin-core/src/security/permission-service.ts:88` | 逻辑 | `PermissionRequest.paths` 从不被强制，grant 无 `domains` 时域检查被跳过 → 窄授权被当作宽授权 |
| `packages/plugin-core/src/security/policy-engine.ts:85` | 重复 | `strictKnownMarketplaces` 是死开关：其后还有一处无条件的白名单检查，该 flag 无法放宽任何东西 |
| `packages/computer-use/src/decide/questions.ts:84` | 逻辑 | `done_change` 从第 2 轮起一直问却从不读（controller 只提取 `done/error/blocked/irreversible`）→ 无进展信号永远到不了循环 |

### 渲染层与设置面
| 位置 | 类别 | 问题 |
|---|---|---|
| `MessageList.tsx:1002` | 逻辑 | `unreadTurns` 只累加与重置、从不渲染，`:1305` 注释承诺的跳转按钮角标不存在 |
| `chat/tools/registry.ts:53` | 重复 | `extractFilename` 只按 `/` 切分，Windows 绝对路径（agent prompt 明确要求绝对 `file_path`）整条显示；同文件 `:304` 与 `lib/projectPaths.ts:173` 是另两份实现，后者才处理 `\`、盘符、UNC |
| `chat/tools/registry.ts:240` | 重复 | 第二条 `todo`/`todowrite` 注册项不可达（`getRenderer` 用 `find`，`:157` 已先匹配），且两者语义不同（`3/5 completed` vs 首条内容） |
| `HookActionRow.tsx:31` | 重复 | 亚秒时长渲染为 `450ms`，同组 chrome 的 `ActionRowChrome.tsx:200`/`useTopLevelChrome.tsx:12` 渲染为 `0.5s`，`useUsageData.ts:60` 是第三种 |
| `components/agent-face/decor.ts` | 重复 | face 引擎两份且已发散：`orb/bot/` 是改版后（紫色色带、`NOTIF_VIOLET`、皮肤 `duya`），`agent-face/` 是改版前（`NOTIF_BLUE`、`'encre'`），而侧边栏与工作流图挂的是后者 → orb 头像紫色、其它地方不是 |
| `StreamingMessage.tsx:188` | 参数 | `StreamingTools` 声明并转发 `totalDurationMs`，唯一调用点 `:392` 从不传 → 恒 `undefined`（被 `useTopLevelChrome.tsx:48` 的 `liveStartedAt` 短路掩盖） |
| `hooks/useTaskList.ts:38` | 逻辑 | 无请求序号守卫，先前线程的慢响应会覆盖新选中线程的任务列表（同仓 `useNextStepSuggestions.ts:64` 已有正确写法） |
| `hooks/useBashTaskOutput.ts:72` | 逻辑 | `disposedRef` 只防卸载不防任务切换，旧 `outputFile` 的在途读取可把上一个任务的输出写到新任务标题下 |
| `settings/MemoryRagCard.tsx:89` | 逻辑 | `handleRebuild` 无 `try/catch`，拒绝后 `rebuildState` 永久停在 `running`，按钮永久禁用且产生未处理 rejection |
| `lib/agent-sse-client.ts:50` | 重复 | 第二套 Agent Server SSE 客户端，与 `agent-http-client.ts:121` 的 live 客户端在去重、重连预算、端口缓存上都不一致 |
| `lib/stream-session-manager.ts:2079` vs `:2500` | 重复 | `tool_use` reducer 有顶层与内嵌两份，内嵌那份丢 `groupId`/`progressTitle`/`progressSource`（回退路径） |

### 重复实现面（无独立行为缺陷，但属维护负债）
- **47 个 `db:*` 能力双写**：`ipc/db-handlers.ts`（渲染层入口，无条件 create）与 `agents/db-bridge.ts`（agent 入口，get-then-create）——已在 `goal:create` 上产生行为分叉。
- **40 个已注册 IPC 通道 preload 无封装可调用**：`db:goal:*`、`db:task:*`、`db:channel:*`、`db:lock:renew`、`plugin:security:*`、`vision:*`、`gateway:status` 等。其中 `lock:renew` 的真实能力走 db-bridge action（`db-client.ts:373` → `db-bridge.ts:1272`），同一能力两套通道。
- **14 个 db-client action 既不可服务也无人调用**：`provider:*`（6）、`pairing:*`（5）、`logs:errors`/`logs:tail` 在 bridge 无 case（会抛 `Unknown DB action`），且全仓零调用点。
- **三处 `normalizePath` 语义各异**：`main/memory-state/pathUtils.ts`（realpath + 仅小写盘符）、`renderer/lib/projectPaths.ts`（整条小写）、`packages/agent/.../ReadTool.ts`（仅换分隔符）。经核 Windows 大小写不敏感使其当前不致故障，但已是三份独立规则。
- **CLI 两套派发器 options bag 不一致**：`build-control-plane.ts:115` vs `build-agent-runner.ts:250`（P1-13/P1-14 即源于此）。
- **路径包含判定两套**：`capability-discovery.ts:215` 的 `isWithin`（正确）vs `resolve.ts:453` 的 `startsWith`（可绕过）。
- **MCP server 发现两条路径字段集不同**：`discoverMcpServers` vs `discoverAgentPluginsMcpServers`。
- **两套 widget srcdoc 构建器**：`buildReceiverSrcdoc` vs `buildWorkbenchSrcdoc`，CSP 策略不同；sanitizer 与 `workbench-runtime.ts:156` 的 `extractInlineScripts` 对 CDN `src` 标签处理相反。
- **入站 IM 消费两套信封**：`gateway` IPC `gateway:inbound`（`NormalizedMessage`）vs `connector-runtime.ts:222` `routeInboundToBot`（`ChannelInboundEnvelope`）。
- **`EditTool.ts:728` + `ApplyPatchTool.ts:604`**：原子写临时文件在 `rename` 失败时不清理，且是两份同构拷贝。
- **`managed-bash.ts:213`**：自动转后台后超时提示报的是前台预算而非真正 kill 进程的上限。
- **`utils/timeouts.ts:6`**：从 env 读 bash 超时的第二套实现，`BashTool/constants.ts:27` 硬编码同值；前者生产无调用方。

---

## 4. 587 计划既有发现（F01–F09）在当前 HEAD 的复核

| # | 状态 | 最强证据 |
|---|---|---|
| F01 | **部分修复** | 写侧已修（`run-control-plane.ts:59` `ok: durable`）；读侧仍坏（`db-bridge.ts:340` 只回 `receipt.write`）→ 见 P1-7 |
| F02 | **仍存在** | `router.ts:2226-2244` 记 warn 后仍 `sendCommand` 原始动词，调用方只拿到 `recorded:false` |
| F03 | **仍存在，逐字未改** | `run-session.ts:1073` `if (this.#queue.length >= this.#limit) this.#queue.shift();`；`#waiters`（`:1063`）是所有 `events()` reader 共享的同一数组，`controller.ts:1192` 把同一个 `active.stream` 对象返回给每个调用方。`BoundedEventQueue`/`FanOutBroker` 仍未接线 |
| F04 | **仍存在** | `router.ts:1953` `respond('interrupted')` → `:1871` `settleSession(..., {cancelRequested:true})`，worker 未被停止 |
| F05 | **仍存在** | `controller.ts:625-654` 的 `sink.envelope` 无 `#enforceBudget` 调用，frame 路径在 `:863` 有 |
| F06 | **仍存在** | `event-emitter.ts:352-353` 在 `session.observe` 后立即 push；`run-session.ts:491` 把 durable flush 做成浮动 Promise，发布早于 `persistence.complete`（`:569`） |
| F07 | **仍存在** | `in-process-transport.ts:113-116` 传空 `sessionId`/`prompt`/`revision`；`http-sse-transport.ts:543` `parseSseStream(await response.text(), …)` 缓冲到 EOF |
| F08 | **仍存在** | `control-plane-service.ts:103-107` 按容量踢最旧 binding，不判活跃；`main/index.ts:360` 仍注入 free dispatcher |
| F09 | **仍存在，且已实跑证伪其自述** | 见 §3 `layer-purity.ts:159-160` 行 |

---

## 5. 建议修复顺序

按「用户可见影响 × 修复成本 × 是否为其它 bug 的根因」排序。

**第一批 — 单点改动、立刻见效**
1. P0-1 `turnCommitted` 改 getter（`DuyaAgent.ts:2349`）。一行改动，消除工具重复执行。
2. P0-4 `goals.get(p.session_id)`（`db-bridge.ts:734`）。一行改动。
3. P0-2 流式事件排除出去重集合（`agent-http-client.ts:757`）。
4. P0-3 `AgentEvent` 补 `metadata` + 三个 mapper 复制（`agent-http-client.ts:325,436,589`）。
5. P0-5 删掉 `controller.ts:1177` 的二次 push。
6. P0-6 飞书所有文本统一走 `onMessage` 并把 `threadId` 作为第 5 参。
7. P0-7 删除动作改为 prop/store 直传（`ProviderEditView.tsx:415`）。
8. P2 `WriteTool.ts:138`/`ReadTool.ts:255` 改读 `file_path`；`ToolRetryExecutor.ts:254` 回退字段改名。两处都是纯字段名笔误。

**第二批 — 收敛重复实现，一次消除多条缺陷**
9. 抽 `toAgentEvent()` 单一 mapper，消除 P1-9。
10. `db:*` 双写收敛为「一个实现 + 两个薄入口」，同时修掉 P1-7、P0-4 的分叉。
11. 渲染层 face 引擎、basename、时长格式化、SSE 客户端各留一份。
12. CLI 两套派发器共用一个 options bag 构造器（P1-13/P1-14）。
13. 路径包含判定统一用 `isWithin`（P1-30）。

**第三批 — 需要设计决策，先写计划再动手**
14. P1-1 工具重试纳入权限/超时闸门；P1-3/P1-4/P1-5 三处 mode 生命周期与工具闸门未接线。
15. F02/F03/F04/F05/F06/F07 六个仍存在的 587 发现——它们共享「durable 先于对外宣布」与「同一执行合同只有一条路径」两条不变量，适合在同一轮里改。
16. 死接口面清理：40 个无人调用的 IPC 通道、14 个不可服务且无调用方的 db-client action。
17. 安全项：P1-30 路径穿越、CDN 白名单子串测试、`permission-service` 的 `paths` 未强制。

**建议补的回归测试**（每条对应一个 P0，都是当前测试未覆盖的接缝）
- 流重放：注入 post-`done` 传输故障，断言工具执行次数仍为 1。
- `goal:create` 幂等：同 session 连续两次 create，断言第二次返回既有行且无 UNIQUE 错误。
- `tool_use_delta`：一次工具调用发 N 个分片，断言渲染层收到 N 片并能拼出完整参数。
- `metadata`：断言 `tool_result` 的 `metadata` 抵达 `BrowserToolRow`。
- 供应商删除：从编辑页触发，断言 provider 真的消失。
- 飞书话题消息：带 `thread_id` 的文本必须抵达 agent。
- 审批：注入 DB busy/not_found，断言未持久确认时工具执行数为 0（F02 现有测试 `permission-router-decision.test.ts:168` 写死了错误策略，需一并改）。

---

## 6. 已核实干净的部分

主动查证后确认无缺陷的边界，记录以免重复排查：

- **IPC 通道对账**：preload 396 个 `invoke` 全部有主进程 handler；436 个注册通道无一重复注册；396 条通道的位置参数 arity 在两侧全部匹配。⚠️ 必须按 `register(` 辅助函数**跨行**匹配——逐行正则会漏掉 64 个并造成「64 个通道无 handler」的假警报。
- `git-ipc.ts` ↔ `preload/index.ts:2619-2633` ↔ `contracts/git.ts` 三方同步，11 个 wrapper 参数全转发。
- `ipc-client.ts` 与 16 个 `*-ipc.ts` 的所有 `window.electronAPI` wrapper 都转发参数，无 wrapper 用默认值覆盖调用方显式值。
- 端到端字段名核对一致：`permission`（`id`/`toolName`/`toolInput`/`mode`/`expiresAt`）、`done.reason`、`error.{message,code}`、`db_persisted.{success,messageCount}`、`title_generated.title`。
- `subscribeToPhase`/`subscribeToTools`（`stream-session-manager.ts:3504,3511`）在订阅时同步回放当前状态，不存在跨会话切换的过期问题。
- `packages/agent/src/tool/SubagentTool/runAgent.ts:643-646` 心跳 `clearInterval` 与 abort 监听移除都在 `finally`。
- `BackgroundAgentLifecycle` 的 `tryComplete`/`tryFail` 正确吸收 kill 竞态；`notified` 使任务通知幂等。
- `ContextLedger` epoch/shrink/round-max 记账与 `TokenBudgetManager` 水位推导自洽。
- `historySanitize.sanitizeCompactedHistory`/`fitCompactedToBudget` 配对修复循环可终止。
- `stores.ts` claim/unassign/lock 路径占位符数与绑定数组全部匹配；`LockStore.acquire` 在同一事务内回收过期行；`SpawnEdgeStore.getTree` 正确用 `UNION`（非 `UNION ALL`）终止环。
- `run-store.ts`：`createRun` 占位符精确，`appendEvents` 在单事务内改为读回比对，`completeRun` 的 `WHERE status='running'` 是真正的 CAS。
- `research-store.ts` upsert 的 13/9 个绑定值与列清单对齐，`getActivitiesByRunId`/`getEventsByRunId` 正确应用 `visibility`/`afterSequence`/`limit`。
- `lease.complete` 18 个占位符 / 18 个参数，CAS 与 lease 删除在同一 `BEGIN IMMEDIATE` 内。
- `automation/schedule.ts` `computeNextRunAt`：`cron` 锚定 `lastRunAt`/`created_at`（非 `nowMs`），`every`/`once`/`endAt` 语义一致。
- `config/store.ts` 写路径：原子写 → 三段 EPERM 退避 → copy 兜底、损坏文件备份、目录监听去抖 + 深比较跳过、密钥拆分/`mergeSecrets` 往返对称。
- Telegram 长轮询：offset 在异步处理前推进、`skipTo` 高水位重放、批次处理后才落盘、`stop()` 尊重 `AbortController`。
- `wake-dispatcher.ts` 排空：`drainGeneration` 僵尸守卫、成功与失败路径都清 escape timer、重驱上限 3。
- weixin/telegram/qq/whatsapp/discord 五个适配器的 sender→chat→message-id 映射内部自洽且与 `NormalizedMessage` 逐字段对应（飞书是唯一例外，见 P0-6）。
- 渲染层 `read` 类 IPC/window/webview 监听全部成对移除；`AgentBrowserTab.tsx:138` 清 interval + 6 个监听 + 反注册。
- 工具行 `key` 用 id（`group.message.id`、`orphan-result-${id}`），无 index-keyed 流式行；Bash/Read/Todo/CUA 输入字段名与 agent schema 完全一致。
- desktop `memory-state/tierConflicts.ts` 是纯再导出 shim，与 agent 侧逐字段一致，**不是**第二套实现。
- `LoopHookBus.dispatch`（`hooks/loop.ts:154-179`）逐 handler try/catch fail-open、effect 类型校验、首个 `block_finalize` 正确短路；outbox 写入原子（tmp + `renameSync` 带 EPERM/EBUSY 兜底），每个目标在任何 fs 写之前都过 `assertSafe`。
- `agent-protocol` 事件字段清单 `required.ts` 结构上锁定在 `RunEventPayloads` 上；`criticality.ts` 的 `CriticalityDisagreements` 在任一方向漂移时真正编译失败。
- `packages/ai` Anthropic 末段 clamp（`:1934-1943`）在预算不足 1024 token 时正确丢弃 `thinking`，不发非法 `budget_tokens`。
- `strip-comments.mjs` 本身是合格的 tokenizer 级剥离器——F09 的缺陷在于纯度门禁没有用它。

---

## 7. 方法与局限

- 12→20 个互不重叠切片并行只读审计，覆盖 `apps/desktop` 全部四个顶层目录、`packages/agent` 全部 src 子目录，以及 `agent-runtime`/`agent-protocol`/`agent-core`/`ai`/`plugin-core`/`conductor`/`gateway`/`computer-use`/`cli`/`voice`/`scripts`/`evals`/`e2e`。第 4、5 波专门封堵前三波自认的覆盖缺口。
- 主控侧独立做了 5 项机械对账：IPC 通道双向对账、通道 arity 全量比对、db-bridge action 与 db-client 发送键全量差集、全仓库空 catch 分布、`normalizePath`/`formatBytes`/`sleep` 等同名函数的跨仓分布。
- 主控对 **21 条**发现做了独立源码复核（`turnCommitted` 值拷贝、`goal:create` 字段名、`input.path` vs `file_path`、`filePath` 回退、`onExit` 唯一调用点、`filterTools` 零生产调用、`tool_use_delta` 去重键、`metadata` 零出现、供应商删除监听者挂载条件、飞书 `onThreadMessage` 零注册、工作区父目录允许根、微信游标推进顺序、`permissions.ts` 放行/拒绝次序、`skillScanner` 死变量、游标失效重头分页、`wf.map` worker 循环、迁移 45 的 CHECK 与拷贝、`token-vault` 缓存顺序、`wechat-qr` TTL 不一致、`backup --dry-run` 标志未转发、`project-database` 游标），**全部属实**。
- 三次自查假警报已排除并记录，避免后续重复：逐行正则漏匹配跨行 `register(`/`case 'x':`；db-bridge 反向差集混入了「默认模型解析」switch 的 provider 分支；`agent-http-client` 的 `metadata` 检索一度误判为存在（实为 grep 路径写错）。
- **未运行**任何产品测试、构建或运行时探针；所有结论均为源码级推理。两条结论来自审计方在其切片内执行的独立 `node -e` 纯字符串探针（`layer-purity` 假阴性、`wf.map` 行为），无副作用。
- 各审计方标记为 unverified 的候选项**未计入**本清单。此外，Wave 4/5 的切片在预算内未能读完、已在其报告中如实声明的区域：
  - `conductor/src/renderer/` 116 个文件中约 90 个仅做 grep 覆盖（`NativeChrome.tsx` 923 行、`connector-renderer.ts` 1379 行、`CanvasArea.tsx` 1565 行中的部分、`CanvasLibraryView`、各 `native/*Element` 等）。
  - `services/browser/daemon.ts` 仅读到 758/868 行；`services/app-connections/` 50 个文件中 11 个做全深度、其余做定向核查。
  - `agent-process-entry.ts` 4942 行的中段（LLM 流/工具派发主体）、`permissions/types.ts` 以外的少量符号级阅读。
  - `evals/agent/matrix/rows.ts`（1039 行）、`e2e` 的 4 个 conductor spec（1037 行）仅做扫描。
  - 50 条迁移的 `up` 函数体中，`schema.ts` 已全部读完并确认守卫健全；未逐一验证「`ADD COLUMN` → 全仓读取点」的反向孤儿列检查。
- 已知但**未纳入**本清单的两类：`node_modules`、`dist`/`release` 等构建产物；以及 `docs/` 下的计划与报告本身。

---

# 第二部分：补充审计（Wave 4–5，针对首轮自认的覆盖缺口）

首轮报告在 §7 如实列出 8 处未覆盖区。第 4 波派 4 个切片、第 5 波再派 4 个切片专门封堵，新增 **44 条**（P0 6、P1 21、P2 17）。此时累计 **138 条**：P0 13、P1 51、P2 74。

## 8. 补充 P0（6 条）

### P0-8 [逻辑] 工作区**父目录**被当作允许根，同级目录全部自动放行 ✔已核
`packages/agent/src/permissions/policy.ts:1094`

```ts
if (context.defaultWorkspaceDirectory) {
  allowedDirs.push(path.resolve(context.defaultWorkspaceDirectory));
  allowedDirs.push(path.resolve(path.join(context.defaultWorkspaceDirectory, '..')));  // ← 父目录
} else {
  ...
  allowedDirs.push(path.resolve(path.join(homeDir, '.duya', 'workspace')));
  allowedDirs.push(path.resolve(path.join(homeDir, '.duya')));                        // ← 整个 ~/.duya
}
```

`isPathWithinRoots`（`tool/allowedRoots.ts:37`）本身是正确的，**错的是根集合**。从工作区 `E:\Projects\duya` 发起对 `E:\Projects\other\.env` 的 `Write`，在 `permissions.ts:601` 的管线第 7 步直接返回 `allow`——无提示、无分类器，default/ask 模式下均如此。

两个放大因素：
- 未配置工作区的分支把整个 `~/.duya` 设为允许根，而 `ReadTool.ts:143-149` 专门为该目录加了 DUYA 自配置防护。**两道防线互相抵消。**
- 该行自 `4bcf31fe`（2026-08-05，plan 315）引入后从未改动，从未被注释过。

审计方定级 P1；本报告上调为 P0，理由是它静默绕过了权限闸门本身，且与仓库内另一处显式防护直接冲突。修复：删掉 `'..'` 根，只保留工作区 + `additionalWorkingDirectories`。

### P0-9 [逻辑] `wf.map` 的并发 worker 在 run 已终止后仍继续执行工具 ✔已核
`packages/agent/src/modes/workflow/dwf/runtime.ts:436`

```ts
const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
  for (;;) {
    const index = nextIndex++;
    if (index >= items.length) return;
    const release = await lane.acquire();
    try { results[index] = await fn(items[index]!, index); } finally { release(); }
  }
});
await Promise.all(workers);
```

N 个 worker 各自独立循环。`fn` 对某个 item 抛错时，只有该 worker 的 promise reject，**兄弟 worker 继续取新下标继续调用 `fn`**；而 `Promise.all` 已 reject，上层 `runDwfScript` → `failFrame` → `finishRun({status:'failed'})` 已把 run 标记为终态。终态之后仍在产生外部副作用。

修复：在 `catch` 中置 `aborted` 标志，每个 worker 在调用 `fn` 前检查。

### P0-10 [逻辑] 浏览器守护进程 EADDRINUSE 恢复无上限递归，且两条重试链并发争抢同一端口
`apps/desktop/src/main/services/browser/daemon.ts:711`

`settle`（`:685`）是每次调用局部的，只约束 reject 不约束重试。一个「`/shutdown` 返回 200 但端口未释放」的服务会让整个周期每 500ms 无计数重启。更糟的是 `:745-753` 对同步抛错调 `onError`，而 `'error'` 事件按其自身注释还会再触发一次 → 500ms 后两条并发重试链争抢同一端口，启动可能永久空转且 Promise 永不 settle。

修复：把尝试计数提升到 `startBrowserDaemon`，超过 N 次 reject；`onError` 加 per-server `handled` 守卫。

### P0-11 [参数] `backup create --dry-run` 会写真实归档 ✔已核
`packages/cli/src/program/build-control-plane.ts:118`

- `descriptors.ts:689` 向用户声明 `{ flags: '--dry-run', description: 'Preview the plan without writing' }`
- `backup.ts:174-178` 读 `ctx.options.outputDir / includeWorkspace / onlyConfig / dryRun / verify`
- `build-control-plane.ts:118-177` 的 options bag（50 个键）中 **`dryRun`、`outputDir`、`includeWorkspace`、`onlyConfig`、`verify` 零出现**

Commander 解析成功、用户看到安全承诺、值被丢弃 → `dryRun` 恒为 `false` → 干跑写真实归档。这是数据安全问题。

同类（同一根因，同一 bag）：`projects-cleanup.ts:229` 的 `--apply`/`--archive-dir`、`status.ts:70` 的 `--watch`/`--interval`、`session.ts` 的 `--q`/`--format`/`--output`、`channel.ts:503` 的 `--chat`/`--label`/`--token-env`/`--stdin`/`--agent` 全部被丢弃。修复：两个派发器从同一份字段表派生 bag。

### P0-12 [逻辑] eval 框架直调 dispatcher，结构上无法发现 P0-13
`apps/desktop/src/main/__tests__/eval-legacy-loop.ts:273`

```ts
dbRequest: (action, payload) => dispatchControlPlaneAction(action, payload)
```

生产链是 `getControlPlane().serve`（`control-plane-service.ts:264`）→ `db-bridge.ts:340`，中间两层才是携带 run 回执的地方。eval 直调最底层的自由函数，**因此下面 P0-13 的契约断裂可以让整个 eval 套件全绿**。

这解释了为什么首轮把该断裂评为「潜伏」：不是没有调用方，而是验证工具结构上看不见它。修复：让 harness 走 `serve`。

### P0-13 [参数] bridge 回执无 `ok` 字段，orchestrator 把成功 create 判为 `unreadable`
`apps/desktop/src/main/agents/db-bridge.ts:340`

`readRunReceipt`（`run-receipt.ts:300`）要求 `typeof record.ok === 'boolean'`，而 `RunWriteReceipt`（`run-receipt.ts:84`）根本没有 `ok` 成员。`run-control-plane.ts:59` 的 `onWire` 加上的 `ok: durable` 被 `serve` 剥掉，`run-orchestrator.ts:399` 重新解析时判为 `unreadable`。

**两个独立切片各自定位到同一条**，并与 587 计划 F01 的「读侧仍坏」一致。修复：`serve` 返回 wire reply 而非已解析的回执。

## 9. 补充 P1（21 条）

**权限与安全**
- `permissions/permissions.ts:377` [逻辑] 内部工具放行闸门位于 deny 规则查询（`:389`）**之前** → 用户为 17 个内置工具（`task`/`SendMessage`/`LSP`/`todo`…）或 `canvas_*`/`database_manage` 设置的 `alwaysDenyRules` 被静默忽略。修复：把 deny 查询上移。
- `security/skillScanner.ts:574` [逻辑] `lower` 计算后从不使用，扩展名匹配大小写敏感 → `payload.SH`、`hook.PY` 在大小写不敏感文件系统上被跳过，判定 `safe` → 社区 skill 策略 `allow` → 未经检查即安装。
- `permissions/classifier.ts` + `askWithoutUser.ts` 与主管线的一致性由 Wave 5 复核。

**数据层**
- `project-database/engine.ts:532` [逻辑] ✔已核 游标记录已不在过滤结果中时，`if (cursorIndex >= 0)` 静默跳过切片 → 分页从第 1 页重来，`nextCursor` 永远重复首页并重复返回每条记录。
- `project-database/engine.ts:478` [逻辑] 日期属性的 `equals` 用 `JSON.stringify` 比较，而 `valueFromRow`（`:395`）恒返回 `{start,end,timezone}` 三键、`DatabaseValueSchema`（`types.ts:127-131`）却允许只给 `{start}` → 日期等值过滤对匹配记录返回 0 行。
- `apps/desktop/src/main/services/app-connections/token-vault.ts:159` [逻辑] `set()` 先改内存缓存再 `flush()`；`flush` 抛错时缓存已被改 → 调用方收到「vault 不可用」拒绝，但该 token 会在下一次**无关**的 vault 写入时被落盘。
- `packages/agent/src/session/db.ts:1102` [重复] `USE_IPC_MODE` 分支与非 IPC 分支逐字节相同且从不调用 IPC client。生产环境 `USE_IPC_MODE` 为真（`db.ts:33`）→ 附件写入落到 worker 自己的第二条 `better-sqlite3` 连接，而非主进程 store；该守卫是死代码。

**流程与生命周期**
- `workflow/gui-runner.ts:152` [逻辑] 每步重放哈希只含 `do` + `text`，漏掉 `element`/`key`/`direction`/`amount`/`verify` → 修订 `key:'Enter'→'F5'` 或 `direction:'down'→'up'` 得到同一哈希，`:215` 的 `if (hit) continue` 跳过动作。
- `packages/conductor/src/renderer/stores/conductor-store.ts:868` [逻辑] undo/redo 无条件覆写栈标志 → 一次撤销即禁用 Undo，且**失败的撤销仍启用 Redo**；`undoAction`（`conductor-ipc.ts:163`）是裸 invoke，无重新水合。
- `agent-process-entry.ts:4415` [逻辑] `!chatInProgress` 在此处恒为真 → pop-one 分支是死代码，空闲时一次 ESC 丢弃**全部**排队提示而非队首一个。
- `packages/voice/src/worker.ts:64` [逻辑] `push`/`finalize` 在无 engine 时静默 return → `stt-worker.ts:135` 的 pending finalize 永不完成，调用方永久挂起。
- `services/voice/stt-worker.ts:83` [逻辑] 无 `child.on('error')` 监听 → fork 失败时 EventEmitter 的未处理 `'error'` 变成 throw，崩溃 Electron 主进程。两个独立切片各自定位到同一条。
- `services/terminal/TerminalManager.ts:128` [逻辑] `defaultShell()` 计算了 ComSpec 判断却丢弃，两个分支都 `return 'pwsh'` → cmd.exe 用户仍拿到 pwsh，该判断是死代码。

**参数传递（CLI options bag 根因）**
- `cli/src/commands/projects-cleanup.ts:229` `--apply`/`--archive-dir` 被丢弃 → 命令永远干跑，且其自身提示无法复现。
- `cli/src/commands/status.ts:70` `--watch`/`--interval` 被丢弃 → `duya status --watch` 打一次快照就退出。
- `cli/src/commands/session.ts` `--q`/`--format`/`--output` 被丢弃 → 搜索忽略查询串、导出忽略目标路径。
- `cli/src/commands/channel.ts:503` `--chat`/`--label`/`--token-env`/`--stdin`/`--agent` 被丢弃 → `channel send --chat <id>` 静默不寻址任何会话。
- `cli/src/program/build-agent-runner.ts:253` [重复] 两个派发器构造的 bag 不同（46 vs 50 键）：runner 有 `cwd` 而缺 `text`/`file`/`memoryAuto`/`memoryProvider`/`memoryModel`；control-plane 侧无 `cwd` 而 `cron.ts:325` 读它。修复：两处从同一字段表派生。

## 10. 补充 P2（17 条）

| 位置 | 类别 | 问题 |
|---|---|---|
| `db/core/database.ts:139` | 逻辑 | 核心迁移注册表有 id 空洞（3、19、20、21、27），`if (migration.id <= current) continue` 使**填进空洞的新迁移被永久跳过且无任何日志**；重复 id 至少会报错 |
| `db/schema.ts`（注册表结论） | — | 56 条迁移覆盖 id 1–58，**28 与 40 从未存在**（非死代码）；57/58 各出现一次、可达、以 `PRAGMA table_info` 守卫；无重复。`collectMigrations()` 注册了全部 16 个 store static，无未注册死面 |
| `stt-worker.ts:120` | 逻辑 | 第二次并发 `init()` 无条件覆写 `pendingInit`，第一个 Promise 永不 settle |
| `security/skillScanner.ts:362` | 逻辑 | 四个结构上限（`MAX_FILE_COUNT`/`MAX_TOTAL_SIZE_KB`/`MAX_SINGLE_FILE_KB`/`SUSPICIOUS_BINARY_EXTENSIONS`）各只有 1 处引用即自身声明 → 50 文件/1MB/256KB 边界与二进制扩展名检查从未执行 |
| `agent-process-entry.ts:2349` | 参数 | 固定 300000ms 定时器忽略 `request.expiresAt`，同一截止时间两个来源；`workflow-runner.ts:446` 发的 `wf.ask` 卡片倒计时 10 分钟，worker 5 分钟就自动 deny |
| `agent-process-entry.ts:2345` | 逻辑 | 过期路径 resolve `deny` 但不发任何事件 → 审批卡片在整个倒计时内仍可点击，迟到的点击被静默丢弃，「允许」看起来失灵 |
| `agent-process-entry.ts:4677` | 参数 | `updatedInput` 被转发并记录但只消费 `.answers`，Promise resolve 裸 `'allow'`；router 发的 `message`（`:4608`）声明后从不读取 → 非 AskUserQuestion 工具的用户改参被丢弃，执行的是原始 `toolInput` |
| `dwf/runtime.ts:238` | 参数 | `resuming` 带完整文档契约却从不读取，`workflow-runner.ts:931` 也不传 → 待批准的 resume 会重复弹窗 |
| `workflow/journal.ts:217` | 逻辑 | `pruneTrailingFailures` 只对 `MemoryJournalSink` 真正裁剪，却对 JSONL/DB 路径返回 `cut > 0` → 报告了未执行的裁剪 |
| `conductor-store.ts:511` | 逻辑 | 删除节点后所有绑定其上的 connector 仍留在 `elements[]`，`connector-renderer.ts:258-259` 解析为 `null` 渲染为空；id 复用时残留物会复现 |
| `CanvasArea.tsx:1534` vs `ConnectorElement.tsx:327` | 重复 | 草稿与已持久化 connector 的 elbow 默认值不同（cornerRadius 14 vs 12、stub 长度不同）→ 创建时 connector 可见地「跳一下」 |
| `services/network/wechat-qr.ts:121` | 逻辑 | 会话清理定时器在 confirm 时从不清除 → 已确认会话的 `bot_token` 在进程级 map 中多存活 10 分钟；且 `QR_TTL_MS` 是 5 分钟而清理是 10 分钟，同一会话寿命两个真相源 |
| `TerminalManager.ts:391` | 逻辑 | 精确匹配过滤发生在 `LIMIT` 之后 → 输入已执行过的命令时该行占据 LIMIT 窗口后被丢弃，候选数少于 limit |
| `TerminalManager.ts:179` | 逻辑 | `applyInputToLine` 按换行覆写 `submitted`，多行粘贴只把最后一条写入 `terminal_command_history` |
| `connector-service.ts:469` | 参数 | `tokenType` 被 `getValidToken` 返回并存入 vault，但 5 个 OAuth 自定义绑定全部丢弃（`connectors/slack.ts:74` 硬编码 `Bearer`）→ 非 Bearer 供应商静默使用错误方案；仅 `rest`（`:446`）与 `mcp-remote`（`:459`）转发 |
| `ipc/app-connection-handlers.ts:283` | 逻辑 | `connectWeCom`/`connectQqMail` 返回成功但不调 `broadcastConnectionConnected`（OAuth handler `:208` 会调）→ 手工凭据连接上线时渲染层无通知，只能靠轮询 |
| `app-connections/oauth/flow.ts:127` | 参数 | `options.scopes ?? config.defaultScopes` 下，显式空数组 `[]` 不是 nullish → `buildAuthUrl:273` 完全省略 `scope` 参数，供应商套用自有默认值，而库里存的是 `scopes: []`，与实际授权不符 |

## 11. Wave 4–5 的普查结论（无独立缺陷，但属结构事实）

- **命令派发普查**（`agent-process-entry.ts` 全量 `handleCommand` switch）：`permission:resolve` 的 `message` 从不读取、`updatedInput` 只用 `.answers`；`config:update` 的 `blockedDomains` 被忽略。`interagent:invoke` 确实无 case——这是正确的，它经 `process.send` → server → 目标 stdin 转成 `interagent:event`。
- **事件普查**：25 个细粒度 `chat:research_*` 类型**不在** `WorkerEvent` 联合（`:790-823`）中，除转换器外 `packages/agent/src` 无任何生产者，`apps/desktop` 无任何消费者——死分支。`sendToMain(msg: Record<string, unknown>)`（`:2092`）正是 `WORKER_EVENT_UNION_IS_COMPLETE` 守卫看不见这些的原因。
- **DWF 失败收敛**：无回滚，也不试图回滚。已完成步骤的宿主副作用已提交并记入 journal；失败步骤在**实时帧**里可见（`cachedCall` 以 `nodeId` 记 `failed`，`runtime.ts:526-541`），但**持久化**的 `finishRun` 消息（`workflow-runner.ts:713`）只带 `err.message`，不含 node id。
- **入站身份映射**：weixin/telegram/qq/whatsapp/discord 五家一致且与 `NormalizedMessage` 逐字段对应；**飞书是唯一例外**（见 P0-6）。
- **`run-orchestrator.ts:399` 确实用 `readRunReceipt`/`isDurableWrite` 校验回执**——587 计划 R1.3「adapter 忽略负 ack」的担忧在生产侧已解决。
- **`production-independence.test.ts` 是真实守卫**，会在真实 `evals/` 导入上失败，不是空断言。
- **Terminal IPC 接缝干净**：7 个通道字段名与顺序全对，`resize`/`suggest` 有数值钳制。
- **令牌边界端到端守住**：所有 `appConnection:*` 返回均为 DTO，vault 写入为 `safeStorage` + `0o600`，任何日志调用中都不出现 access/refresh token。
- **`project-database` 过滤白名单不可绕过**：`assertFilterOperators`（`:448-460`）把 `propertyId` 解析到 source 自有的 property map，过滤在 JS 侧求值，调用方提供的列名永远到不了 SQL；sort id 在 `:518` 校验。
- **`recordSnapshots` 占位符数与绑定数组匹配**（`:406-409`），`limit` 由 zod 钳制在 1–500。
- **journal 缓存无法被重放污染**：缓存写入要求 `reqHash && status==='succeeded'`（`journal.ts:153,167`），命中路径不追加 `reqHash`。

---

# 第三部分：Wave 5（封堵 Wave 4 遗留的缺口）

Wave 4 的四个切片各自诚实报告了未读完的区域，Wave 5 再派 4 个切片定点清除，新增 **32 条**（P0 3、P1 10、P2 19）。累计 **170 条**缺陷：**P0 16 条、P1 61 条、P2 93 条**。

## 12. Wave 5 的 P0（3 条）

### P0-14 [逻辑] 迁移 45 把旧 mailbox 行逐字复制进收紧 CHECK 的新表，可导致**永久无法启动** ✔已核
`apps/desktop/src/main/db/schema.ts:2236`

```sql
-- :2229  新表定义
CHECK (kind IN ('queued','followup','background_notification')),
...
-- :2236  拷贝：无 WHERE、无 kind 映射
INSERT INTO agent_mailbox (${quoted})
  SELECT ${quoted} FROM agent_mailbox_old;
```

旧库若残留一条 `kind = 'correction'` / `'constraint'` / `'stop'` 的行，`INSERT` 违反新 CHECK → 迁移抛错 → `runMigrations`（`:2745-2748`）向上重抛 → **应用启动失败，且该 id 永不标记为已应用，之后每次启动重复失败**，只能手工改库才能恢复。

讽刺的是迁移 46 的注释（`:2259-2262`）明写这些 kind「collapse into followup」——意图被记录下来了，但 45 的拷贝没有实现这个折叠。修复：在 SELECT 中把已退役的 kind 映射为 `followup`。

审计方定级 P1；本报告上调为 P0，理由是失败后果是不可自愈的启动砖。触发依赖数据（未找到当前 `correction`/`constraint` 的写入方），但 46 的注释证明这类行**曾经合法存在过**。

### P0-15 [逻辑] 录屏启动失败后状态永久停在 `starting`，必须重启应用
`apps/desktop/src/main/services/recorder/service.ts:271`

`start()`（`:235`）把 `this.startInFlight = this.doStart()`，只在 `finally` 里置空，**没有 catch 重置状态**。而 `doStart()` 在 `await this.worker.start()`（`:359`）或 `await store.start()`（`:285`）处都可能抛错。抛错后状态停留在 `'starting'`，而 `start()`（`:225`）对 `'starting'` 每次重试都提前 `return getSnapshot()` → 用户再点多少次启动都没用，第二次 `recorder:start` 还会静默报告一个「正在启动」的会话。

修复：`doStart()`体外包 try/catch，失败时调 `doStop()` 再重抛。

### P0-16 [逻辑] `bundledDir` 被读取但接口未声明，插件来源 skill 会让整个快照 IPC 崩溃
`apps/desktop/src/main/services/capability-management/cross-source.ts:193`

```ts
join(options.bundledDir, skill.pluginId, 'skills', skill.name)   // :193
// :148-150
interface CrossSourceSkillOptions { userDir: string }              // 只声明了 userDir
// 调用方 capability-management-service.ts:75 也只传 { userDir }
```

`join(undefined, ...)` 抛 `TypeError`，导致整个 `capability-management:snapshot` IPC 调用失败。当前被掩盖，因为 `buildCrossSourceSkillCandidates`（`:160`）只产出 `origin:'user'`，该分支不可达——**一旦加入插件 skill 立刻变成线上崩溃**。修复：接口补 `bundledDir` 并在 service 传入。

## 13. Wave 5 的 P1（10 条）

- `providers/provider-store-config.ts:69` [参数] `writeAll` 只持久化 8 个字段，丢弃 `extraEnv`/`headers`/`notes`/`sortOrder`；而 `ProviderStore.persist()`（`provider-store.ts:782`）在**任何** upsert/delete/setDefault 时对每个 provider 调用它 → 自定义 `headers`（如必需的 org 头）与 `extraEnv` 被从 config.toml 抹掉，而内存缓存仍显示它们。
- `connectors/gmail.ts:171` [参数] `metadataHeaders` 在 `URLSearchParams` 上被 `set` 三次（`set` 是替换不是追加）→ 只发出 `Date`；`searchGmailMessages` 随后用 `headerValue` 取 `subject`/`from` 恒为 `undefined`，与其 `:113` 的描述符矛盾。修复：改 `append`。
- `recorder/service.ts:343` [逻辑] 权限被拒分支在 tracker 已启动之后返回，却把状态设为 `'recording'` → 无 worker、无 `pollTimer`、**10 分钟自动停止上限（`:363`）永不武装**，会话永不自动结束，`doStop` 还会 flush 一个从未被喂数据的 aggregator。
- `stores/conductor-store.ts:809` [参数] agent patch apply 循环没有 `layout` 分支。`element.arrange` 的 `layout` 数组在 `types/conductor.ts:356` 声明校验、在 `db-service.ts:1262-1269,1447-1455` 发出，却无人读取 → **agent/工具触发的自动布局写进了 SQLite，画布在快照重载前一动不动**。其余每个发出的键（`position`/`config`/`changes.*`/`elements`/`deletedElement`/`widget`/`sourceCode`/`vizSpec`/`metadata`）都有分支，`layout` 是唯一被丢的。
- `components/WidgetShell.tsx:46` [逻辑] `widget:resize` 消息监听器既不校验 `event.source` 也不校验 widget id → **一个 iframe 上报的高度会缩放所有已挂载的 widget**，并为每个都持久化 `element.move`；`resizedRef` 是 per-widget 的，无法去重。同文件 `:124` 的另一个监听器**是**有守卫的。
- `refine/loopController.ts:126` [逻辑] 每轮都用进入时捕获的 `session.iterations` 计算 `[...session.iterations, iteration]`，而 `patchSession`（`refine-store.ts:53`）是**替换**数组 → N 轮迭代后面板里只剩最后一轮。
- `db/schema.ts` / `permissions.ts:517` [重复] 「本会话不再询问」的模式集合被实现两次且成员不一致：闸门把 `plan` 当 bypass-allow，`askWithoutUser` 把 `plan` 当 deny。生产把 `isBypassPermissionsModeAvailable: true` 字面传入（`PermissionsGate.ts:149`、`agent-shell.ts:320`）→ plan 模式下主管线第 5 步对每个工具返回 `allow`，而三个 ask 兜底（`dispatcherFromRegistry.ts:177`、`mcp/apply.ts:536`、`StreamingToolExecutor.ts:1272`）deny。
- `agent-process-entry.ts:5069` [逻辑] compact 处理器在 `finally` 里释放 `chatInProgress` 却**不排空命令队列** → 压缩期间排队的 `chat:start` 被搁浅（不执行、不报错），直到某个无关的后续提示触发排空。对比 `:4382-4387` 与 `:3743-3750` 两处都调了 `drainQueuedChatStart`。
- `project-database/engine.ts:792` [逻辑] `updateView` 没有乐观锁对应物：`db_views`（`schema.ts:85-97`）无 `revision` 列，`view.update` 不声明 `expectedRevision`，`UPDATE` 无版本条件 → 两次并发视图编辑都成功，后者静默丢弃前者。`updateRecord` 与 `archiveRecord` 都有守卫，唯独它没有。
- `db/schema.ts:2275` [重复] 迁移 46 不可达：其守卫要求表 SQL 含 `'queued'` 且不含已退役 kind，而通过 45 的表必然满足；未通过 45 的表在 46 运行前就已让启动失败。且 46 的 76 行重建与 45 逐字重复（`:2276-2349` vs `:2236-2244`）。

## 14. Wave 5 的 P2（19 条）

| 位置 | 类别 | 问题 |
|---|---|---|
| `dwf/def-to-dwf.ts:249` | 参数 | `map.prompt` 从不转发 → map+agent 节点转成 `wf.agent(type, '')`，子 agent 每个 item 收到空提示；`:251` 的 `map.input` 同理产出无输入的 `wf.tool(name)`。`MapPrimitiveSchema.prompt`（`schema.ts:187`）被声明但两个转换分支都不读 |
| `dwf/def-to-dwf.ts:259` | 参数 | `map.parallel: false` 被静默丢弃（只发出 `map.concurrency`）→ 要求串行的副作用调用被转成并发 fan-out；且文件头声称「零损失」却未产生 `warnings` 条目 |
| `dwf/runtime.ts:707` | 逻辑 | `onTimeout: 'fail'` 与 `'escalate'` 塌缩成同一结果（只特判 `'skip'`），失败的审批被报告为已升级，违反 `:203` 的契约；生产可达（`converter.ts:176` 发出 `'fail'`） |
| `dwf/def-to-dwf.ts:143` | 参数 | gui 步骤只插值 `text`，`key` 作为 JSON 字面量发出 → 模板化的按键会按下它自己的源码文本（`gui-runner.ts:210` 会对整个步骤深插值）。当前 recorder 产出的步骤是字面量，故暂不可达 |
| `project-database/engine.ts:720` | 逻辑 | 版本检查是写事务之外的读，WHERE 无 `AND revision = ?` → 第二个进程/CLI 连同一文件时守卫可被绕过。进程内安全（单 worker 单连接），残留风险在单实例锁之外 |
| `capability-management/cross-source.ts:185` | 逻辑 | 循环内每个 skill 都调一次 `getPluginManager().listInstalled()`（`:279` 同）→ O(能力×插件) 的注册表读，快照可能慢到渲染层显示过期启用态 |
| `capability-management/cross-source.ts:395` vs `dto-mappers.ts:117` | 重复 | 两个 `computeEffective` 的 null 语义不同（`boolean` + `'user-disabled'` vs `boolean \| null` 且从不发 `'user-disabled'`）→ 同名 skill 在两条路径下对同一状态报出不同 `blockedReason` |
| `browser/webview-memory.ts:29` vs `cookie-writer.ts:10` | 重复 | 分区串 `'persist:duya-local-browser'` 是两个独立常量；任一处改名会静默把 cookie 写入与缓存清理拆到不同分区 |
| `recorder/ax-helper.ts:259` | 逻辑 | `AxHelperError` 在类型断言中被引用但从未 import（`:31-45` 只导入了 `AxHelperErrorCode`）→ 断言在构建期退化为 `any`；`typecheck:all` 应当报 TS2304 |
| `browser/cookie-importer.ts:118` | 逻辑 | `expirationDate` 用 `row.expires_utc > 0` 判定，而 `:168` 的 `isCookieExpired` 只把恰好 `0` 当会话 cookie → 以非零哨兵过期时间存储的会话 cookie 被导入为真实过期时间，Electron 写入时丢弃，用户表现为掉登录 |
| `stores/conductor-store.ts:235` + `:903` | 参数 | `setUndoRedo` 零调用方，`snapshot.actionCursor`（`types/conductor.ts:197`）从不被读，`canRedo` 被写 12 处却无人读；唯一消费者 `RefinePanel.tsx:313` 依据的 `canUndo` 只被乐观设置 |
| `stores/conductor-store.ts:868`/`:896` | 逻辑 | undo/redo 无条件覆写栈标志，失败的撤销仍启用 Redo |
| `hooks/useCanvasManagement.ts:62` | 逻辑 | 注释声称去重（「`addCanvas` otherwise appends, which can produce duplicate entries」），但 `addCanvas`（`conductor-store.ts:311`）无条件 append → 广播的 `create` 产生重复 id 与重复 React key（`CanvasLibraryView.tsx:470,510`、`CanvasSelector.tsx:196`） |
| `components/native/GroupElement.tsx:189` | 逻辑 | `removeElement` 从不修剪 `config.memberIds`；最后一个成员被删后 `computeGroupBbox` 返回 `null`，组渲染为空却仍留在 `elements[]` → 不可见但仍可选中、可命中、仍会列给 agent |
| `stores/conductor-store.ts:1017` | 逻辑 | `autoLayout` 发起 N 个并发 `executeAction` 无排序；第一个 `.then` 清掉 `uiStatus` 而其余仍在飞，迟到的 reject 用 `uiStatus:"error"` 覆盖成功态；且只移动 `widgets`，从不移动 `elements` |
| `types/canvas-node.ts:110` | 重复 | 第二套元素 schema，形状词汇与实现发散（`ShapeContent.shapeType` `'circle'\|'pill'` vs `StickyElement.tsx:169` 读 `config.shape` `'rounded'\|'ellipse'\|'hexagon'`）→ agent 写 `shapeType` 只会得到一个普通矩形；`NodeType.section/frame` 在 `NativeElementRenderer.elementMap:32` 无对应项 |
| `components/ConnectorOverlay.tsx:19` | 重复 | 遗留 bezier 覆盖层（读 `vizSpec.payload.sourceId`、全局 `#arrowhead` marker）仍与 `NativeConnectorOverlay`、`ConnectorItem`（`CanvasArea.tsx:1587-1588`）同时挂载 → `config.source` 之前的 connector 会以不同几何与 marker 描两条边 |
| `stores/conductor-store.ts:426` vs `:479` | 逻辑 | `setElements` 走 `normalizeElement`，`setSnapshot`（及 `:547` 的水合分支）直接赋原始行 → 同一元素的位置/权限/metadata 默认值取决于它是通过 patch 还是通过重载到达 |
| `session/db.ts:2205` | 参数 | `createResearchEvent` 返回 `ResearchEventRow \| Promise<ResearchEventRow>`：IPC 分支返回 promise、本地分支同步返回行 → 读 `.visibility` 的消费者编译通过但 IPC 模式下拿到 `undefined`；`getResearchEventMaxSequence`（`:2237`）是 async 而其 activity 孪生（`:2170`）是同步 |
| `workflow/manager.ts:446` | 逻辑 | 等待追踪器用**第一个** `node.human` 签超时令牌，而 gui confirm-gate（`gui-runner.ts:563`）挂起时根本没有 human 节点 → `nodeId` 变成 `'unknown'`，`engine.resume` 的守卫不触发，`tickWaitTracker` 仍推 `applied:'timeout'` 并用新 `waitTill` 重新挂起 → 永不解决的审批。**生产不可达**（`WorkflowManager` 无 `process/` 或 `apps/` 接线） |

## 15. Wave 5 的关键否定结论与结构事实

这些是主动查证后确认**无缺陷**或**无第二实现**的部分，价值在于排除后续重复排查：

- **`session/db.ts` 全部 55 个 `prepare()` 站点占位符/实参数完全平衡**，含所有会因内联字面量错位的位置参数 INSERT（`createResearchSession` 10/10、`upsertResearchSource` 13/13、`upsertResearchReport` 11/11 等）与两个动态 `UPDATE ... SET ${fields}` 构造器。审计方在报告前自行推翻了自身两个假阳性（`imageChunks` 写入存数组/读取重新字符串化是文档化的往返；`getModelCapability` 的名称归一化在接收侧 `db-bridge.ts:2533` 完成）。
- **迁移注册表健康**：55 条迁移全部读完，每个 `ADD COLUMN` 都有 `PRAGMA table_info` 或 try/catch 守卫，每个 `CREATE TABLE` 都用 `IF NOT EXISTS`，无迁移引用更高编号迁移创建的列。id 空洞（28、40）是**从未存在**而非死代码。
- **DWF 没有第二个步骤执行器**：`runDwfScript`（`dwf/runtime.ts:826`）是唯一的 DWF 执行器，只有一个生产调用点（`process/workflow-runner.ts:931`）。`node-runner.ts:370 runNode` 确实是第二个步骤执行器，但服务于 `WorkflowDef` YAML 而非 DWF。`WorkflowEngine`/`WorkflowManager` 仅被自身与两个测试文件 import，**无生产接线，是死代码**。两个转换器（`converter.ts` → `def-to-dwf.ts`）是同一管线的先后阶段，不是竞争实现。
- **`updateRecord` 的并发保护在进程内是有效的**：`expectedRevision` 端到端必填（zod + `DatabaseTool.ts:143`）无默认值可绕过；单 worker 单 engine 单连接，WAL + `busy_timeout=5000`，同步 handler 使读-写无法交错。
- **9 个 connector 的声明动作与 `invoke` 派发器完全对应**，无「声明但未实现」的动作。
- **`config` 合并语义一致**：主进程合并（`db-service.ts:1157`）并广播完整合并结果，所以 patch 循环里 `elementPatch.config = configPatch` 的替换是正确的，不是丢键。
- **9 个 connector 的 token 边界守住**：`rest-invoker.ts` 从不回显 token 且对 `retryableStatus` 有界；`remote-mcp.ts` 正确合并在途连接并守护迟到的 discovery 提交。
- **overlay 与 window-restore 干净**：显示器变更拆卸、DIP/物理归一化、白名单重断言一致；`window-restore.ts` 与 `extension-trust.ts` 都是 fail-closed。
- **connector 视觉/控制分层正确**：`ConnectorPath` 的 `renderVisuals`/`renderControls` 分离（`ConnectorElement.tsx:523-524`）意味着被选中的 connector 不会被双描边。
- **分类器 fail-closed**：`classifyAction` 在不可用时返回 `ask`（`permissions.ts:650`）。
- **`normalizeForFts` 在 `schema.ts:522` 与 `db.ts:813` 逐字节一致**；队列 `dequeue` 在同优先级内保持 FIFO。

## 16. 全部 16 条 P0 的修复顺序（合并三部分）

**第 0 批 — 安全与不可自愈，优先于一切功能工作**

| # | 位置 | 修复 | 成本 |
|---|---|---|---|
| P0-14 | `db/schema.ts:2236` | 迁移 45 的 SELECT 里把已退役 kind 映射为 `followup`；顺手删掉不可达的迁移 46（它与 45 逐字重复） | 一行 SQL + 删 76 行 |
| P0-8 | `permissions/policy.ts:1094` | 删掉 `'..'` 根与 `~/.duya` 根，只保留工作区 + `additionalWorkingDirectories` | 两行 |
| P0-12 | `eval-legacy-loop.ts:273` | harness 改走 `getControlPlane().serve` | 改注入点 |
| 附 | `permissions.ts:377`（P1，本批一并做） | 把 `getDenyRuleForTool` 查询上移到两个放行闸门之前 | 移动代码块 |

P0-14 与 P0-8 必须在任何功能合并前落地：前者会让用户无法启动，后者让权限提示形同虚设。P0-12 是二者的验证前提——不修它，修完也无法证明修好了。

**第 1 批 — 一行到几行的定点修复，消除重复副作用与功能失效**
- `DuyaAgent.ts:2349` `turnCommitted` 改 getter。
- `db-bridge.ts:734` `goals.get(p.session_id)`。
- `agent-http-client.ts:757` 流式事件排除出去重集合。
- `agent-http-client.ts:325,436,589` `AgentEvent` 补 `metadata`（一次修掉 P0-3 与 P1-9）。
- `agent-runtime/src/controller.ts:1177` 删掉二次 push。
- `gateway/feishu/index.ts:499` 统一走 `onMessage` 并传 `threadId`。
- `ProviderEditView.tsx:415` 删除动作改 prop/store 直传。
- `dwf/runtime.ts:436` `wf.map` 加 `aborted` 标志。
- `cli/build-control-plane.ts:118` + `build-agent-runner.ts:253` 两个派发器从同一字段表派生 bag（一次修掉 P0-11 与 5 条 CLI 标志丢失）。
- `WriteTool.ts:138`/`ReadTool.ts:255` 改读 `file_path`；`ToolRetryExecutor.ts:254` 回退字段改名。

**第 2 批 — 收敛重复实现，每收敛一处消掉多条缺陷**
- `db:*` 双写 → 一个实现 + 两个薄入口（同时修 P0-4 与 P0-13）。
- 渲染层：SSE mapper 单一化、face 引擎、`basenameFromPath`、时长格式化、SSE 客户端、connector 覆盖层、元素 schema（`types/canvas-node.ts` 死 schema 可直接删）。
- `conductor-store.ts` patch 循环补 `layout` 分支；undo/redo 标志改为从 `actionCursor` 派生。
- 路径包含判定统一用 `isWithin`；权限模式判定统一用一个谓词。

**第 3 批 — 需要设计决策，先写执行计划**
- F02/F03/F04/F05/F06/F07 六个仍存在的 587 发现，共享「durable 先于对外宣布」「同一执行合同只有一条路径」两条不变量。
- 事件流 fanout 策略（单 reader 拒绝 vs per-subscriber）。
- 死接口面清理：40 个无人调用的 IPC 通道、14 个不可服务且无调用方的 db-client action、25 个无生产者的 `chat:research_*` 事件类型、不可达的 `WorkflowEngine`/`WorkflowManager` 整套遗留引擎。

**必须新增的回归测试**（每条对应一个 P0，均为当前测试未覆盖的接缝）
1. 流重放：注入 post-`done` 传输故障，断言工具执行次数仍为 1。
2. 权限根集合：断言工作区父目录与 `~/.duya` 下的写入被拒绝或弹窗。
3. deny 规则优先：断言 `alwaysDenyRules` 命中内置工具时仍为 deny。
4. 迁移 45：构造含 `correction` kind 的旧库，断言迁移成功且该行变为 `followup`。
5. `goal:create` 幂等：同 session 连续两次 create，第二次返回既有行且无 UNIQUE 错误。
6. `tool_use_delta`：一次工具调用发 N 个分片，断言渲染层收到 N 片并拼出完整参数。
7. `metadata`：断言 `tool_result` 的 `metadata` 抵达 `BrowserToolRow`。
8. 飞书话题消息：带 `root_id` 的回复必须抵达 agent。
9. 供应商删除：从编辑页触发，断言 provider 真的消失。
10. `wf.map`：一项 reject 后断言无后续工具调用发生。
11. `backup create --dry-run`：断言不产生归档文件。
12. eval 独立性：断言 harness 经 `serve` 而非直调 dispatcher（防止 P0-12 回归）。
