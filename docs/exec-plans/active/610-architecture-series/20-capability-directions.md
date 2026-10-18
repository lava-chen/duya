# 20 — 能力三向普查与 owner 定案（T13）

Date: 2026-10-18. Parent: [610](README.md) · 执行队列 [19](./19-fast-track-queue.md) T13.
依据缺口：19 §1.2 **G4** —— 能力三向（执行 / 消费 / 提供）未绑定。

## 0. 本文是什么

- 本文对仓库里**三份能力词汇表**的每一个名字给出唯一方向（执行 / 消费 / 提供）与唯一协议 owner。
- 本文**不改语义**。发现的名字重叠、命名漂移与 owner 疑义写进 §4 / §5，由 owner 决定是否改代码。
- 每个名字的方向只能被声明一次；第二方向必须显式写 `both`，并写明两侧各由什么满足。
- 机器可读的方向表在 §3，由 `packages/agent-protocol/test/capability-directions.test.ts`
  直接解析并与真实导出集合对账。**文档与代码漂移即为红**（含反向：文档多写的名字也是红）。

## 1. 基线（2026-10-18 实测于 `25cfd734`，`origin/master`）

三份词汇表，全部是**字面量数组**或**从注册表推导的类型**，没有第四份：

| 方向 | 定义位置 | 名字数 | 性质 |
| --- | --- | --- | --- |
| 执行 EXECUTE | `packages/agent-protocol/src/capabilities.ts:265` | **3** | 字面量 `RUNTIME_CAPABILITIES` |
| 提供 PROVIDE | `packages/agent-protocol/src/host-capabilities.ts:64` | **22** | 字面量 `HOST_CAPABILITIES` ＋ `HOST_CAPABILITY_OWNERS` |
| 消费 CONSUME | `packages/agent-protocol/src/version.ts:92` | **6** | 字面量 `PROTOCOL_CAPABILITIES` |

三表合计 **31 个不重复名字**。实测这个数字来自测试首次运行的红因，而不是本文数出来的：
红因打印了 31 个「exported by code but absent from the census table」。

**消费侧是推导的，不是第二份字面量。** `capability-negotiation.ts:35` 写的是
`RequiredCapability = NonNullable<MessageGate['requiresCapability']>`，真正枚举它的是
`packages/agent-protocol/src/events/registry.ts` 的 `EVENT_META`（5 个门）与 `CONTROL_GATE`（1 个门）。
因此测试不读 `PROTOCOL_CAPABILITIES`，而是从 `MESSAGE_GATES` 现推一遍：新增一个门而本文不补行，
就会红。这比对着字面量表核对强——字面量表和门表本来就可能分叉，而**分叉的正是消费侧**。

`runtimeSupports`（`packages/agent-core/src/capability-negotiation.ts:161`）是 `switch`，6 个
`case` 与 6 个消费名一一对应，`default` 分支返回 `false`（不认识的门名不通过）。这条今天成立。

## 2. 为什么要有这份普查（三份表互相看不见对方）

三份表各自正确，合起来却不自洽：

- `version.ts:88` 已经声明「这是消费侧，不是 runtime 的能力表」，`capabilities.ts:258` 已经声明
  「这是执行侧」。**两份注释互相引用对方，两边都正确，且都没有指认出第三张表。**
- `host-capabilities.ts:2` 声明「host 能 OFFER 什么」，但提供侧的 22 个名字里，**没有一个**
  出现在执行侧或消费侧。跨表重叠 today 是 **0**。

**所以「同一名字出现在两个方向」在今天的树上无法自然发生。** 这不是好消息，是 610 §4 第 4 条说的
那个病：*绿不得等于没检查到*。真正存在的重叠是**换名的重叠**（§4），而按名字做的门禁看不见换名。
本文把 31 个名字的方向钉死，并用 `both` 通道给未来的重叠留出唯一的入口。

## 3. 机器可读方向表（测试读的就是这张表）

列含义：`方向` 只能是 `execute` / `consume` / `provide` / `both`；`另一侧` 为 `—` 表示单方向，
非 `—` 时 `方向` 必须是 `both`。`定义位置` 是可解析的 `path:line`，且该行**必须包含这个能力名**。

<!-- census:start -->
| 能力名 | 方向 | 另一侧 | 唯一协议 owner | 定义位置 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `checkpoint_repository` | execute | — | `packages/agent-protocol/src/capabilities.ts` | packages/agent-protocol/src/capabilities.ts:267 | 运行时有落盘检查点仓库。消费侧的 `checkpoint_resume` 只问事件可不可发，见 §4.2 |
| `permission_coordinator` | execute | — | `packages/agent-protocol/src/capabilities.ts` | packages/agent-protocol/src/capabilities.ts:269 | runtime 自己铸 `expiresAt` 并自己跑计时器，两个钟不许分家 |
| `tool_preview` | execute | — | `packages/agent-protocol/src/capabilities.ts` | packages/agent-protocol/src/capabilities.ts:271 | 执行器能在派发前发 `tool.call_preview`。与消费侧 `tool_call_preview` 是同一件事的两个名字，见 §4.1 |
| `tool_call_preview` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:94 | 消费方能渲染临时工具预告，缺席时是被**不发送**而不是被丢弃 |
| `tool_outcome_detail` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:96 | 消费方认得 `tool.call_completed` 的判别联合 |
| `usage_accounting` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:98 | 消费方拿 `assistant.usage` 算钱 |
| `replay` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:100 | 消费方能按 `seq` 而非轮次边界恢复。唯一由 `CONTROL_GATE` 而非事件引入的门 |
| `checkpoint_resume` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:102 | 消费方认得 `checkpoint.saved` 并按 generation 恢复 |
| `permission_expiry` | consume | — | `packages/agent-protocol/src/version.ts` | packages/agent-protocol/src/version.ts:104 | 消费方渲染 `expiresAt` 并处理 `permission.expired` |
| `workspace_filesystem` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:66 | owner=runtime。跟的是**工作区**，浏览器客户端照样能浏览远端工作区 |
| `workspace_git` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:68 | owner=runtime。状态 / diff / 提交 / 分支 / 应用内评审 |
| `native_dialog` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:70 | owner=host-local。与 `workspace_filesystem` 成对：两个 owner 就是两块磁盘 |
| `os_shell` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:72 | owner=host-local。打开路径 / 外链 / 在文件管理器中显示 |
| `settings_store` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:74 | owner=host-local。设置键值，含第二层持久化 |
| `system_notification` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:76 | owner=host-local。运行结束通知 |
| `vision_models` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:78 | owner=host-local。视觉模型与逐 provider 开关 |
| `provider_crud` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:80 | owner=host-local。增删改模型 provider 并重初始化 runtime |
| `port_discovery` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:82 | owner=host-local。浏览器里缺席是设计，不是缺陷 |
| `voice_capture` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:84 | owner=host-local。麦克风采集与转写 |
| `screen_recording` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:86 | owner=host-local。录屏 |
| `log_files` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:88 | owner=host-local。定位 / 导出 / 清理应用日志 |
| `session_persistence` | both | provide | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:90 | host-local 侧满足：桌面端自持一份会话 / 线程 / 消息副本。runtime 侧满足：控制平面为权威，客户端崩溃后从控制平面取回。见 `packages/agent-protocol/src/host-capabilities.ts:133` |
| `project_registry` | both | provide | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:92 | host-local 侧满足：已注册项目及其工作目录。runtime 侧满足：控制平面持有同一份注册表。见 `packages/agent-protocol/src/host-capabilities.ts:134` |
| `cron` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:94 | owner=host-local。定时与周期运行 |
| `workflow` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:96 | owner=host-local。工作流运行与其图 |
| `skills` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:98 | owner=host-local。技能清单与安装态 |
| `hooks` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:100 | owner=host-local。hook 清单与配置 |
| `inbox` | both | provide | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:102 | host-local 侧满足：已投递、排队等待一轮的消息。runtime 侧满足：消息真正进入运行的是控制平面那份。见 `packages/agent-protocol/src/host-capabilities.ts:139` |
| `plugins` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:104 | owner=host-local。已装插件与其信任态 |
| `canvas` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:106 | owner=host-local。画布表面 |
| `orb` | provide | — | `packages/agent-protocol/src/host-capabilities.ts` | packages/agent-protocol/src/host-capabilities.ts:108 | owner=host-local。Orb 表面 |
<!-- census:end -->

三个 `both` 行不是本文发明的：`CapabilityOwner` 的第三个取值就是 `both`
（`host-capabilities.ts:62`，语义见 `:46`），`HOST_CAPABILITY_OWNERS` 里今天正好三个名字取它
（`:133` / `:134` / `:139`）。测试把这一条双向钉死：**文档说 `both` 而代码说 `host-local` 会红，
代码说 `both` 而文档说 `provide` 也会红**，并且 `both` 行的说明必须同时写出 `host-local` 与
`runtime` 两个满足方，否则红——只写一边就是本文要消灭的那种歧义。

## 4. 三对换名重叠（本文最值钱的部分）

下面三对是**同一个特性在握手两侧各有一个名字**。按名字做的任何门禁都看不见它们，
所以必须在这里点名。三对都不是「同一名字出现两次」，因此**不需要** `both`：
`both` 只描述一个字被谁提供，不描述一个特性被两端各叫一次。

### 4.1 `tool_preview`（执行）↔ `tool_call_preview`（消费）—— 两侧读同一个字段

| 侧 | 判据 | 位置 |
| --- | --- | --- |
| 执行 | `events.volatile` 含 `tool.call_preview` 且未提供 `tool_preview` → 报 `CapabilityConsistencyProblem` | `packages/agent-protocol/src/capabilities.ts:323` |
| 消费 | 发送集合含 `tool.call_preview` → 满足 `tool_call_preview` | `packages/agent-core/src/capability-negotiation.ts:185` |

**判据不同，结果也不同。** 执行侧还额外要求 runtime 声明了 `tool_preview` 这个能力，
消费侧只看事件在不在发送集合里。一个只发了 `tool.call_preview` 却没声明 `tool_preview`
的 runtime，会让 `negotiate()` 判 ok，同时让 `assertCapabilityConsistency` 报一条 finding。
**两个函数对同一个 runtime 给出相反答案，且今天没有任何测试同时调用这两个函数。**

### 4.2 `checkpoint_repository`（执行）↔ `checkpoint_resume`（消费）—— 强弱不对称

执行侧要求「有检查点仓库」或 `run.resume.checkpointGeneration: true` 就报 finding
（`capabilities.ts:305`）；消费侧只要求 `checkpoint.saved` 可发送
（`capability-negotiation.ts:191`）。**一个广播了 `checkpoint.saved` 却没有仓库的 runtime
能让消费侧通过、让执行侧报红。** 这正是 `capabilities.ts:257` 那段注释描述的
「the alternative is a promise nobody keeps」，只是它今天只在一个方向上被抓住。

### 4.3 `permission_coordinator`（执行）↔ `permission_expiry`（消费）—— 同一谓词两个名字

执行侧：`permissionExpiryClock === 'runtime'` 却未提供 `permission_coordinator` → 报红
（`capabilities.ts:312`）。消费侧：`permissionExpiryClock === 'runtime'` → 满足
（`capability-negotiation.ts:189`）。

**这两条是同一个布尔判断。** 三对里只有这一对是严格等价的，也就是说：把它合并成一个名字
在语义上是**零风险**的，另外两对不是。这也是「漂移的是命名而不是行为」的唯一硬证据。

## 5. 我认为 mis-owned 或有歧义的名字（**未改代码**）

1. **`tool_call_preview` 与 `tool_preview` 应归同一个 owner 概念，今天是两个。**
   owner 是 `version.ts`（消费），而它要求 runtime 做的那个动作由 `capabilities.ts`（执行）负责
   自证。同一个声明字段 `events.volatile` 同时是两侧判据，**一个字段养两个名字**。
2. **`checkpoint_resume` 的消费判据比 `checkpoint_repository` 的执行判据弱**
   （§4.2）。按方向表，两个名字分属两个 owner，但它们守的是同一条承诺。
   **今天 host 可以声明 `checkpoint_resume` 并拿到一个假承诺。**
3. **`permission_expiry` / `permission_coordinator` 建议合并**（§4.3）。这是三对里唯一
   可以零风险合并的，却也是今天唯一一个**两份注释都声称「本表不是对方那表」**却逐字相同的。
4. **三个 `both` 名的 `second` 列写的是 `provide` 而不是第二个方向。**
   这是刻意的：`CapabilityOwner` 的 `both` 讲的是「谁提供服务」（本地 + 控制平面），
   不是「这个特性被两个方向使用」。本文没有把它们混为一谈，但**语义上 `方向=both`
   这一列对提供侧表达的是「由两方提供」，对执行 / 消费侧表达的是「在两端各被命名」——
   同一个 token 两种含义**。owner 若认为不妥，应拆成两列。
5. **`RuntimeCapabilities.catalog`（`capabilities.ts:115`）里的 profile / mode / tool /
   connectorProviders 不在本次普查内。** 它们是「runtime 能提供什么」的**另一个维度**
   （词表本身是 catalog 的内容，不是能力名）。`14-producer-inventory-drift.test.ts`
   守的是那一维。本文不与之重叠，但也不应被读成「runtime 的提供面只有 3 个」。

## 6. 本文明确定不了的事

- **不改名、不合并、不删成员。** 上面 5 条都需要动已发布的 wire 词汇表，属于语义变更，
  超出 T13 的独占路径（本文 + 一条断言）。`capabilities.ts` 本次只加注释。
- **不判断 `HOST_CAPABILITIES` 的 22 项是否真的都有 IPC 通道。**
  `assertHostCapabilityConsistency` 已经是那道门，但它的入参 `registered` 在仓库里
  没有生产调用方——**22 个名字今天的满足关系只有一份测量报告**
  （`host-capabilities.ts:23` 记录的 `16-a8-ui-census.md` §9，`c3a1ed41`），
  没有运行时校验。本文因此不给提供侧写「已验证」，只写方向与 owner。
- **不覆盖 mode / profile / permission-mode 三条正交轴**（见 610 §Architecture）。

## 7. 验收与变异证明

```bash
npx vitest run packages/agent-protocol/test/capability-directions.test.ts
npx vitest run packages/agent-protocol/test          # 证明没弄坏既有 22 条测试文件
node scripts/architecture/plan-sync-check.mjs --strict
```

门禁的判据（不是当前结论）：它断言**判据本身**——
① 三表导出的每个名字都在表里；② 表里没有代码不导出的名字；
③ 从 `MESSAGE_GATES` 现推的门名都在表里；④ 每个名字的方向与其来源词汇表一致；
⑤ 第二方向必须带 `both`；⑥ `both` 集合与 `HOST_CAPABILITY_OWNERS` 双向一致；
⑦ 每行的 `path:line` 能解析，且该行**含有这个能力名**（只解析不够，见
`13-citation-drift.test.ts` 对 `router.ts:1697` 的判例）。

**变异 1**：给一个非 `both` 名字加第二方向 → `refuses a second direction on a name that is not declared both` 转红。
**变异 2**：从表里删掉一个代码仍导出的名字 → `classifies every capability name the three vocabularies export`
与 `gives each execution-side name the execute direction` 同时转红。
