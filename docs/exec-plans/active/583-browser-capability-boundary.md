# Plan 583 — 浏览器能力边界：引擎抽包 / 能力插件化 / 工具槽位可替换

> 状态：已设计未开工（`backlog/`）。本 plan 0 行代码，全部为调研结论 + 分阶段方案。
> 日期：2026-10-01　范围：`packages/agent/src/tool/BrowserTool/**`、`packages/plugin-core` 插件 capability 面
> 关联：plan 573（内置浏览器产品面，**本 plan 不碰**）、plan 580（tool catalog，已落地部分见 §4）、
> 2026-09-tool-catalog-unification（catalog 设计）、plan 224（ModeModifier）、plan 241（tool_search）、
> plan 419（权限决策总线）、plan 557（`requiresTools` 门控）

## 1. 决策问题

"是否把庞大的浏览器功能拆成一个 plugin，让其他 agent 也能用、管理更方便、脱离核心 agent 能力。"

结论：**方向成立，但"直接抽成 plugin"这一步在 duya 现状下不可行，且会把边界搅浑。**
拆成两条独立的缝：缝 A 做引擎/版本解耦（真正"脱离核心"），缝 B 做能力交付（plugin 真正擅长的事）。
缝 C（plugin 贡献原生 tool）单列为可选，不在首轮范围。

## 2. 现状：三层被混在一起

| 层 | 位置 | 规模（实测 `ReadAllLines`） | 归属 |
|---|---|---|---|
| ① 产品面：Duya 自己的浏览器窗口 | `electron/services/browser/` + `src/components/browser/` | 12 文件 ~3.5k 行 + 4 文件 ~854 行 | **留在 core**，plan 573 拥有 |
| ② 能力内核：LLM 侧 browser 工具 | `packages/agent/src/tool/BrowserTool/` | **85 文件 23,018 行**（非测试 73 文件 21,660 行） | 缝 A 抽出 |
| ③ 工作流原语 | `modes/workflow/browser-runner.ts` + `process/browser-backend.ts` | 256 + 207 行 | 跟着 ② 走 |

第 ① 层的证据（说明它必须留在 core）：daemon 单例被 `electron/core/window-manager.ts:12`、
`electron/core/graceful-shutdown.ts:8`、`electron/ipc/db-handlers.ts:17`（tab 上限）、
`electron/ipc/settings-handlers.ts:22` 持有。把它外包给 plugin 等于把宿主能力交给扩展，边界更糊。

## 3. 耦合面：比文件数小得多

85 个文件里**只有 6 个**引用目录外的东西。全部出向 import 只有 **5 个目标 / 6 个文件 / 9 条 import 语句**：

| specifier | 解析到 | 文件数 | 种类 |
|---|---|---|---|
| `../BaseTool.js` | `src/tool/BaseTool.ts` | 1 | runtime |
| `../../utils/logger.js` | `src/utils/logger.ts` | 2 | runtime |
| `../../utils/urlSafety.js` | `src/utils/urlSafety.ts` | 3 | runtime |
| `../registry.js` | `src/tool/registry.ts` | 1 | 仅类型 |
| `../../types.js` `../../../types.js` | `src/types.ts` | 2 | 仅类型 |

分类结论：

- **79 文件 / 20,880 行自包含**（只依赖 Node 内建、`zod/v4`、`axios`、`jimp`、`playwright`、兄弟文件）——零改写可搬。
- **5 文件 / 2,889 行依赖 agent core**：`BrowserTool.ts`(464，extends `BaseTool`)、
  `CDPClient.ts`(1521)、`DomainBlocker.ts`、`FallbackBrowser.ts`、`ParallelFetcher.ts`、`actions/types.ts`。
- **0 个文件可按 import 判为"产品面"**。`WebviewCDPClient.ts` 虽面向侧栏 `<webview>`，
  但走 `http://127.0.0.1:${DUYA_DAEMON_PORT}` 的 localhost HTTP，不含任何 Electron 类型。
  换言之"产品面 vs 能力面"在 `BrowserTool/` 内部**不是 import 边界**，Phase 1 不得按 import 切。
- `platform-extractors/` + `platform-hooks/`：**34 文件 10,806 行，零 agent-core 依赖**，
  唯一外部依赖是 `ICDPClient`（仅类型）。是最干净的 plugin 形态候选。
- `platform-adapters/types.ts`(35 行) 全仓 0 importer，死代码。

**外部消费点 4 处**（不是 3 处）：

1. `packages/agent/src/tool/builtin.ts:31-33` — `browserTool` + `DomainBlockerConfig`(type) +
   `BrowserBackendMode`(type)；调用 `setDomainBlockerConfig`(`:93`)、`setBrowserConfig`(`:97`)、
   `registry.register(browserTool.toTool(), browserTool, {exposure:'deferred'})`(`:164`)、再导出(`:354`)。
2. `packages/agent/src/tool/bot-builtin.ts:39-41` — 同样三个 import，调用点在 `:82` `:86` `:146`。
3. `packages/agent/src/process/browser-backend.ts:12` — 只要 `ExtensionCDPClient`。
4. `packages/agent/src/process/agent-process-entry.ts:78` — 经 `../tool/builtin.js` 间接引入，
   在 `:4284` 调 `browserTool.setBrowserConfig`。**遗漏这一处会导致运行期 backend mode 静默失效。**

**测试搬迁面**：`packages/agent/tests/BrowserTool/` 13 文件 2,122 行（用 `../../src/tool/BrowserTool/*`
相对路径）、`packages/agent/tests/unit/tools/DomainBlocker.test.ts`、
`packages/agent/tests/unit/tool/builtin-surface.test.ts:22`（**对源码文本断言**
`expect(source).toContain("from './BrowserTool/BrowserTool.js'")`，任何路径变更都会红）。
目录内 `__tests__/parallel-fetcher-text.test.ts:12` mock 了 `utils/urlSafety.js`。

**硬编码宿主假设**：`CDPClient.ts:106` 与 `WebviewCDPClient.ts:20` 在**模块作用域**读
`process.env.DUYA_DAEMON_PORT ?? '19825'`。抽包后包不能在非 DUYA Electron 宿主里裸跑。

## 4. 现有接缝盘点：比预期多

**已落地（plan 580）**，`packages/agent/src/tool/`：

- `catalog-types.ts:6` — `ToolSourceKind = 'builtin' | 'mcp' | 'plugin' | 'connector'`，**`plugin` 已在枚举里**。
- `catalog-identity.ts:21` — `createToolId(source, rawName)` = `${kind}:${encodeURIComponent(id)}:${encodeURIComponent(name)}`。
- `registry.ts:102-110` — `sourceForTool()` 已能把 plugin 拥有的 MCP 工具标成 `{kind:'plugin', id:`${pluginId}:${connection}`}`。
- `registry.ts:86-89` — `ToolOwner = 'non-mcp' | 'mcp' | connector:<id>`；
  `ReplaceableOwner` **显式排除 `non-mcp`**（`replaceByOwner` 永不碰 builtin 工具）。
- `registry.ts:286-295` — `refreshDefinition(name)`，注释直接点名 *"e.g. browser tool mode switch"*。
- `builtin.ts:164` — browser 已注册为 `exposure: 'deferred'` + `inputSchemaSummary`。
- `mcp/mcpService.ts:25-33` — plugin 连接稳定 id 已是 `plugin:<pluginId>:<serverName>`。

**缺口**：

- 全仓**没有任何 builtin 工具设置 `discovery.namespace`**（`builtin.ts` 零命中，
  无 `namespace: 'computer' | 'browser' | ...`）→ browser 的 namespace 当前 fallback 为 `'builtin'`。
  2026-09-tool-catalog-unification 设计的 `computer: / browser:` 能力提示尚未接线。
- `modes/` 里有 `computerUseMode` 但**没有 browser mode**（`modes/index.ts:15-20` 只注册了 6 个 mode）。
- plugin 侧无原生 tool 出口：`packages/plugin-core/src/plugins/loader/capability-discovery.ts:404`
  的 `PluginCapabilities` 只有 `commands | agents | skills | hooks | workflows | mcpServers`。
- `requiresTools` 门控已存在，但只在 **prompt section** 层
  （`prompts/PromptSystem.ts:178`、`:437` 用 `hasAnyEnabledTool`），尚未用于 tool 可见性。

## 5. 外部参照（11 个 clone 的实测结论）

| harness | 浏览器放哪 | 独立版本线 | plugin 供原生 tool |
|---|---|---|---|
| **openclaw** | bundled plugin 包 `extensions/browser/` | 是（`@openclaw/browser-plugin` 自有 `version`，`private:true`） | **是**（`api.registerTool`） |
| **pi** | core 无 | — | **是**（jiti 动态 import TS 模块） |
| browser-use | 核心包内 | 否 | 无插件系统（另有可选 `--mcp`） |
| hermes-agent | 核心 `tools/`，只把**云端 backend** 插件化 | 否 | 是（provider 而非工具面） |
| OpenHarness | 无内置，期望 MCP | — | 无插件系统 |
| codex | 内置 chrome（仅测试 fixture 可证） | — | 否（manifest 无 `tools` 字段） |
| claude-code-haha | 核心内、以 MCP 命名暴露 | 否 | 否 |
| ZCode | **已做过本 plan 的实验**：browser-use/computer-use 是一方 bundled plugin，但**引擎由宿主 `node_repl` MCP 独立注入** | 是 | 否 |
| grok-bot / grok-build | 核心内 | 否 | 否 |
| prime-agent / bloub | 无浏览器能力 | — | — |

**两条更正（推翻 2026-10-01 早先口头结论）**：

1. openclaw **不是**"同名工具被后者覆盖"。`src/plugins/registry.ts:646-655` 用**数组**存，
   `src/plugins/tools.ts:1363-1376` 遇到同名**丢弃后来者**并记 diagnostic。真正机制是
   *内置插件必须根本不加载*（`plugins.entries.browser.enabled = false`，见
   `src/plugins/loader.prefer-over.test.ts:132-141`）。`preferOver` 存在但是**按 channel 作用域**的，
   browser manifest 未声明 `channels`，故不适用。
2. codex 的 `chrome` 插件**不是**可验证的"浏览器独立版本"先例：`**/plugins/chrome/**` 零命中，
   全部引用都在写合成 `marketplace.json` 的测试里（`codex-rs/core-plugins/src/discoverable_tests.rs:162-174`）。
   真正跑通的独立版本线样本是 openclaw 的 `extensions/browser/package.json`。

其他可借鉴点：

- openclaw **无宿主版本协商**（`manifest-types.ts` 无 `version`/`engines`/`apiVersion`），
  唯一强制门是 `contracts.tools` 声明（`src/plugins/registry.ts:610-619` 缺声明即拒绝注册）。
  想要"响亮失败"必须自己加能力/版本检查。
- 懒加载运行时：`createLazyRuntimeModule(() => import('./register.runtime.js'))`
  （`extensions/browser/plugin-registration.ts:25-27`）——重引擎可以开机挂载、首次 `execute` 才付代价。
- codex 的 `ToolExposure::{Direct, Deferred, CodeModeOnly, Hidden}` + BM25 `tool_search`
  （`codex-rs/tools/src/tool_executor.rs:51-80`、`core/src/tools/handlers/tool_search.rs:57-70`）是
  按需加载参考实现；**duya 侧 `exposure: 'deferred'` + `tool_catalog` 已等价，勿重复造**。

## 6. 决策

**缝 A（引擎/版本解耦，Phase 1-2）**——按 codex 思路但落在包上：新 workspace 包
`packages/browser`，对标 `packages/computer-use` 已有形态。agent 侧只留薄适配。
这是"脱离核心 agent 能力"的唯一真实落点，也是对外（MCP 出口）的唯一前提。

**缝 B（能力交付，Phase 3）**——按 ZCode 结论做：plugin 放 skills / platform extractor 扩展 /
`workflows/*.yaml` / `permissions/policy.json`（域名白名单、DOM blocker 策略）/ UI 模板；
**引擎留在宿主包**。ZCode 已用真实工程证明这是成本最低的形制。

**缝 C（plugin 贡献原生 tool，Phase 4，可选）**——仅当需要支持第三方**引擎**时才做。
改动面已定位为 5 处（见 Phase 4）。pi 证明了代价：进程内 import 不可信代码 + 信任弹窗 +
工具名扁平无命名空间。duya 已有 `plugin:` 命名空间纪律（`createToolId`）是其相对优势。

**"其他 agent 也能用"不依赖 plugin**：靠稳定 `tool_id` + `AgentProfile` / `ModeModifier` 即可，
`AgentProfile` 是 base toolset、`ModeModifier` 正交于它（plan 224）。plugin 解决的是
"能力内容复用"，不是"能力可达"。

**明确不做**：

- 不把 20k 行代码塞进 `.duya-plugin` 目录。9/11 harness 的 manifest schema 连 `tools` 字段都没有
  ——这是 schema 边界不是沙箱，加字段等于自造并长期维护宿主契约（版本协商 / 信任 / 命名空间 / 能力声明）。
- 不按 import 边界在 `BrowserTool/` 内部切"产品面 vs 能力面"（§3：不存在这条 import 边界）。
- 不动 `electron/services/browser/**`（plan 573 拥有，且 0 commit 领先 master 说明其工作已并入）。

## 7. Phases

### Phase 0 — 边界冻结与行为基线（不动代码）

- [ ] 在本 plan 顶部固化"非范围"清单：`electron/services/browser/**`、`src/components/browser/**`、
      `electron/preload.ts` 的 browser 通道。
- [ ] 给 4 个外部消费点各补一个 characterization test（`builtin-surface.test.ts:22` 的源码文本断言
      可作为模板，但 Phase 1 改路径后需同步改断言文案）。
- [ ] 记录基线：browser 工具在 `exposure:'deferred'` 下的 `tool_catalog` 行为、
      `refreshDefinition` 在 backend mode 切换后的 schema 变化、`blockedDomains` 生效路径。
- [ ] 确认 `DUYA_DAEMON_PORT` 缺省行为（`CDPClient.ts:106`），决定包外运行时的失败方式：
      抛可读错误还是 fallback 到 `fallback` backend。

### Phase 1 — 缝 A 主体：抽 `packages/browser`

- [ ] 新建 `packages/browser`（`package.json` / `tsconfig.json` 仿 `packages/computer-use`），
      加入 workspace 列表。
- [ ] 搬 79 个自包含文件（整目录 `cp` + 改相对路径前缀，`actions/`、`platform-extractors/`、
      `platform-hooks/`、`__tests__/` 一并）。
- [ ] 三个 runtime 依赖处置，逐个落定：
      - `utils/urlSafety`（`isSafeUrl` / `isSafeUrlSync`）——纯函数，**搬进包**，agent 侧改为 re-export。
      - `utils/logger`——**注入 port**（结构化 logger 实例属 electron 侧，agent 侧构造时传入），
        避免包反向依赖 `electron/logging`。
      - `BaseTool`——**不搬**。`BrowserTool.ts`(464) 留在 `packages/agent/src/tool/`，
        只 import 包内 engine，`toTool()` / `setBrowserConfig` / `setDomainBlockerConfig` 三个
        对外方法签名保持不变，调用方零改动。
- [ ] 迁移 13 个外部测试 + `DomainBlocker.test.ts` + `builtin-surface.test.ts`，同一 commit 内完成。
- [ ] 删 `platform-adapters/types.ts`（0 importer）。
- [ ] 修 `SchemaGenerator.test.ts:110,:127` 中作为**字符串**出现的 `../../src/tool/BrowserTool/actions/parallel`
      路径（可能触发路径敏感加载，需实测确认）。

验收：`npx vitest run packages/agent/tests/BrowserTool packages/browser` 全绿；
`npm run typecheck:web` 无新增错误；4 个外部消费点 import 全部改完且无遗漏（`agent-process-entry.ts`
的间接路径要用运行时 smoke 验，不靠 grep）。

### Phase 2 — 缝 A 收口：catalog 元数据 + 手册归位

- [ ] 给 browser 注册补 `discovery: { namespace: 'browser', tags: [...] }`，
      与 `computer` 形成对称命名空间（顺带把 §4 的"全仓无 namespace"缺口记给
      2026-09-tool-catalog-unification）。
- [ ] `prompt.ts`(487) 的长操作手册从常驻 prompt 迁到 `ToolExecutor.getPrompt()`
      （`registry.ts:50` 已定义该可选钩子，参照 `computer-use-mode.ts` 的分工）。
- [ ] 评估是否新增 `browserMode`（`ModeModifier`，仿 `modes/computer-use-mode.ts`）：
      收益是 mode 切换即可获得/撤销 browser 工具，代价是多一个 mode id + popover 项。
- [ ] 用 `SectionDef.requiresTools`（`prompts/PromptSystem.ts:178`）把 browser 相关 prompt section
      挂到 browser 工具实际启用时才注入。

### Phase 3 — 缝 B：browser plugin（ZCode 形制）

- [ ] 新建一方 plugin 包（走 `packages/plugin-core/src/plugins/builtin/` 现有先例，如 `github` / `notion`）。
- [ ] 内容边界：skills（research / RPA 场景）、`workflows/*.yaml`、
      `permissions/policy.json`（域名白名单 + DOM blocker 策略）、UI 输出模板。
- [ ] **待决**：34 文件 10,806 行的 `platform-extractors/` + `platform-hooks/` 放包内还是随 plugin 分发。
      包内 = 默认可用、开箱即用（当前行为）；随 plugin = 体积小但首启拉起成本上升
      （ZCode 把 computer-use 默认关的理由）。倾向**留包内 + plugin 只做增量**，
      因为 extractors 已是 `exposure:'deferred'`，不占默认上下文。
- [ ] 权限接线：plugin 的 `policy.json` 声明的域名/DOM 策略要真正接进
      `DomainBlocker`，而不是停在 manifest。

### Phase 4 — 缝 C（可选，需先有第三方引擎诉求）

改动面（已定位，约 5 处）：

- [ ] `packages/plugin-core/src/formats/{types,duya,shared}.ts` — manifest 加 `tools` capability 键
      （或 `tools/index.js` + `contracts.tools` 声明，照 openclaw `contracts.tools` 形态）。
- [ ] `packages/plugin-core/src/plugins/loader/capability-discovery.ts:404` — 新增 `discoverTools()`
      并入 `PluginCapabilities`。
- [ ] `packages/agent/src/tool/registry.ts:86-89` — `ToolOwner` 增加
      `` `plugin-native:${pluginId}` `` 变体，否则 `ReplaceableOwner` 排除机制会让原生 tool
      无法被 `replaceByOwner` 作用域化管理（`non-mcp` 被显式排除，`:369-373` 有运行时守卫）。
- [ ] agent 侧新增加载器：`registerWithKey(key, def, executor, owner, meta)`，
      `meta.source = { kind:'plugin', id: pluginId }`。
- [ ] 信任与门控：项目级信任（比照 pi `trust-manager.ts:30-38`）+ `riskTier` 接
      plan 419 权限总线。
- [ ] 冲突策略**显式选型**：openclaw 是"后来者丢弃"（数组 + `continue`），
      duya 若要"可替换默认能力"需明确 first-wins + 显式禁用，或改成显式 `Map<slot, provider>`。
      不要照抄成 last-write-wins，也不要留成隐式行为。

## 8. Gates

- Phase 1：`npx vitest run packages/agent/tests/BrowserTool packages/browser`；
  `npm run typecheck:web`；worktree 内先 junction `node_modules`（根 + 各 workspace 包）否则报假 TS2307。
- Phase 2：`npm run typecheck:all`；Playwright 验 tool_catalog 对 browser 的 namespace 提示。
- Phase 3：`npx vitest run packages/plugin-core`；plugin 安装/卸载后工具可见性回归。
- Phase 4：`npm run typecheck:all` + 完整 vitest；**真实 Electron renderer 内验 preload 路径**，
  浏览器态不可用纯 Vite 验证。
- 全程：任何阶段都不跑 `npm test` 与 `npm run electron:dev` 并行（共享 `better-sqlite3` 二进制）。

## 9. 未验证项（后续需要补证据）

- codex `DynamicToolSpec` 的**方向**（宿主 → core）未读注册调用点，只确认它是协议类型、
  非 plugin 路径。
- openclaw 版本错配（plugin 声明的 `contracts.tools` 新于宿主）时的**失败形态**无测试断言。
- `SchemaGenerator.test.ts:110,:127` 的字符串路径是否触发路径敏感加载。
- `platform-extractors/` 与 `platform-hooks/` 之间、以及它们与 `actions/` 之间的**运行时**耦合
  （本次只静态核了 import 边）；`Registry` 动态拼装可能有静态 import 看不到的耦合。

## 10. 决策记录

- 2026-10-01：选 583 而非 582 —— `backlog/581-chain-ab-runtime-merge-evaluation.md` 的索引行
  已把 "plan 582+" 预留给 chain-ab 执行。
- 2026-10-01：方案从"整体抽成 plugin"修正为"缝 A 抽包 + 缝 B 插件"。
  依据：11 个 harness 中 9 个的 manifest 无 `tools` 字段；ZCode 已实测"plugin 装 skill、
  引擎留宿主"是可行形制。
- 2026-10-01：更正早先口头结论——openclaw 的同名工具**不是**覆盖式替换，而是内置插件须先禁用；
  codex 的 chrome 插件**不可**作为独立版本线先例引用，改以 openclaw 为样本。
- 2026-10-01：发现 plan 580 的 catalog 机制（`source.kind:'plugin'` / `ToolOwner` /
  `replaceByOwner`）已落地，故缝 C 改动面比预期小（约 5 处），无需新建注册表。
