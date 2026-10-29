# TUI `fetch failed` 噪声与 write 渲染卡顿

状态：active · 负责人：codex（本会话） · 更新：2026-10-29
分支：codex/tui-fetch-failed-write-lag · worktree：`.claude/worktrees/tui-fetch-failed-write-lag` · base：ba9759899 · owner：codex（本会话）

## 目标与边界

用户报告两个 TUI 问题：

1. 轮询报 `Could not read background tasks: fetch failed` / `Could not check pending permissions: fetch failed`，含义不明。
   根因（已实验证实）：Node undici 的 `TypeError: fetch failed`，`cause` 为 `UND_ERR_SOCKET`/`ECONNRESET`——不是 5s 超时（超时报 `TimeoutError`）。TUI 两个 1s 轮询（`chat.ts` BackgroundTaskPoller 与 pollPendingPermissions）走 keep-alive 连接；Host http-server 未设 `keepAliveTimeout`（Node 默认 5s）。TUI 事件循环停顿 >5s 时空闲 socket 被 Host FIN，循环恢复后在死 socket 上派发轮询即报错。日志佐证：`~/.duya/logs/background-host.log` lease 每 ~306s connection_closed 重连。
2. write 工具落盘后 TUI 卡顿。根因（静态分析）：`TranscriptRenderer.blocks()` 每帧对**每个**可见 block 重建 cache key——`blockContent()` 拼接完整 `block.text`/`block.result` 再 FNV-1a，O(全部内容字符)/帧；一帧最多 4 次全量 pass（paint 内 heights+blocks、lines、window）。会话越长越卡。

允许修改：`packages/host/src/http-server.ts`、`packages/cli/src/chat.ts`、`packages/cli/src/tui/blocks.ts`、`packages/cli/src/tui/transcript-cache.ts`、`packages/cli/src/tui/components/transcript-pane.ts`、本计划。
不处理（只报告）：`~/.duya/logs/agent/agent-unknown.log` 401MB 无轮转、worker MCP stderr 刷屏（BlenderMCPServer 每秒重连）、长会话多日复用。

关联：上游无；README 表更新见进度。

## 验收

- `npx vitest run packages/cli/src/tui` 与基线按文件/用例/错误签名比较，无新增失败；`tui-transcript-cache.test.ts` 全绿（缓存正确性由其与 uncached 路径逐字节对比锁定）。
- `npm run typecheck:all`、`npm run architecture:check` 通过。
- 行为验收（代码级）：cache key 不再包含内容哈希（O(1) 每 block 每帧）；Host listen 设置 keepAliveTimeout > 5s；三处 printError 输出包含 `error.cause` 的 code/message。

## 进度

- [x] 定位两个问题的根因（见目标与边界）
- [x] 建 worktree + junction 依赖 + build:packages
- [x] 基线测试（见验证记录）
- [x] 修复 A：http-server keepAliveTimeout/headersTimeout
- [x] 修复 B：chat.ts 错误文本附带 cause
- [x] 修复 C2：TranscriptModel per-block revision；cache key 改 `id#revision`
- [x] 修复 C1：TranscriptPane.paint 单次 blocks() 派生 heights
- [x] 门禁 + 相关测试比较
- [ ] commit + PR + README 表

## 发现与决策

- fetch failed ≠ 5s 超时：本机 Node v24 实验证实 `AbortSignal.timeout` 报 `TimeoutError`；`fetch failed` 是 undici 在 socket 被对端关闭后的 TypeError（cause=UND_ERR_SOCKET/ECONNRESET）。来源：`packages/host/src/http-client.ts` request() 包裹所有轮询调用。
- block 突变全部集中在 `blocks.ts`（grep 证实无外部直接赋值），block id 由模块级单调 `nextId()` 生成、进程内永不重复 → per-block revision 方案安全；`clear()` 重置 revision map 无正确性风险。
- `renderer.invalidate()` 生产代码从不调用，旧方案正确性完全依赖内容哈希；新方案正确性依赖"所有突变经 TranscriptModel"这一事实，测试均经模型突变，兼容。
- C2 比 C1 更关键：卡顿主因是每帧对全部 block 内容做哈希（O(内容字符)），C1 只是消除重复 pass（4→3）。两者都做。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| ba9759899（clean） | Windows / Node v24 | `npx vitest run packages/cli/src/tui`（worktree，构建前） | 1：30 文件 `ERR_MODULE_NOT_FOUND`（@duya/ai dist 缺失，环境问题，非测试失败）；989 测试通过 | 基线被缺 dist 污染 |
| ba9759899（clean） | Windows / Node v24 | `npm run build:packages` 后复跑 `npx vitest run packages/cli/src/tui` | 0：104 文件 / 1297 测试全过 | 干净基线 |
| ba9759899 + 本任务 5 源文件 dirty | Windows / Node v24 | `npx vitest run packages/cli/src/tui` | 0：104 文件 / 1297 测试全过，与基线零差异 | 改动后 |
| 同上 | Windows / Node v24 | `npx vitest run packages/host` | 0：239 文件 / 2146 测试全过（host 无改动前基线；改动为 listen() 两行服务端配置，事后全绿） | 改动后 |
| 同上 | Windows / Node v24 | `npm run typecheck:all` | 0 | 门禁 |
| 同上 | Windows / Node v24 | `npm run architecture:check` | 0：no new boundary violations（既有 baseline） | 门禁 |
| 同上 | Windows / Node v24 | `npm run build:packages` | 0：22 包；`packages/capabilities/.../inline-content.ts` 仅 LF/CRLF 噪声，已 restore，未入提交 | 产物 |

## 接续 / 结果

已实现 + 已验证（typecheck / architecture / cli-tui 1297 + host 2146 全绿），待 PR review 与集成授权。未提交路径：无（全部已提交后此行更新为 PR 链接）。
附带发现（不在本任务处理）：`~/.duya/logs/agent/agent-unknown.log` 401MB 无轮转且命名 unknown；worker MCP stderr 每秒重连刷屏（BlenderMCPServer）；TUI 会话多日复用累积 transcript。
下一步：review/CI 通过后由用户授权集成；真机冒烟 = 长会话 write 落盘观察流畅度、闲置 >5s 后轮询不再报 fetch failed。
