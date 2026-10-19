# 22 — Wave 3 首轮执行

2026-10-19。基线 `205ad958`；远端随后合入 Wave 1 文档 #301，源码基线保持不变。
本文件细化 [19 §8](19-fast-track-queue.md#8-wave-3--骨架开工前必须先由-owner-用当时代码细化)，不另建总队列。
Wave 2 的 #299/#302 尚未合并；T23 仍未验收。不得把本轮写成 Web/Desktop 全面切换。

## 冻结范围与文件所有权

| 车道 | 独占实现 | 本轮验收 |
| --- | --- | --- |
| A / T30 | `packages/plugin-core/src/apps/declarations.ts`、其测试；Desktop manifest/types/parser 测试、renderer plugin-types 投影 | 同一真实 manifest 的两个 App 定义经过现有 parser/catalog/renderer schema 保留；旧格式兼容 |
| B / T31a | `packages/host/src/plugin-app-bridge.ts` 与测试 | 受绑定实例约束的消息验证；调用捕获的已有 Runtime 工具执行器，拒绝伪造来源、身份、方法、schema、撤销与拒绝审批 |
| C / T40a | `apps/web/src/server/**` 与 `apps/web/tests/**`；不写根 package.json | 真 Host HTTP 的同源 BFF：浏览器不持 Host bearer，拒绝跨站和无 CSRF 修改；保留 SSE/cursor、取消与审批 |
| 协调者 | 本计划、公共 exports/scripts/build 接缝、集成与审查 | 最终具名测试、类型/边界检查、独立 PR、下一轮具体接缝 |

先获得失败证据，再改生产代码。每人不得编辑其他车道或脏主检出；构建由协调者统一执行，
不在带 junction 的 worktree 中 npm install，不换共享 SQLite ABI。

## T30 合同

磁盘声明为 `extensions["com.duya.client"].apps`，避免与 Codex 根字段 `apps`（连接器声明文件）冲突。
归一化为 `PluginManifest.apps?: PluginAppDefinition[]`：

```ts
interface PluginAppDefinition {
  appId: string;
  entry: string;
  requiredCapabilities: string[];
  stateSchemaVersion: number;
}
```

- appId 为包内唯一稳定标识；entry 为包内 POSIX 相对文件路径，禁止 URL、盘符、UNC、反斜线、
  空段、`.`/`..`、NUL。真实 parser 验证文件及 canonical containment，含符号链接越界。
- capabilities 为请求，不是权限授予；允许空数组，拒绝空白/格式错误字符串；未来未知的合法
  capability 保留到 bind 时协商，不在读取 manifest 时用静态 Host 表伪装可用性。
- stateSchemaVersion 为正整数；不是实例 revision，也不是 session/runId。
- 包、App 定义、App 实例、关联 session/run 是四种身份；本轮不把状态藏进 React。
- 无 apps 的旧 manifest 行为不变；同一列表重复 appId 或不合法声明明确失败。
- 纯共享 schema 由 plugin-core 拥有，Node 文件路径验证留在现有 Desktop parser。

## T31a 合同与边界

实例 binding 必须由 Host 提供：pluginId/app 定义/instanceId、实例 nonce、精确来源对象及 origin、
session/run 身份、当前有效性和捕获的工具描述符/执行器。App payload 不能决定任何授权来源。
首次只提供严格 `mcp.invoke` 请求；方法必须在已声明且当前获准的能力集合内，工具必须在
该 binding 捕获的 descriptor 集合内，参数由对应 schema 验证。拒绝错误来源、过期 binding、
跨实例/跨 session/run、额外字段、未知方法、未声明工具、版本不匹配。

执行器来自既有 worker/Runtime 工具注册路径，不能直接调用 ConnectorService；测试使用真实
`createMCPToolExecutor` 证明 ask/deny/paused 不会误执行，allow 只执行一次，并复核审批 await 后的
binding 有效性。opaque iframe 的 origin 为 null，必须同时核精确 source 与 nonce；origin 不能单独授权。

这是 bridge kernel/绑定接缝。真实 iframe 创建、实例持久化、worker RPC 生产调用与审计/审批端到端
尚未实现时，不宣称 T31 完成或 Apps 可在 Desktop 上运行；不以测试注入 port 冒充生产切换。

## T40a 合同与边界

独立 Host 拒绝带 Origin 的请求；不修改该边界来方便浏览器。BFF 只监听 loopback，向 Host 发 Node
请求并保管 token。浏览器只调同源窄 API；精确校验 Host/Origin、拒绝 cross-site Sec-Fetch-Site，
修改请求需每进程 CSRF header，不给任意 CORS，不代理任意路径/URL，不返回 Host descriptor/token。
先验收 handshake、会话读取、受控 run 启停/审批与 SSE cursor 转发；流断开应释放上游订阅。

本轮先交付 server/transport，后续 browser UI 直接消费 RunSession，不新写 reducer。
刷新恢复从 Host 台账恢复；完整 T40 仍以 T20/T23 和真实浏览器测试为关口。T41 暂不抽共享 UI。

## 验收与下一步

- T30：现有 manifest 回归 + 多 App/格式碰撞/路径与 symlink/IPC 投影测试。
- T31a：来源与身份故障注入 + 真实 Runtime 审批执行器路径，明确未接生产的边界。
- T40a：真 Host listener + BFF HTTP 测试，证明 token 不进入浏览器、跨站拒绝和 SSE 释放。
- `typecheck:all`、`architecture:check`；涉及 browser closure 时用现有 G11 做检查，不给 baseline 加指纹。
- 下一轮先补 App instance store/生产 iframe caller 与同一审批链，再做两个 App/两个实例示例；
  Web UI/真实浏览器验收与之可独立推进。Relay 和远端授权不在本轮暗中开放。

## 实现复核（2026-10-19）

- T30 追到生产 `listInstalled()` 后发现安装列表不会返回 manifest。补齐 main/preload/renderer
  的 `apps` 字段，只投影 App 元数据，不返回可能含 MCP 凭据的整份 manifest。
  测试证明两 App 保留、旧插件缺省和凭据排除。canonical symlink 越界用 realpath 故障注入，
  未宣称实测创建了 Windows symlink。
- T31a 初版复用 tool-use ID 会复用上一次审批。已改成 Host 每次铸造 UUID 并新建 context；
  两次参数不同的调用会重新询问，第二次 deny 无第二次副作用。参数快照先于 schema 验证，
  审批等待后再核绑定有效性。仍没有 iframe/worker RPC 生产调用者。
- T40a 初版误接 `ToolApproval` 卡片台账，已改接 worker 使用的 `PermissionRequest` 接口。
  真 Host HTTP + SQLite 测试验证创建/列出/allow/deny/消费保存的结果；waiter 是模拟轮询，
  没有在 Web 测试里启动真 worker。run 启停也是真 HTTP 后的受控 execution port。
  SSE 保留身份并测试断连释放；heartbeat 在 backpressure 时暂停写入。
  CLI 复用 `readLocalHostRuntime` 校验 descriptor 和 PID，不重写 Host 发现规则。

完整产品验收未变：两个 App 的独立持久化实例、真 iframe 通过现有审批链调 MCP；
Web 消费 RunSession，真 worker 工具调用/审批/取消/刷新恢复。这些不在本轮默默勾选。

本轮同一工作树验证：8 文件 **108/108**（manifest/schema/installed-list/bridge/Web）；
`typecheck:all` exit 0（包含新 Web workspace）；`architecture:check` exit 0（2769/2769，
baseline 932 未改）；`architecture:self-test` exit 0。构建后 BFF CLI 真子进程从临时 Host descriptor
发现服务，bootstrap/handshake 均 200；该检查不是浏览器 UI 验收。工作树内为 apps 补了指向
自己 packages 的 Host/protocol/plugin-core 解析 overlay，未在 junction 中 npm install。

下批按两条产品链路推进：

1. **T31b/T32**：Data + Host 先给出 App instance/state 持久化窄 API（两 App/两实例隔离、
   重启保留、版本冲突、撤销）；Desktop 并行在 installed Apps 渲染打开入口和沙箱 iframe。
   `PluginRegistryStore` 只存包启用意图，`usePanel` 只存布局，两者均不充当 App 状态仓。
   worker RPC 必须从真正的工具注册/审批 context 捕获 T31a 执行器，做 deny=0/allow=1 副作用验收。
2. **T40b**：在本轮 BFF 上补 browser entry 和 RunSession transport；选会话/发送/工具流/审批/取消/
   刷新恢复做一次真 worker + Playwright 验收，不另写 reducer。T23 依赖缺口继续明确记录。
