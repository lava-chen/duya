# 441 - Browser Tool Latency Optimizations

> 内置浏览器工具提速第一批：消除盲等与冗余往返，收紧进上下文的 payload。目标是在不改协议语义的前提下降低每次工具调用的墙钟时间与后续每轮的 prefill 时间。

## 背景与根因（已核实）

一次浏览器调用的延迟构成（`packages/agent/src/tool/BrowserTool/`）：

1. **导航等待是盲轮询**：`WebviewCDPClient._waitForPageLoad` 每 200ms 经 HTTP 调
   `Runtime.evaluate('document.readyState')`，需连续两次 complete —— 即使页面秒开也有
   ≥400ms 固定开销 + 多次 HTTP 往返。
2. **首会话建立靠客户端盲重试**：daemon 对未注册 session 立即回 404，客户端
   20×500ms 轮询等 renderer 建 tab + 注册；平均多付 ~250ms，且首条命令与注册完全串行。
3. **payload 过大**：snapshot 默认 `maxLength=100000`、全量 DOM；evaluate 结果无任何
   截断（上限 500k 的 `MAX_CONTENT_LENGTH` 只管 HTTP fetch 体）。大 payload 抬高后续
   每轮 LLM 输入 token，直接拖慢「获得回复」。
4. **模型行为浪费**：navigate 已返回 compactSnapshot + refs，但 prompt 未禁止紧跟着的
   冗余全量 snapshot。

## 本批改动

### Phase 1 — daemon 事件驱动 wait-load + 注册保持 ✅

- [x] `/webview-wait-load` 端点（`electron/services/browser/webview-bridge.ts`）：
  daemon 进程内等待页面加载完成——订阅 `Page.loadEventFired` + readyState 兜底轮询 +
  快路径双重检查；agent 单次 HTTP 调用替代 200ms 盲轮询。
- [x] `WebviewCDPClient.navigate` 接入 wait-load，端点失败回落旧轮询（兼容旧 daemon）。
- [x] `/webview-command` 注册保持：请求带 `waitRegistration:true` 时 daemon 持有请求直至
  webview 注册（10s 上限，`REGISTRATION_HOLD_TIMEOUT_MS`），超时回 404 + `held:true`；
  客户端识别 held 快速失败，普通 404 保留原有重试循环作兜底。
- [x] 单测 `electron/services/browser/__tests__/webview-bridge.test.ts`
  （8 例：hold 成功/超时/免保持、wait-load 快路径/loadEventFired/超时/未注册/路由不匹配）。

### Phase 2 — payload 收紧 + prompt 延迟规则 ✅

- [x] snapshot 默认参数：`interactiveOnly` false→true，`maxLength` 100000→50000
  （`actions/snapshot.ts`）；全量视图显式 opt-in。
- [x] evaluate / iframe_evaluate 结果硬截断 50k 字符（cycle-safe 序列化 + 截断标记，
  字符串结果原样透传）（`actions/evaluate.ts`）。
- [x] prompt 新增 Latency Rules 段：禁止 navigate 后对未变化页面的冗余 snapshot、
  说明新默认值、鼓励单次宽调用（search/parallel_fetch/窄化 evaluate）
  （`prompt.ts` + Tips #1 改写）。
- [x] 单测 `evaluate-caps.test.ts`（6 例）+ `snapshot-defaults.test.ts`（2 例）。

### 卫生项 ✅

- [x] 清理 `BrowserTool.execute` 两处 `console.log` 调试残留。

## 验证

- 新增 16 个单测全绿；BrowserTool 全目录 + cookie-importer 回归 68/68 绿。
- `npm run typecheck:web` 与 `@duya/agent typecheck` 均 exit=0。
- Electron 手动验证（待办）：真实会话下首次内置浏览器 navigate 的建链时间应从
  「探测+ping+404 重试+400ms 轮询」降为接近真实 tab 创建+加载时长。

## 后续方向（不在本批）

- 独立 WebSearch/WebFetch（plan 428 Phase 2B/C）——减少 tool round 数的最大杠杆。
- plan 64 daemon 侧 session→tab 追踪收尾，解锁多 agent 并行可靠化。
- parallel_fetch 并发可配置化（配合 plan 426 低配自适应）。
- 扩展端 background.js 导航后固定 500ms re-attach sleep 移除。
