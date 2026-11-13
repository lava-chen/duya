# 移除 progress_update 私有控制工具（保留分组进度标题特性）

状态：active · 负责人：当前会话 · 更新：2026-11-13
分支：`chore/remove-progress-update-tool` · worktree：`/home/lavachen/.duya/worktrees/duya-97c2295ce3ca/remove-progress-update-tool-6661c5` · base：`6d6ea333` · owner：当前会话

## 目标与边界

移除暴露给模型的私有控制工具 `progress_update`（`{ title }`）及其整条实现链：runtime 侧工具定义、Host 装配注入与调用拦截、system prompt 指令、`progressToolName` 接线、遗留 agent 转发壳、已死的来源枚举值、对应测试与文档。工具下线后模型不再能调用它，回合的工具面不再由 Host 私自追加。

**保留（用户 2026-11-13 明确裁定：只删 `progress_update` 工具链）：**

- **`progressTitle` / `progressSource` 字段**：仍由 `provider_commentary`（OpenAI Responses adapter 的 commentary 通道）与 `tool_fallback`（确定性兜底）两条来源产生，UI 分组标题渲染不变。
- **`tool.group_progress` 事件**：协议、client-core、CLI TUI 的整条投影链不动。
- **`provider_commentary` 路径**：`packages/ai/src/api/emit-sse.ts` 的 commentary 映射不动。
- **历史计划文档**：`docs/exec-plans/` 下的既往记录不改写（它们是历史证据）。

关联：推翻 [工具面能力台账](../../references/tool-surface-ledger.md) 中 `progress_update` 的 2026-10-31 裁定「保留」；该裁定由用户直接推翻，非本次重新评估的结果。与 [移除 plan 工具](2026-11-04-remove-plan-tool.md) 是同类任务，删除边界与门禁清单可对照。

## 验收

| # | 命令 / 操作 | 预期 |
| --- | --- | --- |
| 1 | `npm run typecheck:all` | 退出码 0 |
| 2 | `npm run architecture:check` | 退出码 0；无新增边界违规 |
| 3 | `npx vitest run scripts/architecture/slice-classification.test.ts` | 退出码 0（census 的 `RECORDED_LOSSES` 已补） |
| 4 | `npx vitest run packages/host/tests/worker-product-runtime` | 退出码 0 |
| 5 | `npx vitest run packages/host/tests/run-turn-provider-integration.test.ts` | 退出码 0（真 worker 链路，断言模型工具面无 `progress_update`） |
| 6 | `npx vitest run packages/ui/src/components/chat packages/ui/src/lib/stream-session-manager.test.ts` | 退出码 0 |
| 7 | `npm run bundle:worker` 后 `git diff --stat packages/host/bundle/` | bundle 重建且 diff 只反映本工具移除 |
| 8 | `grep -rn "progress_update" packages/ apps/ --include=*.ts --include=*.tsx` | 命中 0（除测试中的负向断言） |

基线：改动前在同检出记录上述命令的退出码与失败签名，按文件 / 用例 / 错误签名比较，不只比数量。

## 进度

- [x] 读必读指南（worktree / engineering-loop / testing / build）与目标子树 AGENTS.md
- [x] 摸清影响面：工具定义、注入点、拦截点、协议枚举、UI 渲染、census、台账、ARCHITECTURE
- [x] 与用户确认删除边界（只删工具链 / 保留 `provider_commentary` 与 `tool_fallback`）
- [x] 分配独立 managed worktree（base `6d6ea333`）+ 配置依赖
- [x] 删除 runtime 工具定义文件与遗留 agent 转发壳
- [x] 删除 Host 侧注入、拦截、prompt 指令、`progressToolName` 接线
- [x] 清理 `model_progress_tool` 枚举值（protocol + UI 五处）
- [x] 改写相关测试（负向断言替代正向断言）
- [x] 补 census `RECORDED_LOSSES` 退休条目
- [x] 更新工具面台账、ARCHITECTURE 与多代理工具清单
- [ ] 跑门禁并记录证据
- [ ] commit + PR

## 发现与决策

1. **`ToolGroupProgressTracker` 已是死代码。** `packages/host/src/worker-session-runtime.ts:125` import 了它，但全仓 `new ToolGroupProgressTracker` 命中 0 —— 没有任何实例化点。分组标题实际由 `provider_commentary` 事件与 UI 的确定性兜底产生，与该 tracker 无关。故连同工具定义整文件删除，不留半截。
2. **工具从不进 registry，只由装配期注入。** 它不在 `builtin.ts` 静态注册清单里，而是 `beginTurnAssembly` 把 `PROGRESS_UPDATE_TOOL` 追加到 `resolved.tools`，再由 `composeLegacyRunSources` 的 `queueTool` 在普通工具解析、权限检查与执行之前拦截并直接回结果。删除后回合工具面完全等于 registry 解析结果。
3. **`controlResults` 是该工具路径的专属产物。** `worker-run-composition.ts` 里 `controlResults` 只有一处 push（进度工具的控制结果），删除工具后整段连同 `drainTools` 的 `splice(0)` 与 `discardTools` 的清空一起删。
4. **prompt 指令保留但收窄。** `TOOL_GROUP_PROGRESS_INSTRUCTIONS` 第二句原本是「provider commentary 不可用时改调私有工具」；工具下线后该分支消失，指令改为只讲 provider commentary 通道。`turn-assembly-seam.test.ts` 断言的 `Tool-group progress:` 前缀仍在，prompt 行为不因本次删除而整体消失。
5. **`model_progress_tool` 枚举值随工具一起失效。** 它只由该工具路径产生（`worker-run-composition.ts` 的 `tool.group_progress` 事件源）。故从 `ToolGroupProgressSource` 联合类型与 UI 四处镜像类型中删除，protocol 的 `MIGRATION.md` 成员计数同步 3 → 2。
6. **census 需要退休条目。** `packages/agent/src/agent/tool-group-progress.ts` 在 `scripts/architecture/slice-census.txt` 的 `runtime-coordination` 桶里，删除后门禁报「recorded paths are no longer runtime-coordination」。按 census 自身规则补 `RECORDED_LOSSES` 条目（`REMOVED_WITH_THE_PROGRESS_UPDATE_TOOL`），不做批量重录。`packages/agent-runtime/src/turns/tool-group-progress.ts` 不在 census 内，删除免费。
7. **`turn-assembly-seam.test.ts` 的冻结工具表少一项。** 该表是从重构前真实循环记录下来的观察值，原本含 `progress_update`；工具下线后表少一项，且原先断言「追加恰好一次」的源码断言改为断言「一次都不追加」—— 同一断言的符号翻转，比直接删断言更强。
8. **`run-turn-provider-integration.test.ts` 保留缓存输入核算。** 原用例同时覆盖私有进度工具与 `cache_read_input_tokens` 的核算；工具下线后重写为只覆盖后者，并在原始请求体上加负向断言（模型收到的工具面里没有 `progress_update`），把端到端链路也钉住。
9. **本机依赖是独立安装的。** 主检出 `/home/lavachen/Projects/duya` 没有 `node_modules`，`junction-worktree.mjs` 的根级链接因此无法建立（它的 primary 无依赖可链）。按根 AGENTS「独立依赖目录可 `npm install`」在本检出执行 `npm ci`；`PUPPETEER_SKIP_DOWNLOAD=true` 绕过本机 Chrome 缓存不完整导致的 puppeteer 安装失败（e2e 浏览器用例本次不涉及）。
10. **`agent-process-entry-import.test.ts` 的失败是既有基线失败，与本次改动无关。** 该用例断言 `process.send` 恰好被调用 1 次，实测 4 次。在**未修改的 base 检出**（`6d6ea333`）上跑同一条命令，失败签名逐字相同（同文件、同行号 `:185`、`expected "vi.fn()" to be called 1 times, but got 4 times`）。判定为既有债，不在本次范围内修。
11. **本次改动消除了 4 条被 baseline 容忍的边界违规。** base `6d6ea333` 与本分支对跑 `architecture:check`：violation total 由 **3206 降到 3202**，「已失效 baseline 指纹」由 **60 升到 63**（多出的 3 条即被删工具的跨包 import 指纹）。未改动 `.architecture-baseline.json`，无新增违规。
12. **CI 暴露了一个本地门禁集覆盖不到的闸门：`agent-retirement-gate`。** PR #635 的 `architecture` job 在第 9 步「Agent retirement reference ratchet」红，退出码 1：`773 current / 772 baseline / 1 new`，`new test-target references: 1`。该闸门**不在** `typecheck:all` 与 `architecture:check` 里，本地跑不到。根因：`RECORDED_LOSSES` 条目必须写出被删文件的字面路径 `packages/agent/src/agent/tool-group-progress.ts`，而退役闸门正是扫描这个字面串，把它算成一条新增的退役包引用（test-target 654 → 655）。
13. **修法：把该条目移进 `RETIREMENT_GATE_FIXTURE_CONTEXT` 有界区间。** 退役闸门对 `scripts/architecture/slice-classification.test.ts` 有专门的有界豁免：位于 `// RETIREMENT_GATE_FIXTURE_CONTEXT_START` / `END` 之间的引用计入 `bounded synthetic fixture references`，不参与棘轮计数。仓库既有先例正是这条路径 —— `plan` 工具退役的 3 条与 projection-compress 退役的 6 条 census 条目都在该区间内（`:1965`–`:1988`）。把新条目移入后：退役闸门回到 `772 current / 772 baseline / 0 new`（bounded 计数 63 → 64），census 用例仍 30/30 通过。**未改任何 baseline 文件**，也没有放宽闸门。

## 验证记录

环境统一为：Linux 7.2.15-300.fc45.x86_64 / Node v26.13.0 / npm 11.20.0 / 本检出独立依赖目录。基线检出为同机独立 worktree（`baseline-6d6ea333`，detach 于 `6d6ea333`，自建 `packages/*/dist`）。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts`（补 `RECORDED_LOSSES` **前**） | 1 | 1 failed / 29 passed；失败点名 `packages/agent/src/agent/tool-group-progress.ts` 离开 `runtime-coordination` 桶 |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts`（补条目**后**） | 0 | 1 file / 30 tests passed |
| `6d6ea333` + 本次改动 | 同上 | `npm run typecheck:all` | 0 | `typecheck-electron-gate: OK — no new type errors (164 known across 90 key(s))`；`21 baselined key(s) shrank` 与 base 记录同值，属既有债；`eval:agent:core:check` 4/4 通过 |
| `6d6ea333` + 本次改动 | 同上 | `npm run architecture:check` | 0 | total 3202 / tolerated 3202，`OK — no new boundary violations`；失效指纹 63 |
| `6d6ea333` clean（基线检出对跑） | 同上 | `npm run architecture:check` | 0 | total 3206 / tolerated 3206，`OK — no new boundary violations`；失效指纹 60 → 本次消除 4 条被容忍违规，无新增 |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run packages/host/tests/worker-product-runtime` | 1 | 32 files passed / 1 failed（183 passed / 1 failed）；失败为 `agent-process-entry-import.test.ts` |
| `6d6ea333` clean（基线检出） | 同上 | `npx vitest run packages/host/tests/worker-product-runtime/agent-process-entry-import.test.ts` | 1 | **同一文件、同一行 `:185`、同一签名**（`expected "vi.fn()" to be called 1 times, but got 4 times`）→ 既有基线失败，非本次引入 |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run packages/host/tests/run-turn-provider-integration.test.ts` | 0 | 1 file / 8 tests passed（真 worker + 真 provider；含「模型工具面无 `progress_update`」负向断言） |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run packages/agent-protocol/test` | 0 | 29 files / 465 tests passed |
| `6d6ea333` + 本次改动 | 同上 | `npx vitest run packages/ui/src/components/chat/ToolActionsGroup.test.tsx packages/ui/src/components/chat/tools/__tests__/buildGroupDisplayTitle.test.ts packages/ui/src/lib/stream-session-manager.test.ts` | 0 | 3 files / 56 passed / 2 skipped |
| `6d6ea333` + 本次改动 | 同上 | `npm run bundle:worker` | 0 | `worker-entry.js` 5.51 MB；bundle 内 `progress_update` 出现次数 **0**；metafile 模块数 1765 → 1764（恰好少一个模块），字节数变化的只有 3 个改动模块（`worker-run-composition.ts` / `worker-engine-driver.ts` / `worker-session-runtime.ts`；第 4 个改动文件 `worker-run-session-port.ts` 是纯类型文件，不进 bundle，metafile 无条目）→ 无工具链 churn |
| `6d6ea333` + 本次改动 | 同上 | `grep -rn "progress_update\|PROGRESS_UPDATE\|progressToolName" packages/ apps/ --include=*.ts --include=*.tsx` | 0 | 仅命中测试中的历史注释与**负向断言**；生产代码 0 命中 |

## 接续 / 结果

**已实现**：`progress_update` 整链已删除 —— runtime 工具定义文件（`packages/agent-runtime/src/turns/tool-group-progress.ts`，121 行，含已是死代码的 `ToolGroupProgressTracker`）、遗留 agent 转发壳、Host 侧装配注入与 `queueTool` 拦截、专用 `controlResults` 通道、`progressToolName` 接线（3 个文件）、system prompt 中指向私有工具的那一句、`model_progress_tool` 枚举值（protocol + UI 共 5 处类型镜像 + `MIGRATION.md` 成员计数）、census `RECORDED_LOSSES` 退休条目、工具面台账与 ARCHITECTURE 段落、相关测试改写。worker bundle 已重建（bundle 内该工具 0 命中）。

**已验证**：见上表。`typecheck:all` / `architecture:check` / census / agent-protocol / UI / 真 worker 集成全部退出码 0；host 套件唯一失败经**基线检出同签名复现**，判定为既有债。

**未合并**：Draft PR [#635](https://github.com/lava-chen/duya/pull/635) 已开，commit `2807b46e8`，分支 `chore/remove-progress-update-tool`。待 CI 与 review；**集成需用户授权**。

回收：owner 退出且 PR 集成后走管理工具回收 managed worktree。基线对跑用的临时检出 `baseline-6d6ea333` 尚未回收（其 untracked 项全是 junction 脚本造的 `node_modules` 软链与 gitignore 的 `dist/`，无源码成果）。
下一步：等 CI 与 review 通过后，由获授权的集成者合并；合并后重验再回收。
