# 617 — 基础工具接口 v2：让模型用起来像 Claude Code 一样直接

状态：**active**（2026-10-19 立项）
前序：[616 duya_app 内置 MCP 层](./616-duya-app-mcp-layer.md)（产品能力从基础工具集剥离）
关联：[580 MCP 能力核收敛](./580-mcp-capability-core-convergence.md)、[443 search tools hardening](./443-search-tools-hardening.md)

---

## 0. 本文是什么

**只管基础工具。** canvas 系列、bot 系列、browser 系列归
[616-duya-app-mcp-layer](./616-duya-app-mcp-layer.md)——那些工具将整体移进
`duya_app` 内置 MCP server，**本文一个字都不碰它们的 schema、命名、暴露方式**。

**不改 duya 的能力架构。** Ports + Host Adapter 的分层、13 槽位贡献者注册表、
权限总线、三层 exposure 全部保留。要改的只是**模型看到的基础工具界面**。

**立场**：duya 该学 Claude Code 的工具**界面形状**，不该学它的工具**数量**，
更不该为了学界面而动已经分层好的产品能力。

---

## 1. 边界：什么是基础工具

616 的 §3 已经定了目标形态。本文按那份清单执行，**基础工具 = 616 §3 表格第二行**：

| 组 | 工具 | 备注 |
|---|---|---|
| 文件系统 | `read` `write` `edit` `apply_patch` `glob` `grep` | 6 个，616 明确保留 |
| Shell | `bash` `powershell` | `powershell` 仅 Windows 注册（`worker-tools/builtin.ts:68`） |
| 任务 | `todo` `task` `get_task_output` `kill_task` `wait_tasks` | `wait_tasks` 今天**未注册**（`packages/host/src/worker-tool-bindings/wait-tasks.ts` 有实现但 `builtin.ts` 没注册）——见 §1.5 |
| 模式 | `EnterPlanMode` `ExitPlanMode` `SwitchMode` | |
| 交互 | `AskUserQuestion` `Skill` | |
| 路由元工具 | `tool_catalog` `tool_invoke` | 基础设施，616 §3 也列为基础工具 |

**明确 Out**（本文不碰，616 或其他线负责）：

- canvas 16 个 + `database_manage` → 616 T610c
- bot 8 个（`send_message` / `send_to_agent` / `post_to_room` / `ReactToMessage` /
  `create_agent` / `update_agent` / `manage_routine` / `list_app_connectors`+`connect_app`）→ 616 T610d
- `browser`（30 op）→ 616 T610d
- `computer_use` / `computer_cua` / `vision_analyze` / `image_generate` / `show_widget` /
  `read_module` / `send_artifact` / `duya_cli` / `session` / `MessageSession` /
  `SessionSearch` / `Brief` / `memory_write` / `write_stage1_policy` / `plan` /
  `update_state` → 616 未点名，**归属待 616 明确**；本文同样不碰

> ⚠️ **归属缺口**：616 §3 的"基础工具"清单只列了 17 个，上表这批"未点名"工具
> （`computer_use` / `vision_analyze` / `image_generate` / `show_widget` / `duya_cli` / …）
> 在 616 里既没进 `duya_app`，也没留在基础清单。**616 落地后这批会悬空。**
> 本文只记录这个事实（§1.6），不替 616 做决定。

---

## 2. 现状实证（2026-10-19 实测，file:line 为当日核对）

### 2.1 基础工具 schema 字节实测

从 `packages/capabilities/dist/` 读 `JSON.stringify(input_schema).length`：

| 工具 | 字节 | 工具 | 字节 |
|---|---|---|---|
| task | 2872 | read | 1222 |
| grep | 1169 | todo | 640 |
| glob | 580 | bash | 757 |
| edit | 785 | powershell | 763 |
| apply_patch | 318 | write | 365 |
| AskUserQuestion | 1048 | SwitchMode | 245 |
| wait_tasks | 240 | Skill | 216 |
| get_task_output | 177 | kill_task | 131 |
| EnterPlanMode | 47 | ExitPlanMode | 47 |

**基础工具无一超 8192。** 最大的是 `task`（2872）。

> 📌 **这推翻了本文早先版本的一条核心论据。** 早先版本写「`browser` 9373 字节超预算、
> 会被降级成空对象、模型因此反复重试」——**该结论对基础工具不成立**：
> 1. `browser` 超出 616 的范围，616 会把它整体搬进 `duya_app`；
> 2. 就算留在原位，`browser` 是 `deferred`（`packages/host/src/worker-tools/builtin.ts:94`），
>    且**没有任何 profile 用精确 allowlist 放行它**（`packages/host/src/worker-profiles/types.ts:132`
>    / `:148` 只在 `disallowedTools` 里禁它，`:291` 的清单里也没有），
>    所以它**今天根本进不了 `tools[]`**，降级路径对它不生效。
>
> **8KB 预算因此从「基础工具的 P0 问题」降级为「616 迁移后要复查的问题」**——
> 见 §7 P1-B。

### 2.2 8KB 预算机制本身的两处债（与基础工具无直接关系，但共用代码路径）

- **降级提示缺失**：`packages/plugin-core/src/mcp/core/projection.ts:65` 有现成的
  `downgradedSchemaDescription()`，但生产调用点
  `packages/host/src/worker-session-runtime.ts:1481` **没调用它**——
  模型会收到一个参数为空对象的工具，且**没有任何文字解释为什么**。
  `projection.ts:12` 的注释写 "description annotation is the caller's job"，caller 没做。
- **两套实现，生产跑一套**：`packages/agent-runtime/src/tools/catalog/spec-budget.ts:17`
  的 `downgradeToolSchemaForBudget` 是**死代码**——全仓无生产调用点，
  只有 `packages/agent-runtime/test/discovery/spec-budget.test.ts` 和
  `packages/agent/src/tool/spec-budget.ts` 的转交 shim 在用。
  生产跑的是 plugin-core 的 `projectForProvider`。

这两条今天不伤害基础工具（都没超预算），但 **616 落地后 `duya_app` 的工具全部走 MCP 路径**，
届时 `browser`（9373 字节）会第一次真正撞上降级。**归属见 §7 P1-B。**

### 2.3 命名现状（基础工具范围）

基础工具里**snake_case 与 PascalCase 混用**：

| 类别 | 工具 |
|---|---|
| snake_case | `read` `write` `edit` `apply_patch` `glob` `grep` `bash` `powershell` `todo` `task` `get_task_output` `kill_task` `wait_tasks` `tool_catalog` `tool_invoke` |
| PascalCase | `AskUserQuestion` `Skill` `EnterPlanMode` `ExitPlanMode` `SwitchMode` |

**对照 Claude Code**：它的 `AskUserQuestion` / `Skill` / `EnterPlanMode` / `ExitPlanMode`
**也是 PascalCase**。所以这不是"duya 抄歪了"，而是**两套并存的约定**。

**历史别名**（模型的历史对话里可能还在用）：

- `LEGACY_TODO_WIRE_NAMES = ['TodoWrite']`（`packages/capabilities/src/TodoTool/TodoTool.ts:19`）
- `LEGACY_SUBAGENT_TOOL_NAME = 'Agent'`（`packages/capabilities/src/SubagentTool/constants.ts:3`）

别名解析点**只有一处**：`packages/host/src/worker-execution/streaming-tool-executor.ts:129`
（`resolveToolKey`）。**注册层不认别名**——模型若用 `TodoWrite` 调 `todo`，
能否命中取决于执行期那一处转换。`Task`/`Agent` 的别名 `Agent` 目前**在基础工具里
没有对应的解析**——`LEGACY_SUBAGENT_TOOL_NAME` 被导出但 `resolveToolKey` 只处理了 TodoWrite。

### 2.4 高频工具 schema 现状 vs Claude Code

| 工具 | duya | Claude Code | 差距 |
|---|---|---|---|
| `read` | `file_path` + `line_range{start,end}` + `cell_range{start,end}` + `pages` + `max_tokens` | `file_path` + `offset` + `limit` + `read_range` | duya 的 `line_range` **语义等价**但需要嵌套对象；Claude Code 的 `offset`/`limit` 是**扁平数字**，模型更少出错 |
| `grep` | `pattern` `path` `case_sensitive` `include_sensitive` `max_results` `file_pattern` `literal` `context` | `pattern` `path` `glob` `output_mode` + `-i -n -A -B -C head_limit offset type` | duya 的 8 个参数**语义正交**（`literal` / `include_sensitive` / `context` / `file_pattern` 各自独立），Claude Code 的是**开关家族**。**duya 的形状更清晰**，但模型要判断何时用哪个 |
| `edit` | `file_path` + `edits[]{old_string,new_string}` | `file_path` + `old_string` + `new_string` + `replace_all` | **duya 更强**（批量原子修改）。**保留** |
| `glob` | `pattern` `path` `maxResults` | `pattern` `path` | 基本一致 |
| `bash` | `command` + `description`(可选) + `timeout` + `run_in_background` + `background`(弃用别名) | `command` + `description`(**必填**) + `timeout` + `run_in_background` + `dangerouslyDisableSandbox` | duya 的 `description` 可选、Claude Code 必填。`description` 直接决定权限弹窗可读性——**Claude Code 的做法更好** |
| `todo` | `todos[]{id,content,status}` + `merge` | `todos[]{content,status,activeForm}` | duya 多 `id`（合并语义），Claude Code 多 `activeForm`（进行中态展示） |

### 2.5 缺失的基础能力

| 能力 | duya 现状 | 位置 |
|---|---|---|
| `NotebookEdit` | **无**。`read` 能读 ipynb 的 `cell_range`（`packages/capabilities/src/ReadTool/ReadTool.ts:224`），但**不能改** | — |
| `WebSearch` / `WebFetch` | **无独立工具**。只有 `browser` 的 `search` / `parallel_fetch` / `network_read`——而 **browser 归 616**，且它是 30-op 大 schema | — |

> ⚠️ **这两项的归属需要 616 裁决**（§7 P1-A）。
> Claude Code 把 `WebSearch` / `WebFetch` / `NotebookEdit` 都放在**基础工具**层。
> 若按 Claude Code 的形状，它们应该留在基础工具层；`browser` 的 30 个 op 归 `duya_app`，
> 但"搜索"和"抓取单页"是**通用能力**，不是"桌面端特殊能力"。

### 2.6 工具结果上下文管理

- **只有 bash 一条路径有**：`packages/capabilities/src/ShellCommandTool/BashTool.ts:73`
  `truncateShellOutput`，上限 30,000 字符 / 1,000 行（`BashTool.ts:65`），
  超限则**落盘**并返回 `Use read("<path>") to read the full output` 提示。
- **其他基础工具无统一策略**：`read` 有 `max_tokens`（`ReadTool.ts:236`）与 50KB 硬上限；
  `grep` 有 `max_results`（默认 100）；`task` 的结果经 `get_task_output` 有
  `DEFAULT_TOOL_OUTPUT_BYTES` 上限。
- **形状是对的，缺的是统一**：截断 + 落盘 + 引用这三件套已经在 bash 上跑通，
  只是没有推广到其他基础工具。

### 2.7 任务生命周期现状（O7 的盘点结果）

- `task` 工具已有 `isolation: 'worktree'`（`packages/capabilities/src/SubagentTool/SubagentTool.ts:83`）、
  `resume_from`、`auto_wake`、`run_in_background`。
- 后台任务**有两套**注册表：
  - shell 任务：`packages/host/src/managed-shell/task-registry.ts:44`
    （`BashBackgroundTask` + 落盘 + 5 分钟 TTL）
  - hook 任务：`packages/host/src/worker-hooks/task-registry.ts:55`
    （`HookBackgroundTask` + 内存 + 5 分钟 TTL，**不落盘**）
  - subagent 任务：第三套，在 `packages/host/src/worker-subagents/background-lifecycle.ts:102`
- **三套的字段与生命周期不统一**，但**都在正常工作**。统一它们是架构级变更，
  且与 610 系列的 run 生命周期耦合 → 见 §7 P2-B（本期只盘点，不落地）。

### 2.8 工具发现机制现状

- 三层 exposure：`eager` / `deferred` / `hidden`
  （`packages/agent-runtime/src/tools/catalog/catalog-types.ts:3`）。
- 路由元工具 `tool_catalog`（`query` / `namespace` / `tool_id` 三模式互斥，
  `packages/agent-runtime/src/tools/discovery/ToolCatalogTool.ts:59`）+ `tool_invoke`。
- 未声明工具直接调用被 `packages/agent-runtime/src/tools/discovery/visibility-guard.ts:1` 拒绝。
- **`tool_catalog` 支持中文同义词**（`ToolCatalogTool.ts:19` `SEARCH_SYNONYMS`）——
  这是 duya 比 Claude Code 强的地方，**保留**。
- **已读 schema 的缓存只活一轮**：`loadedSchemaRevisions` 存在 `ToolCatalogView` 里，
  而 `ToolCatalogView` 每次 `streamChat` 重建
  （`packages/host/src/worker-session-runtime.ts:1466`）。**跨轮不缓存。**
- **对基础工具影响小**：基础工具几乎全是 `eager`（直接进 `tools[]`，不走发现），
  唯一会被降级的是 `powershell`（`worker-tools/builtin.ts:68`）与三个模式工具。
  **跨轮 schema 缓存的价值主要在 616 的 `duya_app` 侧**（那里才有几十个 deferred 工具）
  → 见 §7 P2-A（本文不实现，但要在 616 落地时提醒）。

### 2.9 基础工具的 exposure 现状

| exposure | 基础工具 |
|---|---|
| `eager` | `read` `write` `grep` `edit` `apply_patch` `glob` `bash` `todo` `task` `get_task_output` `kill_task` `tool_catalog` `tool_invoke` `AskUserQuestion` `Skill` |
| `deferred` | `powershell` `EnterPlanMode` `ExitPlanMode` `SwitchMode` |

**基础工具的暴露面已经很小**（约 16 eager + 4 deferred）。
"减少 `tool_catalog` → `tool_invoke`" 这个诉求，**对基础工具几乎不适用**——
它适用于 616 迁过去的几十个产品能力工具。

---

## 3. Scope

### In

| # | 内容 | 依赖的既有资产 |
|---|---|---|
| I1 | **基础工具 schema 压平**：`read` 补扁平 `offset`/`limit`；`grep` 正交项收进子对象；`bash` 的 `description` 改必填 | §2.4 |
| I2 | **命名规范化**：按功能域切（能力级 snake_case / 会话级 PascalCase），旧名永久保留别名 | §2.3 |
| I3 | **别名解析收口**：注册层也认别名，别名表显式化 | §2.3 |
| I4 | **`NotebookEdit`**：补齐，与 `read` 的 `cell_range` 对称 | §2.5 |
| I5 | **工具结果上下文管理统一**：截断 + 落盘 + 引用三件套推广到基础工具 | §2.6 |
| I6 | **工具调用基准测试**：可复跑的 A/B 基准 | §4.4 |
| I7 | **8KB 降级路径修复**（截断 description 而非清空 + 补降级提示 + 合并两套实现） | §2.2 |

### Out（每条写理由）

| # | 不做 | 理由 |
|---|---|---|
| O1 | 改 Ports + Host Adapter 分层 | 用户判断已定：**保留**。改造重点是模型看到的界面 |
| O2 | 改 13 槽位贡献者注册表 / 装配校验 | 同上，注册表是优势不是负担 |
| O3 | 改权限总线 / 三层 exposure 语义 | 同上；I7 只修 exposure 之下**schema 内容**被破坏这一处 |
| O4 | 改 `edit.edits[]` 为单次编辑 | duya 的批量原子修改**优于** Claude Code，保留；只补一个便捷单次入口 |
| O5 | 引入 Anthropic 官方 Tool Search / tool_reference 协议 | 用户判断已定：**借鉴不照搬**。duya 已有等效机制，只做能力对齐不做协议对齐 |
| O6 | 程序化工具组合 | 用户排序里是 P2。架构上不堵死（`ToolResult.blocks` / `structured` 已有承载位），本期不实现 |
| O7 | TaskRun 统一持久化抽象 | 架构级变更，与 610 的 run 生命周期耦合。本期只盘点（§2.7），不落地 |
| O8 | **canvas / bot / browser 的一切改动** | **归 [616](./616-duya-app-mcp-layer.md)**。本文不碰 |
| O9 | `computer_use` / `vision_analyze` / `image_generate` / `show_widget` / `duya_cli` 等未点名工具 | 归属待 616 裁决（§1），本文不碰 |
| O10 | 跨轮 schema 缓存 | 价值主要在 616 的 deferred 工具侧；基础工具几乎全是 eager。见 §7 P2-A |
| O11 | 任务感知工具预加载 | 基础工具只有 16 个 eager + 4 deferred，预加载收益微乎其微。见 §7 P2-A |

---

## 4. 分期

### 4.1 Phase 0 — 事实冻结与基准 harness

**理由**：本文所有结论都是 2026-10-19 单日快照。**没有基准就没有"改进"的定义。**

- [ ] P0-1 写 `scripts/architecture/tool-schema-census.mjs`：遍历**基础工具**
      （按 §1 清单，不含产品能力工具），产出名称 / schema 字节 / exposure / 参数名清单，
      落成机器可读快照。**门禁**：快照进 git，任何人改 schema 都能 diff 出字节变化。
- [ ] P0-2 写 `scripts/architecture/tool-schema-budget.test.ts`：
      对基础工具断言 `JSON.stringify(input_schema).length <= 8192`。
      **今天是绿的**（最大 `task` 2872）——这条测试的作用是**守住**，
      防止 616 迁移过程中基础工具被拖超。
- [ ] P0-3 建**任务基准 harness**（见 §4.4），**先测出当前基线**，不设目标值。
- [ ] P0-4 盘点 TaskRun 现状（§2.7 三套注册表的字段/生命周期差异），落成文档，**不改代码**。
- [ ] P0-5 **给 616 提一个归属问题**（§7 P1-A）：`WebSearch` / `WebFetch` /
      `NotebookEdit` 归基础工具层还是 `duya_app`？**先得到答复再开工 I4。**

**完成标志**：P0-2 绿；P0-3 有可复跑基线数字；P0-5 有书面答复。

### 4.2 Phase 1 — 基础工具接口 v2

对应用户判断的"第一阶段"。**本期的全部价值在这里。**

#### P1-A 命名与别名

- [ ] A1 **命名裁定**：按功能域切——
      「文件 / 搜索 / 执行」= 能力级 → snake_case（今天已是）；
      「用户交互 / 模式 / 技能」= 会话级 → PascalCase（今天已是）。
      **结论：基础工具的命名今天已经符合 Claude Code 的形状，本期基本不改。**
      唯一要处理的是 `Task` vs `task`：616 §3 定的清单里写 `task`，
      而 Claude Code 的 `Agent` 是今天 duya 的 `LEGACY_SUBAGENT_TOOL_NAME`——
      **确认 `task` 为规范名，`Agent` 为别名**。
- [ ] A2 **别名表显式化**：把 `TodoWrite`→`todo`、`Agent`→`task` 收进
      **一份显式的 alias 表**（新建 `packages/capabilities/src/tool-aliases.ts`），
      由**注册层与执行层共用**。今天别名解析只在执行层一处
      （`packages/host/src/worker-execution/streaming-tool-executor.ts:129`），
      **且只处理了 TodoWrite，`Agent` 没处理**。
- [ ] A3 别名**永久保留**——模型的历史对话里可能还在用旧名。
- [ ] A4 补 `wait_tasks` 的注册（今天有实现未注册，见 §1），
      或明确记录"不注册"的理由。**二选一，不能悬着。**

#### P1-B schema 压平

- [ ] B1 `read`：补**扁平** `offset` / `limit` 两个数字参数（Claude Code 形状），
      保留现有 `line_range` / `cell_range` 作为等价入口。
      **两者语义必须等价，且要写测试钉住**——否则模型会在两套参数间乱试。
      `pages` 参数今天已标"PDF 解析不再内置"（`ReadTool.ts:234`），
      **顺手删掉**——留一个无效参数比没有更糟。
- [ ] B2 `grep`：`literal` / `include_sensitive` / `file_pattern` / `case_sensitive`
      四项**正交开关**收进一个 `advanced` 子对象，顶层只留
      `pattern` / `path` / `max_results` / `context`。
      **能力一个不删**，只压层级。
      ⚠️ **443 正在改 grep 的 rg 链路**（timeout / multiline / 打包），
      **B2 只动 schema 形状，不碰 rg 实现**，两者可并行但要避免同文件冲突。
- [ ] B3 `edit`：保留 `edits[]`（duya 优势），**额外**允许顶层
      `old_string` / `new_string` 单次形态，二选一。
- [ ] B4 `bash`：`description` 改**必填**（对齐 Claude Code）。
      今天它是可选的（`packages/capabilities/src/ShellCommandTool/BashTool.ts:298`
      的 `'Optional description for the command'`），
      而它直接决定权限弹窗的可读性——**必填是对的**。
      同时移除 `background` 弃用别名（与 `run_in_background` 二选一，留一个）。

#### P1-C 补原生能力

- [ ] C1 `notebook_edit`：与 `read` 的 `cell_range` 对称
      （`cell_id` / `cell_type` / `new_source` / `edit_mode`）。
      **归属以 P0-5 的答复为准**——若 616 决定把它放 `duya_app`，本卡作废。
- [ ] C2 `web_search` / `web_fetch`：**归属以 P0-5 的答复为准**。
      若留在基础工具层：走 **Ports 注入**（`packages/capabilities/src/` 的端口模式），
      **不复用 browser 的 CDP 会话**——搜索不需要浏览器实例，
      更不该继承浏览器的登录态与 cookie 面。产出统一的 `WebResult` 形状
      （title / url / content / citations）。

#### P1-D 8KB 降级路径修复（虽然基础工具今天不触发，但债要还）

- [ ] D1 `projectForProvider` 超预算时**不再清空参数结构**：
      保留 `type` + `properties` 的**顶层键名**，把每个属性的 `description` 截断，
      丢深层 `items`/`anyOf`/`$ref`。
      **执行器收到的仍是模型原样 JSON**，所以降级只影响模型的理解，不影响执行。
- [ ] D2 生产路径 `packages/host/src/worker-session-runtime.ts:1481` 接上
      `downgradedSchemaDescription()`。
- [ ] D3 **删掉 `packages/agent-runtime/src/tools/catalog/spec-budget.ts` 的
      `downgradeToolSchemaForBudget`**，与 plugin-core 那套合并为一份。
      仓库里有两套预算实现、生产跑一套、另一套是死代码——合并是还债，不是新增抽象。
      **必须同时把 `packages/agent-runtime/test/discovery/spec-budget.test.ts`
      迁到 plugin-core 那套，而不是删掉测试。**
- [ ] D4 D1–D3 是 **616 落地的前置**：616 把 `browser`（9373 字节）搬进 `duya_app` 后，
      它会第一次真正撞上降级。**在 616 的 T610d 之前完成。**

#### P1-E 工具结果上下文管理

- [ ] E1 把 `truncateShellOutput` 的三件套（**截断 + 落盘 + 引用**）
      抽成**共享工具**，推广到基础工具：
      - `read`：`max_tokens` 之外补落盘 + `read(path)` 引用
      - `grep`：`max_results` 之外补落盘（命中量大时）
      - `task` / `get_task_output`：已经是 `DEFAULT_TOOL_OUTPUT_BYTES` 上限，补落盘引用
- [ ] E2 落盘路径复用 bash 已有的 `runtime.outputDirectory()`
      （`ShellCommandRuntimePorts`），**不新造目录约定**。

### 4.3 Phase 2 — 运行时优化（本期不启动，留接口位）

**在 Phase 1 基准数字出来之前不开工。**

| 方向 | 本期只做什么 |
|---|---|
| 跨轮 schema 缓存 | **不实现**。价值主要在 616 迁过去的几十个 deferred 工具侧；基础工具几乎全是 eager（§2.9）。**在 616 的 T610d 落地时提醒他们做** |
| 任务感知工具预加载 | **不实现**。基础工具只有 16 eager + 4 deferred，预加载收益微乎其微。同上 |
| 按操作粒度懒加载 | **不适用**——`browser` 归 616 |
| 工具结果压缩 | Phase 1 只做统一策略骨架（P1-E），**不做自动摘要** |
| 程序化工具组合 | 不实现，架构上不堵死 |

### 4.4 I6 工具调用基准测试（本 plan 的验收依据）

**这是本文最容易被跳过、也最不能跳过的一节。**

**方法**：同一模型、同一批任务，跑两套基础工具面——duya 现状 vs Phase 1 之后。

**任务集**（每类至少 3 个任务，固定 fixture，可复跑）：

| 类别 | 任务示例 | 测什么 |
|---|---|---|
| 代码搜索 | "找出所有调用 `createBuiltinRegistry` 的地方" | grep 参数选择是否正确、是否需要重试 |
| 跨文件编辑 | "给这 3 个文件统一改一处 API" | edit 批量 vs 单次的选择、是否读全了文件 |
| 文件读取 | "读出这 3 个文件里所有 TODO 注释及其行号" | read 的 offset/limit vs line_range 的选择正确率 |
| 大输出处理 | "跑一个输出 5MB 的构建并总结" | 结果截断 + 落盘 + 引用是否让模型少读几轮 |
| 多 agent 协作 | "并行调研 3 个方向并汇总" | task 工具的 subagent_type / background 选择 |
| 模式切换 | "先规划再实施" | EnterPlanMode / ExitPlanMode 的使用时机 |

**指标**（每个任务记录，全部要能复跑）：

1. **任务成功率**（主指标）
2. **参数错误率**（工具因 schema 不匹配而失败的次数 / 总调用数）
3. **工具调用次数**（含重试）
4. **端到端延迟**
5. **Token 消耗**
6. **缓存命中率**

**门禁**：
- Phase 1 合并前，基准数字必须在 PR 里贴出**前后对比**。
- **任何指标恶化超过 20% 的改动不算通过**——这是本文唯一的"变红即停"规则。

**注意**：这必须跑**真实模型**。用 fixture 假装模型行为测不出参数错误率——
而参数错误率正是本 plan 的核心假设。

---

## 5. 关键决策与理由

| # | 决策 | 理由 | 备选方案（为什么没选） |
|---|---|---|---|
| D1 | **只做基础工具**，产品能力归 616 | 用户 2026-10-19 决策 | 一并在本文改 browser/canvas/bot → 与 616 T610c/d 重复劳动且冲突 |
| D2 | 改**模型看到的界面**，不改 Ports + Host Adapter 分层 | 分层是 duya 的优势 | 全盘照抄 Claude Code 的工具形态 → 丢掉隔离与端口的可测性 |
| D3 | `edit.edits[]` **保留**，另加单次入口 | 批量原子修改是 duya 强于 Claude Code 的地方 | 改成 Claude Code 的单次形态 → 能力倒退 |
| D4 | 命名按**功能域**切，**今天基本不动** | 实测基础工具命名已符合 Claude Code 形状 | 一律 snake_case → 与 Claude Code 不一致，且无收益 |
| D5 | 8KB 降级**不清空参数结构**，改为截断 description | 今天清空 = 模型完全不知道有哪些参数 = 反复重试 | 只补降级提示不修降级本身 → 模型仍需猜参数名 |
| D6 | 旧工具名**永久保留别名** | 模型的历史对话里还在用旧名 | 直接改名 → 老对话直接断 |
| D7 | 8KB 修复排在 **616 之前** | 616 把 `browser`（9373 字节）搬进 `duya_app` 后会第一次真正触发降级 | 排在 616 之后 → 616 落地即带病上线 |
| D8 | 基准**必须跑真实模型** | 参数错误率只能由真实模型产生 | fixture 模拟 → 测的是 fixture 不是模型 |
| D9 | 8KB 预算**保留**但改造降级方式 | 预算本身是对的（防 MCP 大 schema 撑爆 prompt） | 取消预算 → 单个恶意 MCP server 就能撑爆每轮 prompt |

---

## 6. 与其他计划的关系

| 计划 | 关系 |
|---|---|
| **[616 duya_app 内置 MCP 层](./616-duya-app-mcp-layer.md)** | **本文的边界由它划定**。它搬走产品能力，本文优化留下的基础工具。**D1–D3 是 616 T610d 的前置**（§7 P1-B / §4.2 D4） |
| **610 架构收口系列** | 本 plan **不动** 610 的任何裁决。O7（TaskRun）与 610 的 run 生命周期相邻但不重叠 |
| **580 MCP capability core** | I7 的 D1/D2/D3 直接动 580 产出的 `projection.ts`——**动之前必须与 580 的 owner 确认** |
| **443 search tools hardening** | B2 改 `grep` schema，但 443 的 rg 打包 / timeout / multiline 仍在途。**B2 只动 schema 形状，不动 rg 实现** |
| **496 工具暴露策略** | 基础工具的 exposure 已经够小，本文不改它 |

---

## 7. 需要 616 裁决的三个问题

**这三个问题不解决，本文有部分工作无法开工。**

| # | 问题 | 影响的本文条目 | 建议 |
|---|---|---|---|
| **P1-A** | `WebSearch` / `WebFetch` / `NotebookEdit` 归**基础工具层**还是 **`duya_app`**？ | I4、C1、C2 | **归基础工具层**。Claude Code 就是这么放的，且"搜索/抓取单页/改 notebook"是通用能力，不是"桌面端特殊能力"。`browser` 的 30 个 op 归 `duya_app` 是对的，但**不该把搜索一起带走** |
| **P1-B** | 8KB 降级路径修复（P1-D）**排在 616 之前还是之后**？ | I7 全部 | **之前**。616 的 T610d 把 `browser`（9373 字节）搬进 `duya_app` 后会第一次真正撞上降级；降级后模型收到空 schema + 无解释，会连续重试 |
| **P1-C** | 616 §3 的"基础工具"清单只列了 17 个，**未点名的 ~20 个**（`computer_use` `vision_analyze` `image_generate` `show_widget` `read_module` `send_artifact` `duya_cli` `session` `MessageSession` `SessionSearch` `Brief` `memory_write` `write_stage1_policy` `plan` `update_state` `wait_tasks` `powershell` …）归哪边？ | §1 的边界表 | 616 补全清单。**悬空工具在 616 落地后会既不在基础集也不在 `duya_app`** |

---

## 8. 风险表

| # | 风险 | 触发信号 | 缓解 |
|---|---|---|---|
| R1 | 压平后模型**选错参数**（如 `read` 的 offset/limit vs line_range） | 参数错误率上升 | B1 用测试钉住两套参数**语义等价**；基准指标 2 恶化 >20% 即停 |
| R2 | `bash` 的 `description` 改必填后，**旧对话里的调用缺字段** | 工具调用报参数错误 | 校验层对缺失 `description` **补一个默认值**而非报错——schema 声明必填、执行层宽容 |
| R3 | 与 **443** 同时改 `grep` 造成冲突 | merge 冲突 / 语义打架 | B2 只动 schema 形状，不动 rg 实现；与 443 串行 |
| R4 | D3 删死代码时**误伤测试** | 快照测试红 | **明确要求：同时把 `spec-budget.test.ts` 迁到 plugin-core 那套，不是删掉测试** |
| R5 | 与 **616** 的 D1–D3 前置关系没被遵守，616 带病上线 | `duya_app` 工具参数为空 | 在 616 §4 的 T610d 卡片里加"依赖 617 P1-D 已合" |
| R6 | 基准跑**真实模型**成本高 | 基准跑不动 | 任务集固定 6 类 × 3 = 18 个，可接受；用便宜模型跑基线、高端模型跑终验 |
| R7 | 本文与 616 **编号/范围再次漂移** | 两份 plan 互相引用矛盾 | 本文 §1 的边界表**逐条列出 Out**，并在 §7 显式列出三个待裁决问题 |

---

## 9. 放弃条件

| # | 触发条件 | 为什么该停 |
|---|---|---|
| 1 | Phase 1 完成后，**基准显示核心指标无改善**（成功率持平且调用次数未降） | 说明"基础工具界面是瓶颈"这个假设错了，该回去找真正瓶颈 |
| 2 | 压平后**参数错误率上升超过 20%** | 压平本身有害，该退回原形状 |
| 3 | 616 的 P1-A 答复把 `WebSearch`/`WebFetch`/`NotebookEdit` 全部划给 `duya_app` | 本文的 I4 失去意义，Phase 1 的 P1-C 整卡作废——**提前知道，别做到一半才发现** |
| 4 | 基准需要**跑超过 50 次真实模型调用**才能得出可复跑结论 | 基准本身不可复跑，等于没有基准 |

---

## 10. 文件清单

```
docs/exec-plans/active/617-basic-tool-interface-v2.md   ← 本文
scripts/architecture/tool-schema-census.mjs              ← P0-1
scripts/architecture/tool-schema-budget.test.ts          ← P0-2
packages/host/tests/worker-product-runtime/tool-call-benchmark/  ← P0-3 基准
packages/capabilities/src/tool-aliases.ts               ← A2 别名表（新增）
packages/capabilities/src/ReadTool/ReadTool.ts          ← B1
packages/capabilities/src/GrepTool/GrepTool.ts           ← B2
packages/capabilities/src/EditTool/EditTool.ts           ← B3
packages/capabilities/src/ShellCommandTool/BashTool.ts   ← B4
packages/capabilities/src/NotebookEditTool/              ← C1（新增，归属待定）
packages/capabilities/src/WebSearchTool/                 ← C2（新增，归属待定）
packages/capabilities/src/WebFetchTool/                  ← C2（新增，归属待定）
packages/plugin-core/src/mcp/core/projection.ts          ← D1/D2
packages/agent-runtime/src/tools/catalog/spec-budget.ts ← D3 删
packages/capabilities/src/ShellCommandTool/BashTool.ts   ← E1/E2 共享截断工具来源
```

---

## 11. 下一步

**唯一 next action：P0-1 + P0-2 + P0-5。**

- P0-1 / P0-2 把本文的事实层（§2）从**一次性快照**变成**可持续基线**——
  没有它们，§2.4 的字节数字随时会因其他人的改动而失效。
- P0-2 今天是**绿的**（基础工具最大 `task` 2872，远低于 8192），
  它的作用是**守住**：防止 616 迁移过程中基础工具被拖超预算。
- P0-5 是**给 616 的问题**（§7 P1-A / P1-B / P1-C）。
  **P1-B（8KB 修复排 616 之前）有真实的时序后果**：
  616 的 T610d 一旦落地，`browser`（9373 字节）会第一次真正撞上降级，
  模型收到空 schema + 无解释。**这个顺序必须在 616 开工前谈定。**

**不要先写代码。**
