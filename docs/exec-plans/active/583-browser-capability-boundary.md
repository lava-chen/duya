# Plan 583 — 浏览器能力边界：引擎抽包 / 能力插件化 / 工具槽位可替换

> 状态：**active**（2026-10-01 由 backlog 提升）。Phase 0 接缝设计已定，Phase 1 开始搬迁。
> 日期：2026-10-01　范围：`packages/agent/src/tool/BrowserTool/**`、`packages/plugin-core` 插件 capability 面
> 关联：plan 573（内置浏览器产品面，**本 plan 不碰**）、plan 580（tool catalog，已落地部分见 §4）、
> 2026-09-tool-catalog-unification（catalog 设计）、plan 224（ModeModifier）、plan 241（tool_search）、
> plan 419（权限决策总线）、plan 557（`requiresTools` 门控）

## 0. 已定决策（2026-10-01）

| 决策点 | 结论 |
|---|---|
| `platform-extractors/` + `platform-hooks/`（34 文件 10,806 行） | **留在包内**，不随 plugin 分发。理由：已是 `exposure:'deferred'` 不占默认上下文；随 plugin 分发会把首启成本推给用户（ZCode 把 computer-use 默认关的理由） |
| 插件化范围 | 缝 B（skills / workflows / 权限策略 / UI 模板）按"怎么安全怎么来"推进；**引擎不进 plugin** |
| 缝 C（plugin 贡献原生 tool） | 保留在计划内，不在首轮路径上；等有第三方引擎诉求再启动 |
| 迁移安全性 | 逐阶段推进，每阶段独立可回滚；`utils/logger` 走注入 port，`utils/urlSafety` 搬入后 agent 侧留 re-export（单一实现） |

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

- [x] 固化"非范围"清单：`electron/services/browser/**`、`src/components/browser/**`、
      `electron/preload.ts` 的 browser 通道。见 §2 第 ① 层证据。
- [x] 接缝设计定案（2026-10-01，逐项附实测依据）：

  | 接缝 | 结论 | 依据 |
  |---|---|---|
  | `BaseTool` | 适配层 `BrowserTool.ts` **留在 agent**，不进包 | 它 `extends BaseTool`（`BaseTool.ts:80`）并提供 `toTool()`（`:234`）/`setBrowserConfig`/`setDomainBlockerConfig`，是 agent-tool 契约本身 |
  | `utils/logger` | 包内定义 `BrowserLogger` port + `setBrowserLogger()`，agent 侧注入 `getLogger()` | 包内仅 2 文件 14 处调用（`CDPClient.ts` 9 处、`BrowserTool.ts` 5 处）；且 `AgentLogger` 的签名 `(message, context?, component?)` / `error(message, error?, context?, component?)`（`utils/logger.ts:232-288`）与 port **结构同构，注入时零适配器** |
  | `utils/urlSafety` | **整体搬进包**（351 行，只依赖 `dns/promises`），agent 侧 `src/utils/urlSafety.ts` 变为 re-export | 消费者只有 5 处（`agent-process-entry.ts`、`session/db.ts` + BrowserTool 内 3 处），re-export 后这 2 个 agent 调用点零改动，且保持单一实现 |
  | 解析方式 | agent 侧走 `@duya/browser/src/...` 深层直引（免 build），配 `tsconfig paths` + `vitest` alias | 与既有先例一致：`catalog-identity.ts:10` 就是 `@duya/plugin-core/src/mcp/core/descriptor.js`；`vitest.config.ts` 已有 worktree-safe 的 `PLUGIN_CORE_ROOT` alias 同款写法 |
  | 目录形态 | agent 侧保留 `src/tool/BrowserTool/` 作**适配层目录**（只留 `BrowserTool.ts` + `index.ts` + 其测试） | 保住 `builtin.ts:31` / `bot-builtin.ts:39` / `builtin.ts:354` 三处 `./BrowserTool/BrowserTool.js` 路径不变，`builtin-surface.test.ts:22` 的源码文本断言**无需改动** |
  | 死代码 | 删 `platform-adapters/types.ts`（35 行，全仓 0 importer） | 已在依赖扫描中确认 |

- [ ] 给 4 个外部消费点各补一个 characterization test。特别是
      `process/agent-process-entry.ts:4284` 的间接路径——它经 `../tool/builtin.js` 引入
      `browserTool` 并调 `setBrowserConfig`，**按显式 import grep 搬迁会漏掉**。
- [ ] 记录基线：browser 工具在 `exposure:'deferred'` 下的 `tool_catalog` 行为、
      `refreshDefinition` 在 backend mode 切换后的 schema 变化、`blockedDomains` 生效路径。
- [x] `DUYA_DAEMON_PORT` 缺省行为已确认：`CDPClient.ts:106` 与 `WebviewCDPClient.ts:20`
      在**模块作用域**读 `process.env.DUYA_DAEMON_PORT ?? '19825'`，端口不可达时由
      `backend-resolver.ts:35-53` 的降级链兜到 `webview` / `fallback`。
      决策：**保持现状**（不在包边界抛错），降级链本身就是容错设计；包外运行落到 `fallback`。


### Phase 1 — 缝 A 主体：抽 `packages/browser`

- [x] 新建 `packages/browser`（workspace glob `packages/*` 自动纳入；`package.json` / `tsconfig.json`
      对标 `packages/computer-use` 的**已构建包**形态，见下方"解析方式"修正）。
- [x] 搬 79 个自包含文件 + 4 个依赖文件（`git mv` 保历史）：引擎 21 个根文件 + `actions/`、
      `platform-extractors/`、`platform-hooks/`、`__tests__/` 进 `packages/browser/src/`。
- [x] 三个 runtime 依赖处置：
      - `utils/urlSafety`（`isSafeUrl` / `isSafeUrlSync`）——**已搬进包**
        （`packages/browser/src/urlSafety.ts`），agent 侧 `src/utils/urlSafety.ts` 变为 re-export shim，
        `agent-process-entry.ts` / `session/db.ts` 两个消费者零改动，且保持单一实现。
      - `utils/logger`——**已注入 port**（`packages/browser/src/logger.ts`）：`BrowserLogger`
        接口 + `setBrowserLogger()`，未注入时落到静默 no-op。适配层 `BrowserTool.ts` 模块作用域
        调 `setBrowserLogger(logger)`，因 `AgentLogger` 签名与 port 同构，**无适配器代码**。
      - `BaseTool`——**不搬**，按 §7 Phase 0 的决策，适配层留在 `src/tool/BrowserTool/`。
- [x] 迁移 13 个外部测试 + `DomainBlocker.test.ts` 到 `packages/browser/tests/`（14 个文件，
      按各自目录深度重算相对路径）。`BrowserTool.test.ts` 测的是**适配层**，已移回
      `packages/agent/tests/BrowserTool/`。`builtin-surface.test.ts:22` 的源码文本断言
      因适配层路径未变而**无需改动**。
- [x] 删 `platform-adapters/types.ts`（35 行，全仓 0 importer）。
- [x] `SchemaGenerator.test.ts:110,:127` 的动态 `import()` 字符串已改为 `../src/actions/parallel`
      （实测确为路径敏感的动态 import，扩展名可省略，vite 正常解析）。
- [x] 删除 `actions/types.ts` 里零消费者的 `ActionResult` 别名及其 `ToolResult` 依赖
      —— 引擎由此**彻底不再依赖 agent 类型**，比镜像定义更干净。

**解析方式修正（实测后与 Phase 0 初稿不同）**：初稿设想 `@duya/browser` 走 `tsconfig paths`
指向源码。实测不可行——agent 是用 tsc **真实产出 dist** 的（`build:agent` → `tsc`），
`rootDir: ./src` 必须守住，而 paths 指向 `.ts` 会把包源码拉进 agent 的 program，
触发 72 个 `TS6059`。最终形态对标 `@duya/computer-use`：

| 消费者 | 解析到 | 手段 |
|---|---|---|
| `tsc`（agent 类型检查） | `packages/browser/dist/index.d.ts` | agent tsconfig `paths` |
| esbuild（agent bundle） | `packages/browser/src/index.ts` | `build-agent-bundle.mjs` 的 `alias`（否则会把 `.d.ts` 内联进 bundle） |
| vitest | `packages/browser/src/index.ts` | `vitest.config.ts` 的 `resolve.alias` |
| 构建顺序 | — | 新增 `build:browser`，串进 `build:agent` 与 `typecheck:agent` |

`@duya/plugin-core` 走的是 `node_modules` 里的 npm Junction（`main: src/index.ts`），
worktree 内不存在该 Junction，故未沿用。

验收进展（2026-10-01）：

- `npx tsc --noEmit -p packages/browser` → **0 错误**
- `npx tsc --noEmit -p packages/agent` → **0 错误**
- `npx vitest run packages/browser` → **25 文件 / 234 用例全绿**（迁移前该组为 232 用例、
  **4 红**；已在基线 `e1bc1650` 原始路径复现同一批红，确认是既有失败而非搬迁引入）
- 顺手修掉 4 个既有红（见下方"顺手修掉的既有红"）
- 归因方法：建 `browser-baseline` worktree（detached `e1bc1650`）跑同一组测试逐条比对，
  剩余 12 个失败与基线同组失败**逐一对应**（适配层 `file://` 1 + `tool-catalog` 2 +
  `fileReadState` 3 + `ReadTool` 4 + `GrepTool` 1 + `PlanTool` 1），零回归。
  适配层 `file://` 失败断言文本在搬迁前后**逐字相同**
  （`expected '### Page...' to contain 'Local snapshot'`），确认与 import 变更无关。
- 待办：真实 Electron 内的 browser 行为 smoke（`agent-process-entry.ts:4284` 的间接
  `setBrowserConfig` 路径不能只靠 grep 验证）。
- `npm run bundle:agent` 在 Phase 1 后实测通过：产物 5.02 MB，且用 `CDPClient` 独有的
  字符串 `Extension mode connected` 确认引擎确已内联（alias 若失效会编译失败或整包缺失）。
  esbuild 的 `alias` 值必须是**绝对路径**——相对路径会被当成包名，报
  `Could not resolve "packages\\browser\\src\\index.ts"`。

**顺手修掉的既有红**（均在引擎内，现归本 plan 所有）：

1. `backend-resolver.test.ts` human-like 用例把期望写反了。`resolveBackend('human-like', true, false)`
   传 `extensionOnline=true`，按 `backend-resolver.ts:45` 的契约"扩展在线即可用 human-like，
   无需 renderer"，应返回 `'human-like'`。已改为断言真实契约，并补
   `('human-like', false, false) → 'fallback'` 这一真正降级的用例。
2. `actions/screenshot.test.ts` 3 个用例仍断言旧的 `result.screenshot`，但实现早已改为
   **优先落盘 `filePath`**、仅在写失败时回退内联 data URL。已改为
   用 `vi.mock('node:fs/promises')` 让两条分支都确定可测：默认路径断言写盘的文件名与字节，
   新增"写盘失败"与"建目录失败"两个内联回退用例（用例数 232 → 234）。


验收：`npx vitest run packages/agent/tests/BrowserTool packages/browser` 全绿；
`npm run typecheck:web` 无新增错误；4 个外部消费点 import 全部改完且无遗漏（`agent-process-entry.ts`
的间接路径要用运行时 smoke 验，不靠 grep）。

### Phase 2 — 缝 A 收口：catalog 元数据 + 手册归位

- [x] 给 browser 注册补 `discovery: { namespace: 'browser', tags: [...] }`
      （`builtin.ts` + `bot-builtin.ts` 两处，两侧解析出同一个稳定 `tool_id`）。
      **顺带记录的仓级缺口**：全仓**没有任何 builtin 工具**设过 `discovery.namespace`，
      全部 fallback 到 `'builtin'`。`computer_cua` / `computer_use` 同样未设，
      命名空间提示（`computer: screenshot, desktop interaction…`）在
      2026-09-tool-catalog-unification 落地前无法生效——已记给该 plan，本 plan 不越界修。
- [x] **手册可达性（修正了本 phase 的原前提）**。原写"把 `prompt.ts` 从常驻 prompt 迁到
      `ToolExecutor.getPrompt()`"，实测前提有误：`prompt.ts` **早已只**挂在 `getPrompt()` 上，
      真正的问题是——`ToolExecutor.getPrompt?()`（`registry.ts:49-50` 声明，注释写着
      "injected after on-demand discovery"）**全仓没有任何消费方**。
      在 `ToolCatalogTool` / `ToolInvokeTool` / `dispatcherFromRegistry` /
      `tool-search-discovery.ts` 中 grep `getPrompt|guide|usage` **零命中**。
      即：browser 约 20 KB 的操作手册、SkillTool / BriefTool / 两个 plan-mode 工具 /
      `image_generate` 的手册**全部对模型不可见**。模型此前只看到
      `BROWSER_TOOL_DESCRIPTION` 的 1,017 字符。
      已在 `tool_catalog` 的 **detail 响应**接线（模型已锁定单个工具、正要读全量 schema 的时刻），
      带 12,000 字符上限 + 显式截断标记；抛异常 / 非字符串 / 空白一律省略，绝不让缺手册
      变成 schema 读取失败。search / list 结果不注入，保持发现路径轻量。
- [x] 用 `SectionDef.requiresTools`（`prompts/PromptSystem.ts:178`）把 browser 相关 prompt section
      挂到 browser 工具实际启用时才注入。**当前无 browser 专属 prompt section**
      （`prompts/configs/{general,code,bot}.ts` 里没有），故本项**无需改动**，
      机制已就位、待真有 section 时再用。
- [x] **不新增 `browserMode`**（用户决定 2026-10-01）。保持 `exposure:'deferred'`，
      browser 通过 `tool_catalog` 按需发现即可。加 mode 的收益只是多一个入口，
      代价是新增 mode id + popover 入口（plan 224 三步注册），且产品面归 plan 573。
      本项就此关闭，不再挂待决。

验收：`tsc -p packages/agent` 0 错误；`vitest run packages/agent/tests/unit/tool-catalog`
仅剩 2 个既有红（`tool_invoke` schema-read，与本改动无关）；新增 7 个 usage-guide 用例 +
2 个适配层手册存在性用例全绿。
`npm run typecheck:web` exit 0；`npm run bundle:agent` 产出 5.14 MB，并逐项确认压缩产物内
含引擎（`Extension mode connected`）、`usage_guide` 接线、`namespace:"browser"` 与
`scraping` tag——即 Phase 2 的两处改动都真正进了 ship 出去的 bundle。



### Phase 3 — 缝 B：browser plugin（ZCode 形制）✅ 已落地

落地于 `82f07912`（plugin + 测试）与 `909234ba`（手册修 github 枚举）。
目录 `packages/plugin-core/src/plugins/builtin/browser/`，5 个文件：

- [x] `.duya-plugin/plugin.json` — `category: automation`（在
      `src/lib/plugin-types.ts:370` 的 `PluginCategory` 联合内；相邻的
      `plans` 用了不在联合内的 `developer-tools`，是既存不一致，未跟随）。
      **无 `setup`**：引擎已在应用内，没有安装或连接动作可做。
- [x] `assets/icon.svg` — 16×16，与 `github` 同规格。
- [x] `permissions/policy.json` — 只写**确实被执行**的三个 tier 字段。
- [x] `skills/browser-research/SKILL.md`（568 字描述）— 多源调研 + provenance、
      批量读取、SPA/XHR 数据回收、交叉验证、以及必须上报而非绕过的
      付费墙 / 登录墙 / CAPTCHA / 限流。
- [x] `skills/browser-automation/SKILL.md`（636 字描述）— 表单填写、多步流程、
      每次写操作后验证、重渲染后 ref 失效、原生 dialog 恢复、以及
      支付 / 凭据 / 删号 / 发帖的不可逆写闸门。
- [x] `electron/plugins/builtin-browser-plugin.test.ts` — 9 用例，见下。

**原计划内容清单的收敛（主动缩小，非遗漏）**

§0 的缝 B 范围写的是「skills / workflows / 权限策略 / UI 模板」。本次只交付了
**skills + 权限策略**两项，另两项**主动推迟**：

- `workflows/*.yaml`：模板化流程的前提是先有稳定的场景词汇。operation 名刚
  从 23 订正为 35、hidden 语义刚定清，立刻把流程写进模板等于把会变的东西
  固化。等 skill 在真实任务里跑过一轮，沉淀出重复出现的步骤再抽模板。
- UI 输出模板：属于产品面（相邻 plan 573），不在本 plan 动。



原写「`policy.json` 声明的域名/DOM 策略要真正接进 `DomainBlocker`，而不是停在
manifest」——**这条前提是错的**，故没有实现它：

- `permissions[].domains` 确实在传递（`PluginManager.ts:480,561`）、确实在 UI
  展示（`PluginPermissionReview.tsx:67`）、也确实到达 daemon（`daemon.ts:569`）。
- 但**导航拦截的实际执行者是设置驱动的 `DomainBlocker`**，daemon 收到的
  `blocked_domains` 来自扩展设置，不是来自 manifest 声明。
- 所以在本插件里写 `domains` 只会是装饰性字段：读得到、传得下去、但拦不住
  任何东西。宁可只声明三个真被执行的 tier 字段，也不制造一个看起来在管事
  的空壳。真要统一，得单独立项改 `DomainBlocker` 的数据源——那是产品面改动，
  不属于本 plan。

**实测事实（写作过程中核出来的，不靠推测）**

- operation 实为 **35 个**，其中 `post` / `twitter_post` 标了 `hidden: true`
  → schema 枚举里只有 **33 个**。（`BrowserTool.ts` 头部注释写的「23 operations」
  是陈旧的。）
- `tool_catalog` 入参只有 `query` / `tool_id` / `namespace` / `cursor`，且
  `additionalProperties: false`。skill 一开始写成了臆造的
  `{action:'detail', target:'browser'}`，会被直接拒收——已改。
- `tabs_select` / `tabs_close` 的参数是 `target`（tab index 或 id），
  不是 `index`。
- `file_upload` 用 **CSS `selector`** 而非 ref——全套里唯一的例外。
- `file_upload` / `cookies` / `network_start` / `network_read` 与整套坐标操作
  在 fallback（无 CDP）下一律**报错而非降级**。
- 手册 `prompt.ts` 的 search engine 枚举漏了 `github`（schema 里有，
  `ALL_ENGINES` 里也有，模型读不到）→ 已在 `909234ba` 修掉。

**为什么 skill 不重复手册**

Phase 2 已把 ~20 KB 手册接到 `tool_catalog` 的 detail 响应。手册负责
「有哪些 operation、参数长什么样、网络环境决策表、安全规则」；skill 只补
手册表达不了的东西——调研工作流与审批姿态。这也是先接手册、再写 skill 的
顺序要求：否则 skill 会固化成一份会过期的 operation 清单。

**测试的取舍**

不造 fixture，直接读**真实出货目录**（`catalog-builtin.test.ts` 造 fixture，
测的是扫描器；这里要测的是产物本身）。另外加了一条**反臆造 API** 断言：
两个 SKILL.md 里所有 `"operation": "x"` 字面量和所有反引号包裹的
snake_case token，都必须存在于 `getAllActions()`。这条守卫在写作时真的抓到了
`tool_catalog` / `usage_guide` 两个误报（也确证了它不是空转）。

变异测试证明它有牙：把 `writeActionsRequireApproval` 拼错成
`writeActionsRequire_Approval`，`readPermissionsPolicy` 会静默把该字段丢成
`undefined`（`JSON.parse` 失败被 `catch` 吞掉），测试立刻红。

### Phase 4 — 缝 C：plugin 贡献原生 tool ⚠️ 原「约 5 处」估计被推翻

**用户 2026-10-01 决定启动**（不再等第三方引擎诉求：这是通用 harness 缺口）。
但启动前的调研把原估计推翻了，故先重写这一节再动手。

#### 原估计错在哪

原文字假设「plugin 已有某种执行路径，只要加个 `tools` manifest 键 + 加载器即可」。
**实测前提不成立**：

- **duya 的 plugin 目前贡献零可执行代码。** 真正被执行的只有三类：
  MCP 子进程（`mcp/collect.ts:75-99`，且需 `enabled === true`）、markdown
  skills/commands/agents、YAML workflows。全仓找不到任何把 plugin 目录里的
  `.js`/`.ts` 做 `import` / `createRequire` / `vm` / worker 的路径。
- **plugin 声明的 hook 从不执行。** 消费者只有 manifest 映射、能力计数、UI DTO 三处。
  真正会执行的 hook 系统（`agent/src/hooks/executor.ts:202` spawn / `:297` fetch）只从
  `~/.duya/config.toml` 的 `[hooks] files` 读定义，而唯一的写入者是 `hooks add` CLI。
  **⚠️ 更正（2026-10-01，`968d18c5`）**：本 plan 原写「两套格式互不兼容
  （数组 vs 对象，`hooks-json.ts:64-72` 明确拒数组）」——**错**。真实情况是
  `discoverHooks` 单方面只接受顶层**数组**，而执行侧的 `parseHooksJsonContent`
  解析**对象**，且仓内自带一份合规样本
  `packages/agent/skills/.system/memory-search/hooks.json` 用的就是对象。
  即：约定只有一个（对象），发现层写错了。已修 `discoverHooks`。
  **但「不执行」这半仍然成立**——没有任何代码把 plugin 的 hook 文件喂进
  `readHooksConfig()`，所以发现对了也仍然不跑。这才是 G2（真正的接线）。
- **信任模型是死元数据，从未被执行。** 这是最关键的一条：
  `trust-engine.ts` 的 `PluginTrustLevel` 与 `TrustLevelCapability`
  （`maxHooks` / `allowHttpHooks` / `maxFileAccess` / `requirePermissionConfirmation`）
  由 `source` 字符串算出（`:61-86`）后存进 registry，但——**本计划复核过全仓调用方**：
  - `getCapabilities()` 只有一个调用点：`electron/ipc/plugin-handlers.ts:630`，
    且是**只读 IPC 查询**（`plugin:security:trust-info`）。
  - `meetsMinimumLevel` 在 `electron/` 与 `packages/agent/src/` 下**零调用方**。
  - `PermissionService.checkPermission`（自述为"不在热路径的审计账本"）**零运行时调用方**。
  - 安装时**无信任提示**：`plugin:install` 装完直接 `enabled = true`
    （`PluginManager.ts:491`），唯一拒绝是企业 blocklist（`:345-353`）。

  也就是说：**「按信任分层决定 plugin 能干什么」这个机制今天不存在，只有
  「启用了没有」。**

  ⚠️ **措辞边界（别读大）**：这只针对 trust **分层**。**MCP 调用时门控是真实生效的**——
  `decideMcpSource`（`permissions/permissions.ts:289`）对 `plugin` / `local` / `unknown`
  一律 `ask`、永不自动批准，且在 `hasPermissionsToUseTool`（`:357`）与 MCP executor
  （`mcp/apply.ts:502`）两处都生效。所以「plugin 提供的 MCP 能力会静默执行」是**错的**。
  缺口在**安装/激活时**与**能力分层**，不在执行时。精确边界见
  [584 §1.2](../completed/584-plugin-trust-enforcement.md)。

  这意味着缝 C 一旦落地，将是这个应用**第一次**允许 plugin 作者的文件在主进程 /
  agent 进程内执行代码——而能按信任档位约束它的分层恰好是未接线的。这不是"加个键"，
  这是安全架构工作。原「约 5 处」的估计因此不成立。

#### 但 duya 的注册表侧位置比两个参照物都好

调研同时发现 duya 在冲突处理上**已经优于** openclaw 和 pi，不必照抄任何一方：

- MCP 工具已有**双身份**机制：`internalKey`（registry 键，`mcp__<server>__<tool>`，
  `mcp/index.ts:782`）+ `providerName`（模型可见名），经
  `computeProviderName`（`@duya/plugin-core`，`mcp/provider-tool-name.ts`）分配，
  冲突时按 `__2` / `__3` 后缀 + 哈希截断。**即：冲突靠构造消除，不靠策略。**
- `replaceByOwner(owner, entries)`（`tool/registry.ts:349-437`）是
  **validate-then-commit 原子替换**：三阶段（校验 / 算 diff / 单块提交），
  任一阶段失败保证 registry 逐字节还原。
- 跨 owner 键冲突**直接抛错**（`:383-388`），所以 `replaceByOwner` 永远无法顶掉
  `non-mcp` 内置工具。
- 已有两个可直接照抄的先例：MCP 走 `apply.ts` → `DuyaAgent.setActiveMCPRuntime`
  → `replaceByOwner('mcp', …)`；App-Connection 走
  `tool/AppConnectionTool/index.ts:290-318` 的**按 owner 分桶**再逐桶提交。
- catalog 侧**零改动**：`ToolSourceKind` 已含 `'plugin'`
  （`tool/catalog-types.ts:6`），`sourceForTool` 已会为 plugin 拥有的 MCP 工具
  返回 `kind:'plugin'`。

#### 三个参照 harness 的实测（`E:\cloned-projects`）

| harness | 磁盘 | plugin 原生 tool | 冲突策略 | 信任门控 |
|---|---|---|---|---|
| openclaw | ✅ | ✅ 进程内 `registerTool` | **first-wins，后来者丢弃**（`plugins/tools.ts:1363-1376` `continue`）；占名需先显式禁用内置（`docs/tools/browser.md:50-62`） | config allowlist + 逐 plugin 开关；local 插件未显式信任**在 import 前**就拒（`loader.ts:2236`） |
| pi | ✅ | ✅ 进程内 `registerTool` | **静默顶掉内置**（`agent-session.ts:2604-2620` 先塞内置再 `set` 覆盖） | 项目级信任，项目内 `.pi/extensions` **未信任不加载**（`docs/extensions.md:113`） |
| codex | ✅ | ❌ 仅声明式 | — | — |
| claude-code-haha | ✅ | ❌ 仅声明式 | — | — |
| 其余 13 个 | — | 不在磁盘上 | — | — |

两处需要**更正我先前的口头结论**：

1. openclaw 的"同名工具被后者覆盖"是**错的**。`registerTool`（`registry.ts:602-656`）
   **完全不做**重名检查，无条件 append；丢弃发生在之后的**物化阶段**
   `tools.ts:1364-1375`，且比对用的 name set **预置了内置工具名**。所以真实机制是
   first-wins + 需先腾出名字，不是覆盖。
2. openclaw 真有价值的不是冲突策略，而是 `contracts.tools` **执行前声明闸门**
   （`registry.ts:610-619`：`plugin must declare contracts.tools before registering
   agent tools`）。这是所有样本里**唯一**能在**不执行 plugin 代码**的前提下
   审阅其工具面的机制。

pi 则是另一极端：无 manifest 预声明 + 静默遮蔽内置，用户在 manifest 里根本看不到
插件要顶掉哪个核心工具。**不要继承这个默认行为。**

#### 缝 C 的正确形态（三选一，必须先定）

| 方案 | plugin 贡献什么 | 是否执行 plugin 代码 | 风险面 |
|---|---|---|---|
| **A. 纯声明式组合** | 只能声明"把哪些已有能力以什么参数暴露"，由宿主映射到已有工具 | **否** | 最低。治不了"第三方需要新能力"的真需求 |
| **B. MCP 子进程**（= 今天的既有能力） | 起一个外部进程 | 是，但在**子进程** | 低。已有 `decideMcpSource` 门控 |
| **C. 进程内原生 tool** | 可执行 JS/TS，同宿主 realm | **是，且全权** | 高。需先修信任层 |

**方案 C 的前置条件（缺一不可，顺序有依赖）**：

- [ ] **C-0 先让信任层真正生效**（独立 plan，不属缝 C）：把
      `trust-engine.ts` 的 `TrustLevelCapability` 与 `PermissionService.checkPermission`
      从死元数据接到至少一处真实门控。否则 C 方案是在无门控的进程内执行第三方代码。
      —— 这是**本 plan 识别出的最高优先级安全缺口，与缝 C 是否做无关**。
- [ ] **C-1 执行前声明闸门**：照 openclaw `contracts.tools`，manifest 声明工具面，
      在**加载代码之前**校验。收益：不执行代码即可审阅插件要暴露什么。
- [ ] **C-2 加载**：manifest 声明 → 信任校验 → 才 import。import 机制可照
      openclaw（原生 `require` 优先，jiti 兜底）或 pi（jiti）。
- [ ] **C-3 注册**：`ToolOwner` 增加 `` `plugin-native:${pluginId}` `` 变体
      （`registry.ts:86-89`；`ReplaceableOwner` 已 `Exclude` 掉 `non-mcp`，`:369-373`
      另有运行时守卫），按 `AppConnectionTool` 的分桶模式逐 plugin
      `replaceByOwner` 原子提交。`meta.source = { kind:'plugin', id: pluginId }`
      （catalog 无需新增 kind）。**必须走 `internalKey` + `providerName` 双身份**，
      否则 `register()` 的 `tools.set`（`registry.ts:222`）会**静默覆盖**同名内置工具。
- [ ] **C-4 冲突策略显式选型**：duya 有第三个选项，比两个参照物都好——
      复用既有 `BUILTIN_FALLBACK_REPLACEMENTS` 的 `shadowedBy` 语义
      （`mcp/discovery.ts:195-243`）：被遮蔽的内置工具**保留在 inventory 里可见**、
      标记 `shadowedBy`、只在 `resolvedConfigs` 排除。参照物要么要求用户先禁用内置
      （openclaw），要么静默遮蔽（pi）；duya 已有第三种更可视的写法，且带
      `mcp-server-shadowed` 这类 issue 事件可复用。
- [ ] **C-5 权限接线**：插件原生 tool 需要 `decideMcpSource` 的同构兄弟
      （`permissions/permissions.ts:289-325`：`plugin`/`local`/`unknown` → `ask`，
      永不自动批准）。今天是**调用时**门控，**注册时**无门控；C 方案要明确
      补不补注册时门控。plan 419 的 P1（`checkPermissions` 预检、`riskTier`、
      `PermissionContext` 注入）正好是这条的地基，但 P1 尚未落地。

#### 推进顺序（G1 / G2 均已落地）

0. ~~G1：`discoverHooks` 格式修正~~ ✅ `968d18c5`
1. ~~独立 plan [584](../completed/584-plugin-trust-enforcement.md)~~ ✅ **2026-10-01 完成**。
   Phase 1 接上了唯一有执行点的能力项；Phase 2 取消为 N/A；Phase 3 删掉只写不读的
   `PermissionService`；Phase 4 给 `setEnabled` 补审计痕迹。
2. ~~G2：让 plugin 的 hook 真的执行~~ ✅ `5477574e`。**方案 A 的主体已落地。**
3. **缝 C 方案 B 判定为「暂不做」**：`plugin` 这个 MCP source 桶在仓内**不可达**
   （零个 plugin 声明 `mcp/servers.json`），放松它对 `decideMcpSource` 是空转。
4. **C 方案（进程内执行）仍需先解决门控缺失**——但注意这不是「等 584」：
   584 已完成且说明了：**要接 C，必须先为它新建一个执行点**（声明 + 校验），
   否则就是无门控地执行第三方代码。

#### G2 的实现要点（2026-10-01）

- **不需要新增跨进程契约。** 一度想给 `InitCommand` 加 `pluginHookFiles`，随后发现
  agent 进程本来就用自己的 `pluginDb.registryList()` 发现 plugin skill 路径，
  于是完全照抄 `discoverPluginSkillPaths()` 的模式，协议零改动。
- **时序是个真坑**：`ConfigHooksRunner` 在**构造函数**里求值一次
  `readHooksConfig()`。所以 `setExtraHookFiles()` 必须在 agent 构造**之前**调用
  （放在 init handler 开头），放在 skill 加载里会晚一轮。
- **`config.toml` 不存在时也必须生效**：旧 `readHooksConfig` 一见文件不存在直接
  `return undefined`，那会让**恰好没手配过 hooks 的用户**丢掉全部 plugin hook。
  测试专门钉了这一条。
- `[hooks] disabled` 是按 config.toml 的 entry 字符串寻址的，**够不到 plugin 文件**。
  所以 plugin 文件走空 disabled 集合——这是承认限制，不是假装它可寻址。

#### 已有的冲突/优先级策略地图（2026-10-01 摸清，比三个参照物都好）

| 能力种类 | 现有策略 | 证据 |
|---|---|---|
| **skills** | 加权优先级：system 6 > custom 5 > agent 4 > user/project 3 > **plugin 2 = 普通 bundled 2** > 无标记 1；同级 first-wins | `packages/agent/src/skills/resolver.ts:50-116` |
| **MCP servers** | `shadowedBy`：被遮蔽的条目**保留在 inventory 里可见**、标记、从生效集排除 | `packages/plugin-core/src/mcp/discovery.ts:195-243` |
| **commands / agents** | **无任何遮蔽/优先级** | `discoverCommands` / `discoverAgents` 在 `electron/`、`agent/src/`、`src/` 下零消费者 |
| 工具（tool） | 尚未支持 plugin 贡献 | — |

skills 那套的关键设计值得单独指出：**「用户改过的 bundled skill 被提升到 user 档（3），
确保 plugin 无法遮蔽它」**——即「用户投入过的能力，优先级高于插件」。
openclaw 要用户先手动禁用内置，pi 静默遮蔽，duya 这套两者都不是。





## 8. Gates

- Phase 1：`npx vitest run packages/agent/tests/BrowserTool packages/browser`；
  `npm run typecheck:web`；worktree 内先 junction `node_modules`（根 + 各 workspace 包）否则报假 TS2307。
- Phase 2：`npm run typecheck:all`；Playwright 验 tool_catalog 对 browser 的 namespace 提示。
- Phase 3（已跑）：`npx vitest run packages/browser electron/plugins/builtin-browser-plugin.test.ts`
  → 26 文件全绿；`npx tsc -p packages/browser --noEmit`、`npx tsc -p packages/agent --noEmit`、
  `npm run typecheck:web` 均 exit 0。
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
- ~~**真实 Electron browser smoke 未做**~~ → **已用更精确的手段覆盖**（`3d815452`）。
  第 4 个消费点 `process/agent-process-entry.ts:78` 从 `tool/builtin.js` 导入**单例**
  `{ browserTool }`（不是 `BrowserTool` 类），在 `config:update` worker 命令里调
  `setBrowserConfig()`。grep 直接 import 站点必然漏掉这条——对象是经 re-export 进来的。
  所以真正的不变量是**身份不变量**：被 entry 改写的对象，必须与 registry 注册的、
  模型读到的，是同一个。`packages/agent/tests/BrowserTool/browser-tool-singleton.test.ts`
  直接断言这一点，并用 `human-like` 模式做探针（`description` 是按 config 切换的
  getter，成功即可从公共面观测，不必开 GUI）。这比「启动 Electron 观察症状」更便宜
  也更定点。
- **node-pty / MSB8040：曾误判为 smoke 的阻塞，实际不是**（2026-10-01 核实）。
  node-pty 1.1.0 **自带 `prebuilds/win32-x64`**，`lib/index.js` 走预编译路径，
  `require('node-pty')` 在本机**实测加载成功**；且 `TerminalManager.loadNodePty()`
  是懒加载（用终端时才 require），不阻塞 app 启动。
  MSB8040 只影响**从源码重建** node-pty，即 `scripts/after-pack.js:320` 的
  `electron-rebuild` → 只卡**打包**，不卡开发态与上面的测试。
  故 VS Spectre 组件**不是 plan 583 的前置**。若要恢复 `electron:pack`，需提权安装
  （当前 shell 非管理员），命令见下方交接说明。
- **browserMode 是否新增 popover 入口**：属产品决策，未擅自加。
  相邻 plan 573 拥有产品面改动权。
- **plugin 安装/卸载后的工具可见性回归未做**（Phase 3 原定的 gate 之一）：
  需真实 Electron 环境。纯 Vite 验不了 preload 路径。
- `electron/plugins/PluginManager.test.ts` 在本 worktree 加载失败
  （`Cannot find package '@duya/agent/message'`）：`packages/agent/dist` 只有 8 个
  文件的陈旧构建，而 `./message` 是已声明导出但 `dist/message.js` 不存在。
  **与本 plan 无关**，属 worktree 环境问题。

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
- 2026-10-01：**两处更正**。(a) 早先称 `actions/index.ts` 导出 `./ActionRegistry.js`
  是潜伏 bug——错，同名 `index.ts` 在 grep 输出里造成歧义，该路径本来就正确。
  (b) Phase 2 原写"把 browser 手册从常驻 prompt 迁到 `getPrompt()`"——错，手册早已只在
  `getPrompt()` 上；真正缺陷是 `getPrompt()` **无人调用**，20 KB 指引对模型不可见。
  这条比原设想更有价值：它同时让 registry 声明的 on-demand 契约变成真的。
- 2026-10-01：Phase 1 的解析方式与 Phase 0 初稿不同（paths→源码不可行，TS6059 ×72），
  最终类型走 `dist/*.d.ts`、运行时走源码；详见 §7 Phase 1 的对照表。
- 2026-10-01：engine 内 4 个既有红已修（`backend-resolver` 期望写反、`screenshot` 落盘契约），
  归因方式为基线 worktree 复跑，非推测。
- 2026-10-01：Phase 3 落地（`82f07912` + `909234ba`）。**第三次更正**：原 Phase 3 写
  「`policy.json` 的域名/DOM 策略要真正接进 `DomainBlocker`，而不是停在 manifest」，
  前提是错的——`permissions[].domains` 确实一路传到 daemon，但导航拦截的实际执行者是
  设置驱动的 `DomainBlocker`，daemon 的 `blocked_domains` 来自扩展设置而非 manifest。
  故本插件只声明三个真被执行的 tier 字段，不写装饰性 `domains`。详见 §7 Phase 3。
- 2026-10-01：顺手修掉手册的一处真实欠文档：search 的 engine 枚举漏了
  `github`（schema 有、`ALL_ENGINES` 有、模型读不到），已补并说明它是
  code/repo 专用且永不领衔（`909234ba`）。
- 2026-10-01：**BOM 静默失效**（写测试时踩到，未修代码，仅记录）：`Set-Content -Encoding utf8`
  在 PowerShell 5.1 下写 BOM，而 `readPermissionsPolicy` 的 `JSON.parse` 遇 BOM 抛错
  被 `catch` 吞掉 → 整个 permission policy 静默变成 `undefined`，且**不报错**。
  任何 `permissions/policy.json` / `plugin.json` 若带 BOM 都会这样。
  修它要动所有插件共用的读取路径，属独立改动，未纳入本 plan。
- 2026-10-01：**再次更正 openclaw 的结论**（本 plan §10 早先那条也需按此读）。
  先前称 openclaw「同名工具被后者覆盖」——**仍错**，且这次拿到了确切机制：
  `registerTool`（`plugins/registry.ts:602-656`）**根本不做重名检查**，无条件 append；
  丢弃发生在之后的**物化阶段** `plugins/tools.ts:1364-1375`，比对用的 name set
  **预置了内置工具名**，故真实机制是 **first-wins + 需先腾出名字**（openclaw 自己也
  要求先 `plugins.entries.browser.enabled = false`）。数组存插件（`registry.ts:646`）
  这半句是对的，但和"丢弃"不在同一处、也不是同一阶段。
  另有一点先前没说清：`contracts.tools` 是**执行前**声明闸门，不是运行时校验。
- 2026-10-01：识别出**既有安全缺口（与缝 C 是否做无关）**：`trust-engine.ts` 的
  `TrustLevelCapability` 与 `PermissionService.checkPermission` 全仓**零执行点**——
  `getCapabilities()` 唯一调用点是只读 IPC 查询（`plugin-handlers.ts:630`），
  `meetsMinimumLevel` 零调用方。已复核（两个独立来源 + 本人 grep 复核）。
  按 §7 Phase 4 的建议，应先立独立 plan 接线信任层，再谈进程内执行第三方代码。


