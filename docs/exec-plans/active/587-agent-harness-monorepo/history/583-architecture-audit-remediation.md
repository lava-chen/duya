> Historical / superseded for execution. 原位置：`docs/exec-plans/active/583-architecture-audit-remediation.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# 583 — 架构审计整改（5 域并行审计的 108 项缺口收敛：契约无单一事实源、门禁缺失、信任模型未落地）

> **Status**: In Progress · **Priority**: P0 · **Owner**: TBD
> **立项**: 2026-10-01（来源：`ARCHITECTURE_AUDIT.md`，5 域并行审计 @ `e1bc1650` / `9522711`）
> **前置**: 无
> **分界**: 本 plan 只做审计报告 `ARCHITECTURE_AUDIT.md` 里的 108 项缺口。Plan 580（MCP 能力收敛）、Plan 582（会话归档加固）另行推进；涉及交叉处只在 §7 说明边界，不替它们排期。
>
> **交付进度（分轨 PR，链式堆叠）**
>
> | 轨 | PR | 分支 | 内容 | 状态 |
> | --- | --- | --- | --- | --- |
> | A 止血 | [#86](https://github.com/lava-chen/duya/pull/86) | `fix/583-track-a-p0` → `master` | ISS-01/02/03/04 + typecheck 棘轮门禁 | MERGEABLE |
> | B1 契约 | [#87](https://github.com/lava-chen/duya/pull/87) | `fix/583-track-b-contracts` → #86 | ISS-06/13/16/24/25/26 + IPC 契约门禁 | MERGEABLE |
> | B2 生命周期 | [#88](https://github.com/lava-chen/duya/pull/88) | `fix/583-track-b2-agent-lifecycle` → #87 | ISS-08/09/10/11/18/19/21/22/27/28 | MERGEABLE |
> | C 根因 | [#89](https://github.com/lava-chen/duya/pull/89) | `fix/583-track-c-root-cause` → #88 | ISS-30（参考接入）/32/33/34/35 | MERGEABLE |
> | C2 RAG hook | [#90](https://github.com/lava-chen/duya/pull/90) | `fix/583-track-c2-rag-hook` → #89 | ISS-32/33 高频实例 + 死测试复活 | MERGEABLE |
> | C3 契约 | [#91](https://github.com/lava-chen/duya/pull/91) | `fix/583-track-c3-ipc-schema` → #90 | ISS-31 payload schema + ISS-30 回归补正 | MERGEABLE |
> | C4 webview | [#92](https://github.com/lava-chen/duya/pull/92) | `fix/583-track-c4-webview` → #91 | ISS-15 `will-attach-webview` 权限地板 | MERGEABLE |
> | D1 凭证 | [#93](https://github.com/lava-chen/duya/pull/93) | `fix/583-track-d1-secret-leak` → #92 | ISS-12 删不可达明文通道 + 新发现 ISS-12b | MERGEABLE |
> | E1 编码 | [#94](https://github.com/lava-chen/duya/pull/94) | `fix/583-track-e-repo-hygiene` → #93 | ISS-48 编码归一化 + 门禁 | MERGEABLE |
> | E2 测试收集 | [#95](https://github.com/lava-chen/duya/pull/95) | `fix/583-track-e-test-integrity` → #94 | ISS-49 测试收集门禁 | MERGEABLE |
> | E3 门禁自身 | [#96](https://github.com/lava-chen/duya/pull/96) | `fix/583-track-e-gate-integrity` → #95 | 棘轮在坏 tsc 上会报绿 | MERGEABLE |
> | D2 站点 | [duya-website#2](https://github.com/lava-chen/duya-website/pull/2) | `fix/583-site-hardening` → main | ISS-37 安全头 / ISS-38 跳转修复；**ISS-39 证伪** | MERGEABLE |
> | C 剩余 | — | — | ISS-30 全量扫、ISS-36 | 未开始 |
> | E 剩余 | — | — | ISS-41 剩余（Git 轮询 hook / useTheme）、45 剩余、49 剩余、50/51 | 部分完成 |
>
> **E3b 死代码（PR #97）** — 分支 `fix/583-track-e3-dead-code`，提交 `1bdb45b7`。
> 提交时本机 `api.github.com` 持续 EOF（`git push` 走 git 通道正常，API 全挂），PR 卡了一阵；
> 网络恢复后已开出 #97。含 ISS-40 主体 + 下面这条新门禁。
>
> **F 轨 通道安全（PR #98）** — 分支 `fix/583-track-f-channel-security`，基于 `1bdb45b7`
> - `755b9f9a` **ISS-20** connector-secret-store 的 `platform` 路径校验
> - `70b8a8a8` **ISS-17** Feishu webhook 强制认证 + encryptKey 验签
>
> **G 轨 Telegram 状态（PR #99）** — 分支 `fix/583-track-g-telegram-offset`，基于 `70b8a8a8`
> - `c32b4a87` **ISS-23** offset 持久化 + 启动期 backlog 上限
>
> **I 轨 重复抽象收敛（PR #101）** — 分支 `fix/583-track-i-ledger-consolidation`，基于 `ada4b376`
> - `9c3d91e8` **ISS-41** 双 InventoryLedger 收敛进 plugin-core（含那个两臂相同的三元）
> - `caae2d3c` **ISS-41** `src/lib/git-ipc.ts` 19 个手抄类型改为 re-export
>
> **⚠️ 本会话新增的第二个「验证工具本身失效」实例**：`Select-String` 对 3000+ 绝对路径组成的管道
> 给出**假阴性**（明明存在的 import 报成零命中）。同一天内第二次遇到「验证手段静默什么都没验」，
> 与 `vitest` 零测试、BOM、tsc 坏掉同族。以后大范围取证优先用 grep 工具或分批 Select-String
>
> **⚠️ 门禁自身的第二个「失败没有失败」——JSON 重复键**（`1bdb45b7` 内修掉）
> - **起因**：跑 vitest 时它报了 `package.json` 重复键警告。查下去是 **#95 自己引入的**——
>   写测试收集门禁时加了 `"pretest:coverage"`，而 scripts 块下方早就有一个同名的 ABI hook。
> - **后果**：JSON 只保留**最后一个**同名键，前一个被**静默丢弃** → `npm run test:coverage`
>   **从来没跑过**测试收集门禁。npm 和构建都不对重复键报任何错，所以这类 bug 天生不可见。
> - **修法**：`scripts/check-manifest-keys.mjs` 扫**原始文本**（`JSON.parse` 根本看不到被丢的那次出现），
>   覆盖全部 10 个 tracked `*package.json`，接进 `typecheck:all`；8 条单测钉住作用域规则
>   （同一对象内重复 = 缺陷，不同对象的同名键 = 正常 JSON）。顺带删掉目标脚本根本不存在的死条目 `pretest:encoding`。
> - **自己的第一版也写错了**：`readStringLiteral` 拿到的是**收尾**引号还往前找，于是报出 8 个幽灵重复。
>   先跑再信，抓住了。
>
> 棘轮门禁已自动收紧一次：清掉 `policy-gate.ts` 的未使用 import 消除 1 个 TS2749，基线 305/150 → 304/149。
> 棘轮还**抓到了本轨自己新写的代码**：`trusted-sender.ts` 误用 `as LogComponent`（值当类型用），
> 顺带暴露既有 `as LogComponent` 用法本身就是错的，只是被基线吸收了。

---

## 0. 一句话目标

把 `ARCHITECTURE_AUDIT.md` 审计出的 108 项缺口收敛成可执行清单，按「先止血、再建契约、最后清根因」的依赖顺序推进，并**先补上那道本可以拦住 4 个 P0 的自动化门禁**（esbuild 不做类型检查，且 CI 上没有跑 `typecheck:all`）。

---

## 1. 背景

审计覆盖 5 个域（agent / main+memory / renderer / connectors / website），共 117 条原始发现，去重后 108 项缺陷。
结论不是「代码写得差」，而是：**局部纪律很好，接缝无人校验**。每个模块自身都干净——URL 白名单是对的、
vault 加密是对的、i18n 键完全对齐、git 只读契约被遵守；但模块之间的契约（channel 名、wire DTO、权限门、
信任模型）全都靠人手维护两份或三份，且没有任何东西会报错。

### 1.1 审计方法与可信度

- 5 个 agent 并行审计，lead auditor 交叉核对。原始报告见 `.tmp-validation/architecture-audit/01..05-*.md`。
- 引用一律相对只读 worktree `.claude/worktrees/audit-head` @ `e1bc1650`；website 结论相对独立仓库
  `E:/Projects/duya-website` @ `9522711`。
- **本 plan 的编译者对最吃重的 15 条断言做了独立复核**，并对 IPC channel 清单做了机械重跑：
  - `duya-file` 无根白名单 —— 复核 `src/components/chat/markdownComponents.tsx:76-118`、
    `electron/main.ts:786-836`（`:812` 的 `readFile`）、`electron/main.ts:135-145`（`standard`+`secure`+`supportFetchAPI`）。
  - `RemoteSession.ledger` 未声明 —— 复核 `remote-mcp.ts:65-82` 无 `ledger` 字段，`:244`/`:317`/`:411` 三处解引用。
  - `db:` 前缀错配 —— 复核 `ipc/db-handlers.ts:478,605,447,434` vs `preload.ts:2295,2298,2311,2313`。
  - `tool_invoke` 绕门 —— 复核 `DuyaAgent.ts:1361` 调 `hasPermissionsToUseTool`，而门在 `PermissionsGate.ts:187`。
  - 插件信任 —— 复核 `trust-engine.ts:25-58` 的 capability 在全仓非测试代码中**只有一个**消费者
    `electron/ipc/plugin-handlers.ts:630`。
  - 重复 abstraction —— 复核 `permissions/policy.ts:477`（含 ANSI 剥离）vs `PowerShellTool/security.ts:92`
    与 `utils/shell/intelligence.ts:47`（仅 `\x00`+NFKC+零宽）。
  - **IPC census 重跑结果**：朴素 diff 得「434 个直接注册 / 406 个 preload 暴露 / 18 个无 handler」，但其中
    `import:*`（`electron/import/import-handlers.ts:40-261`）与 `capability-management:snapshot`
    （`ipc/capability-management-handlers.ts:24`）经由 `register()` 间接注册，**实际无 handler 数 = 12**，
    与原报告一致。审查者「28 个零消费者」的数字未独立复现（本次只做到 preload 作用域上界 46）。
- **可信度纪律**：保留每条原始发现的 `Confidence` 标注。低/中置信度发现**不得**在摘要表中被当作硬结论；
  争议项进 §7「明确不做的事」而不是被悄悄采信。原始 9 条 P0 中，**3 条被降级**（webviewTag、明文 API key 打日志、
  飞书 webhook），理由逐条写在 `ARCHITECTURE_AUDIT.md` §7。

**去重后严重度**：P0 **4** / P1 **34** / P2 **54** / P3 **15**，合计 **108**。**系统性根因 4 个**（RC-1 契约无单一
事实源、RC-2 该自动检查的没检查、RC-3 信任模型声明与落地分离、RC-4 安全原语双份且弱的那份在决策路径上）。

### 1.2 缺口总表

| ID | 轨道 | 严重度 | 一句话 | 位置 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| ISS-01 | A 止血 | P0 | **CI 触发器指向不存在的分支 → 整套 CI 从未运行过**；且根 tsconfig 排除 `electron/**`，类型门禁从未编译主进程 | `.github/workflows/test.yml:4-7` · `tsconfig.json:32-38` · `electron/tsconfig.json:39` | M |
| ISS-02 | A 止血 | P0 | `duya-file://` 无根白名单，模型输出的 markdown 即可读任意本地文件 | `electron/main.ts:786-836` + `src/components/chat/markdownComponents.tsx:76-118` | M |
| ISS-03 | A 止血 | P0 | 远程 MCP 连接路径在 HEAD 必抛 `TypeError`；两个独立类型错误 | `remote-mcp.ts:65-82,244,317,411,350` | S |
| ISS-04 | A 止血 | P0 | `tool_invoke` 绕过 plan 模式硬写屏障 | `DuyaAgent.ts:1361` vs `PermissionsGate.ts:187` | S |
| ISS-05 | B 契约（**原 P0，现降为 P1**，见 §2.1） | P1 | 插件信任模型算了、显示了、从不执行 | `trust-engine.ts:25-58` + `ipc/plugin-handlers.ts:630` | L |
| ISS-52 | ~~A 止血~~ **已由上游修复** | — | `e1bc1650` 上 master 确实构建失败（`dde5295e` 的裸顶层 `await`），但 `1ffc925` 已独立修掉；本 track 撤下该改动 | `electron/main.ts:1140` | — |
| ISS-53 | C 根因 | P1 | 门禁首次运行即抓到：PR #84/#85 新引入 3 个主进程类型错误 | `message-log.ts:1464,2586` · `voice/index.ts:330` | S |
| ISS-05 | A 止血 | P0 | 插件信任模型算了、显示了、从不执行 | `trust-engine.ts:25-58` + `ipc/plugin-handlers.ts:630` | L |
| ISS-06 | B 契约 | P1 | handler 与 preload 差一个 `db:` 前缀 → 4 个已完成功能不可达 | `db-handlers.ts:478,605,447,434` | S |
| ISS-07 | B 契约 | P1 | 命令归一化三份副本，做审批决策的那份最弱（不剥 ANSI） | `policy.ts:477` / `security.ts:92` / `intelligence.ts:47` | S |
| ISS-08 | B 契约 | P1 | 每个 `db:*` 请求泄漏一个 30s 定时器，成功路径不 clear | `packages/agent/src/ipc/db-client.ts:72-78` | S |
| ISS-09 | B 契约 | P1 | 已废弃的 `permissionMode` 仍跨 worker 边界且被静默忽略 | `worker-protocol.ts:47` / `agent-process-entry.ts:194` | S |
| ISS-10 | B 契约 | P1 | stdout 写队列注释写「有界」，实现是无界数组 | `worker-protocol.ts:800-836` | S |
| ISS-11 | B 契约 | P1 | `ask` 在三条派发路径上语义不同；两条 fail-**open** | `dispatcherFromRegistry.ts:170` / `mcp/apply.ts:535` | S+M |
| ISS-12 | B 契约 | P1 | `agent:getProviderConfig` 明文吐 provider 凭证，无 sender 校验 | `agent-communicator.ts:143,179,194` | S |
| ISS-13 | B 契约 | P1 | `app:create-project-folder` 过滤了错误字符集，`/` 与 `..` 存活 | `system-handlers.ts:345,354,358` | S |
| ISS-14 | B 契约 | P1 | `shell:open-path` / `show-item-in-folder` 接受任意绝对路径 | `system-handlers.ts:144-152,154-171` | S |
| ISS-15 | B 契约 | P1 | `webviewTag: true` 且无 `will-attach-webview` 守卫（自 P0 降级） | `core/window-manager.ts:149` | S |
| ISS-16 | B 契约 | P1 | 完整 provider 配置（含明文 API key）打进渲染进程 console（自 P0 降级） | `stream-session-manager.ts:192` | S |
| ISS-17 | B 契约 | P1 | 飞书 webhook 缺 token 头时 fail-open（自 P0 降级：默认绑 `127.0.0.1`） | `webhook-server.ts:110-117` | M |
| ISS-18 | B 契约 | P1 | 浏览器桥自批准首个自称扩展名的 WS 客户端；空种子使审批闸门不可达 | `browser/daemon.ts:135-140,508-544` | S |
| ISS-19 | B 契约 | P1 | `[apps]` 开关既无 UI/IPC 可达，也不在 `invoke` 路径上校验 | `connector-service.ts:234,353-520` / `policy-gate.ts:63,71` | S |
| ISS-20 | B 契约 | P1 | `connector-secret-store` 校验 `agentId` 不校验 `platform`（中置信度） | `connector-secret-store.ts:28-41` | S |
| ISS-21 | B 契约 | P1 | `ensureSession` 无 in-flight 去重，并发首调重复建 session 并泄漏 transport | `remote-mcp.ts:350-423` | S |
| ISS-22 | B 契约 | P1 | 目录缓存按 `connectionId` 命中但不复核端点身份 → 换端点继承旧授权 | `remote-mcp.ts:360,408-414` / `catalog-cache.ts:27-45` | S |
| ISS-23 | B 契约 | P1 | 每 agent 的 Telegram offset 只在内存；重启重放 24h 消息 | `telegram-connector.ts:114,166` | M |
| ISS-24 | B 契约 | P1 | 12 个经 `contextBridge` 暴露的 channel 全仓无 handler | `preload.ts:2033,2295,2495,2613-2616` | S |
| ISS-25 | B 契约 | P1 | 3 个死掉的 `git diff` 包装函数，preload 仍暴露通道 | `git-ipc.ts:109,113,156` / `preload.ts:2601,2602,2609` | S |
| ISS-26 | B 契约 | P1 | widget iframe 把模型给的 href 直接丢给 `window.open`，无协议校验、无 `noopener` | `WidgetRenderer.tsx:291-295` | S |
| ISS-27 | B 契约 | P1 | `CodeReviewPanel.refresh()` 无取消守卫：慢的旧 scope 覆盖新的 | `CodeReviewPanel.tsx:395-460` | S |
| ISS-28 | B 契约 | P1 | 编辑回溯先删 transcript 再发替换消息，无回滚 → 真实数据丢失 | `ChatView.tsx:924-932` / `conversation-store.ts:1112-1122` | M |
| ISS-29 | B 契约 | P1 | 28 个已注册 channel 全仓零消费者 | `db-handlers.ts` / `agent-communicator.ts:131,137` / `updater-handlers.ts:32` | M |
| ISS-30 | C 根因 | P1 | 全部 45 个注册文件的 `ipcMain.handle` 无 sender / frame 校验 | `system-handlers.ts:48` / `main.ts:858` | M |
| ISS-31 | C 根因 | P1 | IPC 层实质无 schema 校验（~200 个 electron 文件里 13 个用 zod） | `db-handlers.ts:2002` / `agent-communicator.ts:478` | L |
| ISS-32 | C 根因 | P1 | RAG 召回每次全量载入 corpus（content + embeddings），主线程同步 | `memory/rag_search.ts:233-234,254-274` | L |
| ISS-33 | C 根因 | P1 | 2 字 CJK 走无 `LIMIT` 的 `LIKE '%term%'` 全表扫 | `memory/rag_search.ts:148-160` | M |
| ISS-34 | C 根因 | P1 | tier 召回在 prompt 热路径上跑三个无 `LIMIT` 的 `SELECT *` | `memory-state/tierIndex.ts:248-254,296-300` | M |
| ISS-35 | C 根因 | P1 | 两个 workspace 逃逸检查器，保证强度不同 | `allowedRoots.ts:37` / `policy.ts:1047` | M |
| ISS-36 | C 根因 | P1 | agent 两个 god 文件共 9563 行，权限装配点有两个 | `DuyaAgent.ts` / `agent-process-entry.ts` | L |
| ISS-37 | D 站点 | P1 | 站点零安全响应头（可被点击劫持、无 HSTS） | `next.config.ts:3,8` / `vercel.json:2` | S |
| ISS-38 | D 站点 | P1 | `vercel.json` 17 条 docs 跳转全部 301 到 404 | `vercel.json:12,36,86` / `lib/docs.ts:41` | S |
| ISS-39 | D 站点 | P1 | Clerk 与 Supabase 两套认证并存，header 接错的那套；middleware 什么都不拦 | `header.tsx:7,95-106` / `middleware.ts:1-10` | M |
| ISS-40 | E 清理 | P2/P3 | 死代码与只被自身测试引用的废弃导出（≈14 项） | 见 §4.1 T1 | S×N |
| ISS-41 | E 清理 | P2/P3 | 已漂移的重复 abstraction（≈11 项） | 见 §4.1 T2 | M×N |
| ISS-42 | E 清理 | P2 | god 文件拆分（≈5 项） | 见 §4.1 T3 | M×N |
| ISS-43 | E 清理 | P2 | 边界反转：main 反向 import 渲染进程 `src/` 40+ 处 | `provider-store.ts:66-71` 等 | M |
| ISS-44 | E 清理 | P1/P2 | 记忆层无任何保留/淘汰策略 | `rag_search.ts:233` / `tierIndex.ts:248-254` | M |
| ISS-45 | E 清理 | P2 | 主题 token 契约被违反（原始 hex / JS 里分叉 light-dark） | `CodeReviewPanel.tsx:95-96` / `CodeBlock.tsx:33-44` | M |
| ISS-46 | E 清理 | P2 | 文档承诺的 API 不存在（8 个子路径 vs 实际 4 个） | `packages/agent/ARCHITECTURE.md:520-528` | S |
| ISS-47 | E 清理 | P2 | `console.*` 绕过强制结构化日志（main + gateway + agent CLI） | 见 §4.1 T8 | S×N |
| ISS-48 | E 清理 | P2/P3 | 编码损坏：`DuyaAgent.ts` 86 处 mojibake 等 | `DuyaAgent.ts:327,366,372,374` 等 | S |
| ISS-49 | E 清理 | P2 | 测试缺口与被关掉的检查（站点零测试 / 25 处 deps 抑制 / `@ts-nocheck`） | 见 §4.1 T10 | M |
| ISS-50 | E 清理 | P2/P3 | 静默失败与恢复缺口（无类型失败通道 / ack 后吞异常等） | 见 §4.1 T11 | M×N |
| ISS-51 | E 清理 | P2/P3 | 仓库卫生：`tsconfig.tsbuildinfo` 被跟踪等 | `tsconfig.tsbuildinfo` / `.gitignore:23` | S |

---

## 2. A 轨道【P0 止血】6 项

### 2.0 实施中修正的两处判断

**ISS-01 的真因不是「没有门禁」，是「门禁从未开火」。** `.github/workflows/test.yml` 一直存在，
里面有 `npm run typecheck:all` 和 `npm run electron:build`。但它的触发器是 `main` / `develop`，
而本仓库的 `origin/HEAD` 是 `master`，`main` 和 `develop` **两个分支都不存在**
（`git rev-parse --verify main` 直接 fatal）。**这套 CI 从来没有在本仓库运行过一次。**
这一条配置错误同时解释了 ISS-03（类型错误出货）和 ISS-52（构建中断出货）——不是两个独立疏漏，
是同一个洞。原表里「CI 上没有跑类型检查」的描述低估了它：门禁是写好的，只是指错了分支。

**ISS-52 是修 ISS-03 途中撞出来的，不在原审计里。** 静态审计全程没有执行过一次构建，
所以没人发现 master 根本构建不出来。审计报告的「已验证范围」一节应当补上这一条方法论缺口。

**ISS-05 从 P0 降为 P1，理由如下。** 原判定「插件信任模型从不执行」成立，但把它排进止血轨
是错的，理由有三条：

1. **现有模型就算全部强制执行，也堵不住那个洞。** `TrustLevelCapability`
   （`trust-engine.ts:16-23`）只有 `maxHooks` / `allowHttpHooks` / `allowAgentHooks` /
   `maxFileAccess` / `requirePermissionConfirmation` / `allowAutoUpdate` 六个字段，
   **没有任何一个字段对应「插件是否可以声明 MCP server」**——而那恰恰是插件最危险的能力
   （声明即等于任意命令拉起）。要真正闭合，必须先给模型加这个旋钮，那是设计决策不是补丁。
2. **只修信任标签今天是纯装饰。** `determineTrustLevel` 把 `source === 'marketplace'`
   无条件判为 `Verified` 且**不做任何签名校验**（`trust-engine.ts:77-83`）。但因为
   `maxFileAccess` 等能力字段全都没有执行点，把 `Verified` 降级在行为上不产生任何可观察差异。
3. **不可远程触发。** 需要用户自己安装插件才能进入这条路径，而 MCP 拉起侧已经硬化
   （`packages/agent/src/mcp/index.ts:315-322` 有 env allowlist，且默认不走 shell）。
   这与 ISS-02 那种「模型输出即可触发」的路径不是同一量级。

因此 ISS-05 移出止血轨，独立成 PR，拆成三件可分别落地的事：
(a) 信任**标签**的可靠性（marketplace 无签名不得判 Verified）——小，但今天无行为变化；
(b) 在**能力物化点**强制执行现有字段（`electron/agents/db-bridge.ts:2385-2400` 的
`plugin:registry:list` 会把 manifest 一起返回给 worker MCP collector，`trustLevel` 就在同一批
数据里，下游从不查）——中；(c) MCP server 授权——需要产品决策 + 存量插件迁移策略，**待决策**。

顺序理由：**ISS-01 必须最先落**。ISS-03 本身就是类型错误被 esbuild 放行，每多一天没有门禁，就多一个同类 bug 上线。
门禁先落，剩下四个修复若有新破坏会被立刻报出来。

### ISS-01【P0 RC-2】把类型检查变成门禁，而不是靠人记得跑

esbuild 不做类型检查（`AGENTS.md` 已明写），而 `npm run typecheck:all` 只是一个本地人工步骤，CI 上没有对应 job。
ISS-03、ISS-21，以及 ISS-24 里的多处「测试 double 签名与真实类不一致」，全部是这道门能机械拦下的。

- [ ] 新增 CI job，在 `npm run electron:build` 之前跑 `npm run typecheck:all`（覆盖 `src/` + `packages/agent`
      + 其余 workspace 包），任一非零退出即失败
- [ ] 同一 job 跑 `npm run test`（Vitest），确保门禁不是唯一新增耗时
- [ ] 在 `package.json` 加 `pretest:typecheck` 之类的组合脚本，让 `typecheck:all` 无法被单独跳过
- [ ] 在 `AGENTS.md`「Gates」小节把「Pre-commit 必过」改成「CI 必过，本地为可选加速」
- [ ] 门禁上线当天记录基线错误数：若非零，先开一个「清理既有类型错误」PR，不要让门禁第一天就红

> 脚注（务必保留）：`AGENTS.md` 的 Footguns 一节已写明 esbuild 不做类型检查。本 plan 的 ISS-03/ISS-05 就是
> 这条脚注的实证——**不要在 PR 里以「本地跑过了」代替门禁**。

### ISS-02【P0 RC-1/RC-3】`duya-file://` 加根白名单 + 去掉 `supportFetchAPI` + 补主窗口 CSP

三位审计者（02 与 03 独立发现、lead 复核）确认的同一根因。模型输出的任意 markdown 路径都会被
`rewriteMediaSrc` 加工成 `duya-file://` URL，main 侧 `readFile` 无白名单，而该 scheme 注册了 `secure`+
`supportFetchAPI`，且主窗口没有任何 CSP。

- [ ] `electron/main.ts:810` 之后、`readFile` 之前插入 `path.resolve` + 根白名单前缀比较；不在
      `resources/public` / app `dist` / `~/.duya/assets` / conductor assets / `app.getPath('userData')` /
      当前 session `workingDirectory` 之内则返回 403
- [ ] 归一化后显式拒绝 `..` 段（`electron/main.ts:797-809` 已有驱动符归一化，就地加，不要另起一段）
- [ ] `electron/main.ts:139-142` 移除 `supportFetchAPI: true`
- [ ] 给主窗口加 CSP（`index.html` 或 `session.defaultSession.webRequest.onHeadersReceived`），`img-src` /
      `media-src` 只列上面那些根；两处沙箱窗口已有 CSP（`src/orb/index.html:5`、conductor），只补主窗口
- [ ] 渲染侧收口：`src/components/chat/MarkdownRenderer.tsx:236` 的 `PRESERVED_URL_RE` 去掉 `duya-file:`，
      改为只从 main 下发的附件元数据派生 `duya-file://` URL
- [ ] 收口后确认 `src/components/chat/markdownComponents.tsx:115` 仍只在 main 提供的路径上生效
- [ ] 补一条 main 侧单测：白名单外的绝对路径必须 403（可仿 `electron/ipc/__tests__/url-safety.test.ts` 的形状）
- [ ] 顺带清 `electron/main.ts:831` 的 `Cache-Control: public, max-age=3600`（泄露字节会留在 HTTP 缓存里）

### ISS-03【P0】远程 MCP 连接路径在 HEAD 必抛

两处独立的类型错误叠在同一个方法上：接口没有 `ledger` 字段却被解引用三次；`private ensureSession` 被以外部
签名调用。两条都是「本地能跑、线上必炸」。这也是 exec-plan 580 的 `pages=N, total=M` 无法复现的最可能机制。

- [ ] `electron/services/app-connections/connectors/remote-mcp.ts:65-82` 的 `RemoteSession` 接口补
      `ledger: InventoryLedger`
- [ ] 同文件 `:369-381` 的对象字面量补 `ledger: new InventoryLedger()`（对照正确实现
      `packages/agent/src/mcp/index.ts:92`）
- [ ] `discoverNow` 开头调 `beginDiscovery()`，失败路径调 `failDiscovery()`
      （两者定义在 `electron/services/app-connections/inventory-ledger.ts:50,71`，目前该 connector 一个都没调，
      所以 `discoveryStatus` 永远卡在 `'refreshing'`）
- [ ] `remote-mcp.ts:350` 提升为公开 API `ensureSessionForConnection(connectionId, provider)`，内部自己
      `getProviderConfig`、token 从 vault 取（对齐 `createStoredRemoteMcpOAuthProvider(vault, connectionId)`）；
      现有 `token` 形参是死的，删掉对 `listDescriptors`/`invoke` 无影响
- [ ] 改 `electron/services/app-connections/app-connection-service.ts:476` 与 `:561` 两处调用点
- [ ] 把 `electron/services/app-connections/__tests__/app-connection-service.test.ts:92` 的 double 改成对真实类
      打桩，让签名与可见性真正被检查
- [ ] 顺手把 ISS-21 的 in-flight promise 缓存一起做（同方法）
- [ ] **跑 exec-plan 580 的 Phase 0 真机基线重跑**，确认 `pages/total` 是否恢复一致（见 §7 的争议处理）

### ISS-04【P0 RC-3】`tool_invoke` 接回同一个权限门

plan 模式是写死的硬屏障（`coordinator.ts:120` 门控 `edit/write/bash/powershell/module`），但门在
`PermissionsGate.ts:187`，而 dispatcher 在 `DuyaAgent.ts:1361` 直接调裸策略引擎，把审批账本、`alwaysAllowTools`
授予、plan 门三样全跳过了。`DuyaAgent.ts:1339-1343` 的注释还写着「走 meta tool 永不绕过权限策略」。

- [ ] `DuyaAgent.ts:1361` 的 `checkPermission` 改为适配已有的 `guardedCanUseTool`（或 `buildPermissions` 里
      的内层 `canUseTool`，`DuyaAgent.ts:1300`），不再重新推导一次权限调用
- [ ] 与 ISS-11 同一个 commit 落地：同一个回调就是第三条派发路径
- [ ] 补一条测试：plan 模式 tracker 激活时，经 `tool_invoke` 调 `module` 必须是 deny
- [ ] 修掉或删掉 `DuyaAgent.ts:1339-1343` 那句现在为假的注释（留着比没有更危险）

### ISS-05【P0 RC-3】插件信任模型：要么落地，要么停止宣称

`TRUST_LEVEL_CAPABILITIES` 全仓非测试代码只有一个消费者，就是把值返回给 UI 的那个 IPC handler。
`determineTrustLevel` 仅凭 `source === 'marketplace'` 字符串就发 `Verified`，全仓无签名校验。

- [ ] 决策并记录（写进本 plan 决策日志）：走 (a) 落地强制，还是 (b) 停止宣称
- [ ] 走 (a)：在 `electron/plugins/PluginManager.ts` 的安装路径与 MCP 候选收集路径调用
      `policyEngine.meetsMinimumTrustLevel(...)` 与 `trustEngine.getCapabilities(trust).maxFileAccess`；无签名
      的 marketplace 源一律降级为 `Untrusted`
- [ ] 走 (a)：`PluginManager.ts:476-483` 把 manifest 声明的权限记为 *requested*，*granted* 只由显式用户决策填充
- [ ] 走 (b)：`electron/ipc/plugin-handlers.ts:630` 不再返回 `capabilities`，manifest schema 标注为 advisory
- [ ] 补一条测试断言 marketplace 源在无签名时拿不到 `Verified`

> **不要半落地**（(a) 做一半、(b) 做一半）。UI 展示一个运行时并不执行的权限姿态，比没有模型更危险。

---

## 3. B 轨道【P1 契约与边界】

按依赖排。**ISS-06 是全表最便宜的用户可见收益**（4 行改动，解锁 4 个已完成功能），无论排期如何都应第一个做。

- [ ] **ISS-06** `electron/ipc/db-handlers.ts:478,605,447,434` 四处注册改名为带 `db:` 前缀的
      `db:session:forkAt` / `db:session:unarchive` / `db:rollout:import` / `db:rollout:reconcile`（目标名全仓唯一）
- [ ] **ISS-06** 确认 `src/components/layout/panels/ThreadListItem.test.tsx:267` 的 unarchive 用例走真实 channel 名
- [ ] **ISS-06** 顺带修 `src/stores/conversation-store.ts:802-809`：先乐观移除再吞掉 rejection，导致行消失不回来。
      失败要回滚
- [ ] **ISS-07** 从 `packages/agent/src/permissions/policy.ts:477` 导出 `normalizeCommandForDetection`，在
      `tool/PowerShellTool/security.ts:92` 与 `utils/shell/intelligence.ts:47` 删除各自私有副本并改为 import
- [ ] **ISS-07** 补一条测试：含 CSI/OSC 转义的命令在策略层与 PowerShell 门上的判定结果一致
- [x] **ISS-08** `packages/agent/src/ipc/db-client.ts:72-78` 捕获定时器句柄，在 `handleDbResponse` 的 resolve 与
      reject 两个分支都 `clearTimeout` 后再从 `pendingRequests` 删除 — 另补 `process.send` 抛错分支
- [x] **ISS-09** 从 `worker-protocol.ts:47` 与 `agent-process-entry.ts:194` 删除 `permissionMode`；若需兼容窗口，
      改成「存在且非 null 就报错」而不是静默忽略 — 无需兼容窗口：改从 3 处 wire 类型整体删除，其中
      `electron/types/agent-message-types.ts` 还带**第四套词汇** `'bypass'|'step'|'full'`；旧 sender 携带时
      只是多余属性，结构性无法被采信
- [x] **ISS-09** 确认 `process/permission-profile-bridge.ts:48-60` 不再需要「读来只打日志」的那段 — 一并删除
      `deprecatedOption` / `ignoredDeprecated` 与 5 个配套测试
- [x] **ISS-10** `process/worker-protocol.ts:800-836` 给 `writeQueue` 加真实上限（N 之后丢弃或合并最旧的 `text`
      delta 帧），并把 `:800` 那句「Bounded write queue」改成与实现一致的描述 — 2000 帧 / 4 MiB 双上限，
      丢最旧；**并发现背压本身是死代码**：原循环在测 `writeQueue.length` 前已把最后一帧 shift 掉，逐帧生产时
      条件恒不成立，`write()` 的返回值从未被采纳。改为 `!canContinue` 即无条件停车，drain 回调先复位标志
- [x] **ISS-10** `:811-814` 静默丢帧处补一条 DEBUG 级日志 — 改为丢帧时一条 `logger.warn`（含 dropped 计数）
- [x] **ISS-11** `tool/ToolInvokeTool/dispatcherFromRegistry.ts:170-175` 改为 fail-closed，返回
      `errorResult('TOOL_PERMISSION_UNANSWERED', ...)`，不再 fall through 到执行
- [x] **ISS-11** 在 `permissions/` 抽一个 `resolveAsk(behavior, context, meta): 'allow'|'deny'|'pause'`，由
      `dispatcherFromRegistry.ts:170`、`tool/StreamingToolExecutor.ts:1751`、`mcp/apply.ts:535` 三处共用；
      自动化例外改为显式 trusted-surface 参数，而不是「回调不存在就放行」 — 落为
      `permissions/askWithoutUser.ts` 的 `resolveAskWithoutUser(mode, toolName)`。**审计少数了一条**：
      `StreamingToolExecutor.ts:1265` 的 pre-check 同样 fail-open，实为 3 条 fail-open / 1 条 fail-closed。
      例外改由 permission mode 表达（`dontAsk`/`bypassPermissions` 已在 `decideMcpSource:304` 上游短路成 allow），
      比 trusted-surface 参数更贴合既有模型；未知 mode 一律 deny
- [x] **ISS-12** 删除 `electron/agents/agent-communicator.ts:143` 的 `agent:getProviderConfig` 整个 handler
      （活路径是 `agents/server/router.ts:1832`）；顺手消掉 ISS-41 里的第二份 runtime config 副本
      — 该 handler 确认**零调用方且 preload 未暴露**（preload 无此通道，也无通道名通用 invoke 透传），
      删除零风险。加 `agent-communicator.channels.test.ts` 钉住 provider 通道面

- [ ] **ISS-12b（新发现，严重度高于 ISS-12 原条目，建议升 P0 复核）** **渲染层确实持有活的 API key。**
      与已删的 `agent:getProviderConfig` 不同，以下两条**在 preload 里真实暴露、且有活的渲染层调用方**，
      返回**明文 `apiKey`**（且 `runtimeConfig.apiKey` 再来一份）：
      - `config:provider:getActiveProviderConfig`（`preload.ts:2386`）← `src/lib/stream-session-manager.ts:177`，
        **每个聊天回合都调**
      - `config:provider:getConfig`（`preload.ts:2388`）← `src/components/settings/ModelSelectionSection.tsx:218`
      根因不是某条 handler 写错，而是**架构**：渲染层充当 main → agent server 的密钥中转站（渲染层拿到 key
      后再 POST 给 `agentServer.getUrl()`）。因此这不是"删 handler"能解决的，删了聊天就起不来。
      正确方向是让 provider 解析下沉到 main 进程或 agent server（与 ISS-43「electron 反向 import 渲染层」
      同源）。**需要架构决策 + 存量迁移，未修**。当前状态由
      `agent-communicator.channels.test.ts` 的 `UNMASKED` 名单显式钉住，防止无声扩张到第三条
- [ ] **ISS-13** `electron/ipc/system-handlers.ts:354` 之后加
      `path.resolve` + 前缀比较，`:358` 的 `mkdirSync` 之前拒绝含 `/`、`\`、`..` 的名字
- [ ] **ISS-14** `system-handlers.ts:151` 与 `:169` 之前加根白名单（session 工作目录 / `~/.duya` /
      `dialog:*` 曾返回过的路径），照抄同文件 `:177` 的 `isHttpUrl` 形状
- [x] **ISS-15** `electron/core/window-manager.ts:149` 保留 `webviewTag` 但注册 `will-attach-webview`，强制
      `prefs.nodeIntegration = false`、`prefs.contextIsolation = true`、`prefs.sandbox = true`，并 pin `params.partition`
      — 落为 `electron/core/webview-guard.ts`：纯函数 `hardenWebviewPreferences` + 薄适配 `attachWebviewGuard`，
      14 个单测 + 5 个**接线**测试（驱动 `createWindow`，断言主窗口上确实注册了 `will-attach-webview`，
      并用一次恶意 `webPreferences` 验证被中和）。**两处偏离原计划，理由如下**
      - **`params.partition` 未 pin**：Electron 类型定义里 `params` 是 `Record<string, string>` 的原始属性表，
        guest 的偏好是从**第二个参数** `webPreferences` 读的。改 `params` 是静默空操作 —— 首版就是这么写的，
        由类型定义核对拦下。`partition` 写错是 cookie 正确性问题，不是提权。
      - **`sandbox = true` 未强制**：`sandbox` 改的是 guest 自身 JS 的运行方式，属行为而非权限。本机无法
        驱动真实 `<webview>` attach 验证（见 ISS-30 全量扫的同一条限制）。**改不可验证的浏览器行为不叫
        安全修复**，故不做；若后续有 e2e 环境再补。
      - 额外**剥离 `preload`**：Electron 文档明示 webview 的 preload 执行时带 node integration，并推荐在
        `will-attach-webview` 里剥掉。本仓两处合法 `<webview>`（`BrowserPanel.tsx:849`、`AgentBrowserTab.tsx:214`）
        都没设 preload，剥它只移除能力、不改行为。
      - 地板只钉**授予权限**的 flag：`nodeIntegration` / `nodeIntegrationInWorker` / `nodeIntegrationInSubFrames`
        （均 false）、`contextIsolation` / `webSecurity`（均 true）、`allowRunningInsecureContent`（false）。
        另：**字段"未设置"与"显式设为危险值"要分开**——前者是 Electron 默认值，写入但不上报，否则每次正常
        挂载都误报警。
- [ ] **ISS-16** `src/lib/stream-session-manager.ts:192` 换成字段投影（`{ provider, model, hasApiKey: Boolean(...) }`），
      或直接删掉——`:228,314,365` 已用更低冗余记同一件事
- [ ] **ISS-18** `electron/services/browser/daemon.ts:135-138` 预置生产扩展 id 固定清单（开发 id 走 debug flag）
      — **不做**：`extension-installer-handlers.ts:47-58` 的 `autoApproveInstalledExtensionId()` 已是正确的信任锚
      （应用为自己刚安装的扩展背书），空清单 + 显式审批即可，无需再硬编码一份清单
- [x] **ISS-18** `daemon.ts:509` 的条件反转为 `requiresApproval = !allowedExtensionIds.includes(id)`（空清单 = 全部拒绝），
      并删掉 `:539` 的自批准 push（或挂到显式用户批准 IPC 上）— 抽成 `services/browser/extension-trust.ts` 的
      `decideExtensionTrust()` 纯函数。**审计漏了第二重**：`resolvedExtensionId = extId ?? helloExtensionId`
      把 hello 里**自称**的 id 当身份凭证，任何本地进程或 `null` origin 页面都能声称生产 id 直接进白名单
      （且经 `onAutoApprovedExtensionId` 持久化，跨重启存活）。现授权只用 origin 派生的 `extId`，
      自称 id 仅用于审批弹窗展示
- [ ] **ISS-18** `daemon.ts:436` 的 `verifyClient` 在有固定清单时要求 `chrome-extension://` origin（当前 `!origin`
      让任何裸 WS 客户端通过）— **未做**：收紧 `null` / `!origin` 有打断用户现有桥接的风险，属产品面。
      已在 `extension-trust.ts` 注释记录该纵深缺口，留作后续
- [x] **ISS-19** `app-connections/connector-service.ts` 的 `invoke`（`:353-520`）在 `getStatus` 之后补
      `isProviderEnabled(readAppPolicy(), conn.provider)` 检查，返回 `provider_blocked`
- [x] **ISS-19** 决定 `policy-gate.ts:63,71` 的两个死函数是暴露（`appConnection:setProviderEnabled` + 设置项开关）
      还是删除；同时删掉代码注释里「Disabled providers are filtered BEFORE tools/list」这句在可达之前不成立的宣称
      — 选删除 `setProviderEnabled`（`isProviderEnabledLive` 被 invoke 复活）。补 IPC + 设置项开关属产品面，
      留作后续；当前 `[apps]` 仍可手改 config.toml 生效
- [x] **ISS-20** `electron/channels/connector-secret-store.ts:28-41` 对 `platform` 施加与
      `attachment-store.ts:35-45` 的 `assertSafeSegment` 相同的检查（`path.sep`、`/`、`..`、`\0`），并额外限定
      `KNOWN_PLATFORMS`
      — `755b9f9a`。**只做分段检查，不加 `KNOWN_PLATFORMS` 白名单**：第一版加了白名单，会打断 QQ Mail
      （`maybeConnectQqMail` 读 `platform "qq-mail"`，它不是 connector 平台）。**凭据平台集是 connector
      平台集的真超集**，词表归调用方管，边界只管「一个安全路径段」。
      **agentId 的旧校验保持逐字节不变**：`config/agent-id.ts` 有更严的 `assertValidBotId`（kebab only），
      但 plan 485 Phase 4 才做遗留 id 重命名，先收紧会把这些 agent 锁在门外——已加测试钉住非 kebab id 仍可用
- [x] **ISS-20** 先确认 `secret:store` 未在 `electron/preload.ts` 暴露这一事实仍然成立；若已被暴露，立即升为 P0
      — **前提成立，非 P0**，但比计划里写的更微妙：该 handler **确实存在**
      （`electron/ipc/db-handlers.ts:2093`），`agentId/platform/field/value` 四个参数**零校验**直通 store；
      只是 preload 没暴露它，且唯一的通用 invoke 指向 `project-database:invoke`（另一通道）。
      UI 侧 secret 输入流是**已知待办**（`BotDirectChatView.tsx:36` 写明 still pending，
      `BotSendCard.tsx:13` 写明 no input yet），所以「handler 没有调用方」是一致的，不是意外断裂
      — **fails-before 很硬**：撤掉守卫后 `setSecret('bot-x', '../../../../evil', ...)` 真的去磁盘 mkdir
      （报 `EPERM ... mkdir`，即已跳出临时目录），NUL 那条把 `path.join` 打成 `path must be a string`
- [x] **ISS-17** `packages/gateway/src/adapters/feishu/webhook-server.ts:110-117` 改成强制头校验
      （`if (headerToken !== this._options.verificationToken) return 401`），未配置 token 时**关闭** webhook 而非放开
      — `70b8a8a8`。原写法是 `if (headerToken && headerToken !== token)`，**不带 header 即放行**，整段形同虚设；
      未配置 token 时整段被跳过。改为强制 + 常数时间比较；无 token 一律 503 且构造时告警一次
      （fail closed）。附带修：配置的 `path` 之前**完全没被检查**，端口上任意路径都收
- [x] **ISS-17** 实现 `encryptKey` 签名校验（HMAC over `timestamp + "\n" + nonce + "\n" + body`）+ 时间戳新鲜度窗口
      + 短时 nonce 集合防重放（字段目前只在 `feishu/types.ts:301` 与 `feishu/index.ts:368` 被赋值，从未被读）
      — `70b8a8a8`。**计划里的「HMAC」是错的**：官方 `@larksuiteoapi/node-sdk`（本地 node_modules 可读）用的是
      **SHA-256 十六进制**拼接 `timestamp + nonce + encryptKey + body`。且**官方 SDK 自己不能当基准**——
      它签的是 `JSON.stringify(data)`，`data` 是已并入 `headers` 的解析后对象，拼接也无分隔符，
      与服务端实际签名对不上。实现取「换行拼接 + 原始 body」形式，偏离原因写在该函数注释里便于一行修正。
      **⚠️ 本机无网络，无法与官方文档核对**；仅在配置了 encryptKey 时生效，未配置者行为不变
      — fails-before：原实现下 20 条新测试挂 10 条（无 header、3 条 fail-closed、路径、4 条签名）
- [x] **ISS-21** `remote-mcp.ts:350-423` 增加第二个 `Map<string, Promise<RemoteSession>>` 缓存 in-flight
      promise，`finally` 里清除；照抄 `token-service.ts:54,127-135` 的 single-flight 写法
- [x] **ISS-22** `app-connections/catalog-cache.ts:27-45` 的 `CachedSnapshot` 增加已解析的 `remoteMcpUrl`（或其哈希），
      读取时必须匹配；`registerPluginAppDeclarations`（`connector-service.ts:145`）在同 provider id 换端点时清缓存
      — 存明文 URL 并在 `readCatalogCache` 强制校验（无 `endpoint` 的旧快照直接判废 → 触发一次实时重取）；
      **未做** `registerPluginAppDeclarations` 侧清缓存：读取时比对已能挡住，额外清缓存是优化而非修复
- [x] **ISS-23** `electron/channels/telegram-connector.ts:114` 的 `offset` 改持久化到既有 `channel_offsets` 表
      （`electron/db/schema.ts:228`），按 batch 成功后写、构造时从存储初始化；加启动期 backlog 上限
      — **PR #99**（`c32b4a87`）。offset 原是每次 start 都归 0 的普通字段，重启即重放 Telegram 队列里
      剩下的全部消息。表和两条通道（IPC `db:channel:*Offset`、agent db-bridge）**早就存在并被使用**，
      只有连接器没接。存储**在 batch 处理完后写**（崩在中间应重放该 batch，而非静默丢弃）；
      存储失败只记日志并吞掉（DB 没就退化成旧的纯内存行为，不打断轮询）；
      DB 句柄**每次访问时解析**而非构造时捕获——connector runtime 可能在 DB 启动完成前就建好连接器。
      启动期上限只作用于**第一个非空 batch**，之后积压仍全速排空；跳过的条数/offset/上限进 WARN，
      且 offset 前移越过它们（默认 500，可配，`Infinity` 关闭）。**按 agentId 分键**（update_id 是按 bot 的）
      — **写测试时抓到一个 review 没抓到的 bug**：上限把 offset 设到保留 batch 之后，
      但逐条处理的循环又把 offset 倒退回最后一条保留的 update → 被跳过的消息下一轮重新投递，上限形同虚设。
      循环后重新应用高水位
      — 另：第一版测试的 fetch stub **无视 offset 无限重发同一批**，断言全绿但毫无意义；
      改成忠实模拟队列（按 offset 取、消费、按页大小）
      — 棘轮抓到新 store 的 better-sqlite3 结构类型过严，已在边界修掉
- [ ] **ISS-24** 对 `preload.ts:2033,2034`（`agent:stream`/`agent:interrupt`）、`:2295,2298`（ISS-06 已修）、
      `:2311,2313`（ISS-06 已修）、`:2495,2496`（`overlay:*`）、`:2613-2616`（`git:*` 写操作）逐条二选一：删掉
      preload 方法，或补上 handler。`overlay:*` 只能删——overlay 窗口根本没有 preload
      （`electron/services/overlay/index.ts:14`），没有 context 能接收它们
- [ ] **ISS-25** 删掉 `src/lib/git-ipc.ts:109,113,156` 三个包装函数及只描述它们的类型；同时在
      `electron/preload.ts:2601,2602,2609` 决定是否一并摘掉通道（倾向一起删）
- [ ] **ISS-26** `src/components/chat/WidgetRenderer.tsx:291-295` 复用 `src/hooks/useLinkOpener.ts:11` 的
      `isSafeWebUrl` 校验后再 `window.open(url, '_blank', 'noopener,noreferrer')`；`widget:previewImage`
      的 `src` 套同一套 scheme 白名单
- [x] **ISS-27** `src/components/layout/panels/CodeReviewPanel.tsx:395-460` 的 `refresh()` 加同文件 `:465,475`
      已经在用的 `cancelled` 守卫（每次 `set*` 前提前返回），或用单调递增 ref 丢弃过期响应
      — 用单调递增 generation ref；被取代的 run 既不提交状态，也不清掉属于新 run 的 spinner
- [ ] **ISS-28** `src/components/chat/ChatView.tsx:926-932` 改成两阶段：先快照被截断区间，发送成功才丢弃；
      失败则恢复。最低限度把 `editTargetRef.current = null` 移到发送成功之后，并把草稿落到既有 mailbox
      — **部分完成**：实现了最低限度的一半（失败时恢复 `editTargetRef` + `chat.editSendFailedRewound` 提示，
      中英文案）。**两阶段快照/恢复未做**：`truncateFromInclusive` 走 `appendRebase` 追加式，
      原消息仍在 rollout 文件里（只是投影被 supersede），消息本身没丢；但它同时
      `restoreFilesForEvents` 回滚了工作区，**文件系统回滚不可逆**，只恢复 transcript 会让记录与磁盘不一致。
      真正的两阶段需要把「发消息」与「回滚」合成一个事务，属架构改动，留给 C 轨
- [ ] **ISS-28** `src/stores/conversation-store.ts:1112-1122` 的 `deleteMessageAndAfter` 在后续失败时具备回填能力
      — 与上一条同因，工作区回滚不可逆，单做 store 回填会产生不一致状态。**不做**
- [ ] **ISS-29** 对审计列出的 28 个 channel 逐个决定「删注册」或「补消费者」；`update:install` 与
      `plugin:security:{check-path,policy,trust-info}` 需单独结论（前者是「重启并安装」不可达，后者是信任门无调用方）
- [ ] **ISS-29** 清理完成后加契约测试：从 `preload.ts` 推导 channel 名集合，断言每个出站名都有 handler、
      每个 handler 都被暴露（这一条同时永久关掉 ISS-24 / ISS-06 / ISS-29 的复发）

---

## 4. C 轨道【根因：强制与共享原语】

**这一轨依赖 B 轨的契约**。ISS-30/ISS-31 的自然落点就是 B 轨产出的 channel manifest；在没有 manifest 之前先做
schema，等于把第三份手写清单固化下来。

- [ ] **ISS-30** 在 `electron/main.ts` 的注册 helper 里包一层 `assertTrustedSender(event)`（主窗口 + 主 frame
      origin），使特权 handler 无法忘记调用 — 落为 `electron/ipc/trusted-sender.ts`：纯函数
      `evaluateTrustedSender` + 薄适配 `assertTrustedSender`，12 个单测。**只做了参考接入**
      （`app:create-project-folder`，加 6 个 handler 级用例）。全仓扫另开：需要真实 Electron 运行
      才能确认 `senderFrame` 适配器行为，浏览器端 Vite 验不了 preload 路径
      — **C3 补正**：参考接入当时弄坏了 `system-handlers.test.ts` 里 5 个既有的
      `app:create-project-folder` 用例（事件 mock 是 `{}`，守卫按设计拒绝）而没有发现。已修：补全
      `mocks.mainWindow.webContents` 的 `id` / `getURL`，引入派生的 `TRUSTED_EVENT`，并补 2 条
      守卫**拒绝**路径的集成测试（之前只有纯函数层的拒绝测试，handler 层的拒绝路径零覆盖 —— 正是这个
      缺口让红灯溜过去）
- [ ] **ISS-30** 清点全部辅助窗口（`services/computer-use-overlay.ts:138`、`services/recorder/badge.ts:183`、
      `services/overlay/index.ts:157`、`services/wake.ts:514`、`conductor/link-snapshot-service.ts:155`），
      明确哪些允许加载 `preload.ts`；`electron/ipc/system-handlers.ts:414-422` 的广播改为只发给显式订阅的窗口
      — 未做：广播点 20 处 / 17 个文件，收窄需要 Electron 端到端验证
- [x] **ISS-31** 建 `electron/ipc/contracts.ts`，按 channel family 定义 zod schema，在 handler 边界 parse；
      从同一份 schema 生成 preload 表面 — 落了 `electron/ipc/contracts.ts`（纯 zod，无 electron 依赖，22 个单测
      ＋ 11 个 handler 级测试）＋ `parseIpcPayload` / `IpcContractError`。**"从同一份 schema 生成 preload 表面"未做**：
      preload 表面目前是手写的 `ipcRenderer.invoke` 包装，生成它需要先有 B 轨的 channel manifest
- [x] **ISS-31** schema 化高危 payload 优先：`db:agentProfile:update` / `create`（`db-handlers.ts`）、
      `config:provider:upsert|update|activate`（`agent-communicator.ts`）、`shell:open-path` /
      `show-item-in-folder`（`system-handlers.ts`，3 份重复的手写校验合并为 `ShellPathSchema`）
      — 三条设计约束写在 `contracts.ts` 头部：① 校验**类型与上界而非必填性**，否则会打断 onboarding
      （`migrateLegacyApiProvider` 一直容忍缺字段）；② 未知键 strip，与既有 `fieldMap` 行为一致；
      ③ 开放词汇用有界字符串而非 enum
- [ ] **ISS-31**（旁证，需产品/架构决策）`ApiProvider['providerType']` 声明为 9 值联合，但实际取值更宽
      —— `lm-studio` / `glm` / `minimax` / `minimax-cn` 都在真实 payload 里。类型比现实窄，导致
      `config:provider:upsert|update` 无法在无 cast 的情况下赋给 `ApiProvider`。收窄或放宽该联合类型跨包，
      不在本轨范围
- [ ] **ISS-31**（新发现，同源于 ISS-48）**zod 解析按 schema 声明顺序归一化对象键**，而 `prompt_profile`
      以 JSON 字符串落库，键序会随之变化。读回是 `JSON.parse`，无语义影响；但任何对存储串做字符串
      比较的断言都会脆。`PromptProfileOverrideSchema` 已按领域类型 `PromptProfileOverride` 的字段顺序声明
- [x] **ISS-32** `electron/memory/rag_search.ts:233-234` 把 embedding 拆到独立 `document_vectors` 表（`BLOB`），
      cosine 扫描下推到 SQL 或 worker，只对最终 top-K 取 `content`；至少先给每个 shard 的候选窗口加 `LIMIT`
      — 只做了 plan 里的**退路**：候选窗口加 `LIMIT 500` + `ORDER BY rowid`。真正的 BLOB 表重构未做。
      另注：该文件根本没有 shard 概念，审计描述有误
- [x] **ISS-33** `rag_search.ts:148-160` 的 2 字 CJK 分支加 `LIMIT` + `ORDER BY`，并新建 2-gram FTS 表替代
      `LIKE` 回退（`lib/blog.ts` 式的 leading-wildcard 不可用索引，站点仓库同款问题见 ISS-49）
      — `ORDER BY rowid LIMIT 200`（每 term）。2-gram FTS 表未建，属更大的改动。
      **同款缺陷的高频实例已修**（#90）：`scripts/memory-rag-lib.mjs`（memory-search hook，**每次 prompt 都跑**）
      的无上限 `LIKE` 回退与向量全量载入，加 `ORDER BY rowid LIMIT 200` / `LIMIT 500`，vendor 副本保持字节一致
- [x] **ISS-48（局部，顺带）** `scripts/memory-rag-lib.mjs` 带着 `#!/usr/bin/env node` shebang，但它是纯库、
      无人直接执行。esbuild 输出保留 hashbang，而 hashbang 在 ES module 里是非法 token，导致
      `scripts/__tests__/memory-rag-lib.test.ts` **根本无法加载**，报的是 "no tests" 而非失败——
      于是「每次 prompt 都跑」的 RAG 核心**长期零覆盖**。移除 shebang 后该目录从
      10 失败/10 通过（共 20）变成 10 失败/36 通过（共 46）。入口脚本
      （`memory-rag-hook.mjs`、skill 的 `memory-search.mjs`）**保留** shebang，它们确实被直接执行
- [x] **ISS-34** `electron/memory-state/tierIndex.ts:248-254` 的 `listTierEntries` 三个分支都加 `limit`，
      `mergedTierRecall`（`:296-300`）给默认值（`ORDER BY updated_at DESC` 已就绪）
      — 默认 1000 / merged 每层 200。额外发现：SQLite 里 `LIMIT -1` 意为「无限制」，
      所以 limit 必须校验而非信任
- [x] **ISS-35** 保留 `packages/agent/src/tool/allowedRoots.ts:37` 为唯一逃逸检查器；把
      `permissions/policy.ts:1047` 的 `isToolWithinWorkspace` 改成解析候选路径后委托 `isPathWithinRoots`，
      `cd` 正则（`policy.ts:1066`）只作候选来源，不再作决策过程
      — 手写那版**不做 realpath**，工作区内指向外部的符号链接可以直接通过。回归测试对旧代码失败。
      顺带发现：`collectAllowedRoots` 含工作区**父目录**为根，工作区为 `E:/Projects/duya` 时
      整个 `E:/Projects` 都在界内——疑似为「仓库子目录」工作区刻意为之，但值得产品裁定
- [ ] **ISS-36** 把 `DuyaAgent.ts` 里 `streamChat` 的工具装配前奏（`:1270-1400`）抽成
      `buildTurnToolchain(...)`，返回 `{ tools, canUseTool, toolInvokeDispatcher, executor, permissionContext }`，
      使权限面只有一个装配点
- [ ] **ISS-36** 删掉 `DuyaAgent.ts:1286-1290` 的两行 `console.error` 热路径诊断（每次 `streamChat` 都写 stderr）
- [ ] **ISS-36** 与 ISS-48 合并做：`DuyaAgent.ts` 反正要重写，顺手修 86 处 mojibake

## 4.1 D / E 轨道【站点与 P2/P3 卫生】

站点轨（D）可与 A/B/C 完全并行，单独仓库、单独 review。E 轨按「形状」批处理，不按文件逐个修。

- [ ] **ISS-37** `next.config.ts` 加 `async headers()`：CSP（`default-src 'self'` + 显式放行
      `api.github.com` 与 Supabase/auth 源）、`Strict-Transport-Security: max-age=63072000; includeSubDomains`、
      `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、
      `X-Frame-Options: DENY`、限制 camera/microphone/geolocation 的 `Permissions-Policy`（产品自带浏览器自动化）
- [x] **ISS-37** 站点 `next.config.ts` 加 `async headers()`
      （`duya-website` PR #2）。每条指令都从**站点实际加载的东西**推导而非套模板：字体自托管
      （`Windsor-Bold.woff2`，无 CDN）、站点不嵌任何 frame（故 `frame-src` 无需白名单）、
      出站只有 account API + 下载页的 `api.github.com` / `update.duya.dev` + Supabase auth。
      两处刻意偏离模板并写明理由：`script-src` 带 `'unsafe-inline'`（Next App Router 注入内联
      bootstrap 脚本，未接 nonce——那需要 middleware），残留的保护是"任何远程主机都不能供脚本"；
      HSTS **不带 `preload`**——preload 还需向 hstspreload.org 提交，光声明不买任何东西、却暗示了
      不存在的保证，是否开启是域名所有者决策而非代码默认值。
      已用 `next start` + 真实请求验证六个头全部下发，且 `/`、`/manual`、`/manual/02-install`、
      `/download`、`/account` 全 200
- [x] **ISS-38** `vercel.json` 的 17 条目标补真实章节号（`lib/docs.ts:41` 要求
      `/^([0-9]+-[a-z0-9-]+)\.([a-z]{2})\.md$/`，实际 slug 形如 `02-install`）
      — 全部 17 条**都是 301 → 404**（只有 `/docs → /manual` 对，因为 `/manual` 是索引路由而非 slug）。
      用 `scripts/check-redirects.mjs`（静态、零依赖、接进 `prebuild`）读 `content/manual/` 校验，
      避免再次漂移。**额外补了 16 条无前缀 `/manual/<name>` 的跳转**：301 被浏览器**永久缓存**，
      已经点过旧跳转的用户历史/书签里已固化死链，只修 `/docs` 源会恰好把这批人留在 404 上。
      fails-before：对原始 vercel.json 跑检查，正确报出 17 条坏目标并逐条给出正确建议
      （"Did you mean /manual/02-install?"）；修好后 35 条跳转对 21 个 slug 全部命中。
      **本地无法端到端验证跳转**：`next start` 不加载 `vercel.json`（那是 Vercel 部署层），
      这正是该缺陷本地永远看不到的原因，检查只能是静态的
- [x] **ISS-39** 删掉 Clerk 依赖 / `middleware.ts` / `@clerk/nextjs`
      — **审计误报，本仓不存在 Clerk，已作废**。证据：`git log -S "clerk" --all` **无任何提交**
      （从未提交过），`git grep -il clerk` 对 tracked 文件**零匹配**，`package.json` 只有
      `@supabase/supabase-js`。审计读到的 Clerk 引用**只存在于 `E:\Projects\duya-website` 的未提交
      工作区**（untracked `middleware.ts`、`app/sign-in/`、`app/sign-up/`，以及被改的
      `header.tsx` / `layout.tsx` / `package.json` + 一批 `scripts-tmp-auth-*.png`）——
      有人把一次认证迁移做了一半没提交。**那批在制品未被本计划触碰**
      - **⚠️ 独立于审计的真实风险**：`duya-website` 共享检出有 **99 项未提交改动**，其中包含
        半成品的认证迁移。距一次 `git checkout .` 全部丢失只差一步。这比 ISS-39 本身值得注意得多，
        **需用户处理**（提交到分支，或确认废弃）
- [x] **ISS-40** 删 `packages/agent/src/tool/ReadTool/ReadTool.ts:801` `createReadTool`（并从 `builtin.ts:13,336`、
      `bot-builtin.ts:28`、`tool/index.ts:7` 摘掉再导出）
      — 提交 `1bdb45b7`，分支 `fix/583-track-e3-dead-code`（PR 待 `api.github.com` 恢复后开）。只在 import/re-export 链中，零调用方
- [ ] **ISS-40** 删 `packages/agent/src/utils/bash/commands.ts:79` `splitCommand_DEPRECATED` 与
      `tests/utils/bash/commands.test.ts:66-70`；删 `utils/bash/shellQuote.ts:151` `hasShellQuoteSingleQuoteBug`
      与 `tests/utils/bash/shellQuote.test.ts:136-141`（该测试三种情况都断言 `false`，永不失败）
      — `splitCommand_DEPRECATED` **已删**（只被自己的测试引用）。`hasShellQuoteSingleQuoteBug` **未做**（本轮未查证是否仍不可达）
- [x] **ISS-40** 删 `packages/agent/src/tool/BrowserTool/CDPClient.ts:1515` `createCDPClient` 与 `:1521` 的
      `export default`，只留 `createCDPClientForMode`
      — **注意**：`createCDPClientForMode` 是 `BrowserPool.ts:301` 在用的**另一个活函数**，两者名字相近，勿误删
- [x] **ISS-40** 处置 `electron/services/overlay/sanitize.ts:23`（38 行模块 + 100 行测试，声称校验一个哪都没实现的
      channel）：随 ISS-24 一起接线，或三件套全删。**不要保留「有测试所以有校验」的假象**
      — 选「全删」。查证删掉不会丢校验：`rectOf`（`index.ts:215`）跳过无可用数值 rect 的条目，
      `selectVisibleOverlayElements`（`geometry.ts`）丢非交互控件类型 / 屏外框 / 超上限条目；`maxNodes` 上限本就在
      生产者侧（`uia-probe.ts`）。**运行时行为零变化**。同时修掉 `overlay/index.ts` 两条已失效注释
      （`showOverlayElements` 的 doc 仍要求「先经 sanitizeOverlayElements 校验」；模块头仍描述
      `overlay:show-elements`/`overlay:clear` 两个已在 #87 移除的 IPC 通道）
- [x] **ISS-40** 删 `src/components/chat/cards/bot-direct/`（4 个组件 + barrel + 100 行测试，源码自述
      `TODO: mount this`），或按 TODO 真正挂到 `GroupRoomChatView`
      — 删。barrel 是其成员的唯一 importer，`src/` 内零外部引用；4 个卡片纯用 Tailwind 工具类，
      删后不留孤儿 CSS。**`BotDirectChatView`（`components/chat/`）是活的**，`App.tsx:832` 在挂载，勿连坐
- [x] **ISS-40** ~~删 `packages/plugin-core/src/mcp` 全链路上的 `useShell`（7 处：`loader.ts:76`、
      `user-config.ts:163,195`、`env-expansion.ts:305` 等）：要么实现（SDK transport `shell: true`），要么在
      `user-config.ts` 显式拒绝~~ — **审计结论已过期，不动**
      — 实测是 **15 处**不是 7 处，且 `resolve.ts:200,578`、`collect.ts:108,141`、`user-config.ts:163,195`
      在实际透传，不是死代码
- [x] **ISS-41** 把两套 `InventoryLedger` 收敛到 `packages/plugin-core/src/mcp/core/ledger.ts`
      （`ledger-types.ts`/`list-tools.ts`/`deadline.ts` 已在那里，两条链都已在用），
      `electron/services/app-connections/inventory-ledger.ts:31` 与
      `packages/agent/src/mcp/inventory-ledger.ts:29` 改为 import；同时解掉 `:71` 那个两臂相同的 ternary
      — **PR #101**（`9c3d91e8`）。两份实现**逐字节相同，只差各一个 helper**：chain B 多 `hydrateFromCache`、
      chain A 多 `static empty()`（**全仓零调用方**）。两边**早已共享类型**（都 import `ledger-types.js`），
      所以「electron 不能 import agent workspace 包」这条理由**不成立**——那对 `@duya/agent` 为真，
      对两条链都已依赖的 `@duya/plugin-core` 为假
      — **两臂相同的三元在 agent 那份**（`failDiscovery` 里 `revision > 0 ? 'failed' : 'failed'`）；
      electron 那份从未有过——计划指的 `electron/.../inventory-ledger.ts:71` 位置是错的
      — **类放在既有 `ledger-types.ts` 而非新建 `ledger.ts`**：第一版新建文件后 agent tsc 报 TS2307，
      因为 worktree 里 `node_modules/@duya/*` 全是指向**主检出**的 junction，workspace 包里**新建文件对其他包的
      typecheck 不可见**（即 AGENTS.md 说的「fake TS2307」）。`ledger-types.ts` 今天两条链都能解析。
      副作用：该文件自称「PURE TYPE ONLY（plan 580 D1）」却同时导出运行时 `emptyLedgerSnapshot()`——
      **这个声称本来就是假的**，头部已改为描述实际内容
      — 三处指向已删文件的注释一并修正
- [x] **ISS-41** 从 `RemoteSession` 删掉与 ledger 重复的 4 个并行字段
      （`remote-mcp.ts:75-78` 的 `inventoryRevision`/`pagesFetched`/`discoveredTotal`/`discoveryStatus`），
      `rediscover`（`:278-288`）改读 `session.ledger.getSnapshot()`
      — **审计结论已过期，无需改动**：`RemoteSession` 上已无这 4 个平铺字段（`:339-340` 处的
      `pagesFetched`/`discoveredTotal` 属于 probe 的 `result`，不是 session）。字段旁注释还明确写着
      「Do not flatten them back out」，并给出理由（`connector-service.ts:339` 消费快照，
      平铺无法表达 `complete` vs `stale`）
- [x] **ISS-41** 删除 `src/lib/git-ipc.ts:9-97` 手抄的接口，改为
      `export type { ... } from '../electron/ipc/git-types'`（先确认 `git-types.ts` 只含类型、import 任何运行时无关模块），
      并删掉 `:3-7` 那段已经不成立的注释（`src/global.d.ts:3` 早已直接 import preload 的类型）
      — **PR #101**（`caae2d3c`）。**19 个类型逐一对应**，全部改为 re-export；
      `git-types.ts` **零 import**，故是纯类型边，不会有 electron 代码进入渲染层 bundle
      — 那段注释的**理由是错的**：`tsconfig.json` 的 `exclude` 只过滤 `include` 的 glob，
      **不会阻止被 `include` 内文件依赖性引入**；而 `src/global.d.ts:3` 一直在
      `import type { ElectronAPI } from '../electron/preload'`——渲染层早就在类型引用 electron 侧
      — **19 个形状逐一比对后才切换，没有假设**：7 个文本上有差异，但**全部只差文档注释或分节分隔符**，
      无一涉及字段。副本只在**文档**上漂移过，且渲染层那份完全没有文档
      — 顺带清掉该文件头部一个 mojibake 字符（ISS-48 的零散实例），并修正 `git-types.ts` 里同源的错误声称
      — web tsc 通过即是真检查：git-ipc 的 **15 个** import 方全部仍对着 preload 定型的 bridge 通过类型检查
      — **诚实缺口**：agent 的 tsconfig 无 `paths`，经 node_modules 解析 plugin-core，
        故 worktree 里 `tsc -p packages/agent` 看不到上述改动；用一次性 tsconfig 把
        `@duya/plugin-core/*` 映射到工作区源码验证过（exit 0），该临时文件已删除未提交。合并后此缺口自动消失
- [ ] **ISS-41** 合并两个 Git 轮询 hook（`src/hooks/useGitRepo.ts:54-121` 与 `src/hooks/useGitStatus.ts`）：抽一个
      `useGitPoll(cwd, channels, interval)`，把「一个 cwd 一个 poller」从注释（`useGitRepo.ts:1-9`）变成抽象的属性
- [ ] **ISS-41** 删 `src/components/chat/WidgetRenderer.tsx:40-57` 的私有 `useTheme`，改用 `@/hooks/useTheme`；
      顺带把两处「谁是真相」对齐（建议 `data-theme` 优先，`localStorage` 只做 hydration 前的初值）
- [ ] **ISS-41** 站点侧：提交 `components/ui/theme-provider.tsx` 与 `components/ui/ThemeSwitch.tsx` 的待删状态
      （两文件仅目录名之差，在大小写不敏感文件系统上会撞名），以 `app/theme-provider.tsx` 为准
- [ ] **ISS-42** 拆 `electron/gateway/message-bus.ts`（1408 行）成 `gateway-sessions.ts` /
      `gateway-commands.ts` / `gateway-qr.ts`，本体只做路由
- [ ] **ISS-42** 拆 `src/components/layout/panels/CodeReviewPanel.tsx`（1067 行、27 个 `useState`）出
      `useReviewData` 与 `useFilePreview` 两个 hook，并把 4 个内联子组件（`StatusIcon`/`UnifiedHunk`/
      `SplitHunk`/`DiffContents`/`ReviewContextMenu`）移到独立文件，目标 < 400 行
- [ ] **ISS-42** 按域拆 `electron/ipc/db-handlers.ts`（session / task / goal / conductor）；
      `electron/main.ts:1154` 的 lazy loader 已证明可行
- [ ] **ISS-43** 把 `src/lib/providers/` 及其它被 `electron/` 反向 import 的契约模块搬进 workspace 包
      （如 `packages/provider-contract/`）；短期先加 lint 规则禁止 `electron/` 非 type 地 import `src/`
- [ ] **ISS-43** 核实 `provider-store.ts:66-71` 之外的全部跨 import 目标当前确实无 DOM 引用
      （审计已确认这 5 个文件干净，扩到 40+ 个 import 需重跑）
- [ ] **ISS-44** 给 `documents` 表与 `memory_tier_index` 加按体积/年龄的裁剪，挂到既有 5 分钟 sweep
      （`electron/memory/memory-worker.ts:126-136`）；`DUYA_MEMORY_ENABLED` 只控写入频率，不控留存量
- [x] **ISS-45** `src/components/layout/panels/CodeReviewPanel.tsx:95-96` 的 `#b68cff` / `#f39a49` 换成新增的
      `--review-rename` / `--review-modified` token（light + dark 两块都加）
      — **PR #100**。两个颜色原本**同时存在于 CSS 和 TSX**，改一处另一处不生效。新增
      `--review-modified` / `--review-renamed`（与既有 `--review-add`/`--review-remove` 并列于
      `.code-review-panel` 作用域），组件改用 `var()`。**取值不变，渲染像素一致**——是去重不是改样式，
      因此不需要视觉验证才敢宣称安全。token 名用 `renamed`（对齐 git status 名 `renamed`），非计划里的 `rename`
      — **dark 覆盖未做**（见下条），新增静态测试 `code-review-status-colors.test.ts`（8 条）钉住：
      token 声明在面板作用域、hex 不出现在组件、`statusColor()` 每个分支都是 `var()`、
      每个 hex 在 CSS 中恰好出现一次（即其自身声明）。fails-before：把字面量放回组件 → 8 条挂 2 条
- [ ] **ISS-45** `src/components/chat/CodeBlock.tsx:33-44` 去掉 JS 里的 `isDark` 分叉，改 `var(--code-bg)` 等
      — **未做**：`code-review.css` 对这四个状态色**也没有 `[data-theme="dark"]` 覆盖**，且全仓
      `src/styles/*.css` 仍有 **284 处**硬编码 hex。把整个样式表 token 化是一次大范围**视觉变更**，
      本机跑不起应用无法验证，留在本条待办而不是塞进 PR #100
- [ ] **ISS-45** 把 `connector-icons.tsx`(21 处)、`DuyaMascot.tsx`(17 处) 这类厂商品牌色在 `AGENTS.md` 里写成
      显式豁免，而不是继续假装它们是违规
- [ ] **ISS-46** 二选一并同步改文档：给 `packages/agent/package.json` 补齐真实子路径，或把
      `packages/agent/ARCHITECTURE.md:520-528` 的 8 个子路径砍到实际导出的 3 个；
      同时刷新 `:196-208` 的 `ToolRegistry` / `:350-354` 的 `MCPManager` 签名
- [x] **ISS-47** `console.*` 全量替换为 `getLogger()` + `LogComponent`：起点
      `electron/memory/curation_single_shot.ts`（8 处）、`electron/gateway/message-bus.ts`（23 处）、
      `packages/gateway/src/adapters/{telegram,index,weixin}`（24/15 处）、`packages/agent/src/cli/slash-commands.ts`（112 处）；
      删 `electron/preload.ts:1722` 的 `[preload][DEBUG]` shim
      — **PR #100 只做了 electron 侧 57 处 / 13 文件**（`message-bus.ts` 29、`curation_single_shot.ts` 9、
      `process-cleanup.ts` 4、`config/agents.ts` 3、其余各 1–2）。`message-bus.ts` 原本**logger 与 console 并存**，
      输出被劈成「结构化文件」与「WARN 默认级别根本不采集的控制台噪音」两路
      — **刻意不动**：`electron/logging/logger.ts`（它的 `console.*` **就是**日志系统的终端 sink，转换是范畴错误）、
      `electron/preload.ts`（隔离上下文，拿不到 main 侧 logger；13 处多为遗留 `[preload][DEBUG]` 追踪，
      清理 + 转发到 main 都需产品决定）、`packages/gateway`（279 处，独立包**无 logger 依赖**，
      给它结构化日志是架构决策不是机械替换）、`packages/agent`（CLI 打印到控制台本就是目的，属豁免）
      — **顺手脱敏（不是机械转换）**：`gateway:feishu:qr:begin:response` / `:poll:response` 原本
      `console.log(... JSON.stringify(msg))`，会把**整个飞书 QR 响应（device_code / QR 载荷）打进 INFO 日志**，
      改为只记 request id
      — 由 subagent 执行，**每项结论均独立复核**：改动文件精确落在 13 个目标 + 1 个测试 mock；
      `git diff --numstat` 与 `--ignore-all-space` 行数一致（无 CRLF 噪声）；`router.ts` 残留两处经查**确为注释**；
      棘轮 304/149 与基线一致且 13 个文件零新增错误；
      测试 `electron/{gateway,services,agents,memory,config,lib}` 改动前后**均 13 failed / 103 passed / 1 skipped**
      （stash 对比）——13 个失败套件为存量
      — `catalog-cache.test.ts` 的 logger mock 被迫补 `getLogger`/`LogComponent`（模块级 `getLogger()` 导致该测试
      文件加载失败），补法即 AGENTS.md 规定的 `vi.hoisted` 共享单例 + factory 返回稳定 logger
- [ ] **ISS-47** `src/` 的 37 处 `console.*` 需要一个渲染进程自己的结构化日志方案（或在 `AGENTS.md` 写明渲染进程的显式豁免）
      — 渲染进程同样无 logger 依赖，与 `packages/gateway` 是同一类架构问题，需一并决策
- [x] **ISS-48** 加 `.editorconfig` / `.gitattributes` 钉死 UTF-8
      — 先扫描取证再动手，扫描本身比计划预估的严重：**13 个 tracked 文本文件带 UTF-8 BOM**
      （其中 9 个正好是 `packages/gateway/src/adapters/feishu/` 整个目录；**5 个是双 BOM**，
      即"对已带 BOM 的文件再做一次编码修复、而工具又加了 BOM"——PowerShell 5.1 的
      `Set-Content -Encoding UTF8` 正是这个行为），另有 **2 个文件整体存为 UTF-16LE**
      （`docs/recovered-plans/479-p3-membership/` 下，不在任何 tsconfig include 里，不参与编译）。
      全部已归一化为无 BOM UTF-8；用 node 逐文件比对确认 **15 个文件 0 处真实内容变化**。
      新增 `.editorconfig`（`charset = utf-8` = 无 BOM，与 `.gitattributes` 换行策略一致，
      Markdown 保留行尾空格，bat/cmd/ps1 保留 CRLF）+ `.gitattributes` 编码约定段。
      **明确不用 `working-tree-encoding`**：它是唯一能真正强制编码的 Git 属性，但会在 checkout
      时**重新编码**文件——在仍含非 UTF-8 字节的树上开启，会让每个贡献者下次 pull 时文件被静默改写。
      先修树，再考虑开；不能当"修复手段"用。
      另加 `scripts/check-text-encoding.mjs` 棘轮门禁（挂到 `npm run check:encoding` 并前置进
      `typecheck:all`），否则这只是一次性清理、下一个人会再犯。已做 fails-before：人为植入一个
      BOM 后门禁报错退出 1。
      **仍未做**：`DuyaAgent.ts` 的 86 处 mojibake 本体未修（见下条）
- [ ] **ISS-48** 修 `packages/agent/src/agent/DuyaAgent.ts` 的 86 处 mojibake（`:327,366,372,374,477,821` 等）与
      `electron/config/store-instance.ts:1`、`index.html:36,40`
- [ ] **ISS-49** 站点加 `test` 脚本（`package.json:5-13` 现在完全没有），最少三条：`lib/docs.ts` slug 解析单测、
      「每条 `vercel.json` 跳转目标都存在于 manual slug 集合」的表驱动断言（这一条就能抓住 ISS-38）、
      `app/api/account/route.ts` 的 `DELETE` 401/204 分支
- [x] **ISS-49**（新增子项）门禁「存在于 git 但没被任何 `test.include` glob 收集的测试文件」
      — 起于本会话反复撞到的「故障伪装成成功」变种，故先做了**实测**再决定要不要写门禁：
      - **假设被推翻**：原以为 vitest 会让「收集到 0 个测试」的文件静默通过。实测
        `vitest 3.2.4` 对这种文件**直接失败**（`Error: No test found in suite ...`，
        `Test Files 1 failed`）。所以那条路已经有覆盖，自定义 reporter 是多余的，没做。
      - **真正的缺口**：`vitest.config.ts` 的 `test.include` 是**显式白名单**（不是
        `**/*.test.ts` 这种约定式），任何白名单外的 tracked 测试文件**没有任何人收集、没有人跑、
        没有人让它失败**。这才是同一类问题。
      - 新增 `scripts/check-test-coverage.mjs`（**静态**检查，不跑 vitest：`git ls-files` ∩
        测试文件名 ∩ 逐条匹配 `include` glob），挂到 `npm run check:test-coverage` 并前置进
        `typecheck:all`。**刻意不用 `vitest list`**：全仓跑要 ~70s，且被既有的
        `@lobehub/ui` / `react-syntax-highlighter` Windows 模块解析错误淹没，输出不能当完备性信号。
      - **实测抓到 2 个真孤儿**：
        1. 仓库根目录的 `MessageInput.test.tsx` —— 8 个测试 vs `src/components/chat/__tests__/`
           那份的 10 个；且它 `import ... from '../MessageInput'`，从仓库根出发 `..` 已在**仓库之外**，
           导入路径本身就是坏的。判定为组件搬到 `src/` 后遗留的陈旧副本，已删。
           **差点犯的错**：我最初打算"把 root 独有的一条测试移植进 src 版再删"。查证发现 `src/` 版
           **刻意删掉了**那条并留注释说明（standalone ModelSelector 已被 slash-command popover 取代），
           移植会**复活一个测已删除 UI 的死测试**。改为直接删，未丢覆盖（src 版 10 测试仍全过）。
        2. `docs/recovered-plans/479-p3-membership/tierMembership.test.ts` —— 归档恢复文档，
           不在任何 tsconfig include 内。**把 `docs/` 整目录排除**并写明理由：门禁是关于代码覆盖的，
           docs 下没有代码，收集它反而更糟。
      - fails-before：造 `packages/plugin-core/probe-orphan.test.ts`（plugin-core 不在白名单里）
        并 stage，门禁报错退出 1；移除后转绿。**基线为空** —— 不是"记下来以后再说"，是真清零
- [x] **ISS-49** 摘掉四个 `@ts-nocheck`（`packages/gateway/src/adapters/feishu/{comment-handler,comment-rules,dedup-persistence,qr-registration}.ts:1`）
      — **PR #105**。先量后改：摘掉 flag 只暴露**一个**真实错误，`comment-handler.ts:8` 导入
      `FeishuConfigOptions`，而 `types.js` 无此导出、全仓无第二处引用。`FeishuAdapterOptions` 不是它
      （那是回调包非凭据），故就地声明并导出（`declaration: true` 要求）。另三个文件摘 flag 后零错误。
      顺带删 `e2e/conductor/pan-zoom.spec.ts` 4 处 `@ts-ignore`（下一行已 `as any`，且 `e2e/` 不在任何
      tsconfig include 内）。新增 `check:no-ts-suppress` 门禁（接入 `typecheck:all`）。
      **未按计划给 `comment-handler.ts` 补测试**：查证 `FeishuCommentHandler` 在
      `adapters/feishu/index.ts:169` 构造后只调过 `stop()`，`handleCommentEvent` /
      `setOnInboundMessage` **全仓零调用方**，`configure()` 永不调用（凭据恒空），
      `comment-rules.ts` 只被它引用 —— 功能未接线。给未接线代码补测试是表演，且删这 ~1100 行是
      "功能是否还要做"的产品决策。归入 ISS-29 裁决。
- [ ] **ISS-49** `src/` 25 处 `react-hooks/exhaustive-deps` 抑制 —— **计划的前提不成立，不执行**
      —— **量到的实情**：全仓**零** eslint 配置、零 eslint 依赖、零 lint 脚本、零
      `eslint-plugin-react-hooks`。`git ls-files | grep eslint` 空，root 与所有 workspace 的
      devDependencies 无 eslint。所以这 34 条（不是 25）`eslint-disable` 抑制**什么都不抑制**，
      `exhaustive-deps` 这条规则在本仓**从未运行过**；全仓 132 条 `eslint-disable` 全部失效。
      计划点名的 3 处逐一看过（`useProviderModels.ts:185,190` / `ProviderEditView.tsx:268` /
      `CodeReviewPanel.tsx:579`），**全是刻意且已写明理由的正确写法**（`join('|')` 深比较依赖键，
      否则每次渲染重跑；`CodeReviewPanel` 那条注释明写"只读守卫、不能重新触发 fetch"）。
      改成 ref 模式是无收益的重构且有我无法在本机验证的回归风险。**决定：不动代码**。
      真正要解决的是"给一个零 lint 基础设施的仓库引入 ESLint"，属工具链决策，需用户拍板。
      其余 31 处未逐条审（已抽样 3/3 无问题）。
- [ ] **ISS-50** `electron/ipc/` 统一失败约定：返回 `{ ok: false, code, message }` 判别联合，throw 只留给
      编程错误（先改 `db-handlers.ts:2037,1984,2506`）；`MAIN-019`/`MAIN-027` 是同一族
- [ ] **ISS-50** `packages/gateway/src/adapters/feishu/webhook-server.ts:119-128` 把 `onEvent` 派发拆出独立
      handler，`catch` 永远记日志（当前 ack 之后被 `headersSent` 守卫静默丢弃）
- [ ] **ISS-50** `electron/services/app-connections/token-vault.ts:75-87`：文件存在但不可解密时**不要**把
      `loaded` 置 true，让后续调用能重试，并暴露 `vault_unavailable` 状态（当前会把活的 OAuth 授权判为 `revoked`）
- [ ] **ISS-50** 站点：`app/download/page.tsx:63-65` 去掉浏览器端未认证的 GitHub 拉取，直接渲染构建期值；
      `scripts/fetch-latest-version.mjs:19` 与 `lib/version.ts:5` 两处硬编码兜底（还是 `v0.1.3-beta.2`，实际 `v0.8.1`）
      合并成一个常量
- [x] **ISS-51** `git rm --cached` 摘掉 `tsconfig.tsbuildinfo`、`.playwright-mcp/**`（`.gitignore:23` 已列但未 untrack，
      11 个文件在版本库里）、`scripts-tmp-shot.cjs`；`.gitignore` 补 `tsconfig.tsbuildinfo` 与 `scripts-tmp-*`
      — **审计结论已过期，逐条核实后无需改动**：`tsconfig.tsbuildinfo` **未**被跟踪（`.gitignore:10` 已有
      `*.tsbuildinfo`）；`.playwright-mcp/**` **未**被跟踪（`.gitignore:94`）；`scripts-tmp-shot.cjs`
      未被跟踪且磁盘上不存在（主检出与 worktree 均无 `scripts-tmp-*`）；`.od-skills/` 不存在于任一检出
      之所以「过期」：`.gitignore` 与仓库卫生是被第三方并发改过的（见 Blockers），untrack 已在其间完成
      **未加** `scripts-tmp-*` ignore 规则：当前无此类文件，加了是投机（但注意 duya-website 仓确实出现过
      `scripts-tmp-auth-*.png`，将来若本仓出现需补规则）
- [ ] **ISS-51** `.od-skills/` 与 `.duya/MEMORY.md` 移出仓库或 ignore；`.duya/MEMORY.md:1` 描述的内容契约
      （`content/docs/{get-started,guides,reference}/`、GitHub Pages 静态导出）与代码
      （`lib/docs.ts:27,29` 的扁平 `content/manual` + 固定双语、Vercel 部署）已完全不符
      — **ignore 部分已满足**：`.gitignore:56` 有 `.duya/`，且 `.od-skills/` 不存在
      **未做**：`docs/` 是 gitignore 的，`.duya/MEMORY.md` 的**内容**与代码不符这条需逐条核对后才能改写，
      而该文件不在版本库内（改动无法通过 PR 交付）——建议在**站点仓**单独处理

---

## 5. 不修会怎样（风险）

**A 轨道不修。**
- ISS-02 不修 = 一次提示词注入（任何被抓取网页、MCP 工具结果、agent 读过的文件）即可读走
  `secrets.json` / 主 SQLite 库 / 任意工作区文件，并让模型把内容打印回对话；字节还会留在 HTTP 缓存里。
- ISS-03 不修 = 远程 MCP 连接功能**完全不可用**，且 exec-plan 580 的真机基线永远复现不出来（见 §7 C2），
  后续所有 MCP 收敛决策都建在不可复现的现象上。
- ISS-04 不修 = plan 模式承诺给用户的「只允许写 session plan 文件」是假的；模型通过读 `tool_catalog` +
  `tool_invoke` 即可绕开，无需任何构造 payload。
- ISS-05 不修 = 无签名校验的 marketplace 插件与内置插件权限等同；UI 还在展示一个运行时并不执行的信任姿态。
  用户据此做的信任判断是错的。

**B 轨道不修。** 40 个坏 channel 维持现状 = 每加一个 feature 就多一次「注册名和调用名对不上」的机会，
而现有门禁一个都拦不住。已发生的后果是可量化的：已上线的 Unarchive 操作让行从归档列表消失且不回来
（`src/stores/conversation-store.ts:802` 乐观移除、`:809` 吞掉 rejection）。ISS-18/ISS-19/ISS-20 是三条
本地提权/接管路径。ISS-23 不修 = 每次重启重放最多 24h 消息，重复唤醒 + 重复副作用 + 账单尖峰。

**C 轨道不修。** 108 项里的根因只有 4 个。不动 C 轨，B 轨修完的东西会以同样的形状再回来一次。
ISS-30/ISS-31 不修 = 任何辅助窗口只要加载了 preload，就静默继承全部 440 个特权通道，而今天这个不变式
只存在于口头。ISS-32/33/34 不修 = 主线程被记忆召回阻塞，且成本随使用时长单调增长（因为没有淘汰）。

**D 轨不修。** 站点可被任意站点 iframe 嵌套与点击劫持，无 HSTS；17 条最可能被收藏/分享/收录的 legacy docs
URL 全部 `301 → 404`（只在 Vercel 上出现，本地 `next dev` 永远看不到）；Clerk/Supabase 并存会持续产出
「我明明登录了」类反馈，而 `.env.example` 照着配会让 `ClerkProvider` 全站抛错。

**E 轨不修。** 54 项 P2 本身不紧急，但它们是**新实例的生产线**：barrel 再导出让死代码看起来是接线的
（11 处），重复原语让弱的那份留在决策路径上（4 组）。不做这一轨，C 轨的效果会以每季度 3-5 个新实例的形式衰减。

---

## 6. 验证方式

**门禁（ISS-01）** —— 先立，再谈别的。
```bash
npm run typecheck:all     # 必须在 HEAD 上零错误；若非零，先清基线
npm run test              # Vitest 全量
npm run electron:build    # 确认门禁没把 esbuild 路径排除在外
```
在 CI 上复现：故意在 `packages/agent` 留一行 `const x: number = 'a';`，确认 job 变红；再在
`electron/services/app-connections/connectors/remote-mcp.ts` 删掉 ISS-03 修好的 `ledger` 初始化，确认 job 变红。
**门禁的价值就等于「删掉修复后它会不会响」。**

**ISS-02 复现与验证（修前修后各跑一次）。**
```bash
# 修前：应用内新会话，让模型输出下面这段（或直接贴进任意模型的回答里）
# ![x](duya-file:///C:/Users/<user>/AppData/Roaming/DUYA/config/secrets.json)
# 修后：同一段必须不渲染，且主进程 app.log 出现 403
```
自动化：新增的 main 侧单测必须覆盖「白名单内路径 200 / 白名单外绝对路径 403 / 含 `..` 403」三种断言。
渲染侧：`src/components/chat/MarkdownRenderer.tsx:236` 改动后，模型输出的 `duya-file:` 链接不再被保留，
而 main 下发的附件仍正常显示（附件渲染回归必须肉眼确认，UI 改动按 `AGENTS.md` 走 Playwright 复核）。

**ISS-03 验证。**
```bash
npm run typecheck:all
npx vitest run electron/services/app-connections/__tests__/app-connection-service.test.ts
```
功能复现：建一条 remote MCP 连接，确认 `ConnectorService.listLedgerSnapshots`（`connector-service.ts:339-346`）
不再抛，且 `getLedgerSnapshot`（`remote-mcp.ts:244`）返回真实快照。并发用例：同时发两个首调 `invoke`，
断言只建一个 transport（ISS-21 一起验）。**随后重跑 exec-plan 580 的 Phase 0 真机基线**，
把 `pages=N, total=M` 的实际值记进 §8 决策日志。

**ISS-04 验证。**
```bash
npm run typecheck:all && npx vitest run packages/agent/tests   # 权限相关用例
```
功能复现：开启 plan 模式 tracker，让模型经 `tool_catalog` 读 `module` 的 schema 再经 `tool_invoke` 执行，
必须被 `coordinator.ts:120` 拦下；同时确认 `edit` / `write` / `bash` / `powershell` 行为不变（无回归）。

**ISS-05 验证。** 装一个 marketplace 源插件：
```bash
git grep -n "getCapabilities\|maxFileAccess\|TRUST_LEVEL_CAPABILITIES" -- '*.ts' ':!*test*'
```
执行修复后，这条 grep 必须返回**至少两个**非测试命中（安装路径 + 执行路径），而不是现在唯一的
`electron/ipc/plugin-handlers.ts:630`。走 (b) 路线时，反向断言：`plugin:security:trust-info` 的返回里不再有
`capabilities`。

**ISS-06 验证（最便宜的收益，先验）。**
```bash
npx vitest run electron/ipc/__tests__/db-handlers.test.ts
npx vitest run src/components/shared/ThreadListItem.test.tsx
```
功能复现：归档一条会话 → 侧栏归档分区 → 点 Unarchive → 行必须回到原位置且刷新后仍在。
再手工点一次 session fork 与 rollout import/reconcile，三条都必须成功（当前三条全部静默失败）。

**B 轨其余项的验证形状。**
- ISS-08/09/10/11：对应单测 + `node --expose-gc` 下跑一轮长 turn，确认定时器数不随 turn 增长；
  ISS-11 必须有一个「无 `requestPermission` 时 `ask` 被拒」的用例，三条路径各一条。
- ISS-12：删除后 `git grep -n "getProviderConfig" -- electron` 不得再命中任何 `ipcMain.handle` 注册。
- ISS-14/15/16：`npx vitest run electron/ipc/__tests__/system-handlers.test.ts`；ISS-16 额外人工确认
  DevTools console 在跑一轮对话后不再出现 provider 对象。
- ISS-19：`git grep -n "isProviderEnabled" -- electron` 必须出现 2 处（descriptor + invoke）。
- ISS-23：重启应用后确认 Telegram 不会重放已处理消息（查 `channel_offsets` 行已推进）。
- ISS-30：`git grep -n "assertTrustedSender" -- electron` 的命中数应等于特权 handler 组数；
  并确认 overlay/recorder/badge 三个窗口均未加载 `preload.ts`。
- ISS-32/33/34：建 2000 条记忆文档后测召回耗时，main 线程阻塞应 < 50ms（当前是数十 MB 分配 + 百万次浮点运算）。

**D 轨验证。**
```bash
cd E:/Projects/duya-website
npm run build && npm test        # ISS-49 新增的脚本
curl -sI https://<deploy>/ | grep -i -E "strict-transport|x-frame|content-security"   # ISS-37
```
ISS-38 必须用表驱动测试断言「每条 `vercel.json` 跳转目标都存在于 `content/manual` 的 slug 集合」——
部署后再手工点一条 legacy docs 链接确认不再 404。ISS-39 修后：`grep -rn "clerk" --include=*.ts --include=*.tsx`
应为零命中。

**E 轨验证。** 每批用 `git grep` 做「零残留」断言：例如 ISS-40 修完后
`git grep -n "createReadTool\|splitCommand_DEPRECATED\|hasShellQuoteSingleQuoteBug\|createCDPClient\b" -- packages/agent`
必须为空；ISS-47 修完后 `git grep -c "console\." -- electron packages/agent/src/agent` 只剩 CLI 允许的豁免。

> **两条踩过的坑，写在这里免得再踩：**
> 1. **在 worktree 里必须显式传 worktree 路径给 grep。** 默认搜索根是主检出，本会话因此误搜主检出得出过
>    「无人引用」的错误结论。同理 PowerShell 的 `cd` 不改 .NET 进程 CWD，`[System.IO.File]::ReadAllBytes(相对路径)`
>    读的是主检出——全仓扫描一律用绝对路径。
> 2. **上面那条断言现在还不会为空**：`hasShellQuoteSingleQuoteBug` 本轮没查证、没删。
>    删掉 `splitCommand_DEPRECATED` 时别顺手把它算进去，否则「零残留」会变成假的绿。
>    `createCDPClient\b` 里的 `\b` 是必要的——`createCDPClientForMode` 是 `BrowserPool.ts:301` 在用的活函数，
>    去掉 `\b` 会误判。

---

## 7. 明确不做的事

**本次审计未覆盖（不要在无结论的情况下动手）。**
- `packages/agent/src/tool/BrowserTool/**` 平台抽取器（1316+ 行 DOM 启发式）、`src/compact/**` 策略内部、
  `src/memory-state/**`、`src/memory-rollout/**`、`src/skills/**`、`src/cli/**`（除 console 统计外）、
  `electron/channels|gateway|messaging` 的全部文件、`packages/{ai,voice,conductor}`、`e2e/**`。
- 站点仓库的 `content/**` 正文（45 个文件，只做了 slug 清单）、`components/agent-face/**`、
  `styles/preview/*.css`、`app/page.tsx`（490 行，只看 `HeroPreview` 用法）、法务页正文。
- 站点合规：隐私政策/服务条款是否点名 Supabase 为处理方、是否覆盖服务端持有的
  `SUPABASE_SERVICE_ROLE_KEY`（`docs/account-supabase` 之外的合规问题，本次无人负责，需另立）。

**争议项在结论出来前不动。**
- **飞书 webhook 的严重度**（审计 §7 C1）：fail-open 本身已确认，但默认绑 `127.0.0.1`
  （`packages/gateway/src/adapters/feishu/index.ts:362`），故降为 P1。**先确认生产部署是否用反向代理/隧道把它
  暴露到公网**；若是，恢复 P0 并排在 A 轨。
- **exec-plan 580 的 `pages=N, total=M`**（审计 §7 C2）：连接器审计者静态复现不出，提出的是
  `maxPages:50`/`maxTools:5000` 截断标记不外传；本 plan 认为是 `ledger` 的 `TypeError` 让 discovery 在记录
  totals 前就抛了。**两个机制不互斥，但只能有一个是 580 观测到的那次的原因**。ISS-03 落地后重跑 580 的 Phase 0
  就能判定；在那之前不要按其中一个结论去改 `list-tools.ts` 的截断语义。
- **`MAIN-018` 记忆检索无身份参数**（中置信度）：审计者明确说没读完 `rag_snippet.ts` / `rag_refresh.ts`，
  且 agent 侧可能另有搜索路径。**先让 agent 侧确认 `MemoryManager` 是否仍是实际读路径**（`memory-worker.ts:20-22`
  自述「Plan 306 Phase E 之前仍走 MemoryManager」），再决定是否加强制 `scope` 参数。
- **`CONN-009` 的可达性**（中置信度）：`secret:store` 未在 `electron/preload.ts` 暴露。实施 ISS-20 时先复核
  这一点；若已被暴露，**立即升为 P0**。
- **`SITE-012` 站点 docs slug 缺遍历守卫**（低置信度，审计者自标）：缺失的守卫本身是确定的，
  但多段 URL 是否真能带着 `..` 到达 `getDocBySlug` 取决于 Next 的路径归一化，需要跑起来验证。
  **不作为本 plan 的整改项**，等有 dev server 复现后再立。
- **`RENDER-019`（`diffLoading` 卡死）**：中置信度，是从 effect 依赖推断的。本 plan 只在 ISS-27 里顺带加
  `.finally()` 清标志，不单独立项。

**不借本 plan 顺手做的重构。**
- 不动 `electron/agents/server/router.ts`（3192 行）—— 它是 ISS-12 删除后的唯一活路径，
  拆它属于 ISS-42 的独立 PR，不与止血项混在一起。
- 不动 `electron/db/schema.ts`（2605 行）—— 记忆层的裁剪（ISS-44）应新增表/索引，不重排既有 schema。
- 不动 `package.json` 的 `better-sqlite3` ABI 机制、不动 `scripts/ensure-sqlite-abi.mjs` 的 pre-hook 设计
  （`AGENTS.md` Footguns 已说明它是自愈的；本 plan 唯一相关动作是 ISS-01 的 CI job 不要与之冲突）。
- 不重写 Git 历史、不做 `reset`/`rebase` 清理；ISS-51 一律用 `git rm --cached`。

**决策日志**
- 2026-10-01：立项。基于 `ARCHITECTURE_AUDIT.md`（117 条原始发现 → 去重 108 项缺陷；9 条原始 P0 保留 4 条、
  降级 3 条、合并 2 对）。ISS-05 走 (a) 落地强制还是 (b) 停止宣称，待实现前决策。
