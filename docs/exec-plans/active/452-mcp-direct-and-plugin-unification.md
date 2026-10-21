# Plan 452: MCP Direct 暴露 + 插件统一载体（app 并入插件）

> **Status**: Phase A 实现，Phase B/C 待开工
> **Priority**: P1
> **Created**: 2026-08-27
> **前置**: Plan 450（mention 框架 Phase G/H 已落地）、Plan 241（tool_search）、Plan 312（app connection 基础设施）
> **用户决策**（2026-08-27）：
> 1. **MCP** 工具暴露默认 Direct + 设置页全局开关回退；**不依赖模型能力标注**（duya 面向所有模型）。
>    **connector（App）工具不在此列**：恒 discoverable，@ 提及当轮暴露，不 @ 只能 tool_search（见 D2）
> 2. 插件 = mcp + skill + app 的集合；**引用式声明**（manifest 引用 provider id，OAuth/凭据/连接表/审批记忆全部不动）
> 3. @ 弹层只出现插件；单 app 连接入口移除；**插件安装时若声明 app 则自动发起连接**

## Codex 参照（已核实源码）

| # | 事实 | 位置 |
|---|---|---|
| R1 | 暴露规则一条管两边：`exposure = search_tool_enabled ? Deferred : Direct`，同一循环处理 MCP 与 app 工具 | `core/src/mcp_tool_exposure.rs:89-93,114` |
| R2 | `search_tool_enabled = model.supports_search_tool && provider.namespace_tools`——按模型/API 能力自动（OpenAI Responses `AdditionalTools` 托管） | `core/src/tools/spec_plan.rs:578` |
| R3 | 插件 manifest 声明 `paths: { skills, mcp_servers, apps, hooks }`；`AppDeclaration { name, connector_id }` 只引用不定义凭据 | `plugin/src/manifest.rs:20-26`、`plugin/src/lib.rs:31` |
| R4 | `PluginCapabilitySummary { has_skills, mcp_server_names, app_connector_ids }` 供 mention/搜索聚合 | `plugin/src/lib.rs:51` |

**duya 差异**：duya 的 tool_search 是纯客户端实现（任何 function-calling 模型可用），无需 API 托管；故 Direct/Deferred 的选择交给用户开关而非模型探测（用户明确：面向所有模型，不赌能力标注）。

## 现状修正（2026-08-27 核实）

- MCP 工具**已是 Direct**（`mcp/apply.ts:560`，plan 241 改为 `exposeMode: 'always'`）
- 仍是 discoverable 的是 **App connector 工具**（`AppConnectionTool/index.ts`）与内置辅助工具
- plan 450 的 `preExposedConnectorTools` 预暴露机制**保留**（connector 的 @ 激活依赖它）

## Phase A: MCP Direct 暴露 + 回退开关 ✅（2026-08-27，含一次方向修正）

> **修正记录**：初版把 connector 工具也改成了 `always`（过度对齐 codex 的统一规则）。
> 用户澄清期望语义是「@ 才暴露，不 @ 只能 tool_search，提示词层只有常驻段」——即
> plan 450 Phase A 原设计。已回滚 connector 侧，本计划 Direct 化仅覆盖 **MCP**。

- [x] `[tools] on_demand_discovery` 配置（默认 false=MCP Direct；env
      `DUYA_TOOLS_ON_DEMAND_DISCOVERY` 覆盖）—— `packages/agent/src/config/tool-exposure.ts`
- [x] MCP 注册点接入开关 + **schema 字节预算降级**（`tool/spec-budget.ts`：
      >8KB schema → 空对象 schema + description 提示，工具仍可调用）——Direct 后防 prompt 膨胀
- [x] **connector 工具保持 `discoverable` + @ 预暴露**（用户拍板，非 codex 的统一规则；
      这是 duya 有意的差异，写入下方设计决策）
- [x] @ popover 移除 `mcpItem`（MCP 服务器开关只留设置页；popover 的 mcp submenu
      渲染分支成为不可达代码，留待 Phase C 弹层重构一并清理）
- [x] 设置页 MCPSection 新增全局「按需工具发现」toggle（`tools.on_demand_discovery`，
      文案注明不影响 App 连接器）
- [x] 测试：spec-budget 4 + tool-exposure 4 全绿；typecheck web/agent 干净；bundle 重建

## 设计决策（用户拍板）

| Decision | Choice | Reason |
|---|---|---|
| D1 MCP 暴露 | 默认 Direct + `[tools] on_demand_discovery` 用户开关回退；不做模型能力门控 | duya 面向所有模型，不赌能力标注 |
| D2 connector 暴露 | 恒 `discoverable`，@ 提及当轮预暴露，不 @ 只能 tool_search；提示词层靠常驻 Apps 段维持认知 | 用户明确的产品语义「@ 才激活」；与 codex 的统一规则是**有意的差异** |
| D3 App→插件 | 引用式声明（manifest 引用 provider id），OAuth/凭据/连接表/审批记忆不动 | codex `AppDeclaration` 同款；迁移成本最小 |
| D4 @ 粒度 | @ 只出现插件；安装插件自动连接其 app；单 app 连接入口移除 | 用户产品决策 |

## Phase B: 插件声明 apps + 官方插件化（待开工）

- [ ] plugin-core `capability-discovery` 加 `discoverApps`：`<pluginDir>/.app.json`
      （或 manifest 字段）声明 provider id 列表——引用式，连接层零改动
      （**定义式**声明新 connector 不在本计划范围 → [plan 455](./455-open-connector-registry.md)）
- [ ] 内置 10 provider（google/slack/microsoft365/wecom/figma/supabase/sentry/vercel/notion/linear/github）
      → 官方插件包（每 provider 一个，声明其 app + 相关 skills/mcp servers）
- [ ] 插件安装流程接 appConnection:connect：安装时检测 apps 声明 → 自动发起 OAuth
      loopback；连接状态挂插件详情页
- [ ] 设置页收敛：Connections 的独立「添加连接」入口移除（连接管理/断开/重授权保留，
      挂到插件详情）；Marketplace 单 app 连接项 → 插件项
- [ ] 连接数据迁移：现有 app_connections 行与插件的归属关系（provider id 即关联键，无需数据迁移）

## Phase C: @ 弹层插件化 + plugin:// mention（待开工）

- [ ] connectorItems → pluginItems：@ 弹层列已安装插件（label=插件名，description 聚合
      其 skills/mcp/apps 能力；codex PluginCapabilitySummary parity）
- [ ] mention scheme：选中插件 → `[插件名](plugin://config-name)`；保留 `app://` 兼容
      旧历史链接
- [ ] agent 侧 `plugin://` 收集 + 注入：codex `render_explicit_plugin_instructions`
      parity（该插件可用的 apps/mcp servers/skills 前缀说明，4KB 截断）
- [ ] 常驻段整合评估：Apps (Connectors) 段与 MCP capability catalog 段是否合并为
      「插件能力段」
- [ ] SlashCommandPopover 的 mcp submenu 死分支清理 + 键盘导航索引简化

## Success Criteria

| Area | Standard |
|---|---|
| 暴露 | MCP 与 connector 工具默认每轮可调；开关打开后回退 tool_search；重连后生效 |
| 防膨胀 | >8KB schema 工具降级可调用；prompt 无巨型 schema |
| 插件 | 插件声明 app → 安装即自动连接；@ 搜到插件即提及；单 app 连接入口不存在 |
| 兼容 | 旧 `app://` 历史链接不炸；不装插件的用户路径与 450 一致 |
