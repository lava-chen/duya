# 09 — `conductor` → `canvas` 重命名影响面评估

> 结论先行：**不建议整体重命名。** 建议只做 4 处文案/注释修正（约 4 个文件、零 DB、零 CSS），
> 拿到 ~90% 的收益；代码重命名并入 RFC 的 **M4 conductor 解耦**一起做。
> 基线：`master` @ `7c5bf050`。

> ⚠️ **路径基准**：本文全部 `electron/` `src/` 前缀写在 M7 搬迁**之前**的布局上
> （基线早于搬迁 commit `ce9366c9`，相距 29 个提交）。
> **结论（不改名）与规模数字不受影响**，读路径时按此映射换算：
>
> | 本文写法 | 搬迁后 |
> |---|---|
> | `electron/**` | `apps/desktop/src/main/**` |
> | `electron/preload.ts` | `apps/desktop/src/preload/index.ts` |
> | `src/**`（渲染层，含 `src/i18n`、`src/lib`） | `apps/desktop/src/renderer/**` |
> | `packages/**` | 不变 |

---

## 1. 规模

| 指标 | 数量 |
|---|---|
| 含 `conductor`（不分大小写）的受版本控制文件 | **344** |
| 原始出现次数 | **3,836** |
| 名为 `conductor*` 的目录 | **5** |
| 不同的 `.conductor*` CSS token | **39** |
| SQLite 表/索引/列 | **~30 个标识符，横跨 2 个数据库** |

按区域分布（原始出现次数）：

| 区域 | 出现 | 文件 |
|---|---|---|
| `packages/conductor/` | 1,028 | 90 |
| `packages/agent/`（`CanvasConductor` 工具 + `conductor-mode.ts`） | 357 | 52 |
| `electron/db/` | 468 | 15 |
| `src/`（含 `src/styles`） | 946 | ~50 |
| `electron/`（其余） | ~455 | — |
| `docs/` | 275 | 49 |
| `e2e/` | 98 | 4 |
| `scripts/` | 95 | ~8 |

### 1.1 5 个目录

```
packages/conductor/                    ← npm 包 @duya/conductor
electron/conductor/                    ← workbench / executor 服务
electron/db/core/conductors/           ← undo-redo, invert-patch
electron/ipc/conductor-handlers/       ← undo-redo handlers
e2e/conductor/                         ← 4 个 playwright spec
```

外加 `packages/agent/src/tool/CanvasConductor/`（35 文件）——
**第六棵子树，名字不含 `conductor*`，但语义负载最大**。

### 1.2 标识符 vs 装饰性

约 **85% 标识符 / 15% 装饰性**，但切分位置不理想：

- **标识符（必须同步移动）**：`@duya/conductor` import specifier（`src/` 7 文件 25 处）、
  `ConductorStore`、`ConductorCanvas*Row`、`conductorCanvasId`（经 `toolUseContextPatch` 注入）、
  `conductorMode`（已注册的 `ModeModifier`）、mode id `'conductor'`、
  `conductor_toggle` slash-command kind、全部 `conductor.*` i18n key、
  全部 `.conductor-*` CSS class、全部 SQL 标识符、`conductor:*` IPC channel 名。
- **装饰性**：注释、文档、**3 个 `.xsd` 误报**
  （`shared-bibliography.xsd` —— XML 书目词汇表，**完全无关，不要碰**）、SVG 资源元数据。

### 1.3 根配置文件（我复核过，确实含 conductor 引用）

| 文件 | 行 |
|---|---|
| `tsconfig.json` | `:22-23` paths `@duya/conductor/renderer`；`:29-30` include globs |
| `vite.config.ts` | `:19-20` 两条 alias |
| `vitest.config.ts` | `:26-27` include globs；`:65-66` 两条 alias |
| `package.json` | `:16`（`build:conductor` + two-pass hack）、`:18`、`:48`、`:50` |
| `.github/workflows/release.yml` | `:62-74`（记录了 two-pass build） |
| `electron-builder.yml` | **0 引用** |

---

## 2. 数据库影响

### 2.1 legacy `duya-main.db`（`electron/db/schema.ts`）

- 表：`conductor_canvases`（`:275`）、`conductor_canvas_groups`（`:290`）、
  `conductor_widgets`（`:301`）、`conductor_actions`（`:320`）、`conductor_elements`（`:337`）
- 索引：11 个，含 `idx_conductor_widgets_canvas`（`:372`）、
  `idx_conductor_canvases_project_path`（`:861`，UNIQUE），
  以及**名字不带前缀**的 `idx_elements_canvas`（`:376`）、`idx_actions_type`（`:389`）
- `chat_sessions` 列：`conductor_mode_enabled`（`:40`，self-repair `:807`）、
  `conductor_canvas_id`（`:41`，self-repair `:808`）

### 2.2 core `duya-core.db`（`electron/db/core/conductor-store.ts:249-347`）

**同样那 5 张表名**被 `ConductorStore.migrations` id=25 `create_conductor_tables` **再建一遍**。

### 2.3 其他

- workbench 表（`electron/conductor/workbench-store.ts`）：
  `conductor_data_sources`（`:58`）、`conductor_handlers`（`:80`）
- **配置键**：`electron/config/store.ts:126` → `conductorFeatureFlags: 'auxiliary.conductor_feature_flags'`
  —— 这是 electron store 里一个**已持久化的用户配置键**，
  **重命名它是数据兼容问题，不只是常量问题**。

### 2.4 可行性诚实评估

SQLite 支持 `ALTER TABLE … RENAME TO`，仓库里已有 9 处先例
（`electron/db/core/mailbox.ts:292`、`electron/db/schema.ts:2196`、
`electron/memory-state/migrations/0011_…:31`）。**SQLite rename 保留行，不需要搬数据。**

但**不是一行的事**：

1. **两个不同的数据库定义了同名表**，两处都要 migration。
2. **索引名不跟随表 rename** —— `idx_conductor_*` 必须显式 `DROP` + `CREATE`，
   而其中 3 个（`idx_elements_canvas`、`idx_actions_type`、`idx_widgets_type`）
   **连前缀都没有**。
3. `schema.ts` 用的是 `CREATE TABLE IF NOT EXISTS` + 临时 "self-repair" `ALTER`
   （`:799-869`），所以 rename 必须插进一条 self-repair 容错路径，
   否则**全新安装与迁移过的库会分叉**。
4. 引用 `conductor_canvases(id)` 的 FK 子句（`:315`、`:332`、`:352`）需要 `legacy_alter_table` 处理。

> **可行，中高风险，仪式感很重 —— 而这全部是为了一个命名偏好。**

---

## 3. i18n：用户可见的问题只有 2 行

约 **230 个 key** 在 `en.ts` 与 `zh.ts` 里都以 `conductor.` 为命名空间。
**绝大多数已经渲染成 "canvas" 这个词。** 只有 4 条英文串真正把这个词显示给用户：

| 位置 | 当前值 |
|---|---|
| `src/i18n/en.ts:46` | `'nav.conductor': 'Conductor'` |
| `src/i18n/en.ts:1374` | `'panel.conductor': 'Conductor'` |
| `src/i18n/en.ts:2880` | `'conductor.loading': 'Loading Conductor...'` |
| `src/i18n/en.ts:2933` | `'conductor.status.settings': 'Conductor settings'` |

其余早已是 canvas 措辞：`'conductor.title': 'Canvas'`（`en.ts:2863`）、
`'conductor.backToLibrary': 'Canvas Library'`（`:2865`）、`'conductor.subtitle'`（`:2864`）。

### 3.1 而且存在一个活的 zh/en + zh 内部不一致（已复核）

```
en.ts:46    'nav.conductor':   'Conductor'
en.ts:1374  'panel.conductor': 'Conductor'
zh.ts:48    'nav.conductor':   '画布'      ← Canvas
zh.ts:1352  'panel.conductor': '指挥台'    ← Conductor（指挥台）
```

**中文用户在侧边栏看到"画布"，在面板标题看到"指挥台" —— 同一个产品、同一种语言、两个名字。**

> **重命名的用户可见目标，靠改这 2 行 i18n 就已经完成了 80%。**

---

## 4. CSS

39 个不同的 `.conductor*` token，`src/styles/conductor.css` 里有 46 处
（由 `src/styles/globals.css:17` import），另有 `sidebar.css` 3 处、
`composer-panels.css` 3 处、`canvas.css` 2 处。

**`src/styles/canvas.css` 已经存在（10,975 字节）** —— 是独立样式表。
重命名要么把 `conductor.css` 并进 `canvas.css`，要么制造 `canvas.css` 冲突。

---

## 5. 语义裁决

### 5.1 "conductor" 误导吗？部分误导 —— 但误导的不是包名

代码库里有**两个不同概念**，只有一个是 UI：

1. **编排的 agent** —— `packages/agent/src/tool/CanvasConductor/`（35 文件、14 个工具）
   加 `packages/agent/src/modes/conductor-mode.ts`。
   这是**真正的编排**：`classify.ts:68` 直接标注 `// Canvas Conductor tools (plan 221)`，
   prompt 以 `## Conductor Canvas Mode` 开头（`prompt.ts:29`）。
   该 mode 注入 canvas 工具集、把 `conductorCanvasId` 打进 tool context、前置 prompt —— 典型的指挥行为。

2. **canvas UI** —— `packages/conductor/`，渲染 agent 驱动的那个界面。

> **所以 "conductor" 对这个包不是误称：它是指挥家的舞台。**
> `packages/conductor/src/index.ts:5` 就是这么说的。
> 而且**这个决定已经写在文档里了** —— `MONOREPO_RFC.md:17`：
>
> > `| Control Plane 与 Conductor 是否重叠？ | ❌ **不重叠** | Conductor 是 canvas UI，与 orchestration 无关 |`

把包改名为 "canvas"，会**抹掉"执行编排的 agent"与"它所编排的舞台"之间的区分** ——
让代码库**更不**清晰，而不是更清晰。

### 5.2 "canvas" 会冲突吗？会，而且存在内部冲突

- `CanvasConductor` → 若强制改名，会得到 **`CanvasCanvas`**。
  两条路都是退步：要么包叫 canvas 而工具保持 `CanvasConductor`（不一致），
  要么工具也改名并撞上 `Canvas*`。
- `CanvasConductorToolRow.tsx`、`canvas-canductor-prompt.test.ts`、`canvasAgent.ts`
- 表 `conductor_canvases` → `canvas_canvases`

> **最糟的冲突在功能内部。**
> 在 conductor 命名空间里，"canvas" 已经有一个**更窄且已被占用**的含义
> （`en.ts:2975-2979`）：
>
> - `conductor.presentation.widgets` = "Document" / "Arrange documents, tables, links… in a **finite workspace**"
> - `conductor.presentation.canvas` = "Canvas" / "Use the **infinite freeform** canvas"
>
> **把整个子系统改名为 "canvas"，会摧毁 i18n 文件极力维护的这个区分。**

---

## 6. 重命名计划（**不建议作为独立工作执行**）

| # | 步骤 | 文件量 | 风险 |
|---|---|---|---|
| 1 | `packages/conductor/` 目录 + 包名 → `@duya/canvas` | 1 目录（~180 文件移动） | **零** —— git 跟踪内容不跟踪路径 |
| 2 | 更新 `tsconfig.json`、`vite.config.ts`、`vitest.config.ts` | 3 | **零** |
| 3 | 更新 `package.json` scripts（`build:conductor`、`typecheck:conductor`、two-pass 顺序）+ `release.yml:62-74` + `scripts/junction-workspace-pkgs.bat:3` | 4 | **中** —— 只影响 CI/发布；需先本地 build 绿 |
| 4 | 重写 `src/` 7 个消费者的 import specifier | 7 | **低** —— 编译器保证 |
| 5 | `packages/conductor/` 内部标识符清扫 | ~90 | **低-中** —— typecheck 把关 |
| 6 | `electron/conductor/` + `e2e/conductor/` + `electron/ipc/conductor-handlers/` + `electron/db/core/conductors/` | ~30 | **中** —— `conductor:*` IPC channel 跨 preload 边界 |
| 7 | i18n key 重命名（~230 key × 2 文件） | 2 | **高** —— **静默损坏：漏一个 key 渲染出的是原始 key 字符串，不是类型错误** |
| 8 | CSS `.conductor-*` → `.canvas-*`（39 token），与既有 `canvas.css` 和解 | 6 | **高** —— 漏一个 token 就是无样式 UI，**没有编译器安全网** |
| 9 | **DB migration**：2 个库共 7 表 + 14 索引、2 列、`auxiliary.conductor_feature_flags` 配置键 | ~12 | **极高** —— 数据兼容、self-repair 路径、新装与迁移库分叉 |
| 10 | 文档清扫（`ARCHITECTURE.md`、`MONOREPO_RFC.md`、28 个 exec-plan、release notes、README） | ~55 | **低** —— 装饰性，但会污染一个正在进行的重构的 git 历史 |

**不要动**：3 个 `.xsd` 文件（误报）；`CanvasConductor` 工具名
（见 §5.2，这是重命名最坏的结果）；`conductor:executor:rpc` 与 `ExecutorAction`
union（`electron/conductor/executor-types.ts`）直到步骤 6 落地。

**验证闸门**：步骤 2/4/5 后 `npm run typecheck:all`（**先**在步骤 3 里重命名 `typecheck:conductor`）；
步骤 3 后 `npm run electron:build`（two-pass 循环构建是最脆的部分）；
步骤 7/8 后用 Playwright MCP 验面板；步骤 9 后跑
`electron/db/core/__tests__/conductor-store.test.ts`（它在 `:40-44` 断言精确表名）。

---

## 7. 最终建议

### 7.1 整体重命名：**推迟**

**理由一：代价与收益严重不成比例。**
~340 个文件、2 个数据库、~230 个 i18n key、39 个 CSS class，
去解决一个**只有 4 行宽**的问题。
用户可见的不一致是 2 行 i18n，内部的不一致是 1 行 package description。

**理由二：它会主动降低清晰度。**
`CanvasConductor` 的工具集承载编排语义，改名即撞车；
而且会摧毁 §5.2 那个 finite-workspace vs infinite-freeform 的区分。
`MONOREPO_RFC.md:17` 已经裁定过这一点。

**理由三：现在是最糟的时机。**
`MONOREPO_RFC.md:373` 与 `:884` 记录着 `packages/agent` 里 **18 个未解循环 SCC**（最大 42 文件）。
`MONOREPO_RFC.md:883` 把 **"M4 conductor 解耦 —— 删整段 build hack"** 列为计划工作，
其明确收益就是删掉 `@duya/agent` ↔ `@duya/conductor` 的 two-pass build hack（`package.json:16`）。
**那次解耦本来就会搬动这些文件。** 先改名意味着付两次钱，
并把两个大型机械 diff 合并进同一次 review —— 而同时还有 28 个活跃 exec-plan 在改动。

**理由四：真正的缺陷是那个 build hack，不是名字。**
循环依赖才是让 `packages/conductor` 构建脆弱的原因。**修掉它，名字就退回纯装饰问题。**

### 7.2 现在就做（4 个文件，零 DB，零 CSS，~90% 收益）✅

| # | 文件:行 | 改动 |
|---|---|---|
| 1 | `packages/conductor/package.json:6` | 修正**错误**的 description：`"DUYA canvas workspace UI — renders the surface the CanvasConductor agent drives"` |
| 2 | `src/i18n/en.ts:46` | `'nav.conductor': 'Conductor'` → `'Canvas'`（与 `zh.ts:48` 已有的"画布"对齐） |
| 3 | `src/i18n/en.ts:1374` | `'panel.conductor': 'Conductor'` → `'Canvas'` |
| 4 | `src/i18n/zh.ts:1352` | `'panel.conductor': '指挥台'` → `'画布'`（消除 zh 内部劈裂） |

外加一条注释建议（可选，零风险）：

- `packages/conductor/src/index.ts:5` 现有注释扩写为显式边界说明：
  *"conductor = 指挥家的舞台。编排 agent 的工具在 `packages/agent/src/tool/CanvasConductor`，
  不要在这里 import。"* 并在 `ARCHITECTURE.md` 镜像一行
  （该文件已有 "Conductor multi-canvas target contract (Plan 233)" 章节）。

> 顺带：`en.ts:2880` `'Loading Conductor...'` 与 `en.ts:2933` `'Conductor settings'`
> 也建议一并改成 Canvas，否则上面 4 条改完仍有 2 条露在外面。

### 7.3 之后：并入 M4 conductor 解耦（不作为独立工作）

循环依赖切断之后，把**步骤 1–6 + 10** 作为一个可 review 的 PR 一起做。
**步骤 7–9（i18n / CSS / DB）应当是各自独立可回滚的后续 PR**，
且 **DB migration 应等到有用户可见的理由时再做** ——
一次装饰性改名不值得付出两个数据库的迁移代价，而用户一点好处都拿不到。

---

## 8. 开放问题

1. **`conductor:executor:rpc` 算不算准公开 contract？**
   它被 `electron/agents/server/interagent-router.ts:288` 消费。
   若有外部插件或 agent-process contract 依赖 `conductor:*` 前缀，
   步骤 6 需要兼容 shim 而不是直接改名。**未核实** ——
   仓库外没找到插件引用，但 `packages/plugin-core` 未被穷尽检查过 channel 名。
2. **`auxiliary.conductor_feature_flags` 是否已存在于任何持久化的用户 DB 里？**
   `electron/config/store.ts:126` 提示是的。
   若真实用户写过 flag，改名会**静默重置他们的设置**。
3. **`conductor_canvases` 表是否被仓外读取？**
   （例如项目归档的导入/导出，`electron/import/writer/session-writer.ts`？）
   若是，步骤 9 就成了格式版本化变更。
4. **zh/en 的"指挥台"/"Conductor"措辞归谁负责？**
   `nav.conductor` 与 `panel.conductor` **在 `zh.ts` 内部就不一致** ——
   这看起来是**无意的漂移而非一次决策**，改之前值得确认。
5. **`conductor.presentation.widgets` vs `.canvas` 的区分是刻意的产品设计吗？**
   如果是，它约束未来任何重命名，且**无论重命名与否都应写进 `ARCHITECTURE.md`**。
