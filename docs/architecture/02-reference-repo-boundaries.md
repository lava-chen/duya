# 参考仓库边界分析：ZCode / codex / grok-build

> 阶段一交付物 2/5 · 生成日期 2026-10-01
> 分析对象均为本地只读 clone：
> - `E:\cloned-projects\ZCode` @ `872ad96`（"feat: open source"）
> - `E:\cloned-projects\codex` @ `2df6705423`
> - `E:\cloned-projects\grok-build` @ `75e73f3d`（`SOURCE_REV a61c32b1`）
>
> 已有 Duya 侧笔记：`docs/references/codex-deep-dive/`（17 章）、`docs/references/harness-comparison/`（16 篇）。
> 本文**不重复**那些文档的机制细节，只回答一个问题：**这些仓库的 boundary 是被什么逼出来的。**

---

## 0. 三个仓库的一句话对照

| 仓库 | 规模 | 边界的主要驱动力 | 最值得抄的一件事 |
|---|---|---|---|
| **ZCode** | ~30 包（两个 workspace） | 多 host（desktop / web / server / CLI）+ 遗留迁移 | `architecture-policy.yaml` + `managedOnly` 分级 |
| **codex** | ~135 crate（Rust）+ 2-file npm shim | 编译规模 + 远程执行 + TS/Rust 双语言同步 | **一条 CI 脚本强制单个依赖方向** |
| **grok-build** | 81 crate（同步子集） | 多 host（TUI / headless / ACP / WS / 远程沙箱） | **用 linter 强制进程边界**（禁裸 `Command::spawn`） |

> **共同的错误做法**：三者都有远超 Duya 需要的包数量。codex 的 135 crate 是对 1M 行 Rust workspace
> 编译成本的**反应**，不是原因（其 `AGENTS.md:69` 原文："resist adding code to codex-core!"）。
> Duya 不应照搬任何一方的包数。

---

## 1. ZCode — 唯一提供了完整治理机制的仓库

### 1.1 真实结构（纠正一个常见误解）

| 顶层 | 内容 |
|---|---|
| `packages/` | 15 包 —— **host 侧**图：Electron app、web client、server、RPC、UI、provider、services |
| `apps/zcode-cli/` | **agent 侧**图 —— 第二个独立 pnpm workspace，含 15 个嵌套包（core / contracts / adapters / bootstrap / TUI / CLI） |
| `harness/` | **不是** test harness。只有 3 个文件：一个 SSH-in-Docker 远程沙箱，用于人工远程工作区测试 |
| `architecture-policy.yaml` | **可执行的边界策略**（见 §1.4） |

**真正的 "harness" 在别处**：`apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts` ——
子进程 + `vm.createContext` + NDJSON 的沙箱宿主。其 `README.md` 把边界契约写死：

> "只依赖 `@zcode/dynamic-workflow` … 绝不 import `@zcode/core`/`@zcode/contracts`/`@zcode/bootstrap`/`@zcode/adapters`
> … 完整 sandbox（engine 永远 app-free 可跑）"

**为什么是两个 workspace**：agent 侧（CLI/SEA 打包、NodeNext、无 DOM）与 host 侧（Electron、web、React）、
依赖方向、构建工具链全不同。**这是 Duya 最值得直接借鉴的结构决策。**

### 1.2 core / runtime / protocol 的三分

ZCode 的三分是**可从 manifest 验证的**：

- `@zcode/core` → 依赖 `@zcode/contracts`
- `@zcode/adapters` → 依赖 `@zcode/contracts`（所有 IO：exec/fs/http/mcp/auth/browser/pdf/storage/image）
- `@zcode/dynamic-workflow-runtime` → **只**依赖 `dynamic-workflow`，被明令禁止依赖 core/contracts/bootstrap/adapters
- `@zcode/contracts` → **只**依赖 `@zcode/shared`，没有任何向上的边

core 内部再按关注点拆（不拆包）：`core/src/agent/turn-machine.ts`（纯状态机）vs
`core/src/runtime/{agent-runtime,command-queue,permission-*}.ts`（有副作用的执行器）。

**两套 protocol 层，对应两种耦合强度**：
- `packages/shared/src/zcode-protocol/` —— **跨进程**协议，`AGENTS.md:59` 明确要求"协议改动同步更新"
- `@zcode/contracts` —— **进程内**编译期契约

> **对 Duya 的意义**：Duya 现在只有"进程内"这一层（`packages/agent/src/types.ts` 50 行 re-export），
> 而 electron↔agent 的 142 条边实际上已经需要一个**跨进程**协议层了。

### 1.3 agent 以子进程方式被调用（设计选择）

`packages/services/src/zcode-agent/zcodeAgentProcessManager.ts` 用 `node:child_process` 的 `spawn`
+ `ZCodeProtocolClient` + `ZCodeStdioTransport`。`AGENTS.md:60`：

> "Main 负责窗口、原生操作、进程调度和消息转发，**不承载 task/session 业务状态**"

> Duya 已经是子进程架构（`AgentProcessPool` + `agent-process-entry.ts`），
> 但 `electron/agents/server` 仍然直接 import `packages/agent/src/message/index.ts` 等 142 条 ——
> **进程边界存在，语言边界没守住**。

### 1.4 治理机制（`architecture-policy.yaml`，本次调研最高价值）

**全局策略，逐字：**

```yaml
global:
  maxFileLines: 400
  maxContractLines: 300
  maxPublicMethods: 12
  forbidCycles: true
  forbidDeepImports: true
  managedOnly: true
exceptions: []
```

**模块声明形状（storage 模块，逐字）：**

```yaml
  - id: storage
    roots: [packages/services/src/storage]
    managed: true
    requires: [shared, rpc, services]
    publicEntrypoints: [packages/services/src/storage/contract.ts]
    layers: { domain: domain, app: app, adapters: adapters }
    layerOrder: [domain, app, adapters]
    owner: desktop-settings
```

**12 条规则**（`.agents/skills/architecture-governance/references/rule-catalog.md:5-16`）：

| 规则 | 含义 |
|---|---|
| `module-dependency` | 跨模块 import 不在 `requires` 中 |
| `deep-import` | 绕过模块 public entrypoint |
| `cycle` | 托管依赖图存在环 |
| `max-file-lines` / `max-contract-lines` / `max-public-methods` | 体量预算 |
| `layer-direction` | layer 依赖更高实现层 |
| `domain-io` | domain 代码 import process/network/fs/timer |
| `ui-implementation-import` | ui 层 import repo/runtime/service 实现 |
| `expired-exception` | 配置的例外已过期 |
| `missing-module-artifact` | 托管模块缺 manifest/contract |
| `disable-count` | 托管代码新增 lint 抑制 |

**执行引擎**：`scripts/architecture/architecture-check.mjs`（~1000 行），非 dependency-cruiser / madge / eslint-import。

三个关键机制值得直接抄：

1. **`managedOnly: true` + `managed: false` 分级。**
   ZCode 16 个声明模块里**只有 `storage` 是 `managed: true`**，其余 15 个显式 `managed: false`。
   策略文件自己的注释（`:3`）："存量模块先标记为 legacy；新模块或完成迁移的模块设置 managed: true"。
   `.architecture-baseline.json` 只有 43 字节：`{"version":1,"violations":[]}`。
   **这让遗留仓库可以渐进接入边界检查，而不需要大爆炸修复。**

2. **指纹式 baseline，不是计数式。** `sha256(rule\0file\0detail).slice(0,16)`；
   只有**不在 baseline 里**的指纹才 block。这避免了 baseline 腐化成永久静音。
   `--changed` 模式会沿反向边图展开变更集，抓下游破坏。

3. **要求每个模块有 `module.ts` + `contract.ts`**（`index.mjs:113-127` 强制），
   把"每个模块都有 manifest 和公共面"从文档约定变成机器可检。

### 1.5 ZCode 治理机制的**三个致命弱点**（必须避免）

1. **检查器只解析相对 import。** `policy.mjs:153` 对任何非 `.` 开头的 specifier 返回 `null`，
   `index.mjs:203` 直接 `continue`。而 `tsconfig.base.json` **没有 `paths` alias**，
   包之间靠 pnpm link + `exports` 解析。
   **结论：`module-dependency` 和 `deep-import` 规则从未检查过任何一条 `@zcode/*` 跨包 import。**
   而这正是 monorepo 里最关键的边。**这是"治理的假象"。**

2. **没有 CI。** 没有 `.github/`，没有任何 pipeline 配置。
   唯一接线是 `package.json:19` 的 `"verify:pre-push"`，即**本地 advisory**。
   husky 只存在于 `apps/zcode-cli/.husky/pre-commit`，跑的是 `lint && test`，**不跑架构检查**。

3. **实际覆盖率 1/16。** 叠加 `managedOnly: true`，全仓真正被守住的只有 `storage` 一个模块。

> **给 Duya 的直接教训**：如果照抄 ZCode 的 policy 文件而不修 resolver，
> 会得到一个"看起来有治理、实际什么都没查"的系统。**Duya 必须让检查器能解析 workspace 包名。**

### 1.6 另一个负面发现：测试几乎不存在

全仓 **4 个测试文件**（`packages/services/test/` 3 个 + `packages/ui/test/` 1 个）。
`packages/desktop` 一个都没有。任何"边界"在没有测试时只是一句注释。

---

## 2. codex — 单条边界的强制执行

### 2.1 app-server 协议缝（最关键的架构接缝）

**依赖方向：`app-server → core`，绝不反向。**
`app-server-protocol/Cargo.toml` 不含 `codex-core`；`app-server/Cargo.toml:39` 含。

**但这条缝并不干净 —— 这是本次调研最有价值的负面发现：**
`core/Cargo.toml:29` **确实**依赖 `codex-app-server-protocol`。
全仓只有 2 个文件真的用到它（`core/src/thread_manager.rs`、`core/src/thread_rollout_truncation.rs`）。

> **推论**：core 拥有一小片**刻意**的 wire type，而不是整个协议。方向只在这片上被反转。
> 一条只有 2 个泄漏文件的缝，就是一条正在承压的缝。

**协议形态**：JSON-RPC 2.0 形状但**故意不conformant** ——
`app-server-protocol/src/rpc.rs:1-2`："We do not do true JSON-RPC 2.0, as we neither send nor expect the `jsonrpc": "2.0"` field."
每个 request 带可选 `W3cTraceContext`（`rpc.rs:55`）—— **分布式 trace 从协议层就内建**。

**域模型**：Thread → Turn → Item，命名由策略强制（`AGENTS.md:272-273`：`*Params`/`*Response`/`*Notification`，
方法名 `<resource>/<method>` 单数）。

**传输**（`app-server/README.md:24-29`）：stdio JSONL（默认）、unix socket over HTTP-Upgrade、
plain websocket（实验性）、`off`。背压契约是 JSON-RPC error `-32001 "Server overloaded; retry later."`。

### 2.2 host 模型：TUI 是**平级协议客户端**

`tui/Cargo.toml` **不依赖 `codex-core`**。`tui/src/app_server_session.rs:479` 支持两种拓扑：
in-process（TUI 在自己进程内托管 app-server，默认）与 `AppServerClient::Remote`（本地 daemon 或远程 host）。
两条路径走**同一份代码**。UI 里零 agent 逻辑。

**而且是被强制的**（`.github/scripts/verify_tui_core_boundary.py:16-21`）：
若 `codex-tui` 在**任何** dependency section（含 `[target.*]`）声明 `codex-core`，
或任一 `tui/**/*.rs` 匹配 `codex_core::` / `use codex_core` / `extern crate codex_core` → CI 失败。
失败信息：

> "Use the app-server protocol/client boundary instead; temporary embedded startup gaps belong behind
> `codex_app_server_client::legacy_core`."

**逃生舱是一个具名模块，不是一堆 grep-ignore。** 这是极高明的设计。

> **对 Duya 的直接映射**：
> `verify_tui_core_boundary.py` 约 90 行 Python，断言一条边不存在。
> Duya 需要的对应物是：断言 `packages/agent-protocol` 不 import `packages/agent-core`、
> 断言 `src/` 不 import `electron/`。**一条边一个脚本，是本次调研 ROI 最高的治理产物。**

### 2.3 TS ↔ Rust 类型同步：两套独立机制

1. **Rust → TS**：`ts-rs` + `schemars`。`app-server-protocol/src/lib.rs:64-71` 在非 test 构建下把真实 derive
   换成 no-op 宏，test 下才启用 —— **构建图不为 codegen 付费，但测试总是重新生成**。
   产物落在 `schema/typescript/v2/*.ts`（~500 文件），头部是 `"// GENERATED CODE! DO NOT MODIFY BY HAND!"`。
   漂移由 `schema_fixtures_tests.rs:20` 的 `typescript_schema_fixtures_match_generated()` 抓。
2. **第三方 runtime dump**：`codex app-server generate-ts --out DIR` / `generate-json-schema`，
   README 强调每个输出**版本锁定**，消费者拿到的类型匹配自己的二进制。
3. **Python SDK** 通过 `datamodel-codegen` 消费 JSON schema，然后当**真正的 JSON-RPC 客户端**
   驱动 `codex app-server --listen stdio://`。
4. **TypeScript SDK 完全不用 protocol**：`sdk/typescript/src/exec.ts:92` spawn `codex exec --experimental-json` 解析 JSONL。
   README 原文："The TypeScript SDK **wraps the `codex` CLI**… It spawns the CLI and exchanges JSONL events."

> **负面教训**：两套 SDK 走两种传输 = 两套契约、两份文档、两条 CI 路径。
> **正面做法**："build 时不生成，test 时必生成" 的 derive 切换 —— Duya 可直接用
> `tsc --emitDeclarationOnly` + CI diff 实现等价物。

### 2.4 治理：codex 的强项

| 机制 | 内容 |
|---|---|
| Workspace clippy | `codex-rs/Cargo.toml:506-542`，~40 条 `deny`（`unwrap_used` / `expect_used` / `await_holding_lock`…） |
| Manifest 策略 | `verify_cargo_workspace_manifests.py`：每 crate 必须 `version.workspace = true`、包名匹配目录名、**禁 `[features]` 表**、禁 `optional = true`、禁内部依赖的 `features = [...]`。理由是 Bazel 不支持，会藏问题 |
| 依赖方向 | `verify_tui_core_boundary.py`（见上）—— **唯一**的跨 crate 方向检查 |
| Bazel/Cargo lint 对齐 | `verify_bazel_clippy_lints.py` diff `.bazelrc` 的 `clippy_flag=` 与 `[workspace.lints.clippy]` |
| 供应链 | `cargo-deny` + `codex-rs/deny.toml`（advisories/licenses/bans/sources） |
| 体量 | `check_blob_size.py --max-bytes 512000` + allowlist |
| 所有权 | `.github/CODEOWNERS` 把 `core/`、`exec-server*`、`arg0`、`prompts`、`extension-api` 钉给 `@openai/codex-core-agent-team` |
| 成文策略 | `AGENTS.md:69` "resist adding code to codex-core!"；模块目标 <500 LoC，硬上限 ~800 |

**例外列表会失效即报错**（manifest verifier 中一段 38 行逻辑）—— 防止策略腐化。

### 2.5 测试/eval 现状

**没有产品无关的 "harness" 概念**，只有三个编译进 workspace 的 test-support 成员：
`core_test_support`（143 个测试文件、mock Responses server）、`app_test_support`（强制 app-server 测试走公共 JSON-RPC API）、
`mcp_test_support`（真实子进程 MCP harness）。另有 `app-server-test-client`（人/CLI 驱动的 smoke harness）。

**codex 没有 evaluator、没有打分、没有跨 run 比较。** 它的 "eval" 是 snapshot 相等 + 脚本化 smoke。
> 若 Duya 想度量 agent 质量，那是**全新工作**，不是可以照抄的东西。

---

## 3. grok-build — 用 linter 强制进程边界

### 3.1 前提：这是同步子集，不是构建根

`README.md:39`："It is synced periodically from the SpaceXAI monorepo."
无 `.github/`、无 `deny.toml`、无 `CODEOWNERS`，`prod/` 只剩 1 个 crate。CI 策略在 monorepo（Bazel），只能引用不能验证。

### 3.2 分层：纯叶子契约 → 中间件 → 恰好 3 个 composition root

验证过的 fan-in 排名：`xai-grok-shell` 40 · `xai-grok-pager` 27 · `xai-grok-workspace` 27 ·
`xai-grok-tools` 16 · `xai-grok-mcp` 10。

**四个独立契约面**：

| 契约 crate | 内容 | 内部依赖 |
|---|---|---|
| `xai-tool-types` | 工具描述类型 | **none** |
| `xai-tool-protocol` | JSON-RPC 2.0 envelope + 封闭 `Method` 目录 | `xai-tool-types` |
| `xai-grok-workspace-types` | `workspace.*` RPC 纯数据类型 | **none** |
| `xai-grok-sampling-types` | 模型侧对话协议 | ⚠️ `xai-grok-tools` + `reqwest` |

**最重要的负面发现**：`xai-grok-sampling-types/src/lib.rs:5-7` 声称
"It intentionally contains **no I/O** (no HTTP clients, no file system access)."
但其 `Cargo.toml` 的 `[dependencies]` 含 `reqwest`、`async-openai`、以及 `xai-grok-tools`。
后果：`xai-chat-state` → `sampling-types` → `xai-grok-tools` → 16 个内部 crate。
**名义上的契约 crate 不是叶子。**

对照 `xai-grok-workspace-types` 是真叶子，且 lib.rs 里的声明与 manifest 一致。

> **对 Duya 的直接教训**：如果 Duya 建 `packages/agent-protocol`，
> **必须有一个测试遍历它的 import 图，任何指向实现包的边都 fail**。docstring 不是强制力。
> Duya 的 `message/`（3,433 LOC，零外部信号）正是可以做成真叶子的候选；
> 而 `types.ts`（50 行，做了大量 re-export 并被 electron 依赖 17 次）绝不能直接升格为 protocol。

### 3.3 单一 `define_methods!` 生成封闭方法目录

`xai-tool-protocol/src/methods.rs:10-53` 的宏从一个源生成 `Method` enum、serde rename、
双向转换、`Method::ALL`，然后**测试全量 round-trip**。37 个方法，扁平，按方向分组。
设计注记（`:17-21`）："direction enforcement is the computer hub's job, not the protocol crate's."

> 直接可映射到 Duya 的 IPC surface：renderer / preload / main 三处共用一个方法名常量表，
> 断言三者集合相等。

### 3.4 可重试性是**线上码**，不是错误类型

`xai-grok-workspace-types/src/rpc/envelope.rs:1-6` 固定线格式
`{"ok": <value>}` / `{"err": {"code","message"}}`。
可重试性是 wire const：`pub const TURN_ACTIVE: &str = "turn_active"` + `is_turn_active()`，
理由是"clients can recognise the retryable class **without depending on the workspace crate's error enum**"。
向后兼容显式：`is_unknown_method()` 同时匹配新 code 和 legacy `HUB_ERROR` + `"unknown workspace method:"` 前缀。

> 直接适用于 Duya 的 `db:*` / `gateway:*` / `agentControl` IPC surface。

### 3.5 五种 host 驱动同一个 runtime

1. **TUI** — `pager-bin` → `pager` + `shell`
2. **Headless** — `grok -p "…"`；`shell/src/agent/relay.rs` 拨 WebSocket relay，15s keepalive，
   显式 read-side liveness deadline（记录了"half-open TCP 让 session 变砖直到进程被杀"的真实故障）
3. **ACP stdio** — `grok agent stdio`，基于外部 `agent-client-protocol` crate
4. **远程 WebSocket** — `shell/src/agent/server.rs:470-474`：`/ws` 路由、共享密钥、
   "A single agent instance is shared across all connections (persisted across reconnections)
   so that in-flight session work survives client disconnects."
5. **远程沙箱 guest（反向连接）** — `workspace/src/bin/workspace_server.rs` **主动外拨**
   `wss://computer-hub.grok.com/v1/tools`，注册为 tool server。

另有 `shell/src/leader/` 的**本地单例 daemon**（lock/protocol/transport/server/client/in_process）。

> **对 Duya 的意义**：Duya 计划中的四个 consumer（Desktop / CLI / Harness / Bot-Cloud）
> 恰好对应 1/2/3/5。**第 4 种（远程 WS + 跨重连保持 session）正是 Duya 多 host 场景最需要、
> 而当前架构最不具备的能力** —— 见设计文档 §Harness。

### 3.6 治理：只有一条是真政策

`[workspace.lints.clippy]` 是 **10 条全 `allow` 的抑制表**（还带一个解释"缺少 merge queue"的 TODO）。
**唯一真正的架构政策是 `clippy.toml` 的 `disallowed-methods`**：

- 禁 `std::fs::canonicalize` / `Path::canonicalize` / `tokio::fs::canonicalize`（Windows `\\?\` verbatim 路径问题）
- 禁 `std::process::Command::spawn` / `tokio::process::Command::spawn` / `portable_pty::SlavePty::spawn_command`，
  理由："an unenrolled child outlives its session; use `xai_tty_utils::ProcessScope::enroll`"

> **这是本次调研对 Duya 最高价值的单条建议。**
> Duya 的 spawn 点分散在 `electron/services`(16)、`electron/agents`(13)、`packages/agent/tool`(10)、
> `electron/ipc`(6)、`packages/agent/cli-control-plane`(6)、`electron/plugins`(4) 等至少 6 处，
> 没有任何统一登记。grok 的做法把"不留孤儿进程"从 review 习惯变成**构建错误**。
>
> Duya 已经有真实的进程泄漏类 bug 记录（`AGENTS.md` footgun：Windows 上运行中的 Electron 锁住 `.node` 文件，
> 导致 `npm test` 与 `electron:dev` 不能同时跑）—— 同一 bug 类。

### 3.7 其他可直接抄的细节

- **配置优先级 fail-closed**：`sandbox/src/profiles.rs:113-118` —— 项目内 `.grok/sandbox.toml`
  **只能新增** profile 名，不能重定义全局 profile，理由是
  "last-write-wins would let a malicious workspace hollow out a user/enterprise custom profile
  while keeping the trusted name."
  → 直接适用于 Duya 的 AGENTS.md / settings 信任模型。
- **能力探测优于版本协商**：`workspace_server --capabilities` 打印 JSON 清单并 exit 0，
  老二进制对未知 flag 大声失败。比跨独立部署 host 的 semver 协商更便宜更稳。
- **mock 推理在 wire 层，不在接口层**：`xai-grok-test-support` 的 `MockInferenceServer` 在 `127.0.0.1:0`
  上服务 8 个 endpoint，三种 **byte-exact** SSE wire 格式生成器，按请求指纹确定性重放。
- **要求 harness README 与 `src/` 同 PR 修改**（README 明写，reviewer 把只有 src diff 的 PR 视为不完整）。
- **让抽出的 crate 说真实理由**：`xai-grok-shell-base` 注释直说它存在是为了"并行编译、shell 编辑时不重编"——
  一个诚实的**构建成本**边界，优于假装是架构边界。

---

## 4. 横向结论：boundary 是怎么形成的

把三个仓库放一起看，boundary 只有四种真实成因：

| 成因 | ZCode 证据 | codex 证据 | grok 证据 |
|---|---|---|---|
| **多 host 共享同一 runtime** | 两个 workspace；agent 走 stdio 子进程 | TUI/CLI/daemon/remote 都是 app-server 客户端 | 5 种 host 驱动同一 shell |
| **可测试性倒逼纯度** | `dynamic-workflow` 纯编译器 / `-runtime` 沙箱 / `bootstrap` 生产驱动 | `core_test_support` / `app_test_support` 是独立 workspace 成员 | `TestSandbox` 隔离 HOME/TMPDIR |
| **构建/工具链不兼容** | 两 workspace 依赖方向与打包方式全不同 | Cargo 为真值 + Bazel hermetic（实验性） | `shell-base` 纯为并行编译而拆 |
| **策略强制** | `architecture-policy.yaml` 12 规则（但 resolver 有洞） | `verify_tui_core_boundary.py` 一条边 | `clippy.toml` 禁裸 spawn |

**"目录整齐"从未成为任何一方的成因。** ZCode 的 `packages/services` 有 46 个扁平目录，
结果 16 个声明模块塌缩进去，反而需要为 `storage` 单独挖出来 —— 这是"为了整齐而整齐"的反面教材。

### 4.1 三个仓库的共同失败模式（Duya 应主动避免）

1. **策略文件存在但 resolver 看不到真实的边**（ZCode：只解析相对 import，跨包 import 全部漏检）
2. **策略不在 CI 里跑**（ZCode：无 `.github/`；husky 不含架构检查）
3. **名义上的契约 crate 不是叶子**（grok：`sampling-types` 声称无 I/O 却依赖 `reqwest` + tools）
4. **一条缝只有 2 个泄漏文件就不管了**（codex：`core → app-server-protocol`）
5. **两套消费契约**（codex：TS SDK 走 CLI/JSONL，Python SDK 走真 JSON-RPC）
6. **边界没有测试 = 注释**（ZCode：30 个包 4 个测试文件）

### 4.2 Duya 应当直接采纳的 6 条

1. **agent 侧与 host 侧分离**（ZCode 两 workspace 的核心价值）
2. **一条边一个 CI 脚本 + 具名逃生舱**（codex `verify_tui_core_boundary.py` + `legacy_core`）
3. **用 linter 强制进程边界**（grok `clippy.toml` 禁裸 `Command::spawn`）
4. **`managedOnly` 分级 + 指纹 baseline**（ZCode，让遗留仓库渐进接入）
5. **真叶子契约 + 一个测试证明它是叶子**（grok 的正面对照 + 负面教材）
6. **可重试性建模为 wire code；单一生成的方法目录 + round-trip 测试**（grok）

---

## 5. 明确不建议采纳

| 不采纳 | 原因 |
|---|---|
| 照搬包数量（30 / 135 / 81） | 三者的规模驱动力（1M 行 Rust、SpaceXAI monorepo、多团队）Duya 都没有 |
| 第二套构建系统（Bazel） | codex 自己标注 "still experimental"，且因此需要三套 lint 对齐机制 |
| 全面 opt-in 的 feature flag 策略 | Duya 用 esbuild 而非 Cargo，feature flag 在 bundler 层不可靠 |
| `[workspace.lints]` 式抑制表 | grok 的 10 条全 `allow` 是抑制而非政策 |
| 按团队名分目录（grok `codegen/` vs `common/`） | 组织拓扑不是架构层 |
| 把 `integration tests` 当 harness | codex 没有 eval/打分/跨 run 比较；Duya 要做度量是全新工作 |
