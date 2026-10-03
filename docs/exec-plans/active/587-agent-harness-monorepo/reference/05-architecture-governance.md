> Historical / superseded for execution. 原位置：`docs/architecture/05-architecture-governance.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# 架构治理设计（architecture-policy.yaml + 执行机制）

> 阶段一交付物 5/5（治理部分） · 生成日期 2026-10-01
> 参考：`02-reference-repo-boundaries.md` §1.4（ZCode policy）、§2.4（codex 脚本）、§3.6（grok clippy）
> **本设计明确修正 ZCode 机制的两个致命弱点**：resolver 看不到跨包 import、策略不在 CI。

---

## 1. 从 ZCode 继承的与必须丢弃的

| ZCode 机制 | 裁决 | 理由 |
|---|---|---|
| `architecture-policy.yaml` 声明式策略文件 | ✅ **继承** | 67 行编码 7 个全局预算 + 12 规则，性价比极高 |
| `managedOnly: true` + `managed: false` 分级 | ✅ **继承（最高价值）** | 让遗留仓库渐进接入，无需大爆炸修复 |
| 指纹式 baseline（`sha256(rule\0file\0detail)`） | ✅ **继承** | 避免 baseline 腐化成永久静音 |
| 例外带 `expires` + `expired-exception` 规则 | ✅ **继承** | 防止策略腐化 |
| 要求每模块有 `module.ts` + `contract.ts` | ⚠️ **改造后继承** | Duya 用 `package.json` 的 `exports` 字段替代 `contract.ts`，减少一个文件 |
| `architecture:context <module>` 上下文裁剪 | ✅ **继承** | 直接对应准则 7，约 35 行实现成本 |
| **只解析相对 import 的 resolver** | ❌ **必须修正** | **ZCode 因此从未检查过任何 `@zcode/*` 跨包 import —— 治理的假象** |
| **无 CI，仅 pre-push** | ❌ **必须修正** | 唯一接线是 `package.json:19` 的 `verify:pre-push`，husky 不含架构检查 |
| `managed: true` 覆盖率 1/16 | ❌ **必须修正** | 叠加 `managedOnly` 后全仓实际只守住了 `storage` 一个模块 |

---

## 2. 策略文件设计

`architecture-policy.yaml`（仓库根）：

```yaml
version: 1

# ── 全局预算 ──────────────────────────────────────────
global:
  maxFileLines: 500          # 对齐 AGENTS.md 的 800/500 惯例
  maxContractLines: 300
  maxPublicMethods: 14
  forbidCycles: true
  forbidDeepImports: true
  managedOnly: true
  baselineFile: .architecture-baseline.json

# ── 分层：依赖只能向下 ─────────────────────────────────
layers:
  - protocol      # agent-protocol, shared
  - core          # agent-core, agent-tools, ai
  - runtime       # agent-runtime
  - host          # desktop, cli, gateway
  # harness 不在 workspace 内，单独校验

# ── 显式禁止的边（无论 requires 怎么写） ──────────────
forbiddenDependencies:
  # ★ 目标态的四条硬规则
  - from: "packages/agent-protocol/**"
    to:   ["packages/agent-core/**", "packages/agent-runtime/**", "electron/**", "src/**"]
    reason: "protocol 必须是零实现依赖的真叶子（grok sampling-types 教训）"

  - from: "packages/agent-core/**"
    to:   ["electron/**", "apps/desktop/**", "src/**", "packages/computer-use/**"]
    reason: "agent-core 不得依赖任何 host（实测 V1：16 条违规）"

  - from: "src/**", "apps/desktop/src/renderer/**"
    to:   ["electron/**", "apps/desktop/src/main/**"]
    reason: "renderer 不得依赖 main 实现（实测 V2：9 条违规）"

  - from: "packages/**"
    to:   ["electron/**", "src/**", "apps/desktop/**"]
    reason: "workspace 包不得反向依赖 host（实测 V4：57 条违规，需先解耦）"

  - from: "packages/agent-*/**"
    to:   ["packages/ui/**", "packages/conductor/**"]
    reason: "agent 不得依赖 UI（实测：agent→conductor 2 条，抽离后归零）"

# ── 需要显式许可的外部依赖（能力型） ──────────────────
allowedDependencies:
  - from: "packages/agent-runtime/**"
    to: ["packages/plugin-core/**", "packages/computer-use/**", "packages/ai/**"]
  - from: "packages/agent-runtime/**"
    to: ["packages/gateway/**"]     # 未来 Bot host

# ── 模块声明 ─────────────────────────────────────────
modules:
  - id: agent-protocol
    roots: [packages/agent-protocol]
    managed: true
    requires: []
    publicEntrypoints: [packages/agent-protocol/src/index.ts]
    owner: agent-harness

  - id: agent-core
    roots: [packages/agent-core]
    managed: true
    requires: [agent-protocol, ai]
    publicEntrypoints: [packages/agent-core/src/index.ts]
    owner: agent

  - id: agent-runtime
    roots: [packages/agent-runtime]
    managed: true
    requires: [agent-protocol, agent-core, agent-tools, ai, plugin-core]
    publicEntrypoints: [packages/agent-runtime/src/index.ts]
    owner: agent

  - id: plugin-core
    roots: [packages/plugin-core]
    managed: true                 # ★ 迁移完成即转 true
    requires: []
    publicEntrypoints: [packages/plugin-core/src/index.ts]
    owner: extensibility

  # ── 遗留：先 managed: false，完成迁移后逐个转 true ──
  - id: legacy-agent
    roots: [packages/agent]
    managed: false
    requires: []
    owner: agent
    migrateTo: agent-core        # 迁移指引

  - id: legacy-desktop
    roots: [src, electron]
    managed: false
    requires: []
    owner: desktop
    migrateTo: apps/desktop
```

---

## 3. 规则目录（12 条，对齐 ZCode + Duya 增补）

| 规则 | 含义 | Duya 实测违规数 |
|---|---|---|
| `module-dependency` | 跨模块 import 不在 `requires` 中 | 568 |
| `deep-import` | 绕过模块 public entrypoint | **117** |
| `cycle` | 托管依赖图存在环 | 0（✅ 已满足） |
| `package-boundary-escape` | ★ 相对路径进入 `packages/` | **161**（`src/` 0 · `electron/` 161） |
| `max-file-lines` | 超过 500 行 | 待测 |
| `max-contract-lines` | contract 超过 300 行 | 待测 |
| `max-public-methods` | 公开方法超过 14 | 待测 |
| `layer-direction` | 依赖更高层 | 待测 |
| `domain-io` | domain 代码 import `node:`/`fs`/`fetch(`/`setTimeout(` | 待测 |
| **`ui-implementation-import`** | ui 层 import 实现 | 23（`src→conductor`） |
| `expired-exception` | 例外已过期 | — |
| `missing-module-artifact` | 托管模块缺 `exports` 字段 | **1**（`plugin-core`） |
| **`disallowed-process-spawn`** | ★ Duya 增补：在 `ProcessScope` 之外 spawn 子进程 | **~50+** |

### 3.1 增补规则 `disallowed-process-spawn`

这是本次调研中对 Duya 价值最高的单条建议（来自 grok-build `clippy.toml`）。

**实测依据**：spawn 点分散在至少 6 个 owner：

| Owner | spawn 触达文件数 |
|---|---|
| `electron/services` | 16 |
| `electron/agents` | 13 |
| `packages/agent/tool` | 10 |
| `electron/ipc` | 6 |
| `packages/agent/cli-control-plane` | 6 |
| `electron/plugins` | 4 |
| 其余（hooks / utils / modes / sandbox / gateway / computer-use / voice …） | 各 1–3 |

**Duya 已有真实 bug 佐证**（`AGENTS.md` Footguns）：
> "a running Electron locks the `.node` file on Windows" —— `npm test` 与 `electron:dev` 不能同时运行。

grok-build 的原文理由：
> "an unenrolled child outlives its session; use `xai_tty_utils::ProcessScope::enroll`"

**规则形式**：

```typescript
// 允许：packages/process-scope
ProcessScope.spawn({ name, command, args, signal })
// 禁止：任何其他位置的 child_process.spawn / fork / exec / execa
```

分阶段：先 `warn` 记录所有 spawn 点 → 建 `ProcessScope` → 逐个迁移 → 转 `error`。

---

## 4. 执行引擎设计（修正 ZCode 的致命弱点）

`scripts/architecture/architecture-check.mjs`

### 4.1 Resolver 必须能解析 workspace 包名 ★

ZCode 的 `policy.mjs:153` 对任何非 `.` specifier 返回 `null`，
导致 `module-dependency` / `deep-import` **从未检查过任何跨包 import**。Duya 必须避免。

```javascript
// 解析顺序（全部支持，缺一不可）
function resolveSpecifier(spec, fromFile) {
  // 1. 相对路径
  if (spec.startsWith('.')) return resolveRelative(spec, fromFile);
  // 2. tsconfig paths（含 root 与各 package 的 tsconfig）
  if (matchesTsconfigPath(spec)) return resolveTsPath(spec);
  // 3. workspace 包名 ★ ZCode 缺这一步
  if (spec.startsWith('@duya/')) return resolveWorkspacePackage(spec);
  // 4. 外部依赖 → 记为 external，不检查
  return null;
}
```

**自检要求**：引擎上线第一天必须跑一个 `--self-test`，
断言它能看见 §5 列出的**全部**已知违规条数。对不上就是 resolver 有洞。

### 4.2 相对路径穿透检测 ★

**实测基线：全仓 161 条相对路径穿透，100% 来自 `electron/`，`src/` 为 0 条。**

```javascript
// 任何从 workspace 外部（src/ electron/ apps/ tests/ e2e/）出发、
// 用相对路径进入 packages/ 的 import → 违规。
// 实测分布：electron→agent 125 · →plugin-core 16 · →gateway 13 · →conductor 7
const escapesPackageBoundary = (from, to, spec) =>
  spec.startsWith('.') && to.startsWith('packages/') && !from.startsWith('packages/');
```

**为什么这条规则优先级最高**：`package.json` 的 `exports` 字段只对裸标识符生效，
对相对路径完全无效。Duya 的 161 条穿透全部绕过了 `exports`，
因此**只收紧 `exports` 一点用都没有** —— 必须先把相对路径改成 `@duya/*` 裸标识符。

> **修正记录**：初版本节称 renderer 侧存在 8 条穿透（4 条 `src→agent` + 4 条 `src→electron/preload`）。
> 实测 `src → packages/` 的相对路径穿透为 **0**；那 4 条 `src→agent` 是裸标识符
> （3× `@duya/agent` + 1× `@duya/agent/message`），经 `exports` 正常解析，
> **不是 deep import，也不是穿透**。详见 `01-current-state-audit.md` §9。
> 修正后本节数字从 8 → 161，且归属方从 renderer 改为 main。

### 4.3 指纹式 baseline

```javascript
const fingerprint = (rule, file, detail) =>
  createHash('sha256')
    .update(`${rule}\0${file}\0${detail}`)
    .digest('hex')
    .slice(0, 16);
```

只有**不在** baseline 中的指纹才 block。配套：
- `exceptions[].expires` 过期即 `expired-exception`
- 例外列表若有条目不再被触发 → 报错（codex 的 fail-if-unused-exception，防止策略腐化）
- `--changed` 沿反向边图展开，抓下游破坏

### 4.4 CI 接线 ★

```json
// package.json
{
  "scripts": {
    "architecture:check": "node scripts/architecture/architecture-check.mjs",
    "architecture:self-test": "node scripts/architecture/architecture-check.mjs --self-test",
    "architecture:context": "node scripts/architecture/architecture-context.mjs",
    "verify": "npm run architecture:check && npm run typecheck:all"
  }
}
```

CI 必须是**阻塞式 required check**，不能是 advisory：

```yaml
# .github/workflows/ci.yml
- name: Architecture boundaries
  run: npm run architecture:check
# 失败即阻塞合并
```

> ZCode 把 gate 写在 `AGENTS.md` 里但没有 pipeline —— 那是"看起来有治理"。
> Duya 的第一步必须是让这个 check 真的在 CI 上跑并阻塞。

### 4.5 上下文裁剪命令

```bash
npm run architecture:context -- agent-runtime
```

输出（对齐 ZCode `generateContext()`）：

```
module: agent-runtime
owner:  agent
requires: agent-protocol, agent-core, agent-tools, ai, plugin-core
files: 148
contracts:
  - packages/agent-protocol/src/index.ts
  - packages/agent-runtime/src/index.ts
dependency contracts:
  - packages/agent-protocol  (message, permissions, ipc, events, run)
  - packages/agent-core      (DuyaAgent, modes, compaction)
  - packages/plugin-core     (mcp, plugins)
boundaries:
  ⚠ agent-runtime MUST NOT import electron/ or src/
  ⚠ agent-runtime spawns only via ProcessScope
```

**这是准则 7 的直接实现**：让 AI/人类在改动 `agent-runtime` 时不必加载 148 个文件。

---

## 5. 初始 baseline 的预期内容

`architecture-check.mjs --self-test` 应至少能数出这些已知违规（来自交付物 1 的实测，
由 `node scripts/architecture/audit-imports.mjs` 与 `audit-modules.mjs` 复现）：

| 规则 | 预期计数 | 来源 |
|---|---|---|
| `module-dependency` | **568** | 全部跨 owner 内部 import |
| `package-boundary-escape` | **161** | 相对路径进入 `packages/`（`src/` 0 · `electron/` 161） |
| `cycle` | **18** | SCC>1 分量，最大 42 文件 ⚠️ 见 §3.2 |
| `deep-import` | **117** | 按目标包 `exports` 字段判定 |
| `disallowed-process-spawn` | 50+ | 6 个 owner 的 spawn 点 |
| `ui-implementation-import` | 23 | `src → conductor` |
| `missing-module-artifact` | 1 | `@duya/plugin-core` 缺 `exports` |

**不变量**（M0 self-test 必须与之一致，否则 resolver 有洞）：

```
── audit-imports.mjs ──
files scanned        3047
file edges           13700
internal edges       7978
cross-boundary edges 568
deep imports         117
package escapes      161
unresolved           34

── audit-modules.mjs ──
packages/ files           1597
cyclic groups (SCC > 1)   18
agent/src top-level mods  36
agent/src files (no tests) 669
agent/src LOC (no tests)  156994
```

**策略：`managedOnly: true` 起步。** 所有 legacy 模块先 `managed: false`，
baseline 记录全部现有违规。只有 `agent-protocol` 一个新模块从第一天起 `managed: true`。
迁移每完成一个模块，就把它转 `managed: true` 并从 baseline 移除对应指纹。

> 这就是 ZCode 最有价值的一条经验：**渐进式边界治理**。

---

## 6. 分阶段强制强度

| 阶段 | 模式 | 效果 |
|---|---|---|
| P0 | `managedOnly: true`，baseline 含全部现有违规 | 只拦**新增**违规。零阻塞 |
| P1 | `agent-protocol` 转 `managed: true` | 第一个真正被守住的模块 |
| P2 | `plugin-core` 补 build+exports 后转 `managed: true` | 收敛 49 条 deep import |
| P3 | 豁免到期（`expires`）逐批失效 | 分批清理 baseline |
| P4 | 全部模块 `managed: true`，baseline 清空 | 完全强制 |

**例外必须带 `expires`**，且同一模块的例外总数上限（如 20 条）—— 超过说明该做迁移而非加例外。

---

## 7. 一句话总结

**照抄 ZCode 的 policy 文件形状，但必须重写它的 resolver，并且第一天就接进 CI。**
否则会得到一个统计出 0 违规、实际有 568 条跨边界违规的治理系统 —— 那比没有治理更危险。
