# Plan: Built-in Browser Parallel Action Isolation & Post-Execution Cleanup

> **Status**: In Progress
> **Priority**: P0
> **Created**: 2026-08-17
> **Related**: [64-browser-parallel-isolation](./64-browser-parallel-isolation.md) (extension backend), [441-browser-latency-optimizations](./441-browser-latency-optimizations.md)

---

## 问题

1. **并行 action 共享同一个页面**：`StreamingToolExecutor` 将 `browser` 分类为 READ batch（maxConcurrency 5），同一轮的多个 `search` / `navigate` 等 action 会并发执行。但 `BrowserTool` 是进程级单例，只持有一个 `this.cdp`（绑定单一 sessionId 的 `WebviewCDPClient` = 一个 webview 页面）。并发的导航/求值在同一个页面上交错：最后一次 navigate 生效，所有 snapshot/evaluate 读到的都是同一个页面 → 不同查询返回完全相同的结果。
   - `BrowserPool`（每任务独立客户端）只接入了 `parallel_fetch`，普通 action 不经过它。
2. **执行完后页面不关闭、缓存不清除**：
   - `browserTool.cleanup()` 无任何调用方（无 session 结束钩子）。
   - 全代码库没有调用 `Network.clearBrowserCache` 的路径。
   - 附带缺陷：`BrowserPool.acquireSession` 用新任务的唯一 id 去清 idle timer，但 `releaseSession` 把 timer 存在会话自己的 id 下 → 复用的会话 timer 永远不会被取消，可能在使用中被关闭。

## 方案

- **并发隔离**：`BrowserTool.execute()` 维护 in-flight 计数。当检测到已有浏览器操作在执行时（并发争用），为本次操作创建一个临时（ephemeral）客户端，sessionId 为 `${convSession}::op${n}`（webview 走 `background: true`，不抢侧栏焦点），操作完成后立即关闭该临时客户端（daemon `/webview-close` → 渲染层同步关闭面板 tab）。无争用时保持现状（串行流程继续使用用户可见的主页面）。
- **空闲自动回收**：in-flight 归零后启动 idle 定时器；到期后先通过 CDP `Network.clearBrowserCache` 清缓存，再关闭主客户端与连接池，重置连接状态。任何新操作先取消该定时器。
- **close_window 顺带清缓存**。
- **修复 BrowserPool timer keying 缺陷**。

Daemon 侧无需改动（per-sessionId webview 映射、10 页上限、background 打开均已存在，`parallel_fetch` 已验证）。

---

## Implementation Plan

### Task 1: BrowserTool — 并发隔离 + 空闲回收

- [x] Step 1: `ensureConnection` 加单飞（single-flight）promise 锁，防止并发首次连接创建两个主客户端
- [x] Step 2: 新增 `inflightOps` 计数 + 临时客户端获取/释放；execute() 在争用时走独立客户端
- [x] Step 3: in-flight 归零调度 idle close（默认 120s）；到期清缓存 + 关页面 + 重置连接
- [x] Step 4: cleanup() 同样先清缓存再关闭

### Task 2: CDPClient — 导出 clearCache 辅助

- [x] Step 1: `clearBrowserCache(client)` helper（Network.enable + Network.clearBrowserCache，失败静默——extension 协议不支持 raw CDP）

### Task 3: close_window 清缓存

- [x] Step 1: close.ts 执行 `clearBrowserCache` 后再关窗口

### Task 4: BrowserPool timer 修复

- [x] Step 1: acquireSession 复用会话时清除该会话自身的 idle timer

### Task 5: 验证

- [x] Step 1: 单测覆盖（并发隔离决策、idle close 调度、pool timer）
- [ ] Step 2: Electron 实测：同轮多个 search action 各得独立结果；执行完约 2 分钟后页面自动关闭
- [x] Step 3: `npm run typecheck:all`

## Verification Checklist

- [ ] 同一对话一轮内发两个不同 query 的 search → 两个结果互不相同、各自指向对应 SERP
- [ ] 并行操作产生的额外页面在操作结束后立即消失（侧栏 tab 同步关闭）
- [ ] 浏览器空闲 ~2 分钟后主页面自动关闭且缓存被清除
- [ ] 串行浏览流程（navigate→click→snapshot 多轮）不受影响（主页面保持打开）
