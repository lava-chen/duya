# Web 浏览器端到端验收（T40b）：真 Host + 生产 worker + 受控 provider + 实际浏览器

状态：active · 负责人：mavis（会话 mvs_2387fca26eb84e6ba038bb6962b10891） · 更新：2026-10-27
分支：`codex/web-bff-esm` · worktree：`E:\Projects\duya\.claude\worktrees\web-bff-esm` · base：`a99e1444` · owner：mavis

## 目标与边界

用户可观察的变化：Web 客户端在真浏览器里能驱动一个真的 agent 回合——发送、工具流、审批、取消、
刷新重放都跑通，且每一项都由 **Host 的台账** 复核，而不是只看 DOM。

允许修改：`e2e/web/**`（新增）、`packages/ui/src/components/shared/ThreadListItem.tsx`
（新增 `data-session-id`）、`docs/exec-plans/active/**`。

本次**不**处理：Host / worker / UI 的行为改动；`packages/plugin-core` 的 `moduleResolution`；
BFF 的入口问题（已由 [web-bff-runnable-entry](2026-10-27-web-bff-runnable-entry.md) 解决，
PR #527）。

关联：610 架构系列 T40b（`docs/exec-plans/active/610-architecture-series/23-wave3-product-dispatch.md`）。

## 验收构成

| 件 | 是什么 | 不是什么 |
| --- | --- | --- |
| `apps/web/tests/fixtures/web-acceptance-env.mjs` | 回环 Anthropic provider（脚本化模型）+ 真 standalone Host（生产 worker bundle）+ **按产品方式启动的 BFF** | 不是 mock executor：provider 只决定一次 HTTP 请求的字节 |
| `e2e/web/run-web-acceptance.mjs` | 起环境 → 读 data root → 跑 Playwright → 收尾 | 不是 `webServer`：环境必须随运行而死，且要把它选的端口传给 spec |
| `e2e/web/web-playwright.config.ts` | 纯浏览器 Chromium 项目（与 Electron 轨道分离） | 不是 `_electron` |
| `e2e/web/web-turn.spec.ts` | 6 个场景 | 不直接调 `/api/runs/start`——那样只证明传输层 |

**环境夹具为什么在 `apps/web/tests/fixtures/` 而不在 `e2e/`**：它要 compose Host，
所以 import `@duya/host`。`architecture-policy.yaml` 把 `apps/web/tests/fixtures`
声明为 `web-server` 模块的 root，该模块 `requires` 含 `duya-host`——这是"Node 侧
web 夹具可以摸 Host"的**声明位置**（旁边的 `browser-host.mjs` 同形）。`e2e/` 不在任何
声明模块内，在那里 import Host 是边界违规而不是测试。

BFF 以 `node apps/web/dist/server/main.js` 启动，**不带 resolver shim、不带 `--import`**：
验收的就是文档里那条命令。

## 三条实测出来的硬事实

这三条是本任务的主要产出，代码里读不出来：

1. **worker 每个回合发两类 provider 请求。**
   回合请求广告 21 个工具，用户请求是**最后一个 user 消息的最后一个 text part**——
   前面挂着 4 个 `<system-reminder>` 附件（environment / skills / session guidance / vision），
   每个都长达 KB 级。旁路请求（会话标题生成器）**不广告工具**，把同一段请求包成
   `<request>…</request>`。
   → 判别"哪一次请求是回合"的依据是**有没有广告工具**，不是有没有 `<request>` 标签；
   取用户输入要看**尾部**，看头部只会读到环境。

2. **`tool_use` 的正确帧形状是 `content_block_start`（`input:{}`）+ `input_json_delta` 分片。**
   把完整 input 塞进 `content_block_start` 且不发 delta，线客户端虽然保留它（Plan 418 L1），
   但执行器**不派发工具**：回合以 `stopReason: tool_use` 结束、工具从未运行、也不会有第二轮。
   参考实现：`apps/desktop/src/main/__tests__/eval-offline-provider.ts`。

3. **权限闸在 `default` 档会放行工作区内的命令。**
   `isToolWithinWorkspace` 为真就自动 allow，所以一条干净的工作区命令在 `default` 档也**不会**
   弹审批。真正会发审批的是**触发命令安全告警**的命令（`node -e` → "Script execution via -e/-c
   flag"）。→ 工具场景用干净命令、审批场景用带告警的命令；两者跑**同一个** proof 脚本。

## 进度

- [x] 摸清 e2e 基础设施与 web UI 可交互结构
- [x] 起真 Host + 受控 provider + BFF 的验收环境
- [x] 修 worker 读错 `config.toml`（`DUYA_DATA_ROOT`）、标题随首条消息变化
- [x] 定位 provider 请求形状与 `tool_use` 帧格式（工具/审批不执行的根因）
- [x] Playwright 跑通 6 个场景
- [x] 记录验证证据
- [ ] commit + PR

## 场景与断言

| 场景 | 断言的事实 | 复核 |
| --- | --- | --- |
| 发送 | 回答出现在聊天区 | Host run 行 `status=completed` 且 `finishedAt` 非空 |
| 工具流 | 工具结果出现在聊天区 | proof 脚本写了 `executions.txt`（工具真的跑了） |
| 审批 | 审批卡出现；点"允许" | Host 审批台账有 pending → 允许后工具执行、结果回到模型 |
| 取消 | Stop 之后 run 不再 running | Host run 行终态 `failed` / `runtime_crash` |
| 刷新重放 | 刷新后 transcript 不丢 | run 行数不变（没有第二个 run） |
| 会话隔离 | 切到别的会话看不到本会话回答 | 另一个会话的 run 数为 0 |

## 发现与决策

- **worker 必须有 `DUYA_DATA_ROOT`。** 否则它读开发者自己的 `~/.duya/config.toml`，
  找不到本环境定义的 provider，每个 run 都在 self-init 阶段失败。
- **会话标题由首条消息派生**，跑一次就改名，按标题定位必失效。
  → `ThreadListItem` 加 `data-session-id`（id 不随标题变），并补了单测。
- **`getByText` 会命中侧栏里的会话标题**，隔离断言必须限定在聊天区（`.chat-main-column`）。
- **取消的终态是 `failed` / `runtime_crash`**，不是 `cancelled`：
  `"the transport hard-killed the run before the clean cancel path completed"`，
  `requestedReason: delete:host_run_cancel`。这是 Host 的真实语义，测试与文档都如实写，
  不粉饰成"优雅取消"。
- **审批按钮**：`.permission-prompt-btn-primary` 是"本会话内允许"（`allow_session`），
  "仅允许一次"是次级按钮。Web 侧 `allow_session` → BFF `always` → Host `allow_for_session`。
- **夹具进程自己挂 resolver shim、BFF 不挂**：这个不对称是有意的——夹具要 compose Host
  （走 dist 链），BFF 是产品入口，**不能**靠 shim 才跑得起来。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `66cb2919` + 本任务改动（worktree，dirty） | Windows / Node 24.16.0 | `node e2e/web/run-web-acceptance.mjs` | **6 passed（15.9s）** | 第 1 轮全绿 |
| 同上 | 同上 | 同上 | **6 passed（15.3s）** | 第 2 轮全绿，确认非偶然 |
| 同上 | 同上 | 读 `duya-core.db` 的 `runs` 行 | send/tool/approval/reload = `completed`；cancel = `failed`（`runtime_crash`）；isolation = `running`（该会话本就不发消息） | run 台账实测 |
| 同上 | 同上 | 读 `permission_requests` 表 | 审批场景产生 `pending` 请求，reason = "Complex command detected…; Script execution via -e/-c flag"，允许后清空 | 审批台账实测 |
| 同上 | 同上 | 读 `sessions` 表 | `web-tool` 的 `permission_mode = full_access`，其余 = `default` | 档案落库实测 |
| 同上 | 同上 | 读 run 的 `manifest_json` | `"permissionPolicy":{"mode":"bypassPermissions","hostSwitch":"ask"}` | Host 侧桥接实测 |
| 同上 | 同上 | `npm run typecheck:all` | 0 | 类型门禁 |
| 同上 | 同上 | `npm run architecture:check` | 0，`OK — no new boundary violations` | 架构门禁（见下"夹具为什么在 apps/web"） |
| 同上 | 同上 | `npx vitest run apps/web packages/ui/src/components/shared` | 0，14 文件 / 137 用例 | 单测 |
| 同上 | 同上 | `npm run check:test-coverage` / `test:inventory` | 均 0 | 其余门禁 |
| 同上 | 同上 | `npm run check:encoding` / `check:no-ts-suppress` / `check:manifest-keys` | 均 0 | 其余门禁 |
| 同上 | 同上 | `npm run bundle:verify` | 0，`FRESH 0/993` | worker bundle 未过期 |
| 同上 | 同上 | `node e2e/web/run-web-acceptance.mjs`（夹具搬到 `apps/web/tests/fixtures/` 之后） | **6 passed（15.4s）** | 搬移后复跑仍全绿 |

## 留明（未覆盖）

- **审批只覆盖 allow**，未覆盖 deny。
- **未做截图留证**：计划里写了"用实际浏览器做交互与截图"，本轮只做了交互断言。
- **取消的终态语义**是 Host 现状（`runtime_crash`），未追查是否为缺陷；本任务只如实记录。
- 边界路径（重连、稀疏 seq、多个 pending 审批）未覆盖。
- **测试清单（`docs/development/test-inventory.{json,md}`）未重新生成**：
  在本机重生成会带进 1.7 万行**环境相关的测量 churn**（耗时、断言计数），与本任务无关；
  且它按**已跟踪文件**扫描，新 spec 未跟踪时连条目都不会进。该文件是生成物，
  下一次在正常环境重生成时会自动收录。`npm run test:inventory` 本身退出 0。

## 接续

验收 6/6 通过（两轮）。未授权集成，不合并。
worktree：`E:\Projects\duya\.claude\worktrees\web-bff-esm`，分支 `codex/web-bff-esm`。
下一步：commit + PR；PR #527 与本 PR 合并后同步 master 并重验。
