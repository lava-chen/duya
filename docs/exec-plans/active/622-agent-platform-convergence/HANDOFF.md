# 622 交接说明（2026-10-23）

> **一句话**：本机（macOS）性能不足且 4 个 agent 会话丢失，本文件记录**已推送到远端的全部进度**、
> **每个检出该怎么重建**、以及**新机器上会踩的环境坑**。接手方从这里开始，不要从 622 README 重读。

## 0. 为什么有这份文件

- 主 agent 会话 `mvs_0cf34d532edd4120b5ddd37666133e82` 在本机执行，第一波 4 个子 agent
  （卡 01 / 07 / 08 / 09）在会话层面 **`lost`**（`bg_28a42dcf` / `bg_ee79dc0c` / `bg_66b850ba` / `bg_7c06d43e`）。
  子 agent 的**工作区改动当时仍未提交**，已由父 agent 逐个提交为 WIP 快照并推送。
- 本机 Node v20.20.2 低于仓库 `engines: >=22`，`better-sqlite3` 原生模块直接 segfault；
  Clash Verge 的 mihomo 内核未运行，`github.com` 极慢而 `api.github.com` 正常。

## 1. 远端分支状态（全部已 push）

| 分支 | 提交 | 内容 | 验证状态 | PR |
| --- | --- | --- | --- | --- |
| `codex/plan-622` | `6c6a411f` | 622 计划系列（README + 11 张卡） | **已合并**：PR #384 → `c81ed169`，CI `architecture` / `test scope` 绿 | 已合 |
| `codex/plan-perf-handoff` | `9765601e` `6bd8a0a6` | Desktop 性能爬坡计划归档 + 交接说明；`exec-plans/README.md`、`catalog.md` 索引同步；622 README 与 615 去掉性能任务引用 | `plan:sync` OK；`architecture:check` **未取得**（见 §3 环境坑 2） | 待开 |
| `codex/622-01-import-graph-resolver` | `ee29d9cb` | 卡 01：`import-graph.mjs` 的 `resolveTarget` 解析裸 `@duya/*` 与子路径；`slice-cut-list.ts` 声明重算 | **全部未验证**（无 vitest / 无门禁） | 待开 |
| `codex/622-07-workflow-dag-parallel` | `2b3db6b1` | 卡 07：`engine.ts` 同层无依赖节点交错执行 + 新增 `dag-concurrency.test.ts` | **未验证**；C2 失败级联未实现 | 待开 |
| `codex/622-08-background-lifecycle` | `8acbe4ce` | 卡 08：**仅 Phase 1 测试层**（`background-lifecycle.test.ts`）+ 卡片记录 | **未验证**；Phase 4 F1 落盘**未实现** | 待开 |
| `codex/622-09-security-governance` | `89569a63` | 卡 09：sandbox 真实接线、manifest 权限线格式来源、资源预算与外部副作用台账、4 个子项测试文件 | **未验证**（测试没跑过） | 待开 |

**卡 02 / 03 / 04 / 05 / 06 / 10 / 11 未开工。** 它们的检出目录在本机已建好（见 §2），
但**没有新增提交**，分支仍指向 `codex/plan-622`（其内容已在 master 里）。

## 2. 在新机器上重建检出

```bash
git clone <repo-url> duya && cd duya
git fetch origin

# 第一波（已有提交，检出会带上 WIP 快照）
git worktree add .claude/worktrees/622-01 -b codex/622-01-import-graph-resolver origin/codex/622-01-import-graph-resolver
git worktree add .claude/worktrees/622-07 -b codex/622-07-workflow-dag-parallel origin/codex/622-07-workflow-dag-parallel
git worktree add .claude/worktrees/622-08 -b codex/622-08-background-lifecycle origin/codex/622-08-background-lifecycle
git worktree add .claude/worktrees/622-09 -b codex/622-09-security-governance origin/codex/622-09-security-governance

# 后续波次（未开工，直接从 master 起）
for n in 02:gate-wiring 03:host-layer 04:unlayered-packages 05:client-axis-gate 06:runtime-purity 10:retirement-and-doc-truth 11:resident-reconciler; do
  id="${n%%:*}"; slug="${n##*:}"
  git worktree add ".claude/worktrees/622-$id" -b "codex/622-$id-$slug" origin/master
done

# 每个检出都要配依赖覆盖层（每个检出单独跑，不要在主检出跑）
cd .claude/worktrees/622-01 && node scripts/junction-worktree.mjs .
```

**开工前先 rebase**（本文件与性能下线都改过 `exec-plans/README.md`、`catalog.md`、622 README）：

```bash
git -C .claude/worktrees/622-01 rebase origin/master   # 其余三个同理
```

四个分支只碰自己卡片声明的独占路径，与本文件不重叠，rebase 应无冲突。

## 3. 新机器上会踩的环境坑

1. **Node 版本**：仓库 `engines: >=22`。本机 v20.20.2 会让 `better-sqlite3` **segfault**
   （实测 `evals/agent/performance/run-io.mjs` 直接段错误退出 139）。先装 Node 22+ 再开工。
2. **`architecture:check` 在带 junction 的检出里会挂起**：本机实测 >420s 无输出。
   同机无 junction 的干净检出里 24s 内报 `ERR_MODULE_NOT_FOUND`（缺 workspace 包链接）。
   ⇒ 门禁要跑在**有真实 `node_modules`、且没有 junction 环**的检出上。接手方请先确定这个检出在哪，
   再把它的结果作为门禁证据；**跑不出来就写「未验证 + 原因」，不要伪造退出码**。
3. **网络**：Clash Verge 的 mihomo 内核未运行（`/var/run/clash-verge-service/users/501/` 为空）。
   `api.github.com` 正常（1.7s），`github.com` 极慢（>12s）。`git fetch` / `git push` 用
   `git -c http.version=HTTP/1.1` 并预留长超时；本机的成功记录：
   `GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=120 git -c http.version=HTTP/1.1 fetch origin master`。
4. **门禁数字会变**：卡 01 修好 `resolveTarget` 后，切片图第一次出现跨包边，`architecture:check`
   的检测数与 baseline 指纹都会动。**这是预期的**——但**不许**用新增 baseline 指纹把新违规消掉
   （根 `AGENTS.md` 明令）。要动 baseline 只能**删**已不再触发的条目。
5. **`node_modules` junction 不会被 `.gitignore` 吃掉**：`.gitignore` 写的是 `node_modules/`（带斜杠），
   macOS 的 junction 被 git 当符号链接，匹配不上。提交时用
   `git add -A -- . ':(exclude)node_modules' ':(exclude)**/node_modules'`，否则会把 junction 提交进去。

## 4. 继续工作的顺序

622 系列的排序规则是**先修测量、再动结构**，不要跳步：

```
卡 01（已 WIP 提交，待验证）→ 卡 02（门禁接线 + 两套解析器收敛）
   → 卡 03（@duya/host 层归属裁决）→ 卡 04（其余无层包）
       → 卡 05（客户端轴反向门禁 G11）
       → 卡 06（runtime 纯净度：过渡导出 vs 实耦合）
```

独立线（可与上面并行，但依赖关系仍要核）：

- **卡 07**（已 WIP 提交）：先补齐验收——交错用例、对照组（有依赖仍串行）、
  **并发上限不超过 `options.concurrency` 那条用例**（没有它，"并行"可能变成"无限并发"）、变异证明；
  C2 失败级联要么实现，要么在卡片里显式写「未做」。
- **卡 08**（已 WIP 提交）：**只落地了 Phase 1 测试层**。Phase 4 F1 的 write-through 落盘、
  rehydrate 后 running → `lost`、F3 的 `RunLifecycleState` ↔ `TaskStatus` 映射表**都还没做**。
  落盘要照 `BashTaskStore` 的范式，不许出现第二套「写文件 + 重启读回」。
- **卡 09**（已 WIP 提交）：四个子项的测试文件都在，但**一个都没跑过**。先跑通再谈收尾。
- **卡 10**：退役收尾 + 残留目录 + 文档事实源。**排在卡 02 之后**——退役门禁得先接进 CI，退役才有守卫。
- **卡 11**：常驻对账监督者，依赖卡 08 的落盘先落地。

## 5. 不要重做的调查（本轮已完成的取证）

这三条结论是卡片的证据基础，接手方**不需要重新查**，但要保留引用：

1. **`resolveTarget` 的根因**：`scripts/architecture/import-graph.mjs` 把裸 `@duya/<rest>` 映射成
   `packages/<第一段>`（子路径被丢弃），候选只试 `<pkg>.ts` / `<pkg>/index.ts`，而本仓**没有任何包在
   根目录放 `index.ts`**（入口一律 `src/index.ts`）⇒ 实测 2935 个 `@duya/*` 说明符**全部解析为 null**，
   切片图跨包边为 **0**。主门禁走的是另一套解析器 `audit-imports.mjs`（按各包 `package.json` 的
   `name`/`exports` 建注册表），它是正确的——**两套工具口径不一致**才是要收敛的东西。
2. **层门禁几乎空转**：`boundary-gates.mjs` 的 `LAYERS`（约 67-75 行）只含 protocol / core / runtime / host
   四层，且 "host" 层指的是 `@duya/desktop` / `@duya/cli` / `@duya/gateway`——**`@duya/host` 本身不在任何层**。
   `findReverseEdges`（约 161 / 166 行）有两道 `if (!xLayer) continue` 早退守卫，
   **无层包的进出边永不被判违规**。`@duya/host` 一家就贡献 1425 条被跳过的跨包边（占全部跳过边的 69%）。
   另：`LAYERS` 里的 `@duya/desktop` 是幽灵条目（master 无 `packages/desktop`）。
3. **sandbox 隔离从未接线**：`packages/sandbox` 的 `wrapCommand` / `executeIsolated` **全仓零生产消费者**
   （只有自身定义与 `index.ts` re-export），`sandbox-adapter.ts:251` 还留着
   「BashTool will use executeIsolated() instead」的未做 TODO；`prepare-sandbox.ts` 调
   `setSandboxEnabled(true)` 属于**假保证**。真正一直在跑的是路径策略 `isPathWithinRoots`。
4. **Rust 重构的量化结论**（用户已决定暂不做，保留备查）：本机实测引擎侧完整运行 **0.274 ms**（J1）、
   50 次工具往返 **2.285 ms**、500 帧事件 **0.557 ms**、10 路并发 **4.607 ms**；
   host 每事件管道（ledger 0.1µs + 帧封装 2.1µs + 扇出 26.3µs）平均 **9.5 µs**，
   一次 10 分钟回答（60,000 delta）合计 **570 ms CPU = 回答时长的 0.095%**；Rust 快 3× 只省 **0.063%**。
   而 host 中间层本身**尚未被测**（`evals/agent/performance/METRICS.md` 明写 host 链路 unmeasured）。
   仓库已有裁决：`610/17-shared-agent-platform-execution.md` §3 与 §3.2 七道门槛。

## 6. 当前未合并的东西

- `codex/plan-perf-handoff`（本文件所在分支）：**未开 PR、未合并**。接手方开 PR 时正文写明：
  Desktop UI 性能与 TUI 性能两项任务已从 mavis 手上移出，本计划按「移交（未完成）」归档。
- 四个 WIP 快照分支：**未开 PR、未验证**。**不要**把它们当成完成的卡合进 master。
