# E4 — 真实行为基准与 Evals

前置：R2；三adapter比较需T3。E4.1–E4.3 已合并（E4.1 #160、E4.2 #164、E4.3 #163）。Next：E4.4（E4.4-A renderer/preload 真实 turn、E4.4-B 打包门禁，两条在途，均未验收）。必须在M5大规模迁移前建立，防止只有新包脚本测试。

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

状态：四条全部未验收，记blocked/unverified，不是通过。origin/master（5dc45fcf）上没有任何E4.4产物。

- 第1条：E4.4-A在途（真实Electron renderer/preload turn到durable terminal），未合并、未验证。
- 第2条：需要真实provider key。离线provider不算过；按本文件规定不能用offline替代P6，无key即记blocked。
- 第3条：E4.4-B在途（packaged agent-bundle/BashWorker/nativeSQLite门禁）。整包检查需要磁盘与一次真实打包，未跑。
- 第4条：依赖第1条，未开始。

在E4.4落地前，P6证据不得称完成。

## PR、验收、回退

E4-Aworkerfixture+artifact；E4-B行为矩阵；E4-Cevalrunner/evaluators与CI；E4-DElectron/provider证据。不得为了“测试全绿”重写整个产品loop或移除失败场景。

exit：矩阵关键case可重复通过，产物与真实worker相连，至少Desktopoffline闭环；live/packaged未验收时标明限制并阻止对应能力称完成。测试设施回退不影响生产包；fixedcases保留为M5每个切片的回归锚点。
