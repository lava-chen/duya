> Historical / superseded for execution. 原位置：`docs/architecture/10-reference-comparison.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# 10 — 参考实现对比：codex / grok-build / pi / ZCode

> 生成日期 2026-10-01 · 证据基线 `master` @ `b6f8e7c0`
> 参考仓库：`E:\cloned-projects\{codex, grok-build, pi, ZCode}`
> 本文是 `02-reference-repo-boundaries.md`（广度调查）的**深读补充**：
> 那份说"哪些该抄"，这份说"**抄哪一行**"，以及**哪些绝对不能抄**。
> 结论直接喂给 `docs/exec-plans/active/584-agent-protocol-implementation.md`。

---

## 0. 一句话

四家参考仓库里，**没有一家有真正的 agent harness**（02 结论 8）。
它们提供的是**词汇的来源**和**三个反面教材**。
`@duya/agent-protocol` 的每一个关键决定，都对应下面某一条具体证据——
而不是一条风格偏好。

---

## 1. grok-build — `define_methods!`：union 必须派生，不能手写

`crates/common/xai-tool-protocol/src/methods.rs`

Rust 版做法：一个宏调用同时生成 enum、serde rename、`ALL`、正向和反向查表。

```rust
define_methods! {
    SessionOpen => "session_open",
    ToolCall   => "tool.call",
    // ...
}
```

生成物（宏内 `methods.rs:22-51`）：

| 生成物 | 对应 07 §4 的 |
|---|---|
| `enum Method` | `RunEvent` union |
| `#[serde(rename = $wire)]` | `payload.type` 的 wire 字符串 |
| `const ALL: &'static [Method]` | `registry.all` |
| `as_wire_str()` | `specOf` / 反查表 |
| `from_wire_str() -> Option<Self>` | **`fromEnvelope` 对未知 type 返回 `UnknownRunEvent`** |

**四条可直接落地的教训**

1. **`from_wire_str` 对未知返回 `None`，不 panic。** 07 §13 要求"未知事件类型不抛异常"，
   grok 用一个返回类型直接固化了这个纪律。
2. **enum 是扁平的。** 源码注释原话：*"the enum is flat — direction enforcement is the
   computer hub's job, not the protocol crate's."*
   → 07 的 `EventCategory` 只是分类标签，**方向强制属于 transport/adapter**。
   协议包只出词汇，不出行为。
3. **测试是穷举的**（`methods.rs:146-207`）：全量 round-trip、未知返回 `None`、
   serde 与 `as_wire_str` 一致。→ drift test #3 / #4 的原型。
4. **遗留形状被显式钉住**：`UNKNOWN_METHOD_MSG_PREFIX` 常量配注释
   *"Do not change casually"*，说明"必须为老 binary 保留"的理由要写进代码。
   → 07 的 `legacy/sse-event.ts` 必须带删除期限和理由，不能只留一个 shim。

### 1.1 必须照抄的反面教材：`xai-grok-sampling-types`

这是 07 §14 全部禁令的立论依据。**2026-10-01 复核：不但成立，而且比文档描述的更严重。**

`crates/codegen/xai-grok-sampling-types/Cargo.toml` 的 `description` 自称：

> Pure data types for the xAI sampling / chat-completion API layer

实际依赖 **11 个**：

```toml
async-openai    chrono    indexmap    reqwest ← 07 §14 点名的那个
schemars        serde     serde_json  thiserror
tracing    xai-circuit-breaker
xai-grok-compaction  ← 同域 path 依赖
xai-grok-tools      ← 同域 path 依赖
```

**它根本不是叶子**：一个 HTTP 客户端、一个熔断器、一个 tracing subscriber，
外加两个同域模块。文档说"no I/O"，依赖表说"什么 I/O 都有"。

> **对 duya 的直接推论**：`agent-protocol` 的 `dependencies` 必须是 `{}`。
> 因为 agent core 会被 esbuild 打进 `packages/agent/bundle/agent-process-entry.js`，
> 协议包的每个运行时依赖都会进那个 bundle 并出现在每个子进程里。
> **在 TS 里给一个"纯类型包"加 `typebox` 或 `zod`，就是这个 bug 的 TS 版本。**

---

## 2. codex — 90 行的边界脚本，和两个我该抄的细节

`.github/scripts/verify_tui_core_boundary.py`（89 行）

一条边一个脚本：无框架、无配置语言、`sys.exit(main())`。

### 2.1 细节一：**同时查 manifest 声明和源码引用**

`manifest_failures()` 查 `Cargo.toml`，`source_failures()` 查 `.rs` 里的
`codex_core::` / `use codex_core` / `extern crate`。

**只查一边都不够**：声明了不用的依赖是腐烂，没声明就用是逃逸。

→ 落到 duya：drift test #1 除了扫 `src/**/*.ts` 的 import 图，还必须查
`packages/agent-protocol/package.json` 的 `dependencies` / `devDependencies` /
`peerDependencies` 是否为空，以及 `scripts.build-electron.mjs` 的 esbuild `external`
列表有没有把它标成 external（标 external 等于运行时逃逸）。

### 2.2 细节二：**门禁自己说出逃生舱的名字**

失败信息原文：

> Use the app-server protocol/client boundary instead; temporary embedded
> startup gaps belong behind `codex_app_server_client::legacy_core`.

不是"违规了"，而是"**该走哪条路** + **临时的洞放在哪个具名模块**"。

→ 落到 duya：`architecture-policy.yaml` 的 `forbiddenDependencies` 应该给每条规则一个
具名逃生舱（如 `packages/agent-protocol/src/legacy-escape.ts`），
而不是只给一句 reason 文字。

### 2.3 它没做什么

codex 这个脚本**不读全仓**，只盯一条边。它不是通用门禁。
→ duya 的 `architecture-check.mjs` 走的是另一条路（全仓 + policy + baseline ratchet）。
两者不是替代关系：codex 那种形态适合"一条硬边"，ratchet 适合"几千条历史债"。

---

## 3. pi — `packages/protocol`：形态几乎一致，但有一个**根本分歧**

`E:\cloned-projects\pi\packages\protocol`（`@earendil-works/pi-protocol` v0.84.3）

这是四家里唯一的 **TypeScript ESM protocol 包**，和 `agent-protocol` 同一个角色。

```
src/index.ts     4 行，export * from 四块
src/cbor/        encoder / decoder / options
src/codec.ts     encodeClientMessage / parseClientMessage
src/framing.ts   长度前缀 + 增量解码
src/schemas.ts   typebox schema，Static<typeof> 派生类型
test/            三个测试文件，在 src/ 之外
```

`package.json` 要点：`"type": "module"`、单一 `exports: {"."}`、
`files: ["dist","README.md"]`、`engines.node >= 22.19.0`、
**唯一运行时依赖 `typebox`**。

### 3.1 分歧：谁是事实来源

| | pi | 07 / duya |
|---|---|---|
| 事实来源 | **typebox schema** | **TypeScript 类型** |
| 类型怎么来 | `Static<typeof XSchema>` 派生 | 手写 interface |
| union 怎么来 | `Type.Union([...])` | `UnionFrom<typeof EVENT_SPECS>` mapped type |
| 运行时依赖 | `typebox` | **无** |
| 校验时机 | 每次 `encode*` | 显式 `codecs.validate` |
| JSON Schema | schema 自带 | **测试期生成**（drift test #10） |

**两者都做到了同一件关键事：union 是派生的，不是手写的。** 分歧在派生方向。

**为什么 duya 必须选 07 的方向（三个理由，都不是偏好）**

1. **§1.1 那条教训直接适用。** agent core 要被 esbuild 打进子进程 bundle。
   `typebox` 进 `dependencies` 就是 `reqwest` 事件的 TS 重演。
2. **四个 host 独立部署**（Desktop / CLI / eval harness / 未来 cloud），
   加上一个独立的 subprocess runtime。host 与 runtime 版本会**各自偏移**。
   纯类型 = 零运行时成本 = 偏移只影响编译期。
3. **07 §10 的 capability probe 才是解 skew 的机制**。
   有 runtime validator 之后你会想"让 validator 兜着"，
   而那正是把 4 个 host 的版本重新绑死在一起。

> pi 能选 schema-first，是因为它 README 最后一句写明：
> *"The protocol is experimental and has no compatibility guarantees."*
> duya 没有这个奢侈。

### 3.2 必须抄的四条

**(a) 严格性放在校验、不放在解码——但方向和 pi 相反。**
pi 的 `StrictObject`（`schemas.ts:7-8`）给**每个** object 强制
`additionalProperties: false`，一个 helper 全局生效，想漏都漏不掉。
pi 的 README 明说 *"All schemas reject unknown object properties."*

**07 §13 第 4 条要求恰好相反**：解码路径忽略未知字段，严格性属于 `codecs.validate`。

**这不是谁对谁错，是版本承诺不同**：
- pi 无兼容承诺 → 可以严格
- duya 有 4 个独立部署的 host + 能力探测 → **必须前向兼容**，
  老 host 遇到新 runtime 的新字段不能崩

→ **抄的是那个 helper 的形态，不是它的策略**：
建一个 `LenientObject` / 严格 decode 入口的**单一收口 helper**，
让"宽松"也成为不可绕过的默认，而不是靠每个作者记得。

**(b) "不要第二套词汇"**（`schemas.ts:37` 注释原文）
> `/** Matches AgentHarnessPhase so adapters do not need a second phase vocabulary. */`

**这是 drift test #7（permission 词汇统一）的全部理由。**
今天的 bug 就是活体例证：`'allow'|'deny'|'paused'` vs `allow_once|allow_for_session`
vs 同样的四种，三套并存。

**(c) 帧格式与 schema、与 codec 分开。**
pi 分成 `framing.ts` / `codec.ts` / `schemas.ts` 三块，README 明说
*"handle framing independently of schemas"*。
**07 §1 把 framing、SSE↔envelope、NDJSON↔envelope 全塞进一个 `codecs.ts`——三份工。**
→ 采纳 pi 的切法：协议包内也拆。

**(d) 显式资源上限。** pi 的默认值全部写死并可配置：

| 项 | pi |
|---|---|
| 单帧 / payload | 16 MiB |
| array 元素 / map 条目 | 1,000,000 |
| 嵌套层级 | 64 |
| 校验时机 | **先验声明长度，再收字节** |

**07 §10 只有 `maxEventBytes` 一个字段，没有默认值，另外两项完全缺失。**
→ 采纳 pi 的三档上限 + "先验长度再缓冲"的顺序，作为 v1 的补齐。

### 3.3 一条卫生纪律

> *"Validation errors do not retain rejected payloads."*（README:40）

错误对象**不保留被拒绝的载荷**。duya 尤其该抄：07 §3 禁止密钥进 manifest，
`ProtocolErrorInfo.details?: JsonValue` 如果回填整个 payload，就会把
`apiKey` 写进日志和 IPC。→ v1 加注释约束，details 只能放**已脱敏的诊断信息**。

---

## 4. ZCode — 复核确认：跨包 import 一次都没查过

`scripts/architecture/policy.mjs:152-153`

```javascript
export function resolveImport(from, specifier, knownFiles) {
  if (!specifier.startsWith(".")) return null;   // ← 02:186 的指控，复核成立
```

任何非相对 specifier 直接 `return null`，于是 `module-dependency` 和
`deep-import` **两条规则在跨包场景下从未触发过**。

**教训已经内化进 duya 的实现**：
`architecture-check.mjs` 不自己写 resolver，而是消费
`audit-imports.mjs --json`——而那个 resolver 读每个包真实的 `exports` 字段
判 public/deep（`audit-imports.mjs:68-77`）。
**共享计算 = 计数一致是结构性保证，而不是纪律。**

ZCode 另一条仍然值得抄：`managedOnly: true` 的**分级准入**。
`policy.mjs` 让遗留包逐个转 `managed: true`，这条已被 duya 的
`architecture-policy.yaml` 原样采纳。

---

## 5. 决定汇总：哪些抄、哪些不抄

| # | 来自 | 决定 | 理由 |
|---|---|---|---|
| 1 | grok `define_methods!` | ✅ 抄 | 单一事实来源派生 union + 正反查表 |
| 2 | grok `from_wire_str → None` | ✅ 抄 | 未知事件不抛异常（07 §13） |
| 3 | grok 扁平 enum | ✅ 抄 | 协议出词汇，方向强制归 adapter |
| 4 | grok `sampling-types` | ⛔ 绝不抄 | `dependencies` 必须为 `{}` |
| 5 | codex 双查（manifest + source） | ✅ 抄 | 声明和引用都要查 |
| 6 | codex 具名逃生舱 | ✅ 抄 | 门禁要说清"该走哪条路" |
| 7 | pi 分层（framing/codec/schema） | ✅ 抄 | 07 的 `codecs.ts` 混了三份工 |
| 8 | pi 显式资源上限 | ✅ 抄 | 补 07 §10 的缺口（16 MiB / 1e6 / 64） |
| 9 | pi 错误不留载荷 | ✅ 抄 | 与 07 §3 禁密钥直接相关 |
| 10 | pi "不要第二套词汇" | ✅ 抄 | drift test #7 的全部理由 |
| 11 | pi `StrictObject` helper 形态 | ✅ 抄形态 | 但策略相反：duya 收口**宽松** |
| 12 | pi schema-first | ⛔ 不抄 | 见 §3.1 三条理由 |
| 13 | pi `additionalProperties: false` | ⛔ 不抄 | 4 个独立部署的 host 必须前向兼容 |
| 14 | ZCode 相对路径-only resolver | ⛔ 绝不抄 | 已内化为"共享 audit 计算" |
| 15 | ZCode `managedOnly` 分级 | ✅ 抄 | 已在 policy 里 |
| 16 | codex 单边脚本形态 | ❌ 不整抄 | 它没有历史债；duya 有 938 条 |

---

## 6. 这些参考**没有**提供的东西

02 结论 8 复核仍然成立：没有 evaluator、没有打分、没有跨 run 比较。

- `pi` 有 `packages/evals`，但它是**产品功能**（跑评测任务），不是 harness 侧的评分器。
- `grok-build` 有 `xai-circuit-breaker`，是可靠性组件，不是可观测性契约。
- `codex` 有 `tui-plan.md`，是 UI 规划，不是事件契约。
- `ZCode` 30 个包只有 4 个测试文件。

**这是 duya 的差异化机会，不是可以抄的东西。**
`harness/agent/`（584 计划范围外）的 evaluator 没有任何参考实现可依，
必须自己设计——这也是它被单列一个阶段的原因。

---

## 7. 写完代码之后：这份对比被自己推翻的三条

第 5 节是**动笔前**的判断。PP-1 落地之后有三条必须改，否则文档就在说谎。

### 7.1 决定 12（不抄 pi schema-first）从「偏好」升级为「有代价的决定」

动笔时拒绝 schema-first 的理由是三条定性判断。真写 drift test #10 时才发现，
07 §15 #10 抄的正是 pi 的那条「测试期重新生成 `schema/*.json` 再 diff」——
**规格里那一节本身预设了 schema-first**。

于是 #10 有两个选项：照字面建 `schema/`，或者承认规格预设错了。
选后者，理由是硬的：`packages/ai` 已有 9 条 deep-import 边指向 `dist/`，
说明本仓库的包**本来就在被深导入穿透**；再加一份没人用运行时校验的 JSON Schema，
只会得到第二个没人维护的事实来源——grok `sampling-types` 的缩小版。

所以 **#10 被改写成偏离守卫**：它检查 `schema/` **不存在**。
`schema/` 一旦出现就失败，并要求同一个 commit 附上生成器与 diff 测试。
手写的 schema 落不了地。这比检查一份没人维护的 JSON 有没有过期有用得多。

**规格 07 §15 #10 需要按这个结论修订**，本文件先记录，修订随 PP-2 一起做。

### 7.2 决定 14（不抄 ZCode 的相对路径 resolver）需要加一条：共享计算还不够

原判断是「门禁消费 audit 脚本的输出，不重写 resolver」。落地后发现**光共享不够**：

- 计数曾经依赖本地构建状态（16 条指向 `packages/agent/dist/` 的 electron 深导入），
  同一个 commit 在干净检出和构建过的检出上结论相反；
- 两个 audit 都对原始文本跑正则，**注释被当成代码**——文档里写的 `from '...'` 变成一条边，
  被注释掉的 import 也被当成活边（意味着删掉注释看起来像「消掉了一个违规」）。

两个都不是 resolver 写得不够细，是 resolver **根本没有代码/文本的概念**。
修法是新增 `scripts/architecture/strip-comments.mjs`（保字符偏移的词法器），
并把指向本仓库 `packages/<x>/dist/` 的 specifier 归一化回 `src/`。
实测移除 6 条误报、新增 0 条；基线 938 → **941** 指纹，selfTest 567/153 → **562/161**。

**codex 那个 89 行脚本不需要这些，因为它没有历史债。**
这条不是「codex 更聪明」，是「无债仓库和 941 条债的仓库不是同一个问题」——
这本身就是 02:220 的一条教训。

### 7.3 drift test #2 上线当天抓到我们自己引入的一个环

第 5 节没有任何一条能预见到这个。初版把 `EventSource` / `EventSink` 放在 `transport.ts`，
`run.ts` 从那里导入，`transport.ts` 又导入回 `RunHandle`——循环组 18 → 19。

修法是**分层**不是 `eslint-disable`：两个通道原语下沉到 `envelope.ts`（它本来就是叶子），
单向无环。已植入探针复现，确认测试会红。

**这条值得单独立一条决定（第 17 条）**：
**协议包的模块图必须是 DAG，且这条要在包还小的时候落地。**
grok 的 `sampling-types` 说明「文档声称的纯度」要靠工具查；
而工具要在第一天就在，否则等你搬完 122 条边再查，环已经缠进新位置了。

---

## 8. 数字的出处（不要在别处引用别处的数字）

| 数字 | 值 | 来源 | 备注 |
|---|---|---|---|
| 现有违规 | **941** | `npm run architecture:check` | 基线 `.architecture-baseline.json`，棘轮 |
| module-dependency | 562 | `--self-test` | 7.2 修完后 |
| package-boundary-escape | 161 | `--self-test` | 7.2 修完后；**比 05:327 记的 153 高，且是更准的数** |
| deep-import | 117 | `--self-test` | 与 05:327 一致 |
| cycle (SCC > 1) | 18 | `audit-modules.mjs` | 协议包贡献 0 |
| 协议包违规 | **0** | `architecture:check` | 含测试文件；刻意不留容忍项 |
| `@duya/ai` 的消费方 | 122 边 / 98 文件 | `audit-imports.mjs` | PP-2a 的规模：agent 80 / electron 20 / src 18 / computer-use 4 |

**05-architecture-governance.md §5 里的数字全部过期**，以本表为准。
文档里的数字漂移过一次（568 → 567、34 → 41），这次又漂了一次（567 → 562、153 → 161），
所以规则是：**数字只从命令输出，表格进本文件，不进散文。**
