# 旧任务逐项接管清单

> 由搬移前原文枚举。每行均保留原checkbox状态、原行号与新owner；历史checked需G0复验，unchecked以587新阶段合同执行。此清单没有独立Next action，完整多行细节见history原文。

共 256 个checkbox；63 个原checked / 193 个原unchecked。原行号指搬移前版本，便于Git追溯。

## 429-harness-gap-closure.md (29)

原文：[history](history/429-harness-gap-closure.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 50 | unchecked / inherited | E4/X | 在 `~/.duya/config.toml` 提供模板注释，例如： |
| 57 | unchecked / inherited | E4/X | 评估 `matcher` 正则与 tool 名对齐（`packages/agent/src/hooks/config-loop.ts` L134-145 的 `patternMatches`）。 |
| 60 | unchecked / inherited | E4/X | `packages/agent/src/hooks/executor.ts`：当 `type:"command"` 退出码非 0 时，将 `stderr` 前 512B 合并为诊断（近期 `executeHookCommand` L91-100 目前返回 `ok:false` → 被调用方丢弃）。 |
| 61 | unchecked / inherited | E4/X | `packages/agent/src/hooks/config-loop.ts`（L83-90）：对 `result.ok === false` 告别 `continue`+`logger.warn`，改为在 `hook.type==='command'` 且退出码非 0 时把错误诊断合入 injection，而非静默丢弃。 |
| 62 | unchecked / inherited | E4/X | 新增测试：仿真命令退出非 0，断言诊断进入下一轮注入。 |
| 65 | unchecked / inherited | E4/X | 明确文档语义：当前 PostToolUse 为 per-turn 一次性分发（`buildHookInput` 注释，config-loop.ts L99-115），匹配规则为"本轮任 Edit/Write 触发一次验证"。 |
| 66 | unchecked / inherited | E4/X | 若需"每次 edit 立即验证"，跟随建议 2 的 per-tool 分发一并解决。 |
| 69 | unchecked / inherited | E4/X | 决定是否引入独立配置节（如 `[project.verifier]`）抑或直接复用 `[hooks]`。默认方向：复用 `[hooks]`，仅当需要"默认对全部项目开启"时才下沉为内建（可泛化为 plan 413 的 mode modifier）。 |
| 79 | unchecked / inherited | M5/E4 | 在 `packages/agent/src/hooks/loop.ts` 的 `LoopHookEffect` 上扩展一个阻断效应：`{ type: 'block_tool', toolName, reason }`（对应 `types.ts` 的 `deny` branch）。 |
| 80 | unchecked / inherited | M5/E4 | 在 `DuyaAgent` 工具执行前（现 `gateWriteTool` 等 per-tool 检查点所在印制点）增加一个 dispatch 点，与现有校验井水不犯河水。 |
| 81 | unchecked / inherited | M5/E4 | PreToolUse per-tool 分发顺带解决建议 1.3 的粒度。 |
| 82 | unchecked / inherited | M5/E4 | 本项为 plan 87 的运行时部分正式归属；落地后视作 plan 87 运行时完成。 |
| 107 | checked / revalidate | E4/D7 | **快照库**：`FileSnapshotStore`（内容寻址，`~/.duya/snapshots/<sha256>.blob`）。 |
| 108 | checked / revalidate | E4/D7 | **pre-image 引用**：Edit/Write → `metadata.preImageSha`；ApplyPatch → `metadata.fileSnapshots[]`。 |
| 109 | checked / revalidate | E4/D7 | **rewind 联动**：`rewriteSession` 回退某 turn 时，将该 turn 之后被改文件的 `preImageSha` 逐个写回磁盘，并在 UI 明示"已恢复 N 个文件"。端点规划：主进程新增 `files:restore` IPC（输入 `{sessionId, cutMessageId}`），读被截断 tool_call 的 `metadata.preImageSha`/`fileSnapshots`，经 `FileSnapshotStore.get()` 取回原样写盘（cwd 由 `sessions.working_directory` 解析）。（2026-08-24：truncate* 处理器内联恢复 + 独立 `db:files:restore`；工具记录的是绝对路径，无需 cwd 解析） |
| 110 | checked / revalidate | E4/D7 | **清理策略**：快照随其所属 turn 一起保留/压缩，与已有 rollout 压缩 checkpoint 生命周期一致。（2026-08-24：`snapshot-gc.ts` 启动延迟扫描 —— rollout 无引用且超 24h 宽限期的 blob 删除） |
| 111 | checked / revalidate | E4/D7 | 测试：写文件 → 回退 → 断言磁盘文件恢复到 pre-image。（`file-snapshot-restore.test.ts` 覆盖含重复编辑同路径时最旧 pre-image 胜出） |
| 119 | unchecked / inherited | C6/X3 | **L1 软隔离（低成本，立即）**：把 `BashClassifier` 从 stub 做成真实规则分类器 + 路径写约束，与 plan 97 path-permission-refactor 合流；不引入新进程模型。 |
| 120 | unchecked / inherited | C6/X3 | **L2 硬隔离（中成本，决定 bypass 可信度）**：Windows restricted-token / Job Object（限制文件系统 + 网络 ACL）+ BashWorker 默认禁网、按需放行。 |
| 121 | unchecked / inherited | C6/X3 | 作为 Gateway / 无人值守场景的安全前提。 |
| 127 | unchecked / inherited | X2 | **provider fallback chain**：`packages/ai/src/runtime-adapter.ts` 的 stream 入口包一层 —— overload/5xx/网络错误抛 `RetryableError`，向配置的下一个 `(provider, model)` 重试 + 用户通知；不碰主干控制器。 |
| 128 | unchecked / inherited | X2 | **per-role model 配置**：在现有 model 配置旁加 `fanout_model` / `skeptic_model`（422 已有 `compact_model`，天然延伸），先在 Research/Goal 落点，不必等 plan 310。 |
| 134 | unchecked / inherited | X4 | 复用 plan 37 现有规划输出 agent tree；前端补充嵌套会话树。 |
| 135 | unchecked / inherited | X4 | 配合 Conductor 画布场景：子树可直接成为画布节点。 |
| 158 | unchecked / inherited | E4/X | 建议 1：`packages/agent/src/hooks/__tests__/executor.test.ts` 增补非 0 退出诊断用例；`config-loop` 增补失败不吞用例。 |
| 159 | checked / revalidate | E4/X | 建议 3：`FileSnapshotStore` + rewind 联动单测。 |
| 160 | unchecked / inherited | E4/X | 建议 2/4：PreToolUse 阻断单测 + BashClassifier 规则单测。 |
| 161 | unchecked / inherited | E4/X | 全量：`npm run typecheck:all`（esbuild 不做类型检查，提交前必须跑）+ 相关 `vitest run`。 |
| 162 | unchecked / inherited | E4/X | DB 相关测试需先 `npm run rebuild:node`（参见 AGENTS.md footgun：`npm install` 后 Electron ABI 与 Node ABI 不匹配）。 |

## 550-prompt-hbs-and-agent-decomposition.md (7)

原文：[history](history/550-prompt-hbs-and-agent-decomposition.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 496 | unchecked / inherited | E4/M5 | `npm run typecheck:all` 全绿 |
| 497 | unchecked / inherited | E4/M5 | `npm run test --workspaces -- --run` 单测全绿 |
| 498 | unchecked / inherited | E4/M5 | 触及 prompt 系统时,跑 `prompts/__tests__/prompt-system.test.ts` 确认输出字节级一致 |
| 499 | unchecked / inherited | E4/M5 | 触及 agent 循环时,跑 `agent/__tests__/duya-agent.test.ts` + 集成 smoke |
| 502 | unchecked / inherited | E4/M5 | 三遍整体检查: |
| 506 | unchecked / inherited | E4/M5 | `git diff --stat` 评估改动体量符合预期 |
| 507 | unchecked / inherited | E4/M5 | CHANGELOG / ARCHITECTURE.md 同步更新 |

## 583-architecture-audit-remediation.md (122)

原文：[history](history/583-architecture-audit-remediation.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 206 | unchecked / inherited | M5/X | 新增 CI job，在 `npm run electron:build` 之前跑 `npm run typecheck:all`（覆盖 `src/` + `packages/agent` |
| 208 | unchecked / inherited | M5/X | 同一 job 跑 `npm run test`（Vitest），确保门禁不是唯一新增耗时 |
| 209 | unchecked / inherited | M5/X | 在 `package.json` 加 `pretest:typecheck` 之类的组合脚本，让 `typecheck:all` 无法被单独跳过 |
| 210 | unchecked / inherited | M5/X | 在 `AGENTS.md`「Gates」小节把「Pre-commit 必过」改成「CI 必过，本地为可选加速」 |
| 211 | unchecked / inherited | M5/X | 门禁上线当天记录基线错误数：若非零，先开一个「清理既有类型错误」PR，不要让门禁第一天就红 |
| 222 | unchecked / inherited | M5/X | `electron/main.ts:810` 之后、`readFile` 之前插入 `path.resolve` + 根白名单前缀比较；不在 |
| 225 | unchecked / inherited | M5/X | 归一化后显式拒绝 `..` 段（`electron/main.ts:797-809` 已有驱动符归一化，就地加，不要另起一段） |
| 226 | unchecked / inherited | M5/X | `electron/main.ts:139-142` 移除 `supportFetchAPI: true` |
| 227 | unchecked / inherited | M5/X | 给主窗口加 CSP（`index.html` 或 `session.defaultSession.webRequest.onHeadersReceived`），`img-src` / |
| 229 | unchecked / inherited | M5/X | 渲染侧收口：`src/components/chat/MarkdownRenderer.tsx:236` 的 `PRESERVED_URL_RE` 去掉 `duya-file:`， |
| 231 | unchecked / inherited | M5/X | 收口后确认 `src/components/chat/markdownComponents.tsx:115` 仍只在 main 提供的路径上生效 |
| 232 | unchecked / inherited | M5/X | 补一条 main 侧单测：白名单外的绝对路径必须 403（可仿 `electron/ipc/__tests__/url-safety.test.ts` 的形状） |
| 233 | unchecked / inherited | M5/X | 顺带清 `electron/main.ts:831` 的 `Cache-Control: public, max-age=3600`（泄露字节会留在 HTTP 缓存里） |
| 240 | unchecked / inherited | M5/X | `electron/services/app-connections/connectors/remote-mcp.ts:65-82` 的 `RemoteSession` 接口补 |
| 242 | unchecked / inherited | M5/X | 同文件 `:369-381` 的对象字面量补 `ledger: new InventoryLedger()`（对照正确实现 |
| 244 | unchecked / inherited | M5/X | `discoverNow` 开头调 `beginDiscovery()`，失败路径调 `failDiscovery()` |
| 247 | unchecked / inherited | M5/X | `remote-mcp.ts:350` 提升为公开 API `ensureSessionForConnection(connectionId, provider)`，内部自己 |
| 250 | unchecked / inherited | M5/X | 改 `electron/services/app-connections/app-connection-service.ts:476` 与 `:561` 两处调用点 |
| 251 | unchecked / inherited | M5/X | 把 `electron/services/app-connections/__tests__/app-connection-service.test.ts:92` 的 double 改成对真实类 |
| 253 | unchecked / inherited | M5/X | 顺手把 ISS-21 的 in-flight promise 缓存一起做（同方法） |
| 254 | unchecked / inherited | M5/X | **跑 exec-plan 580 的 Phase 0 真机基线重跑**，确认 `pages/total` 是否恢复一致（见 §7 的争议处理） |
| 262 | unchecked / inherited | M5/X | `DuyaAgent.ts:1361` 的 `checkPermission` 改为适配已有的 `guardedCanUseTool`（或 `buildPermissions` 里 |
| 264 | unchecked / inherited | R2/M5 | 与 ISS-11 同一个 commit 落地：同一个回调就是第三条派发路径 |
| 265 | unchecked / inherited | M5/X | 补一条测试：plan 模式 tracker 激活时，经 `tool_invoke` 调 `module` 必须是 deny |
| 266 | unchecked / inherited | M5/X | 修掉或删掉 `DuyaAgent.ts:1339-1343` 那句现在为假的注释（留着比没有更危险） |
| 273 | unchecked / inherited | M5/X | 决策并记录（写进本 plan 决策日志）：走 (a) 落地强制，还是 (b) 停止宣称 |
| 274 | unchecked / inherited | M5/X | 走 (a)：在 `electron/plugins/PluginManager.ts` 的安装路径与 MCP 候选收集路径调用 |
| 277 | unchecked / inherited | M5/X | 走 (a)：`PluginManager.ts:476-483` 把 manifest 声明的权限记为 *requested*，*granted* 只由显式用户决策填充 |
| 278 | unchecked / inherited | M5/X | 走 (b)：`electron/ipc/plugin-handlers.ts:630` 不再返回 `capabilities`，manifest schema 标注为 advisory |
| 279 | unchecked / inherited | M5/X | 补一条测试断言 marketplace 源在无签名时拿不到 `Verified` |
| 289 | unchecked / inherited | M5/X | **ISS-06** `electron/ipc/db-handlers.ts:478,605,447,434` 四处注册改名为带 `db:` 前缀的 |
| 291 | unchecked / inherited | M5/X | **ISS-06** 确认 `src/components/layout/panels/ThreadListItem.test.tsx:267` 的 unarchive 用例走真实 channel 名 |
| 292 | unchecked / inherited | M5/X | **ISS-06** 顺带修 `src/stores/conversation-store.ts:802-809`：先乐观移除再吞掉 rejection，导致行消失不回来。 |
| 294 | unchecked / inherited | M5/X | **ISS-07** 从 `packages/agent/src/permissions/policy.ts:477` 导出 `normalizeCommandForDetection`，在 |
| 296 | unchecked / inherited | M5/X | **ISS-07** 补一条测试：含 CSI/OSC 转义的命令在策略层与 PowerShell 门上的判定结果一致 |
| 297 | checked / revalidate | M5/X | **ISS-08** `packages/agent/src/ipc/db-client.ts:72-78` 捕获定时器句柄，在 `handleDbResponse` 的 resolve 与 |
| 299 | checked / revalidate | R2/M5 | **ISS-09** 从 `worker-protocol.ts:47` 与 `agent-process-entry.ts:194` 删除 `permissionMode`；若需兼容窗口， |
| 303 | checked / revalidate | R2/M5 | **ISS-09** 确认 `process/permission-profile-bridge.ts:48-60` 不再需要「读来只打日志」的那段 — 一并删除 |
| 305 | checked / revalidate | T3 | **ISS-10** `process/worker-protocol.ts:800-836` 给 `writeQueue` 加真实上限（N 之后丢弃或合并最旧的 `text` |
| 309 | checked / revalidate | T3 | **ISS-10** `:811-814` 静默丢帧处补一条 DEBUG 级日志 — 改为丢帧时一条 `logger.warn`（含 dropped 计数） |
| 310 | checked / revalidate | R2/M5 | **ISS-11** `tool/ToolInvokeTool/dispatcherFromRegistry.ts:170-175` 改为 fail-closed，返回 |
| 312 | checked / revalidate | R2/M5 | **ISS-11** 在 `permissions/` 抽一个 `resolveAsk(behavior, context, meta): 'allow'\|'deny'\|'pause'`，由 |
| 319 | checked / revalidate | R2/M5 | **ISS-12** 删除 `electron/agents/agent-communicator.ts:143` 的 `agent:getProviderConfig` 整个 handler |
| 324 | unchecked / inherited | R2/M5 | **ISS-12b（新发现，严重度高于 ISS-12 原条目，建议升 P0 复核）** **渲染层确实持有活的 API key。** |
| 335 | unchecked / inherited | C6/M5 | **ISS-13** `electron/ipc/system-handlers.ts:354` 之后加 |
| 337 | unchecked / inherited | C6/M5 | **ISS-14** `system-handlers.ts:151` 与 `:169` 之前加根白名单（session 工作目录 / `~/.duya` / |
| 339 | checked / revalidate | C6/M5 | **ISS-15** `electron/core/window-manager.ts:149` 保留 `webviewTag` 但注册 `will-attach-webview`，强制 |
| 357 | unchecked / inherited | R2/M5 | **ISS-16** `src/lib/stream-session-manager.ts:192` 换成字段投影（`{ provider, model, hasApiKey: Boolean(...) }`）， |
| 359 | unchecked / inherited | M5/X | **ISS-18** `electron/services/browser/daemon.ts:135-138` 预置生产扩展 id 固定清单（开发 id 走 debug flag） |
| 362 | checked / revalidate | M5/X | **ISS-18** `daemon.ts:509` 的条件反转为 `requiresApproval = !allowedExtensionIds.includes(id)`（空清单 = 全部拒绝）， |
| 368 | unchecked / inherited | M5/X | **ISS-18** `daemon.ts:436` 的 `verifyClient` 在有固定清单时要求 `chrome-extension://` origin（当前 `!origin` |
| 371 | checked / revalidate | C6/M5 | **ISS-19** `app-connections/connector-service.ts` 的 `invoke`（`:353-520`）在 `getStatus` 之后补 |
| 373 | checked / revalidate | C6/M5 | **ISS-19** 决定 `policy-gate.ts:63,71` 的两个死函数是暴露（`appConnection:setProviderEnabled` + 设置项开关） |
| 377 | checked / revalidate | X1 | **ISS-20** `electron/channels/connector-secret-store.ts:28-41` 对 `platform` 施加与 |
| 385 | checked / revalidate | X1 | **ISS-20** 先确认 `secret:store` 未在 `electron/preload.ts` 暴露这一事实仍然成立；若已被暴露，立即升为 P0 |
| 393 | checked / revalidate | X1 | **ISS-17** `packages/gateway/src/adapters/feishu/webhook-server.ts:110-117` 改成强制头校验 |
| 398 | checked / revalidate | X1 | **ISS-17** 实现 `encryptKey` 签名校验（HMAC over `timestamp + "\n" + nonce + "\n" + body`）+ 时间戳新鲜度窗口 |
| 406 | checked / revalidate | M5/X | **ISS-21** `remote-mcp.ts:350-423` 增加第二个 `Map<string, Promise<RemoteSession>>` 缓存 in-flight |
| 408 | checked / revalidate | M5/X | **ISS-22** `app-connections/catalog-cache.ts:27-45` 的 `CachedSnapshot` 增加已解析的 `remoteMcpUrl`（或其哈希）， |
| 412 | checked / revalidate | X1 | **ISS-23** `electron/channels/telegram-connector.ts:114` 的 `offset` 改持久化到既有 `channel_offsets` 表 |
| 427 | unchecked / inherited | M5/X | **ISS-24** 对 `preload.ts:2033,2034`（`agent:stream`/`agent:interrupt`）、`:2295,2298`（ISS-06 已修）、 |
| 431 | unchecked / inherited | M5/X | **ISS-25** 删掉 `src/lib/git-ipc.ts:109,113,156` 三个包装函数及只描述它们的类型；同时在 |
| 433 | unchecked / inherited | E4/X4 | **ISS-26** `src/components/chat/WidgetRenderer.tsx:291-295` 复用 `src/hooks/useLinkOpener.ts:11` 的 |
| 436 | checked / revalidate | E4/X4 | **ISS-27** `src/components/layout/panels/CodeReviewPanel.tsx:395-460` 的 `refresh()` 加同文件 `:465,475` |
| 439 | unchecked / inherited | E4/X4 | **ISS-28** `src/components/chat/ChatView.tsx:926-932` 改成两阶段：先快照被截断区间，发送成功才丢弃； |
| 446 | unchecked / inherited | E4/X4 | **ISS-28** `src/stores/conversation-store.ts:1112-1122` 的 `deleteMessageAndAfter` 在后续失败时具备回填能力 |
| 448 | unchecked / inherited | M5/X | **ISS-29** 对审计列出的 28 个 channel 逐个决定「删注册」或「补消费者」；`update:install` 与 |
| 450 | unchecked / inherited | M5/X | **ISS-29** 清理完成后加契约测试：从 `preload.ts` 推导 channel 名集合，断言每个出站名都有 handler、 |
| 460 | unchecked / inherited | M5/X | **ISS-30** 在 `electron/main.ts` 的注册 helper 里包一层 `assertTrustedSender(event)`（主窗口 + 主 frame |
| 470 | unchecked / inherited | M5/X | **ISS-30** 清点全部辅助窗口（`services/computer-use-overlay.ts:138`、`services/recorder/badge.ts:183`、 |
| 474 | checked / revalidate | M5/X | **ISS-31** 建 `electron/ipc/contracts.ts`，按 channel family 定义 zod schema，在 handler 边界 parse； |
| 478 | checked / revalidate | M5/X | **ISS-31** schema 化高危 payload 优先：`db:agentProfile:update` / `create`（`db-handlers.ts`）、 |
| 484 | unchecked / inherited | M5/X | **ISS-31**（旁证，需产品/架构决策）`ApiProvider['providerType']` 声明为 9 值联合，但实际取值更宽 |
| 488 | unchecked / inherited | M5/X | **ISS-31**（新发现，同源于 ISS-48）**zod 解析按 schema 声明顺序归一化对象键**，而 `prompt_profile` |
| 491 | checked / revalidate | M5/X | **ISS-32** `electron/memory/rag_search.ts:233-234` 把 embedding 拆到独立 `document_vectors` 表（`BLOB`）， |
| 495 | checked / revalidate | M5/X | **ISS-33** `rag_search.ts:148-160` 的 2 字 CJK 分支加 `LIMIT` + `ORDER BY`，并新建 2-gram FTS 表替代 |
| 500 | checked / revalidate | M5/X | **ISS-48（局部，顺带）** `scripts/memory-rag-lib.mjs` 带着 `#!/usr/bin/env node` shebang，但它是纯库、 |
| 506 | checked / revalidate | M5/X | **ISS-34** `electron/memory-state/tierIndex.ts:248-254` 的 `listTierEntries` 三个分支都加 `limit`， |
| 510 | checked / revalidate | C6/M5 | **ISS-35** 保留 `packages/agent/src/tool/allowedRoots.ts:37` 为唯一逃逸检查器；把 |
| 516 | unchecked / inherited | M5/X | **ISS-36** 把 `DuyaAgent.ts` 里 `streamChat` 的工具装配前奏（`:1270-1400`）抽成 |
| 519 | unchecked / inherited | M5/X | **ISS-36** 删掉 `DuyaAgent.ts:1286-1290` 的两行 `console.error` 热路径诊断（每次 `streamChat` 都写 stderr） |
| 520 | unchecked / inherited | M5/X | **ISS-36** 与 ISS-48 合并做：`DuyaAgent.ts` 反正要重写，顺手修 86 处 mojibake |
| 526 | unchecked / inherited | X6 | **ISS-37** `next.config.ts` 加 `async headers()`：CSP（`default-src 'self'` + 显式放行 |
| 530 | checked / revalidate | X6 | **ISS-37** 站点 `next.config.ts` 加 `async headers()` |
| 540 | checked / revalidate | X6 | **ISS-38** `vercel.json` 的 17 条目标补真实章节号（`lib/docs.ts:41` 要求 |
| 550 | checked / revalidate | X6 | **ISS-39** 删掉 Clerk 依赖 / `middleware.ts` / `@clerk/nextjs` |
| 560 | checked / revalidate | M5/X | **ISS-40** 删 `packages/agent/src/tool/ReadTool/ReadTool.ts:801` `createReadTool`（并从 `builtin.ts:13,336`、 |
| 563 | unchecked / inherited | M5/X | **ISS-40** 删 `packages/agent/src/utils/bash/commands.ts:79` `splitCommand_DEPRECATED` 与 |
| 567 | checked / revalidate | M5/X | **ISS-40** 删 `packages/agent/src/tool/BrowserTool/CDPClient.ts:1515` `createCDPClient` 与 `:1521` 的 |
| 570 | checked / revalidate | M5/X | **ISS-40** 处置 `electron/services/overlay/sanitize.ts:23`（38 行模块 + 100 行测试，声称校验一个哪都没实现的 |
| 577 | checked / revalidate | M5/X | **ISS-40** 删 `src/components/chat/cards/bot-direct/`（4 个组件 + barrel + 100 行测试，源码自述 |
| 581 | checked / revalidate | M5/X | **ISS-40** ~~删 `packages/plugin-core/src/mcp` 全链路上的 `useShell`（7 处：`loader.ts:76`、 |
| 586 | checked / revalidate | M5/X | **ISS-41** 把两套 `InventoryLedger` 收敛到 `packages/plugin-core/src/mcp/core/ledger.ts` |
| 602 | checked / revalidate | M5/X | **ISS-41** 从 `RemoteSession` 删掉与 ledger 重复的 4 个并行字段 |
| 609 | checked / revalidate | M5/X | **ISS-41** 删除 `src/lib/git-ipc.ts:9-97` 手抄的接口，改为 |
| 624 | unchecked / inherited | M5/X | **ISS-41** 合并两个 Git 轮询 hook（`src/hooks/useGitRepo.ts:54-121` 与 `src/hooks/useGitStatus.ts`）：抽一个 |
| 626 | unchecked / inherited | M5/X | **ISS-41** 删 `src/components/chat/WidgetRenderer.tsx:40-57` 的私有 `useTheme`，改用 `@/hooks/useTheme`； |
| 628 | unchecked / inherited | M5/X | **ISS-41** 站点侧：提交 `components/ui/theme-provider.tsx` 与 `components/ui/ThemeSwitch.tsx` 的待删状态 |
| 630 | unchecked / inherited | M5/X | **ISS-42** 拆 `electron/gateway/message-bus.ts`（1408 行）成 `gateway-sessions.ts` / |
| 632 | unchecked / inherited | M5/X | **ISS-42** 拆 `src/components/layout/panels/CodeReviewPanel.tsx`（1067 行、27 个 `useState`）出 |
| 635 | unchecked / inherited | M5/X | **ISS-42** 按域拆 `electron/ipc/db-handlers.ts`（session / task / goal / conductor）； |
| 637 | unchecked / inherited | M5/X | **ISS-43** 把 `src/lib/providers/` 及其它被 `electron/` 反向 import 的契约模块搬进 workspace 包 |
| 639 | unchecked / inherited | M5/X | **ISS-43** 核实 `provider-store.ts:66-71` 之外的全部跨 import 目标当前确实无 DOM 引用 |
| 641 | unchecked / inherited | C6/X5 | **ISS-44** 给 `documents` 表与 `memory_tier_index` 加按体积/年龄的裁剪，挂到既有 5 分钟 sweep |
| 643 | checked / revalidate | E4/X4 | **ISS-45** `src/components/layout/panels/CodeReviewPanel.tsx:95-96` 的 `#b68cff` / `#f39a49` 换成新增的 |
| 652 | unchecked / inherited | E4/X4 | **ISS-45** `src/components/chat/CodeBlock.tsx:33-44` 去掉 JS 里的 `isDark` 分叉，改 `var(--code-bg)` 等 |
| 656 | unchecked / inherited | E4/X4 | **ISS-45** 把 `connector-icons.tsx`(21 处)、`DuyaMascot.tsx`(17 处) 这类厂商品牌色在 `AGENTS.md` 里写成 |
| 658 | unchecked / inherited | M5/X | **ISS-46** 二选一并同步改文档：给 `packages/agent/package.json` 补齐真实子路径，或把 |
| 661 | checked / revalidate | M5/X | **ISS-47** `console.*` 全量替换为 `getLogger()` + `LogComponent`：起点 |
| 682 | unchecked / inherited | M5/X | **ISS-47** `src/` 的 37 处 `console.*` 需要一个渲染进程自己的结构化日志方案（或在 `AGENTS.md` 写明渲染进程的显式豁免） |
| 684 | checked / revalidate | M5/X | **ISS-48** 加 `.editorconfig` / `.gitattributes` 钉死 UTF-8 |
| 700 | unchecked / inherited | M5/X | **ISS-48** 修 `packages/agent/src/agent/DuyaAgent.ts` 的 86 处 mojibake（`:327,366,372,374,477,821` 等）与 |
| 702 | unchecked / inherited | G0/X | **ISS-49** 站点加 `test` 脚本（`package.json:5-13` 现在完全没有），最少三条：`lib/docs.ts` slug 解析单测、 |
| 705 | checked / revalidate | G0/X | **ISS-49**（新增子项）门禁「存在于 git 但没被任何 `test.include` glob 收集的测试文件」 |
| 729 | checked / revalidate | G0/X | **ISS-49** 摘掉四个 `@ts-nocheck`（`packages/gateway/src/adapters/feishu/{comment-handler,comment-rules,dedup-persistence,qr-registration}.ts:1`） |
| 740 | unchecked / inherited | G0/X | **ISS-49** `src/` 25 处 `react-hooks/exhaustive-deps` 抑制 —— **计划的前提不成立，不执行** |
| 751 | unchecked / inherited | R1/C6/X | **ISS-50** `electron/ipc/` 统一失败约定：返回 `{ ok: false, code, message }` 判别联合，throw 只留给 |
| 753 | unchecked / inherited | R1/C6/X | **ISS-50** `packages/gateway/src/adapters/feishu/webhook-server.ts:119-128` 把 `onEvent` 派发拆出独立 |
| 755 | unchecked / inherited | R1/C6/X | **ISS-50** `electron/services/app-connections/token-vault.ts:75-87`：文件存在但不可解密时**不要**把 |
| 757 | unchecked / inherited | R1/C6/X | **ISS-50** 站点：`app/download/page.tsx:63-65` 去掉浏览器端未认证的 GitHub 拉取，直接渲染构建期值； |
| 760 | checked / revalidate | G0/X | **ISS-51** `git rm --cached` 摘掉 `tsconfig.tsbuildinfo`、`.playwright-mcp/**`（`.gitignore:23` 已列但未 untrack， |
| 768 | unchecked / inherited | G0/X | **ISS-51** `.od-skills/` 与 `.duya/MEMORY.md` 移出仓库或 ignore；`.duya/MEMORY.md:1` 描述的内容契约 |

## 584-agent-protocol-implementation.md (54)

原文：[history](history/584-agent-protocol-implementation.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 145 | checked / revalidate | G0 | 0.1 `architecture-policy.yaml`：迁移前版本——**全部模块 `managed: false`**， |
| 147 | checked / revalidate | G0 | 0.2 `scripts/architecture/architecture-check.mjs` + |
| 150 | checked / revalidate | G0 | 0.3 `--self-test`：断言能数出全部已知违规 |
| 152 | checked / revalidate | G0 | 0.4 `.architecture-baseline.json`（指纹式，**941** 条，含全部现有违规） |
| 153 | unchecked / inherited | G0 | 0.5 接入 CI（阻塞式 required check）+ `AGENTS.md` 补 Gates 章节 |
| 157 | checked / revalidate | G0 | `npm run architecture:self-test` 的违规计数与 `audit-imports.mjs` **完全一致** |
| 158 | checked / revalidate | G0 | 故意新增一条违规 → 检查失败（植入跨 3 条边界的探针，报出正好 4 条、exit=1；移除后恢复绿） |
| 159 | checked / revalidate | G0 | 现有代码**零改动**（只动 `scripts/`、policy、baseline、`AGENTS.md`、根 `package.json`） |
| 204 | checked / revalidate | G0 | 1.1 workspace member：ESM、`"type": "module"`、`composite: true`、 |
| 206 | checked / revalidate | G0 | 1.2 `src/` 骨架：`index.ts`（唯一公开入口，05:86）、`version.ts`、`primitives.ts`、 |
| 209 | checked / revalidate | G0 | 1.3 **排在最前面先构建** —— **偏离原写法，见下** |
| 210 | checked / revalidate | G0 | 1.4 加入 `typecheck:all`（`typecheck:protocol` 排在**第一位**） |
| 211 | checked / revalidate | G0 | 1.5 落 drift test **1, 2, 3, 4, 5, 6, 10, 12** —— 全绿，另加 09 与 hash 两个 |
| 212 | checked / revalidate | G0 | 1.6 `schema/` —— **刻意不建**，见下 |
| 379 | unchecked / inherited | T3 | 2.0 搬入清单（全部去 Promise、去 `Map`/`Set`、去回调）： |
| 383 | unchecked / inherited | T3 | 2.1 新增 `RunEvent`（由注册表派生） |
| 384 | unchecked / inherited | T3 | 2.2 `SSEEvent` 移入 `legacy/sse-event.ts`，暴露为 `@duya/agent-protocol/legacy`， |
| 386 | unchecked / inherited | T3 | 2.3 `packages/agent/src/types.ts` 退化为 re-export shim |
| 388 | unchecked / inherited | T3 | 2.4 drift test 1, 3, 4, 9 |
| 404 | unchecked / inherited | T3 | 3.0 **先补完枚举**：`normalizeWorkerEvent`（`router.ts:450-569`）在 `:569` 之后 |
| 407 | unchecked / inherited | T3 | 3.1 `legacy/sse-event.ts` 持有 `SSE_EVENT_TO_PROTOCOL: Record<SSEEvent['type'], EventType>` |
| 408 | unchecked / inherited | T3 | 3.2 删 `normalizeWorkerEvent`，换成注册表驱动的 `codecs.toEnvelope(workerFrame)`。 |
| 410 | unchecked / inherited | T3 | 3.3 **`seq` 铸造从 router 移到 runtime**。今天的 `seqNum` 是每连接计数器， |
| 414 | unchecked / inherited | T3 | 3.4 删 `multiLineBuffer` 的 JSON 累加 hack（`router.ts:1334-1386`，100 KB 上限）。 |
| 416 | unchecked / inherited | T3 | 3.5 router 停止维护自己的 event ring（`:2411`），退化为纯字节泵； |
| 418 | unchecked / inherited | T3 | 3.6 drift test 8, 9 |
| 429 | unchecked / inherited | R2/T3 | 4.1 `manifest.ts`：`RunManifest`（全字段 `readonly`）+ `manifestFingerprint()` |
| 430 | unchecked / inherited | R2/T3 | 4.2 `run.ts` / `resume.ts` / `capabilities.ts` / `transport.ts` 的接口定义 |
| 431 | unchecked / inherited | R2/T3 | 4.3 `assertSatisfies()` 落地 |
| 432 | unchecked / inherited | R2/T3 | 4.4 probe 落地：`POST /sessions` 响应与 `GET /sessions/{id}/status` |
| 434 | unchecked / inherited | R2/T3 | 4.5 drift test 11, 14 |
| 461 | unchecked / inherited | R2/T3 | 5.1 单一 `PERMISSION_ACTIONS = ['allow','allow_always','deny','defer']` |
| 462 | unchecked / inherited | R2/T3 | 5.2 **唯一权威时钟**：`expiresAt = startedAt + manifest.permissionPolicy.defaultTimeoutMs` |
| 465 | unchecked / inherited | R2/T3 | 5.3 legacy 映射（07 §7.3）：`allow_once → allow`； |
| 468 | unchecked / inherited | R2/T3 | 5.4 drift test **7**（扫描那三个文件里任何竞争性的字符串字面量 union） |
| 487 | unchecked / inherited | R2/C6 | 6.1 `InitCommand`（`worker-protocol.ts:3-35`）+ `ChatStartCommand`（`:37-138`） |
| 489 | unchecked / inherited | R2/C6 | 6.2 `agent-process-entry.ts` 保留**一个 release 的翻译 shim** |
| 490 | unchecked / inherited | R2/C6 | 6.3 **密钥离开 wire**——需要 Control Plane 的 secret resolver（见 §6 D1） |
| 491 | unchecked / inherited | R2/C6 | 6.4 drift test 12（构造 manifest 遍历查找 |
| 503 | unchecked / inherited | R2/D7 | 7.1 `interruptWorker`（`worker-manager.ts:304`）变成带 `reason` + `graceMs` |
| 505 | unchecked / inherited | R2/D7 | 7.2 终态 CAS 语义（07 §8）：`pending → running → completing → terminal`， |
| 515 | unchecked / inherited | R2/D7 | 7.3 drift test 8 |
| 564 | unchecked / inherited | T3/M5 | 11.1 改写 17 个文件 / 18 个 specifier |
| 565 | unchecked / inherited | T3/M5 | 11.2 修 2 处**相对路径穿透**到 `packages/agent/src/message/message-source`： |
| 567 | unchecked / inherited | T3/M5 | 11.3 drift test 1, 2 |
| 651 | unchecked / inherited | G0/T3 | 14 条 drift test 全部存在且通过（07 §15） |
| 652 | unchecked / inherited | G0/T3 | `architecture-check.mjs` 在 CI 里是 **required check**，`agent-protocol` 为 `managed: true` |
| 653 | unchecked / inherited | G0/T3 | `packages/agent` 的 SCC 数 ≤ 18 且 protocol 贡献 0 |
| 654 | unchecked / inherited | G0/T3 | 17 个 `@duya/agent/message` deep import 全部改指（protocol 或 storage），0 条残留 |
| 655 | unchecked / inherited | G0/T3 | 2 处相对路径穿透清零 |
| 656 | unchecked / inherited | G0/T3 | 三种 transport 的 `EventType` 序列与终态 `RunResult` 一致（drift test #13） |
| 657 | unchecked / inherited | G0/T3 | `SSEEvent` 只从 `@duya/agent-protocol/legacy` 导出，且**带删除期限** |
| 658 | unchecked / inherited | G0/T3 | `typecheck:all` 在 CI 绿，`electron/` 被覆盖 |
| 659 | unchecked / inherited | G0/T3 | `ARCHITECTURE.md` 已更新（AGENTS.md 要求：重大变更后更新） |

## 585-event-stream-perf-debt.md (16)

原文：[history](history/585-event-stream-perf-debt.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 80 | unchecked / inherited | T3 | 在 `electron/agents/server/` 抽出 `ephemeral-batcher.ts`，形状对齐 |
| 82 | unchecked / inherited | T3 | 合并粒度：同一 `sessionId` + 同一 `type` 的 delta 拼成一个帧； |
| 84 | unchecked / inherited | T3 | 合并只作用于 `durability === 'ephemeral'` 的事件， |
| 86 | unchecked / inherited | T3 | 合并后的帧仍占**一个** seq（天然缓解 P1，但不依赖 P1 完成） |
| 87 | unchecked / inherited | T3 | 测试：合并窗口内的 durable 事件必须**先于**被合并的 delta 写出 |
| 91 | unchecked / inherited | T3 | `sseWrite` 触发的 `child.stdout.pause()` 改为只暂停 ephemeral 产出， |
| 93 | unchecked / inherited | T3 | 若做不到按类型暂停，退而求其次：durable 事件走独立的高优先队列， |
| 95 | unchecked / inherited | T3 | 验证：慢渲染端下 `tool.call_started` 的发出延迟不随 delta 速率上升 |
| 99 | unchecked / inherited | T3 | 先定契约再动代码。三个候选： |
| 104 | unchecked / inherited | T3 | 改契约会牵动 `Last-Event-ID` 恢复路径与已有 replay 存储， |
| 106 | unchecked / inherited | T3 | 若选 (a)：`toEnvelope` 需要能铸造无 seq 的 ephemeral 信封， |
| 113 | unchecked / inherited | T3 | `npm run typecheck:all` 通过 |
| 114 | unchecked / inherited | T3 | 协议包 drift test 全绿（当前基线：20 文件 / 356 用例） |
| 115 | unchecked / inherited | T3 | 一次 10 分钟回答的 SSE 帧数下降 ≥ 90%（P2 生效的直接指标） |
| 116 | unchecked / inherited | T3 | 慢渲染端压测下 durable 事件无丢失（`tool.call_started` 计数与 |
| 118 | unchecked / inherited | T3 | `Last-Event-ID` 断线重连在 Phase 1/2 之后行为不变 |

## 586-reference-run-vertical-slice.md (0)

原文：[history](history/586-reference-run-vertical-slice.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |

## 2026-09-workspace-phase-0.md (28)

原文：[history](history/2026-09-workspace-phase-0.md)。新scope与冲突裁决见[接管表](10-legacy-crosswalk.md)。

| 原行 | 历史状态 | 新owner | 原任务首行 |
| --- | --- | --- | --- |
| 107 | unchecked / inherited | C6 | Read the current `ARCHITECTURE.md`, execution-plan README, and relevant scoped `AGENTS.md` files in the local checkout. |
| 108 | unchecked / inherited | C6 | Read active plans that affect Project DB ownership, Permission, and nested instruction loading; record their status and avoid overlapping schema changes. |
| 109 | unchecked / inherited | C6 | Inventory every `Project.paths`, `canonical_root`, path-alias, `working_directory`, and additional-directory producer / consumer. |
| 110 | unchecked / inherited | C6 | Inventory file, shell, MCP, connector, Plugin, Workflow, Research, and CLI execution entry points; mark which run in Main, Agent Worker, or child processes. |
| 111 | unchecked / inherited | C6 | Record current path-check coverage, symlink/junction behavior, and any direct filesystem access outside the built-in tools. |
| 115 | unchecked / inherited | C6 | Write the object ownership table for Project, Workspace, Root, Session, and Run. |
| 116 | unchecked / inherited | C6 | Decide the single-root Project field and identify the exact multi-path fields / APIs to deprecate or remove. |
| 117 | unchecked / inherited | C6 | Preserve Project UUID and classify plans, instructions, Memory, bots, and path-relocation metadata as Project- or Workspace-owned. |
| 118 | unchecked / inherited | C6 | Define migration behavior for existing multi-path Projects and sessions whose cwd is not the Project's primary path. |
| 122 | unchecked / inherited | C6 | Finalize the creation form fields and the required / advanced / derived / deferred split. |
| 123 | unchecked / inherited | C6 | Finalize root alias, role, access, default-root, and cwd behavior. |
| 124 | unchecked / inherited | C6 | Choose safe defaults for Trust, shell, network, MCP, and connectors; document effects in user-facing language. |
| 125 | unchecked / inherited | C6 | Define validation and error cases for paths, duplicate roots, missing folders, symlinks, and junctions. |
| 129 | unchecked / inherited | C6 | Define `WorkspaceService`, `WorkspaceRegistry`, `RootResolver`, `PolicyEngine`, `ContextResolver`, and Run manifest responsibilities. |
| 130 | unchecked / inherited | C6 | Choose whether V1 file operations are brokered by Main or are explicitly an Agent-side application policy with narrower security claims. |
| 131 | unchecked / inherited | C6 | Define how Chat, Research, Workflow, Terminal, CLI, and MCP receive or are denied Workspace context. |
| 132 | unchecked / inherited | C6 | Specify manifest identity, revision, instruction digest, path privacy, and in-flight policy-change behavior. |
| 136 | unchecked / inherited | C6 | Split follow-up work into P0 foundation, P1 local Workspace V1, and P2 sandbox / index / extension capabilities. |
| 137 | unchecked / inherited | C6 | Name the files/modules to change and the migration/compatibility steps. |
| 138 | unchecked / inherited | C6 | Define security acceptance cases for traversal, root access modes, symlink/junction escapes, stale manifests, and shell bypass disclosure. |
| 139 | unchecked / inherited | C6 | Update `ARCHITECTURE.md` proposal or link this plan from it after the Phase 0 decisions are reviewed. |
| 151 | unchecked / inherited | C6 | Every current multi-path Project consumer has a migration or removal decision. |
| 152 | unchecked / inherited | C6 | No Project ID, Memory scope, or project-private user data is silently re-keyed or discarded. |
| 153 | unchecked / inherited | C6 | Creation fields, defaults, derived state, and deferred controls are explicit. |
| 154 | unchecked / inherited | C6 | Restricted / Trusted behavior is specified for all six capability categories. |
| 155 | unchecked / inherited | C6 | The design distinguishes Agent-side permission checks from OS-enforced isolation. |
| 156 | unchecked / inherited | C6 | Chat, Research, Workflow, Terminal, CLI, and extension handling of Workspace context is defined. |
| 157 | unchecked / inherited | C6 | Phase 1 plan is implementable without unresolved ownership or compatibility questions. |

