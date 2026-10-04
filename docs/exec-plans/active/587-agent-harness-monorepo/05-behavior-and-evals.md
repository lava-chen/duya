# E4 — 真实行为基准与 Evals

前置：R2；三adapter比较需T3。E4.1–E4.3 已合并（E4.1 #160、E4.2 #164、E4.3 #163）。Next：**在有空间的机器上真正执行一次 `npm run test:e2e:turn`**——E4.4 的断言已由 #201 裁定、由 #203 补齐产品缺口，但那份 spec **一次都没有被真正跑过**（见下方 E4.4 状态块）。必须在M5大规模迁移前建立，防止只有新包脚本测试。
>
> **阶段状态（2026-10-04 对 `2a375c1c` 核对）**：E4 仍是 **In progress**。#201 裁定并修了 E4.4 第1条的两条断言中的一条，#203 补上了另一条断言指向的产品缺口，#200 修好了挡住打包 parity 步骤的 CI publish 失败。**四条仍无一条验收，且原因未变**：E2E spec 未经执行、第2条无 key、第3条打包应用从未被运行。E4.3 最后一条（CI 固定少量高价值 case）仍未接线：`.github/workflows/` 下没有任何 job 调用 `eval:agent:smoke` / `eval:agent:extended`。

## E4.1 真实旧执行器闭环

- [x] 使用实际workerentry/processadapter/DuyaAgent，注入offlineprovider，按真实provider协议返回可控制的text/thinking/toolcall/usage；不要直接手写RunEvent绕过旧循环。
- [x] tooladapter使用临时workspace与真实安全边界，所有外部网络默认fixture；SQLite使用隔离namespace和matchingABI，不访问用户数据。
- [x] 捕获manifest/inputref、protocoltrace、transcript、permissionaudit、toolattempt、usage、terminal和artifact，敏感值脱敏。metadata写HEAD/版本/环境/seed与测试配置。
- [x] 对照R2前旧执行基准和新adapter：忽略可明确规范化的timestamp/randomID，不能忽略实际行为差异。

## E4.2 必测场景

| 组 | 场景与断言 |
| --- | --- |
| 生命周期 | 正常完成、dispatch失败、modelstream断开、无terminal退出、cancelrace、hardkill |
| 工具 | 成功/失败/timeout、streaming结果、read+write、同path写串行、不同path并行、同文件真实别名冲突 |
| 审批 | allow/deny/defer/timeout/updatedinput/late/duplicates；拒绝执行计数0 |
| Hooks | PreToolUse否决、PostToolUse失败诊断、PreFinalize、postturn；event顺序与await取消 |
| 模式 | general/plan与statefulGoal/Research、continuation、snapshot、finish；未实现pause不开放 |
| Context | AGENTS嵌套、动态skills/catalog、截断/compaction、runtimecontext不持久化、缓存稳定段 |
| Mailbox | 执行期间补消息/图片、同名附件、背景subagent完成、去重与pendingprojection |
| 存储 | slowack/negativeack/transactionrollback、terminalCAS、runreopen、cursor重连 |
| 资源 | 长流、slowconsumer、队列limit、100次run后timer/process/subscription无增长 |

已有单测可以复用；没有真实wire路径的mock不能作为对应host闭环证明。

已合并（#164）：`evals/agent/matrix/rows.ts`，56行（49显式 + 7条approvals由map生成），每行带`evidence`与`divergence`字段。分布：proved-real 8、covered-by-existing-suite 46、unsupported 2。两行unsupported具名留口，不记为通过：`model-stream-disconnect`（E4.1 offline provider只会`res.end()`，无法中途断socket）、`refused-executions-zero`（E4.1 harness不回权限请求，决策层证明不了真实tool未执行）。`matrix.test.ts`强制每条covered-by-existing-suite行指向的文件与测试标题真实存在。

## E4.3 Evals 消费 API

建议 `evals/agent/{cases,fixtures,runner,evaluators,reports}`；需要依赖管理时设privateworkspace，生产build不依赖它，CI使用明确smoke/extended脚本。

- [x] case采用版本化JSON描述输入、tools/mockscenario、permissionpolicy、预算、expectedinvariants/产物。测试IO引用临时路径，不把evalrunner放进core。
- [x] evaluator分结构/安全/任务产物/成本性能；任务完成要检查真实文件或可执行结果，不把model自述视为通过。
- [x] deterministicoffline与stochasticlive分report。offline精确trace/产物断言；live固定模型参数与多次测量，报告sample和变动，不声称逐token确定。
- [x] 结果包含失败层级：contract、hostadapter、modeldecision、tool、storage、policy、environment。记录unknown与skipped，不能聚合成success。
- [ ] CI固定少量高价值case；扩展eval手动/定时由用户既有授权决定，不新增自动任务。本计划只是定义脚本和数据契约。
  未完成：`FIXED_SUITE`（`evals/agent/runner/run-suite.ts`，`requireComplete: true`）与脚本`eval:agent:smoke`/`eval:agent:extended`已定义，但`.github/workflows/`下没有任何job调用它们；机制在，CI未接线。

## E4.4 Desktop / packaged smoke

- [ ] Electron真实renderer与preload，isolatednamespace，经UI或真实HTTP入口发turn，校验runsrow/events/terminal与UI结果一致。
- [ ] 配置provider的livechat、审批与stop；没有key或环境不可用时记录blocked/unverified，不能用offline通过替代P6。
- [ ] 每次lazy/moduleboundary变化打包检查agentbundle/assets/BashWorker/nativeSQLite；firstchat到ready，无modulemissing。
- [ ] Playwright对涉及UI的变更验证light/dark、pending/terminal/approval；浏览器mock只验证视觉，bridge必须Electron。

状态：**四条都有证据，没有一条验收。** 记 blocked/unverified，不是通过。下列状态由本文件在 `55384c55` 上重新核对（#179 写的"四条全部未验收 / 第4条未开始"已过时）。

> **结论在 `2a375c1c` 上复核后不变：四条仍无一条验收。** #201/#203 把第1条推进了一大步（断言裁定 + 产品缺口补齐），#200 拆掉了第3条的一个 CI 阻塞，但**没有任何一条跨过"验收"线**：第1条的 E2E spec 从未执行，第2条仍 `unsupported`，第3条的打包应用从未被运行，第4条已在 #195 交付但其自身声明了未覆盖项。

- **第1条：部分成立——两条断言已分别裁定，其中一条已修，另一条是产品缺口。** 真实 Electron renderer/preload turn 已落地并**跑到 durable terminal**——#188 取消 `test.fixme` 后合同**真的跑了、真的是红的**，失败在两条断言上。**（a）`:384` 末帧断言：测试错、产品对，已修。** 真实末帧是 `title_generated`，因为 session 标题生成是 worker 在 `chat:done` 之前**不 await** 的另一次异步 LLM 调用，产品**刻意**在终态之后继续读流收集标题（`router.ts:1708-1715`），并在可配置窗口（默认 5s，`router.ts:1716-1726`）内等不到就强关流。协议规格也把它归为 host-only、从来不是 run event（`07-agent-protocol-spec.md:278`、`:313`），translator 对它 unmapped/forward-only。**因此不是运行时越契约，是断言写错了**；现已改为断言真正成立的不变量（终态存在、其帧带 payload、其后只允许出现 host 的标题帧），这比原来的"末帧字面量"更强（能抓住重复 `done`、终态后到达的 `error`、以及任何其它越界帧），而且原写法在超时路径上还是 flaky 的。
  **（b）`:430` 查 `assistant.message_finalized`：断言对、产品缺，故仍红。** 真实完成的 turn 持久化的是 `assistant.text_block` 事件，该 finalized 事件 **0 行**；且**任何路径都不产出它**——desktop / headless / CLI / subagent 全部汇入同一个 `translateFrame` 接缝，那里没有对应分支。**它不是陈旧声明**：registry 自带该事件的存在理由（`legacy/sse-event.ts:185-186`——旧表面"从不标记消息停止变化的那一点，所以 compaction 只能猜边界"），规格从 `AssistantMessage` 推导其 payload（`07-agent-protocol-spec.md:244`），合同 §F 要求断线恢复靠 message snapshot 而非被丢弃的 delta，消费者已按 authoritative 且 superseding 处理（`transcript-snapshot.ts:28-31`）。**也不是 translator 一行能修的**：`content` 与 `stopReason` 都是 REQUIRED，而 worker 唯一发的终态帧 `chat:done` = `{ sessionId }`（`worker-protocol.ts:326-329`）两者都不带，而 `translateFrame` 是纯逐帧函数，今天产出它就等于**凭空编造这两个事实**。补齐需要**扩 wire**（agent 必须带上 finalized message），属更大切片。缺口已记为 `control-plane-census.ts` 里 `assistant.message_finalized` 的 `NOT YET WIRED` 行，并有门禁让整类"声明了却没产出"不可再被静默丢弃。
  从同一 namespace 的 SQLite 读回仍可证 `status=completed terminal=completed`、`run.started` 居首并携带该行 `manifestHash`、`run.completed` 居末且一致——#182 修掉的那类缺陷穿过真实 preload 边界确实消失了。**原写的下一动作"事件查找改到 `assistant.text_block`，预期转绿"已撤回**：那会把契约违规冻成绿灯，正是本条要防的失败模式。仍未验证：本轮未跑 `electron:build`，故 spec 断言变更**未经执行**。

> **第1条后续（2026-10-04 对 `2a375c1c`）——(a) 已修、(b) 的产品缺口已由 #203 补上，但本条仍未验收。**
>
> - **(a) 末帧断言**：`#201`（`d20e31ae`）已改为断言更强的不变量（终态存在 + 带 payload + 其后只允许标题帧），理由与"post-terminal 等标题是刻意的（`router.ts` 记录了 5s 窗口）"都已写在该 spec 内。
> - **(b) `assistant.message_finalized`**：`#201` 先把它记为 census 的 `NOT YET WIRED` 行并加门禁（scope 从 registry 派生，不能靠删行"修好"）；**`#203`（`b81b3c64`）随后真的接上了**——新增 worker 帧 `chat:message_finalized`，在所有 host 共享的 `translateFrame` 接缝翻译。census 行的 `producer` 从 `NOT YET WIRED` 改为**点名两个帧生产者**（worker 子进程 / in-process headless host），并写明两处收窄（`image` 与 `provider_block` 原样留在 `providerMeta.untranslatedBlocks`；运行时独有的 stop reason 被**拒绝**而非强行映射，故那些 turn 不带 finalized 事件）。unproduced 集合由 `['assistant.message_finalized']` 变为 `[]`，census 测试 70 → **73**。
>   真实路径的台账前后对比（`HeadlessRunHost` → 真实 transport → 真实 controller → 真实 translator → 真实 emitter）：**4 行 → 6 行**，新增 `5:assistant.message_finalized`，位置在它所取代的最后一条 `text_block` 之后、`run.completed` 之前，且携带**同一个 run-scoped `messageId`**。Desktop 侧另由真实 `run_events` SQLite 读回验证。
>
> **⚠️ 关键限制：那份 E2E spec 至今一次都没有被真正执行过。**
> `npm run test:e2e:turn` 需要真实 `electron:build`，本机磁盘不允许，**#201 与 #203 都在各自 PR 里明写了这一点**。因此：
> - **不得**把 E4.4 第1条读成通过。断言改了、产品缺口补了，但断言本身**未经运行**。
> - **类型通过 ≠ 断言通过**；且仓库 16 个 tsconfig **无一**引用 `e2e/`，故 `typecheck:all` 对这份文件**不构成任何证据**（#201 用单独 `tsc --strict` 检查过并证明该检查非空，但那仍然只是类型）。
> - 上面那些**较窄的真实证据是真的，但它是另一条更小的声明**：真实 `run_events` SQLite 读回、真实 translator/host/ledger 都跑过，`reference-run-closed-loop.test.ts` 与 `eval-baseline-comparison.test.ts` 都是绿的。它**没有**启动 Electron、**没有**走 preload 桥、**没有**执行那份断言本身。
> - 一句话记法：**产品缺口已补，断言仍未执行，本条未验收。**
> - 下一动作：在有空间的机器上跑一次 `npm run test:e2e:turn`，把实际 pass/fail 计数写回本块。预期是 2 条失败断言 → 1，但**这是预期，不是实测**。
- **第2条：unsupported——需要真实 provider key。** 按本文件规定离线 provider 不能替代 P6，无 key 即记 blocked。#181/#195 的模型都是 `127.0.0.1` 上的 loopback provider，**不是 live provider**。未用代理冒充。
- **第3条：门禁落地，真实包在 CI 产出过，但打包应用从未被运行。** #180 把 `AGENTS.md` 预发布清单里只由人读注释断言的三条路径变成机器门禁（`check:packaged-artifacts`，三模式拆开），`typecheck:all` 每次都跑；#191 补上了 `BashTool/BashWorker.js` 这个**清单里有、构建里没有**的产物，并删掉 known-defect 条目（满足它自己记录的移除条件）。
  **本机从未跑过 `electron:pack`/`electron:build`**（磁盘；#191 记录 E 盘曾两次被打满到 0.27 GB / 0.42 GB）。**但 CI 的 macOS `build` job 真的跑了 electron-builder**：`test.yml` 有 macOS-only 的 `Package (macOS only)` → `npm run electron:pack:mac`，在 `#192` 的 run `37194425248` 里它产出了 `release/mac-arm64/DUYA.app`、DMG 与 zip，而 `afterPack` 对**包内**文件做了真实验证并通过——`agent-process-entry.js`（5.06 MB）与 `BashTool/BashWorker.js`（11.24 KB）。**该 job 随后 exit 1**，卡在 electron-builder 的 publish 阶段：`electron-builder.yml` 有 `publish: [{provider: github}]` 而 runner 没有 `GH_TOKEN`；因此紧随其后的 `verify-packaged-parity.mjs --platform mac` **从未执行**。**仍然未验证**：打包应用被启动、打包后的 chat turn 到达 Agent `ready`、`app.log` 无 `ERR_MODULE_NOT_FOUND`——`check:packaged-artifacts --packaged` 在三个 test job 里每次都打印 `UNVERIFIED`。下一动作（属代码/CI 改动，不属本计划文档切片）：给 `electron:pack:mac` 加 `--publish never`，让 parity 脚本真的跑；然后在有空间的机器上跑一次 `check:packaged-artifacts:packaged` 并接进 release workflow。

> **第3条后续（2026-10-04 对 `2a375c1c`）——上面那条下一动作的前半已由 #200 做完，后半仍未做。**
>
> - **#200（`c59b3cfd`）已修**：`Package (macOS only)` 步骤改用 `npx electron-builder --mac --config electron-builder.yml --publish never`。根因是 `electron-builder.yml` 声明了 `publish: [{provider: github}]`，而 push 事件下 `PublishManager` 会**推断**出发布策略并去构造 `GitHubPublisher`，runner 没有 `GH_TOKEN` → exit 1 → 其后的 `verify-packaged-parity.mjs --platform mac` 被跳过。CI 侧加 `--publish never` 之后，parity 步骤**有机会执行了**。
> - **但"有机会"不等于"跑过"**：该步骤此前从未在这个 workflow 里执行过一次；#200 自己写明——若包里真缺东西，parity 步骤现在会**变红**，那是门禁在干活，不是回归。
> - **且这次修复本身未经运行验证**：macOS `build` job 是否转绿是**从配置与 electron-builder 自身决策代码推出来的，不是观察到的**；#200 还指出，`pull_request` 事件下旧配置本来就不会触发那条路径，所以它自己的 CI run **不能**作为修复的证据，要等下一次 push 到 master 才算数。
> - **仍然未验证**：打包应用被启动、打包后的 chat turn 到达 Agent `ready`、`app.log` 无 `ERR_MODULE_NOT_FOUND`——`check:packaged-artifacts --packaged` 在三个 test job 里每次仍打印 `UNVERIFIED`。
> - 下一动作（仍是同一条）：在有空间的机器上跑一次 `check:packaged-artifacts:packaged` 并把结果接进 release workflow；等一次 master push 确认 macOS `build` job 真的转绿。
- **第4条：已落地并 4/4 绿。** #195 新增 `e2e/ui-states/`（注册为 `ui-states` Playwright project，脚本 `test:e2e:ui-states`），4 个测试：**light/dark**（点应用自己的侧栏主题按钮，断言渲染出的 `data-theme` 等于持久化的 `settings.theme`、两个 token 解析到另一主题的声明值、真实元素上解析出的 `background-color` 也跟着变、SQLite 独立读回、点击回反方向、无点击 reload 落在存储值上）、**pending**（真实 turn，loopback provider **握住 socket** 使"在飞"成为观察而非竞态；断言 `status='running'`、`terminal IS NULL`、`finished_at IS NULL`、`manifest_hash` 非空、账本非空且无终态事件）、**terminal**（同一真实 turn 驱动到终点，行/有序账本/renderer 收到的文本三者一致，`seq` 单调唯一，`finished_at >= started_at`；文本在帧**到达时**读，不在流关闭时读）、**approval**（`persistApprovalCard` 造的同一行真实 durable 行，经 preload 双向 + CAS 转换 + 两侧读回一致）。#195 记录 `npm run test:e2e:ui-states` 对真实 `npm run electron:build` 为 **4 passed (1.3m)**。**明确未声称**：审批**卡片被画出来**——卡片渲染在 bot-direct chat 面里，在全新隔离 namespace 里打开一个 session 绑定面需要一次本切片没解决的导航；测试停在最后一个能诚实跨过的边界。**另注**：`typecheck:all` **不覆盖 `e2e/`**（仓库 18 个 tsconfig 无一引用 `e2e/`），所以 #195 额外单独用 `tsc --strict` 检查了该 spec。

在E4.4落地前，P6证据不得称完成。

## PR、验收、回退

E4-Aworkerfixture+artifact；E4-B行为矩阵；E4-Cevalrunner/evaluators与CI；E4-DElectron/provider证据。不得为了“测试全绿”重写整个产品loop或移除失败场景。

exit：矩阵关键case可重复通过，产物与真实worker相连，至少Desktopoffline闭环；live/packaged未验收时标明限制并阻止对应能力称完成。测试设施回退不影响生产包；fixedcases保留为M5每个切片的回归锚点。
