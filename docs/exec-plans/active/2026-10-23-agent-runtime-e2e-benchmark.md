# Agent Runtime 真实基准：首 Token、工具调用、事件传输分段

状态：active · 负责人：mavis / `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-23
分支：`codex/tui-perf-benchmark` · worktree：`E:\Projects\duya\.claude\worktrees\tui-perf-benchmark` · base：`af6e7eb6` · owner：mavis

## 目标与边界

`evals/agent/performance/METRICS.md` 写明现有基准的缺口：Host 受理、worker 启动、
Worker→Host IPC、Host→客户端 SSE 交付**全部未测**；`tui.test.ts` 的 scope 也自述
不含 Host/Worker/provider 时间。本次补上这一段，并按用户要求定位三个瓶颈：

- **首 Token**：从 TUI 提交到第一个 token 被消费 / 被画出，分段到 provider 请求、
  provider 首字节、事件到达、终端绘制。
- **工具调用**：模型发出 tool_use → `tool.call_started` → 真实工具执行 →
  `tool.call_completed` → 第二次模型请求 → 终稿。
- **事件传输**：每个事件从 Host 铸封（`envelope.timestamp`）到客户端收到的延迟分布，
  以及到达间隔、事件类型构成。

边界：

- 不改生产代码。基准是新增的 eval 套件 + 计划/文档。
- 断言只针对**不变量**（事件序列、工具轮次、终稿文本、span 完整性），时间数字只**上报**，
  不设阈值——沿用 `tui.test.ts` 的既有立场。
- provider 是本机脚本化 Anthropic SSE 服务器；模型时间由 fixture 控制并单列。
- worker 是独立进程，不做跨进程时间戳相减；worker 段以合并 span 上报。
  唯一的例外是 worker **自己日志内部**的行间差（同进程时长，可比）。

关联：`evals/agent/performance/METRICS.md`（指标地图）、`INITIAL_FINDINGS.md` 优先项 1–2、
`packages/cli/tests/integration/shared-client-vertical.test.ts`（同一套真实 Host + 生产 worker 的既有竖切）。

## 验收

- `npm run eval:agent:runtime` 在本机跑通，写出 `evals/agent/reports/runtime-latest.json`。
- 报告含三个场景的分段数字、worker/Host 日志阶段缺口，且 `scope` 写明排除了什么。
- `npm run typecheck:all` 通过；`npm run architecture:check` 无新增违规。
- `npm test` 中新文件被收集（`check-test-coverage` 不报孤儿）。

## 进度

- [x] 读通链路：`chat.ts:1091-1099` 的 TUI 消费路径 = `startAgentRun` → `watchAgentRunEvents` → `HostEventStream.push` → `TUIApp.push`；Host SSE 走 live 通道（含 ephemeral delta）后接 durable 账本收尾（`http-server.ts:3090-3109`）。
- [x] 独立 worktree + junction 依赖 + `build:packages`。
- [x] `evals/agent/performance/runtime-fixture.ts`：脚本化 provider + 真实 Host/worker + TUI 消费驱动 + 日志解析。
- [x] `evals/agent/performance/runtime-e2e.test.ts`：三场景 + 报告。
- [x] 跑基线并定位瓶颈（见下）。
- [x] 更新 `README.md` / `METRICS.md` 与根 `package.json` 脚本。
- [x] 修复批次 1：提示词只发一次、时间线只投影一次、TUI 首帧 leading edge、
      基准帧封口口径（`firstChar*` 指标）、jimp 惰性加载。
- [x] 修复批次 2：技能威胁扫描预筛（−65 ms）、提示词去重**删错副本**的修正、
      turn review 的 git 快照复用 stat 缓存（1426 → 189 ms）、desktop IPC 普查解析常量。
- [x] 修复批次 3：把**请求装配顺序**抽成契约（`request-assembly.ts` + 契约矩阵），
      并让「系统附带行」的身份跨 host→engine 边界可见（见下）。
- [ ] 门禁 + PR。

## 发现与决策

### 瓶颈定位（本机基线，5 样本）

| 段 | p50 | 结论 |
| --- | --- | --- |
| Host 受理（submit → accepted） | 18 ms | 不是瓶颈 |
| **accepted → provider 请求** | **637 ms** | **首 Token 的主要成本** |
| provider 首字节 → token 被 TUI 收到 | 33 ms | worker + IPC + Host 解码 + SSE |
| token 被收到 → 画到终端 | **70 ms** | TUI 的 70 ms 渲染节流，不是传输 |
| **Host 铸封 → 客户端收到（每事件）** | **0.73 ms**（p95 3.8） | **事件传输不是瓶颈** |
| 客户端收到 → 画到终端（每事件） | 62 ms | 渲染节流 |
| 工具开始 → 工具完成 | 14 ms | 工具本身很快 |
| 模型第 1 次请求 → 第 2 次请求 | 41 ms | 模型↔工具往返 |

**结论：事件传输被排除在瓶颈之外**（每事件 0.73 ms p50）。首 Token 的成本集中在
「Host 受理之后、provider 请求之前」，以及终端侧的 70 ms 节流。

### 该 637 ms 在哪（worker 与 Host 自己的日志）

- Host 日志最大缺口：**412 ms**——「Sending command to worker」到 worker 的第一条输出，
  即 **fork + 4.6 MB worker bundle 的模块初始化**。
- worker 日志最大缺口：**161 ms**——「Failed to discover plugin skill paths」到
  「Loaded 18 skills after filtering」，即**每轮技能发现扫描**。
- 其余：MCP 初始化 → handleChatStart 113 ms，多模态能力探测 33 ms，
  `projectModelMessages` 投影 30 ms。

### 顺带查出的三个缺陷（均由本基准实证）

1. **用户提示词在模型请求里出现两次。** 持久化的时间线只有 1 条 user 行、1 个文本块，
   但 provider 收到的 user 消息内容数组是
   `[{"type":"text","text":"<prompt>"},{"type":"text","text":"<prompt>"}]`。
   即：**存一次、发两次**，首轮提示词 token 与上下文组装成本翻倍。

   **根因已定位**（2026-10-23，用 worker 日志逐段打点确认）：
   `packages/agent-runtime/src/engine/run-engine.ts` 的 `#modelRequest` 在第 1 轮把
   `input.prompt` 与 `history` **拼接**，而 `history` 在 host 走 `by_ref` 时就是
   `assembled.messages`——host 从自己的时间线投影，**那条 user row 就是本轮的提示词**
   （`buildLegacyRunInput` 把它命名为 `promptRowId`，即该行的 id）。
   两条 message **id 完全相同**，实测 model port 收到 6 条 message：
   `[user(prompt), user(prompt, 同 id), rail×4]`。
   修法：按 **message id** 去重——history 里已有同 id 的那条就不再单独插入
   `input.prompt`。id 是唯一可靠的判据（engine 不能比文本，host 也可能改写过行内容），
   且 host 若没把提示词行投影进 history，去重不生效、行为与改前一致。

2. **每开一个新会话会多一次 provider 调用。** 提示词是 `<request>…</request>`，
   来自 `packages/host/src/worker-session/title-generator.ts:320` 的标题生成，
   与用户那一轮并发抢占同一个 provider。**未修**：改它会动到「标题何时出现」的用户可见行为，
   留作下一批。
3. **每轮时间线被投影两次。** worker 日志里连续两行
   `projectModelMessages: 1 agent messages → 5 model messages`；
   对应 `worker-session-runtime.ts:459` 与 `worker-run-composition.ts:265` 两次投影。

   **根因已定位**：`worker-session-runtime.ts:459` 产出的 `projection` 字段
   **没有任何消费者**（全仓只有构造处与接口声明），所以那 30 ms 的第一次投影是纯浪费；
   而 `applyTurnModes` 只需要其中的 **system prompt** 一半。
   修法：把 system prompt 的计算从 messages 投影里拆出来
   （agent-core 新增窄导出 `projectSystemPrompt`），`beginTurnAssembly` 只算 system 一半，
   `projection.messages` 改成惰性 getter。契约不变、行为不变、少走一次时间线。

### 修复后的复测（同机 5 样本）

| 段 | 修前 | 修后 | 说明 |
| --- | --- | --- | --- |
| accepted → provider 请求 | 506 ms | 513 ms | 噪声区间；内部结构已变（见下） |
| Host → worker 首条输出 | 336 ms | **313 ms** | jimp 惰性加载 |
| token 被收到 → 画到终端 | 76 ms | **2.7 ms**（p95 3.6） | TUI leading edge + 帧封口口径修正 |
| 首个**字符**被收到 → 上屏 | （原先无此指标） | **2.7 ms** | `firstCharReceivedToPaintedMs` |
| 提交 → 首个字符上屏 | — | **574 ms** | `firstCharSubmitToPaintedMs` |

`tokenReceivedToTokenPaintedMs` 从 76 ms 掉到 2.7 ms，有一半是**测量口径修正**：
原 harness 用「下一帧的 SYNC_BEGIN」给帧封口，测的是**渲染间隔**而不是上屏延迟；
真实的首帧 leading edge 只花 0.29 ms 就起帧，而旧口径把整个 70 ms 节流窗口算给了它。
现在帧用「携带它最后一个字节的那次 write」封口。

### 请求装配契约（修复批次 3）

`b8dda429` 修好了「删错副本」，但**顺序规则本身仍是一行数组表达式**加一大段注释——
注释能解释规则，却挡不住下一个改它的人。这条规则已经被改坏过两次：`01344cd3` 把引擎
那份放到了请求最前，`b8dda429` 改回保留 host 那份，两次都是就地改表达式。

于是规则本身被抽成契约：

- `packages/agent-runtime/src/engine/request-assembly.ts`：五个来源、顺序，以及四条
  受保护的规则——提示词只发一次；host 那份优先且**留在 host 放的位置**；host 没投影
  提示词行时引擎那份落在**对话末尾**而不是最前；第 2 轮起不带提示词。
- `packages/agent-runtime/test/request-assembly.test.ts`：**契约矩阵**，每个来源组合一行，
  输出形状逐条钉死。
- `ModelMessage` 新增 `origin?: 'conversation' | 'context'`；host 的 `toModelMessages`
  从 `metadata.runtimeContext === true` 推出 `'context'`——那是 volatile context rail、
  hook 块、附件正文三类「系统附带行」的共同标记，此前在 host→engine 边界被整个丢掉。
  带上它，引擎才知道**对话在哪里结束**，fallback 的提示词因此落在与 host 那份相同的位置。
- `packages/host/tests/worker-product-runtime/engine-prompt-order-proof.test.ts`：真实链路
  到 provider 边界，断言「提问是这个人说过的最后一句话」（系统附带的行可以跟在后面）。
  变异验证：把契约改回「引擎那份放最前」，该用例变红。

行为变化只有一处，且是 latent 的：host **没有**投影提示词行时，引擎那份不再落在请求最前，
而是落在对话末尾——`b8dda429` 之前落在最前，而那正是本缺陷的原始形态。

### 剩余瓶颈（实测、均未修）

| 瓶颈 | 代价 | 为什么没修 |
| --- | --- | --- |
| 技能加载 | 冷 **84–160 ms**（热 12–17 ms） | 威胁扫描已优化（见上）；剩下的分解见下方「再更正」，**主体是 I/O 等待**（Defender 逐文件扫描），没有语义可省 |
| worker bundle 编译 | ~94 ms（V8 `wrapSafe`） | node 的 compile cache **不缓存进程入口**；要吃到收益必须让 bundle 变成被 `require()` 的模块（小 launcher），而这会动打包链路（`PRIMARY_AGENT_ENTRY` 锁 `harness-bundle/worker-entry.js`）与 `bundle:verify` 的产物命名。**机制已验证可行**：1.38 MB 的合成 CJS 模块，冷 require 20.5 ms → 缓存命中 10.7 ms（首次写缓存反而 30.6 ms）。卡点是打包与发布契约，不是可行性 |
| 三个 db action 未实现 | ~1 ms/次，但**功能坏** | `plugin:registry:list` / `plugin:setup:list-all` / `mailbox:claimBatch` 在 Host 侧仍抛 `unimplemented_domain`：CLI/TUI 路径因此**加载不到插件技能**、mailbox 领取每次失败。属功能缺口，不是延迟瓶颈，建议单独 PR |
| 标题生成多一次 provider 调用 | 不在关键路径 | 代码上它在助手回复**完成后**才发起，不阻塞首 token；改它会动「标题何时出现」的用户可见行为 |

> **更正**：上一版把「工具目录初始化」记为 116–129 ms，是**误判**。探针实测
> `initToolCatalog` 只有 **8 ms**（registryList 2 ms + createBuiltinRegistry 5 ms + register 1 ms）。
> 真实热点是 `loadSkillsFromDirectory(user)` 的 **118–169 ms**：本机 `~/.duya/skills`
> 有 4 个技能目录、236 个文件、3 MB、18 个 SKILL.md。
>
> **再更正（技能加载 118–169 ms 的内部归因也错了）**：CPU profile（`--cpu-prof`，
> 采样间隔 200 µs）给出的冷加载分解是——
>
> | 阶段 | 代价 | 说明 |
> | --- | --- | --- |
> | I/O 等待 | **~60 ms** | Windows Defender 逐文件扫描；profile 里是 idle，**不可压缩**（除非少读文件） |
> | fingerprint 遍历 | ~10 ms | plan 445 的快照指纹：对 236 个文件各 `stat` 一次取 mtime/size |
> | 威胁扫描 | **7.5 ms** | 预筛后（原 75–155 ms） |
> | 读 SKILL.md | ~5 ms | 21 个文件 / 280 KB，带防抖 stat 序列 |
> | 目录遍历 | **1–4 ms** | 上一版记的「目录遍历 ~70 ms」是**误归因**：readdir + 逐条目 stat 实测只有 1–4 ms |
>
> 热加载（同一进程第二次）只要 **12–17 ms**（plan 445 的进程内快照缓存命中）。
> 结论：威胁扫描那块已经拿掉，剩下的**主要是 I/O 等待**，没有语义可省；
> 唯一还能省的是 fingerprint 的 236 次 `stat`（≈10 ms），收益太小，本轮不做。

### 另一个瓶颈：turn review 的 git 快照（已修）

每个用户回合要取**两次**「工作树快照」（回合开始前、回合结束后），用来算这一回合
agent 改了什么。旧实现用一个**全新索引**跑 `git add -A`：新索引没有任何 stat 信息，
git 必须把全仓文件重新读一遍、重新哈希一遍。

| | 一次快照 | 每回合（两次） |
| --- | --- | --- |
| 改前（全新索引） | **1426 ms**（中位数，5 样本） | ~2.9 s |
| 改后（复用仓库 index 的 stat 缓存） | **189 ms** | ~0.4 s |

回合开始那一次就在**首 token 关键路径**上：worker 起来 → `handleChatStart` → 快照
→ 才发模型请求。改法是让隔离索引**先复制仓库自己的 index**，git 就能复用 stat
缓存，只重新哈希 stat 变了的文件。两种路径产出的 tree 对象**完全一致**（同一个
SHA），仓库自己的 index 只读不写；没有 index 可复用时回退到旧路径。

> 这个瓶颈是被 `packages/cli/tests/integration/host-child-sessions.test.ts` 的
> 15 秒预算暴露的：每个 worker 付 ~1.5 s，4 个 worker 就是 ~6 s，父会话来不及
> 走到第 6 张审批卡，测试按超时失败。

### CI 的盲区：master 的 push 不跑 test job

master 的 `Test` workflow 里，`test` job 对 push 事件是 **skipped**（只跑
`test scope` 与 `architecture`）。所以 desktop 的两个 IPC 契约测试在 master 上
**一直是红的**，直到本 PR 第一次跑全量才暴露：

- `gpu-diagnostics.ts` 用**常量**注册 channel（`ipcMain.handle(GPU_STATUS_CHANNEL, ...)`），
  而契约普查的正则只认字面量 → 把 `GPU_STATUS_CHANNEL` 当成了 channel 名，
  真正的 `gpu:get-status` 被判成「preload 能调、主进程没注册」。
- 修法：普查**解析常量**（先收集 `const X = 'ch'`，再解析标识符）。不是放宽断言——
  实测注入一个无 handler 的 channel，两个用例仍然会报。

### 其它实测结论

- **Node 的 compile cache 帮不到 worker bundle。** `module.enableCompileCache()` 只缓存
  **被 `require()` 的模块**，不缓存**进程入口**；而 `child_process.fork()` 是**起一个全新
  node 进程**（不是 POSIX fork），父进程打开的开关也**不会**被继承。所以 4.38 MB 的
  worker bundle 每次 spawn 都要重新编译。
  实测参照：require 一个 2.4 MB 的 CJS 模块，冷 49 ms → 热 5 ms（**省 ~45 ms**）。
  要让 worker 吃到这块收益，必须让 bundle 变成「被 require 的模块」（一个小 launcher），
  **而这会动打包链路**（`check-packaged-artifacts.mjs` 的 `PRIMARY_AGENT_ENTRY`
  锁定 `harness-bundle/worker-entry.js`），留作下一批。
  本次仍保留父进程侧 `enableWorkerCompileCache()`：它对 **Host 进程**自身的模块加载有效
  （Electron 冷启动），对首 token 路径无收益。
- **多模态探测 25 ms 是基准的冷缓存假象**：探测走 `modelCapability:get/set`，
  Host 侧**已实现**（`worker-db-bridge.ts:220-229`），缓存本该命中；
  但基准每个样本用**独立 dataRoot**，能力表每次都是空的。真实使用（同一个 DB）会命中。
- **Host 侧最大缺口是「命令投递 → worker 第一条输出」~341–380 ms**（基线 394 ms），
  包含子进程启动 + bundle 编译 + bundle 顶层执行；bundle 编译是其中可优化但需改打包
  链路的那一块（见上）。


### 其他决策

- **时钟规则**：provider / Host / TUI 同进程，共用单调钟；worker 独立进程，
  worker 段整体上报，不跨进程相减。唯一例外是 worker **自己日志的行间差**（同进程时长）。
  `envelope.timestamp` 是 epoch 毫秒整数，Host 侧铸封 span 带 ±1 ms 量化误差。
- **每个样本用独立 session**：否则上一轮的 tool_result 会留在历史里，
  让下一轮的首个请求被脚本误判成「工具后的追问」，测到完全不同的负载。
- **provider 脚本按「最新 user 消息是否含 tool_result」判定**，不是「历史里有没有
  tool_result」——后者从第二轮起就恒为真。
- **worker 子进程必须继承 `DUYA_DATA_ROOT`**，否则它读开发者真实的 `~/.duya` 配置、
  打真实的 provider，基准会以一个和基准无关的原因失败。
- **断言只覆盖不变量**：run 完成、工具真的跑了、事件 seq 单调、终稿文本正确、
  provider 被问过 ≥2 次。耗时不设阈值（共享 CI 机器会把阈值变成假红）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| af6e7eb6（clean） | Windows / Node 24.16.0 | `git worktree add … -b codex/tui-perf-benchmark origin/master` | 0 | 检出在 `.claude/worktrees/tui-perf-benchmark` |
| af6e7eb6（clean） | Windows | `node scripts/junction-worktree.mjs .` | 0 | 56 link(s) created |
| af6e7eb6（clean） | Windows | `npm run build:packages` | 0 | built 20 package(s) |
| af6e7eb6（clean） | Windows | `npx vitest run packages/cli/tests/integration/shared-client-vertical.test.ts` | 0 | 1 passed，7.3 s（参照用例，同一套真实 Host + worker） |
| 1b0bbef4 + 本任务改动 | Windows / Node 24.16.0 / 20 核 | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（PERF_RUNTIME_SAMPLES=5） | 0 | 2 passed；报告 `evals/agent/reports/runtime-latest.json` |
| 1b0bbef4 + 本任务改动 | Windows | `npm run typecheck:all` | 0 | 含 `typecheck:evals`：no new type errors |
| 1b0bbef4 + 本任务改动 | Windows | `npm run architecture:check` | 0 | OK — no new boundary violations |
| 1b0bbef4 + 本任务改动 | Windows | `npm run bundle:verify` | 0 | FRESH，0/921 输入变更 |
| 7d63953b（合并 origin/master 后） | Windows / Node 24.16.0 | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（5 样本） | 0 | 2 passed；结论不变：mint→client p50 0.99 ms / 1.86 ms，accepted→provider p50 506 ms，token→paint p50 76 ms，工具执行 p50 11.9 ms |
| 7d63953b | Windows | `npm run typecheck:all` | 0 | 含 `typecheck:evals`：no new type errors |
| 7d63953b | Windows | `npm run bundle:verify` | 0 | FRESH（合并带入的 bundle 重建 ea419929） |
| 7509038a | Windows / Node 24.16.0 | `npx vitest run packages/host/tests` | 0 | 176 files / 1631 passed，1 skipped |
| 7509038a | Windows | `npx vitest run packages/cli/src/tui/` | 0 | 71 files / 908 passed |
| 7509038a | Windows | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（5 样本） | 0 | 2 passed；firstCharReceivedToPaintedMs p50 2.7 ms，Host→worker 313 ms |
| 待提交（scanner 优化） | Windows / Node 24.16.0 | `npx vitest run packages/agent-core/test/skills/` | 0 | 2 files / 24 passed（含新增 3 个等价性对拍用例） |
| 待提交（scanner 优化） | Windows / Node 24.16.0 | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（5 样本） | 0 | 2 passed；`acceptedToProviderRequestMs` p50 **512.6 → 448 ms**（-65 ms） |
| 待提交（prompt 去重修正） | Windows / Node 24.16.0 | `npx vitest run packages/cli/tests/integration/host-child-sessions.test.ts packages/cli/tests/integration/shared-client-vertical.test.ts` | 0 | 2 files / 2 passed（修前这 2 个用例都失败） |
| e9f9daec | Windows / Node 24.16.0 | `npx vitest run packages/host/tests` | 0 | 176 files / 1632 passed，1 skipped |
| e9f9daec | Windows | `npm run typecheck:all` / `npm run architecture:check` / `npm run bundle:verify` | 0 / 0 / 0 | no new boundary violations；FRESH 0/921 |
| e9f9daec | Windows | `node docs-local/research/tui-perf-benchmark/measure-turn-review.cjs`（5 样本） | 0 | 快照中位数 **189 ms**（同脚本的旧算法复现：1426 ms） |
| e10e0587（合并 origin/master 后） | Windows | `npx vitest run apps/desktop` | 0 | 292 files / 3477 passed，1 skipped |
| e10e0587 | Windows | `npx vitest run apps/desktop/src/main/ipc/__tests__/ipc-contract.test.ts apps/desktop/src/main/ipc/__tests__/ipc-channel-contract.test.ts` | 0 | 2 files / 7 passed（合并前这 2 个文件都失败） |
| 1747d15f | Windows / Node 24.16.0 | `node --cpu-prof` 采样技能冷加载 + `measure-skill-load.cjs` | 0 | 冷 84–160 ms / 热 12–17 ms；分解：I/O 等待 ~60 ms、fingerprint ~10 ms、扫描 7.5 ms、读 5 ms、遍历 1–4 ms |
| be5224e7（base，含 `b8dda429`） | Windows / Node 24.16.0 | `git reset --hard origin/codex/tui-perf-benchmark` | 0 | 位置修复已由 `b8dda429` 落在基线上，本分支只做契约化 |
| 69a84dab | Windows | `npx vitest run packages/agent-runtime` | 0 | 103 files / 1142 passed（含新增契约矩阵 9 例） |
| 69a84dab | Windows | `npx vitest run packages/host/tests/worker-product-runtime --maxWorkers=2` | 0 | 23 files / 128 passed（含新增真实链路回归） |
| 69a84dab（**变异**） | Windows | 把契约改回「引擎那份放最前、丢掉 host 那份」 | 1 | 新增回归用例变红：`expected 'PRIOR-QUESTION-MARKER' to contain 'PROMPT-QUESTION-MARKER'` —— 该用例确实咬住这个缺陷 |
| 69a84dab | Windows | `npm run typecheck:all` | 0 | OK |
| 69a84dab | Windows | `npm run architecture:check` | 0 | OK — no new boundary violations |
| 69a84dab | Windows | `npm run bundle:verify` | 0 | FRESH，0/922 输入变更 |

## 接续 / 结果

本分支（PR #381，base `master`，未合并）已交付：基准套件 + 修复 commit
（提示词去重、单次投影、Host compile cache、TUI leading edge、帧封口口径、jimp 惰性加载）
+ 技能威胁扫描预筛 + turn review 的 git 快照复用 stat 缓存 + desktop IPC 普查解析常量
+ 每次源码变更后重新构建的 worker bundle（`bundle:verify` 要求同变更内重建并提交）。

CI：head `1747d15f` 一轮 **五项全绿**（architecture / test scope / typecheck / test / build，
run 39996699375）。之后的提交只改文档。

### 提示词去重的坑：删错了副本

第一版「去重」按 id 过滤 **history** 里那条 prompt，留下 engine 前置的那份——这**删错了**。
host 提交 prompt 行后，engine 前置的 prompt 与 timeline 里那一行是同一条消息的两个副本，
但**位置不同**：engine 的在前，timeline 的在末尾（紧挨 context rail）。删掉末尾那份后，
用户的提问从「最后一个 user 消息」变成「第一个」，末尾只剩 rail；而 Anthropic 边界
（`mergeConsecutiveRoles`）会合并相邻 user 消息，于是 prompt 反而**同时出现在首尾**，
既多花 token 又打乱对话顺序。

修法是反过来：**删 engine 前置那份，留 host 那份**——host 那份的位置就是 legacy 的位置
（legacy 的 transcript 就是 timeline）。修后 provider 请求里 prompt 出现 1 次，且仍是
最后一条 user 消息。

这个回归是被 CI 抓到的：`packages/cli/tests/integration/host-child-sessions.test.ts` 与
`shared-client-vertical.test.ts` 里脚本化 provider 按「最新 user 消息」识别提问，
收到 rail 就直接 500。本地 A/B 对拍（回退该 commit 后重建 bundle）定位到根因。

### 顺序规则的固化（独立分支 `codex/fix-run-prompt-order`，PR #398）

这条规则已经改坏过两次，两次都是就地改 `#modelRequest` 里那行数组表达式。契约化后
规则有了名字和表格（见「请求装配契约」小节），并且补上了两处基线上还缺的判定：

- host **没**投影提示词行时，引擎那份不再落在请求**最前**（`b8dda429` 之前落在最前，
  而那正是这个缺陷的原始形态），而是落在**对话末尾**——与 host 那份所在的位置一致。
  判定需要知道对话在哪里结束，所以 `ModelMessage` 增加了 `origin`，host 从
  `metadata.runtimeContext` 推出「系统附带行」。
- host 把提示词行投影了两次时，只发一次。

未做（带实测数字见「剩余瓶颈」）：bundle 编译缓存 launcher、技能加载剩余开销
（读文件 + 目录遍历）、三个 db action、标题生成去重。
