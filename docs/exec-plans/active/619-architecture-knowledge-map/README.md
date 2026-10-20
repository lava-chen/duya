# 619 — Architecture Knowledge Map

> 目标：让**下一个来排障的 agent 或工程师**，在 30 秒内知道「这个症状该打开哪个包的哪个文件」，
> 并且知道 26 个 workspace 之间是怎么互相影响的。

Status: active
Baseline: `origin/master @ 492c08f8` (worktree `E:/Projects/duya/.claude/worktrees/arch-map`, branch `docs/arch-map-20261020`)

---

## 1. 为什么要做（实测证据，不是推测）

duya 的架构在 plan 587 / 610 的推进下已经大改：渲染器搬进了 `packages/ui`，
执行所有权从 `@duya/agent` 迁到了 `@duya/host` + `@duya/agent-runtime`，桌面主进程
搬到了 `apps/desktop`。但**人类面向的文档没有跟上**，实测失配如下。

### 1.1 机器门禁当前是红的

`tests/rules-compliance.test.mjs` 测试 2 要求 `packages/*` 每个子包都必须有
`AGENTS.md` / `CLAUDE.md` / `.cursorrules` / `.clinerules` 之一。

实测（在 `origin/master @ 492c08f8` 的干净 worktree 上跑）：

```
✗ packages/* 各子包至少有一个规则文件(子包级约束)
以下子包缺少 Claude/Cursor/Cline 类规则文件: agent, agent-core, agent-protocol,
agent-runtime, ai, capabilities, cli, client-core, command-catalog, computer-use,
conductor, connectors, data, gateway, host, input-completion, memory, plugin-core,
sandbox, tooling, ui, voice
```

**22 个包，一个不缺，全红。** 这个计划的首要交付物就是把它变绿——不是做好心加文件，
是补上一个**已经被 CI 强制要求**的知识层。

### 1.2 文档指向已不存在的路径

实测：`git ls-files src` 与 `git ls-files electron` 均为 **0 个文件**，
两个顶层目录在磁盘上也不存在。但：

| 文档位置 | 声称的内容 | 实测真相 |
| --- | --- | --- |
| `README.md:204-213` | 仓库结构含 `src/`、`electron/`、`packages/agent/` | 三个顶层路径**均已不存在** |
| `ARCHITECTURE.md:1783` | 渲染器在 `apps/desktop/src/renderer/` | 渲染器主体已迁到 `packages/ui/src`（有 components/stores/hooks/i18n/styles） |
| `ARCHITECTURE.md:1755-1772` | 包清单 13 个 | 实际 **22 个包 + 2 个 app**；缺 `client-core`/`data`/`host`/`ui`/`memory`/`sandbox`/`tooling`/`input-completion`/`command-catalog` 与 `apps/web` |
| `ARCHITECTURE.md:98-101` | worker 入口 `agent-process-entry.js` | 磁盘上只有 `packages/host/bundle/worker-entry.js`（5.5 MB），**没有** `agent-process-entry.js` |

### 1.3 文档自相矛盾

`ARCHITECTURE.md` 的 **System Architecture 图**（第 80–112 行）仍画着
「Process layer 2 — Agent Server (HTTP + SSE)」与 `entry: agent-process-entry.js`，
而同文件 **Overview**（第 20–24 行）自己写着新入口是
`packages/host/bundle/worker-entry.js`，打包位置 `resources/harness-bundle/worker-entry.js`。
同一份文档，两个互斥的运行时事实。

### 1.4 章节重复

`ARCHITECTURE.md` 的 `## Package Workspace` **出现两次**：第 1692 行与第 1753 行。
前者讲 Canvas Workbench Runtime，后者才是包清单。

---

## 2. 目标（可验收的陈述）

完成这个计划后，一个**没读过本仓库的新 agent** 应该能做到：

1. 拿到一个症状（「工具调用卡住」「权限弹窗不出现」「run 起不来」「渲染器白屏」
   「模型选错了」），在**一张表**里查到该打开哪个包的哪个文件。
2. 说清楚 26 个 workspace 的**分层依赖方向**，以及哪条边是被 CI 强制的、哪条是历史债。
3. 知道**每个包的边界**：它负责什么、明确不负责什么、它向谁暴露端口。
4. 知道运行时工件在哪（worker bundle 入口、DB 路径、IPC census、arch gate 命令）。

---

## 3. 交付物

| # | 文件 | 类型 | 负责 |
| --- | --- | --- | --- |
| D1 | `ARCHITECTURE_MAP.md` | 新增：排障导航主文档 | 协调者 |
| D2 | `packages/*/AGENTS.md` × 22 | 新增：包级知识索引 | worker × 3（按包簇切分） |
| D3 | `ARCHITECTURE.md` | 修改：修进程图 / 修包清单 / 删重复章节 / 加导航入口 | 协调者 |
| D4 | `README.md` + `README_CN.md` | 修改：修 Repository structure 死路径 | 协调者 |
| D5 | `AGENTS.md`（根） | 修改：加「Debug this first」导航段 | 协调者 |
| D6 | `CLAUDE.md`（根） | 修改：降级为指向 `AGENTS.md` 的薄壳 | 协调者 |
| D7 | `docs/exec-plans/README.md` | 修改：索引加本计划一行 | 协调者 |
| D8 | `tests/rules-compliance.test.mjs` | 修改：修 Windows 分隔符 bug | 协调者 |
| D9 | `apps/{desktop,web}/AGENTS.md` | 新增：两个 app 的包级指南 | worker × 1 |

**并发写者必须文件所有权互斥。** 见 §5。

---

## 4. 硬约束（写文档时必须遵守）

这些不是风格偏好，是**门禁**。写错了 CI 会红。

1. **UTF-8 无 BOM**。`scripts/check-text-encoding.mjs` 的 `TEXT_EXT` 包含 `.md`，
   跟踪文件必须严格 UTF-8 解码、无 BOM、非 UTF-16。
   ⚠️ PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM——**不要用它写文档**。
2. **包级 AGENTS.md 必须 ≥ 200 字节**（`rules-compliance` 测试 3，防空壳）。
3. **引用的仓库路径必须真实存在**（测试 5）。它只 warn 不 fail，但会污染 CI 日志。
   该正则只匹配以 `packages|scripts|src|docs|.cursor|.claude|electron|e2e|extension|assets`
   开头的引用；**`apps/` 不在匹配列表里**，所以 `apps/...` 引用不被校验（但仍应写对）。
4. **代码标识符、命令、路径、报错原文保持原样不翻译**；文档正文可用中文。
5. **代码注释一律英文**（仓库既有约定）。
6. 引用代码位置用 `path:line`，相对仓库根，例如 `packages/host/src/run-orchestrator.ts:42`。

---

## 5. 分工（文件所有权互斥）

| 队 | 范围 | 拥有文件 |
| --- | --- | --- |
| A | harness 核心链 | `packages/{agent-protocol,agent-core,agent-runtime,host,cli,agent}/AGENTS.md` |
| B | 能力与工具层 | `packages/{capabilities,ai,tooling,sandbox,computer-use,plugin-core,memory,data}/AGENTS.md` |
| C | 客户端与 UI 层 | `packages/{ui,client-core,command-catalog,input-completion,connectors,conductor}/AGENTS.md` + `apps/{desktop,web}/AGENTS.md` |
| D | 导航主文档 | `ARCHITECTURE_MAP.md` + `ARCHITECTURE.md` |
| E | 入口文档 | `README.md`、`README_CN.md`、`AGENTS.md`、`CLAUDE.md`、`docs/exec-plans/README.md` |

实际执行：A/B/C 由三个并行 worker 各写自己那一簇（文件所有权互斥），
D/E 与门禁修复由协调者完成。`packages/{gateway,voice}` 一开始漏派，
后由协调者补写——**分工表漏项就是漏项，不要靠"反正有人会写"**。

---

## 6. 验收标准（全部机器可执行）

```powershell
# 1. 包级规则文件门禁转绿（当前 22 红 → 0 红）
node tests/rules-compliance.test.mjs

# 2. 文本编码门禁
npm run check:encoding

# 3. 边界门禁未被文档改动打破
npm run architecture:check

# 4. 链接与路径自查（本文档自带的引用必须存在）
#    见 §7 的人工核对清单
```

CI 侧 `architecture` 是 required job；`tests/rules-compliance.test.mjs` 挂在
`npm run test:rules`，必须同时绿。

---

## 7. 人工验收清单

- [x] `ARCHITECTURE.md` 里不再出现 `src/`、`electron/` 作为顶层路径
- [x] `ARCHITECTURE.md` 里 `## Package Workspace` 只出现一次，包清单覆盖全部 24 个 workspace
- [x] `ARCHITECTURE.md` 的进程图与 `packages/host/bundle/worker-entry.js` 现状一致
- [x] `ARCHITECTURE_MAP.md` 的排障入口表覆盖 ≥ 26 个症状，每行都有 `path:line`
- [x] 22 个包级 `AGENTS.md` + `apps/{desktop,web}/AGENTS.md` 全部存在、全部 ≥ 200 字节
- [x] 根 `AGENTS.md` 的 Map 段与实际包清单一致
- [x] `README.md` / `README_CN.md` 的 Repository structure 与磁盘一致
- [x] `docs/exec-plans/README.md` 索引里有本计划一行，且状态一致
- [x] `CLAUDE.md` 降级为薄壳（404 行 → 25 行），消除与 `AGENTS.md` 的 12 处冲突
- [x] `node tests/rules-compliance.test.mjs` → 6 passed, 0 failed
- [x] `npm run check:encoding` → OK
- [x] `npm run architecture:boundaries` → no new findings
- [x] `npm run bundle:verify` → FRESH（0/1073 bundle 输入变更）

**导航文档为什么放在仓库根**：`.gitignore:131` 有 `docs/*.md`——`docs/` 顶层的
markdown 属于"本地并行文档工作区"，不入库。放根目录（`ARCHITECTURE_MAP.md`）
既避开这条规则，又与 `ARCHITECTURE.md` 配对；放 `docs/architecture/` 虽也被
放行，但那个目录的 README 把自己定位成"重构入口与历史指针"，
与"当前态排障导航"语义不合。

---

## 8. 风险与已知冲突

1. **共享检出有并行 session 的在途改动。** `E:/Projects/duya`（master 分支）的 index
   里有**未提交**的 `AGENTS.md`（+18 行）、`ARCHITECTURE.md`（+191 行）、
   `docs/exec-plans/README.md` 改动，内容是 plan 610 cutover 的所有权叙述。
   本计划**不触碰共享检出**，全部工作在独立 worktree 完成。
   合并时若与那批改动冲突，以**双方都保留**为准：它们改的是深度所有权叙述，
   本计划改的是包清单、进程图与导航层。
2. **origin/master 在活跃合并。** 勘察期间远端已从 `3c1e26d0` 前进到 `492c08f8`
   （PR #316）。合并前需要 rebase。
3. **文档会随架构继续漂移。** 所以除了文档本身，本计划还要求在
   `ARCHITECTURE_MAP.md` 里写明**每个事实的证据来源**（`path:line`），
   让下一次漂移能被快速发现，而不是重新通读全仓。

---

## 9. 不在范围内

- 不改任何 `packages/*/src/**` 代码——本次只补知识层，不动运行时行为。
- 不改 `architecture-policy.yaml` 的边界规则——边界规则本身是权威，文档去对齐它。
- 不清理共享检出的脏状态——那是集成区的事。
- 不重新录制 `.architecture-baseline.json`。

---

## 10. 顺带修掉的门禁 bug（`tests/rules-compliance.test.mjs`）

本计划的目标之一是让这个门禁转绿，过程中发现**门禁本身在 Windows 上永远红**，
与文件是否存在无关。

**测试 2**（`packages/*` 子包约束）用 `f.path.startsWith("packages/<pkg>/")` 判断，
而 `f.path` 来自 `path.relative()`，win32 返回**反斜杠**：

```
relative()                        => "packages\\ui\\AGENTS.md"
startsWith('packages/ui/')         => false    ← 门禁的判断
normalized.startsWith('packages/ui/') => true
```

所以在 Windows 上即使每个包都有规则文件，这个测试也永远失败；CI 跑 ubuntu，
所以线上一直是绿的——这正是"本地红 / CI 绿"那类翻车的一个实例。
修法是先归一化分隔符，POSIX 上是 no-op，**CI 语义完全不变**。

**测试 5**（相对路径引用可解析）只按"规则文件所在目录"解析，仓库根相对的引用
（`packages/ui/src/App.tsx`）会被判成不存在，噪音 233 条，把真正的断链淹了。
改成**两种基准都试**（仓库根 + 规则文件目录），两者都不存在才算断链，噪音降到 57 条
（剩下的都是占位符与构建产物，例如 `packages/cli/bundle/cli.cjs`）。

---

## 11. 发现但未修（留给后续）

| 发现 | 证据 | 为什么本次不修 |
| --- | --- | --- |
| `scripts/ipc-contract-census.mjs` 读已删除的 `electron/` 目录，**实跑 exit 2**（`cannot read electron/: ENOENT`，`scripts/ipc-contract-census.mjs:66`、`:103`） | 该脚本**没有**接到任何 npm script，CI 不跑它 | 修它要把 `electron/` 路径重写成 `apps/desktop/src/`，属于**代码改动**，超出本次"只补知识层"的范围 |
| `packages/agent/src/modes/index.ts` 仍是模式注册路径之一，但现役注册表在 `packages/host/src/worker-modes/modifiers/index.ts` | 两个路径都存在 | 属于运行时归属清理，不是文档问题 |
| `architecture-policy.yaml` 头部写 core carve-out 是 6 个文件，`scripts/architecture/layer-purity.ts` 实际是 5 个 | 两个文件都在 | policy 与实现不一致，属于边界规则问题 |
| policy 的 `layers:` 块对主门禁是装饰性的——`architecture-check.mjs` 从不读它；真正的层级表在 `scripts/architecture/boundary-gates.mjs:67-75`，且两表成员不一致、13 个包未分层 | 实读两个文件 | 改边界规则超出本次范围；已在 `ARCHITECTURE_MAP.md` §1 标注真实执行位置 |
| `packages/agent-protocol/src/provider-catalog.ts` 被 `ARCHITECTURE.md` 引用，但在 `origin/master @ 492c08f8` 不存在（共享检出有未跟踪的同名新文件） | `Test-Path` 实测 | 引用已改为指向真实存在的 `packages/ai/src/providers/catalog-data.ts`；该文件何时入库由上游决定 |
