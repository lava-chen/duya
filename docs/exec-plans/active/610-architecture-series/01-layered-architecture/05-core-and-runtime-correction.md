# 05 — Core 纯岛与职责纠偏

> Core = 纯 Agent 大脑:prompt/context、reasoning/planning、compaction。**零 IO。**
>
> **2026-10-04 修正**:原文写"core 装的四样全部属于 runtime""这不是没迁完,是迁反了"。
> **这个判断过强,已撤回。** 见 §1.1。

---

## 1. 当前状态

### 1.1 职责判断的纠正(2026-10-04)

`packages/agent-core` 只有 5 个文件:

```
capability-negotiation.ts
durability-policy.ts
run-budget.ts
run-outcome.ts
index.ts
```

原计划把这四个**全部迁出 core**,理由是"名字里有 `run`"。**这个理由不成立。**

实测 `run-budget.ts:120` 的 `isBudgetExhausted()` 是**输入数据、输出判断的纯函数** —— 它不读时钟、不停执行、不做 IO。正确的分层是:

```text
core:    根据 budget、spend、elapsed 判断是否耗尽     ← 纯计算,现在就是
runtime: 读取时间、累计使用量、停止 provider/工具、提交结果
```

**core 可以包含执行策略的纯计算;runtime 负责执行这些决策。** 是否迁移应看**职责和依赖**,不能仅凭名字里有 `run` 就判错层。

| 文件 | 正确归属 | 处置 |
| --- | --- | --- |
| `run-budget.ts` | **core 保留** | 纯判定,不迁 |
| `durability-policy.ts` | **core 保留** | 需先核实是否纯;若含 IO 则拆纯部分 |
| `run-outcome.ts` | **core 保留** | 终态结果的纯归约 |
| `capability-negotiation.ts` | runtime 边界 | 唯一与 transport 耦合的一个,单独裁决 |

**处置原则改为:先测纯度,再定归属。** 不按名字判层。

### 1.2 真正值得优先迁入 core 的(这才是重点)

下列都是**明确的纯计算**,且现在在 `packages/agent` 里:

| 内容 | 来源 | 目标 |
| --- | --- | --- |
| prompt 渲染(纯部分) | `prompts/modules/registry.ts`、`prompts/hbs/` | core |
| module 排序、section 优先级、截断 | `prompts/dynamic/` | core |
| context 选择算法 | `context/os-context/payload.ts` | core |
| 纯消息转换 | `message/` | core |
| compaction transforms | `compact/transforms/`(6 文件) | core |
| mode 声明与状态 reducer | `modes/index.ts`(`ModeModifier` 形状) | core |

**这些是 core 的定义本身,不是"顺带能放的"。** 而 §1.1 那四个是 core 已经做得对的东西。

---

## 2. 逐块处置

### 2.1 prompt 渲染(纯部分)

| 迁入 core | 留在 runtime/host |
| --- | --- |
| 模板**渲染**(HBS 纯函数调用) | `.hbs` 文件读取、asset 加载 |
| module 排序、section 优先级 | 目录扫描、watch、缓存 IO |
| section 截断与预算切分 | cache 失效策略 |
| `ModuleName` 类型与配置引用校验 | — |

来源:`packages/agent/src/prompts/`(7 个主文件 + 60 个子目录文件)
- `prompts/modules/registry.ts` — 已是好形状:`ModuleName` 类型化,改名是编译错误
- `prompts/hbs/` — 渲染逻辑
- `prompts/dynamic/` — 动态段拼装

**注意:** `assets/*.hbs` 被 `build-agent-bundle.mjs` 复制进 bundle。迁移后 loader 路径要同步改,门禁 G18。

### 2.2 context 选择与组装

| 迁入 core | 留在 runtime/host |
| --- | --- |
| 选择算法(哪些文件进 context) | 文件系统扫描 |
| 预算分配与截断 | watch 与失效 |
| `os-context` 的**纯** payload 计算 | 真实读环境变量 |

来源:`packages/agent/src/context/os-context/`(8 文件,66 KB)
- `context/os-context/payload.ts` 需拆分:纯计算 vs 读环境

### 2.3 compaction 转换

| 迁入 core | 留在 runtime |
| --- | --- |
| `compact/transforms/`(6 文件)纯变换 | `compactStrategies` 的模型调用 |
| 预算计算、保留策略 | `CompactionManager` 的 IO 与调度 |
| — | 真实模型压缩调用(必须 IO) |

来源:`packages/agent/src/compact/`(14 文件 + transforms 6 + strategies 2)

### 2.4 mode 声明与状态 reducer

| 迁入 core | 留在 runtime/CP |
| --- | --- |
| `ModeModifier` 的**声明**部分 | mode 的 tools/hooks 装配 |
| 状态 reducer(纯) | 生命周期与 continuation |
| profile/mode/permission 正交组合 | Goal/Research 的 durable owner(→ CP) |

来源:`packages/agent/src/modes/index.ts`(plan 224 的 `ModeModifier` 注册)

**正面例子:** `modes/` 的 `ModeModifier` + `applyModes` 已经是"声明式注入"而非"接管行为" —— 这是 [02 tooling](02-tooling-and-extensions.md) 要保留的形状。

### 2.5 纯消息转换与其他

| 迁入 core | 留 / 去向 |
| --- | --- |
| message JSON ↔ 内部对象纯转换 | storage/ingest → host |
| `mentions/` 纯格式化(1 文件) | 文件/connector 解析 → runtime |
| `decisions/` 策略 core(6 文件) | 跨 run durable → CP |
| `permissions/policy.ts` 纯策略 | environment/realpath → runtime |
| `security/` 纯归一化(1 文件) | 实际 path/network/token → host |
| `agent/turnShape.ts` 纯形状推导(**已在盘上**) | — |

---

## 3. 迁出 core 的内容(已缩小)

原计划把四个文件全部迁出。**修正后只剩一个需要裁决:**

| 文件 | 处置 |
| --- | --- |
| `run-budget.ts` | **留在 core** —— 纯判定 |
| `durability-policy.ts` | **留在 core** —— 需先测纯度,若含 IO 则只拆纯部分 |
| `run-outcome.ts` | **留在 core** —— 纯归约 |
| `capability-negotiation.ts` | **迁 runtime** —— 唯一与 transport 耦合的,单独裁决 |

**纪律不变:迁出前先确认 runtime 已有等价物或同 PR 一起迁。不留双份。**

---

## 4. 零 IO 的具体含义

**不是"core 没有 IO 函数",是 core 的输入只能是数据,输出只能是决策。**

- 需要异步端口的算法/loop → 放 runtime
- core 通过**输入**接收 clock / seed / 随机数,不自己 `Date.now()` / `Math.random()`
- `@duya/ai` 是混合包(既有 adapter 又有纯转换)→ 拆出口

**当前 carve-out 6 个文件(门禁 G2 会报):**
- `utils/backoff.ts:119`
- `utils/idle-timeout.ts:40`
- `system-one/client.ts:188`
- `system-one/client.ts:166` 与 `api/google-generative-ai.ts:398` 已证明注入 transport 可行

**每条 carve-out 的退役条件是注入 transport/signer/clock port,不是改文件位置。**

**不抄 codex-rs:** `codex-core` 的 `Cargo.toml` 依赖 `codex-mcp` / `codex-file-system` / `codex-login` / `codex-client`。本系列 Core 不允许这样。

---

## 5. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| **G2** | core 内无 fs/net/proc/db | 在 core 文件加 `readFileSync` |
| G18 | prompt asset 路径在迁移后仍解析 | 改 loader 路径使 bundle 找不到 `.hbs` |
| G19 | core 不含 `Date.now()` / `Math.random()` | 在 core 加一次直接调用 |
| G20 | `agent-core` 不再装 run-budget/durability | 把 `run-budget` 加回 core exports |
| G21 | `layer-purity` 的注释剥离不吞代码 | `const label="//"; return fetch(...)` |

**G21 的来历:** 现存 `layer-purity.ts:224` 自行正则去注释,字符串 `"//"` 会吞掉同一行后续代码。探针实测该例返回**无 IO finding** —— 证伪了"只有 false positive 没有 false negative"的说法。**必须复用已有 tokenizer/TS AST 与 value graph,不要造第二份 scanner 实现。**
