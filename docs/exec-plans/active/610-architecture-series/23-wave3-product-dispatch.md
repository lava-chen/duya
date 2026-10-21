# 23 — Wave 3 产品接线第二批

2026-10-19 用户修正：Web 使用 Desktop 的现有界面，不另做一套视觉设计；明确授权
提取 `@duya/ui`。本批增加 T41：从 Desktop 提取布局、composer 外壳和 Markdown 展示，
Desktop 与 Web 同时直接消费。UI 包不导入 Host/client-core/Electron；Desktop 保留现有
状态/平台行为，Web 保留已验证的 BFF/RunSession。样式直接复用 Desktop 的 globals，
不复制维护另一套主题。原独立 Web 皮肤退出产品入口。

2026-10-19。承接 19 的队列与 22 的冻结合同，不重写总计划。
初始隔离基线为 Wave 2 集成候选 `9a1afd27`；合入后从 master 同步。
本批不把 T21/T22/T23 自动勾选完成，也不把 App store 写成 iframe 已跑通。

## 文件所有权

| 车道 | 独占实现 | 验收 |
| --- | --- | --- |
| A / T31b Data | 新 App instance store、core-stores 组合/迁移、Data exports 与相应测试 | 两 App/两实例隔离、重开持久化、CAS、版本不符拒绝、停用/撤销 |
| B / T40b server | apps/web/src/server/**、apps/web/tests/server/** | 同源静态 build 服务；禁止目录越界/符号链接逃逸；保留现有 API 安全合同 |
| C / T40b browser | apps/web/index.html、src/browser/**、src/client/**、tests/client/** | 真 RunSession 消费；发送/工具/审批/取消/刷新重放，无第二套 reducer |
| 协调者 | 计划、根与 Web package/lock/Vite/tsconfig/policy；Host API 接缝；集成/浏览器验收 | 真 Host + 生产 worker + 受控 provider + 实际浏览器，不以假 executor 冒充 |

agent 不构建整个 workspace，不 npm install，不同时修改公共配置；由协调者统一构建。

## T31b store 合同

- Data 只拥有持久身份与不透明 JSON 状态，不导入 plugin-core/Host。
- 记录：Host 铸造的 instanceId、pluginId、appId、正整数 stateSchemaVersion，
  JSON state、revision（初值 1）、status（active/disabled/revoked）、createdAt/updatedAt。
- 不存 session/run、nonce、当前能力 grants 或 MCP 凭据；下次启动须重新建立权威 binding。
- 写 state 需 expectedRevision 和 expectedSchemaVersion；原子 CAS 增 revision。
  返回区分 not_found/stale_revision/schema_mismatch/inactive；不得静默重置/迁移版本。
- disabled 可显式启用；revoked 为终态。状态变化同样 CAS，且 bump revision。
- CoreDataHost 使用同一迁移/组合入口，候选 migration 40 在落笔时再查重。
- 大型或不可序列化 state 明确拒绝，不把 undefined/NaN/函数静默写成另一种值。

## T40b 浏览器与服务端合同

- 仅浏览器模块导入 client-core/protocol/React；不得导入 Host/Data/Node/Electron。
- Host bearer 始终由 BFF 持有；浏览器只获取 CSRF，同源 fetch。
- UI 读取 Host 会话，按 runId/sessionId 建 RunSession。接收 Host SSE 原生信封，
  用 apply/acceptWindow 和 getSnapshot/subscribe；身份拒绝与稀疏 seq 由共享层处理。
- 浏览器刷新后从 Host 台账重放；断线按 lastAcceptedSeq 请求，不靠本地事件日志恢复。
  session 选择可存在 URL 中；切换/卸载释放 fetch/SSE/poll。
- 原生事件与 durable run 状态有不同事实来源。取消成功必须看到 Host 的请求回执/台账状态，
  不因流静默、断线或缺终态擅自宣称 completed/cancelled。
- 现有 pending PermissionRequest API 是审批事实来源；allow_once/deny 复用 worker 原路径。
- 原始 Host message history 只做展示投影；工具/turn 状态来自 RunSession，不另写 reducer。
- CLI 默认从 dist/browser 提供生产构建。同一监听器托管 API 和静态资源，原 Host/Origin/
  fetch-site/CSRF 检查保留。仅允许 build 内 index/assets，禁止任意文件、目录和外部链接。
- UI 为中文本机工作台：会话侧栏、可读的对话/工具/审批、发送/取消、连接状态。
  明确空会话/连接失败/重连状态；不放实现层术语、虚假控件或演示业务数据。

## 产品验收

先有会失败的测试，再实现。Data + BFF/transport 定向测试；构建 client closure，检查无 Host
或凭据进入 browser bundle；真 provider/worker 实际工具 → 审批 allow/deny → 下一模型请求，
浏览器刷新恢复同一 run；另一运行发取消并核对 durable 状态。
用实际浏览器做交互与截图；未完成的路径逐条留明，不以截图替代整链路。

合并继续用普通 merge PR，不改 required checks 或 baseline。后续 iframe/worker RPC 与两个 App
示例仍待专门验收；本批 App store 本身不代表 T31/T32 完成。
