# 插件 UI 改为 MCP 资源面

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：codex/three-learning-plans · worktree：E:/Projects/duya/.claude/worktrees/three-plans · base：7063a47f · owner：本会话

## 目标与边界

让插件的侧栏界面不再依赖包内静态 HTML 入口，而是由插件自己的 MCP server 以资源形式提供。插件 manifest 声明 UI surface（`server`、`resourceUri`、`availability`、图标与 i18n 标题），宿主通过 MCP `resources/read` 取内容，沿用现有的 loopback 文档地址、launch nonce、opaque-origin iframe 与逐次 invoke 复核，把内容渲染成侧栏 tab。

这是对 ZCode `ui.surfaces[] + ui://` 模型的吸收，但只借资源面与声明方式，不引入完整的 MCP Apps 协议，也不复制它的 tab 状态源。

允许修改 `packages/plugin-core` 的清单 schema 与发现逻辑、`apps/desktop/src/main/plugins` 的 app host、`packages/ui` 的 app 启动与侧栏入口，以及 `duya-marketplace` 中的一个示例 UI 插件。本次不处理插件市场运营、推荐排序与安装计费。

关联：[conductor canvas 插件](619-conductor-canvas-plugin.md)、[面板列树](2026-10-22-panel-column-layout.md)。资源面依赖面板 tab 的归属语义，但不要求列树先完成。

## 验收

- 一个声明 `ui.surfaces` 的插件被安装后，界面入口出现在插件应用区；点击后在侧栏打开，内容来自该插件 MCP server 的资源读取，而不是包内 `entry` 文件。
- 同一 surface 重复点击只激活已有 tab；`availability: session` 的 surface 在没有活动会话时隐藏，`global` 的 surface 不依赖会话。
- 安全回归：非本 iframe 的 `postMessage` 被丢弃，token 不匹配、非 loopback 地址、跨插件资源名、超限资源体都被拒绝；错误在 UI 可见而不是静默空白。
- 宿主→guest 事件通道可用：agent 触发一次 `select` / `highlight`，界面收到事件并更新；guest 的 `invoke` 仍按既有能力映射复核。
- 现有静态 `entry` 插件不受影响，兼容期至少保留一个真实用例。
- `npm run typecheck:all` 与相关包测试通过；UI 改动通过实际产品路径验证。

## 进度

- [ ] S1 契约：在 `PluginAppDefinitionSchema` 旁新增 `PluginUiSurfaceSchema`（surface id、i18n 标题、icon、server、resourceUri、availability），校验 server 必须存在于 `mcpServers`、resourceUri 使用 `ui://`、surface id 在插件内唯一；`entry` 改为双向兼容而非立即删除。
- [ ] S2 发现与目录：能力发现把 surfaces 投影到已安装插件目录；拒绝跨插件同名 surface；安装态变化时刷新目录。
- [ ] S3 宿主资源解析：用现有 MCP client 执行 `resources/read`，校验 MIME、大小上限与来源 server；通过现有 loopback 文档通道下发，签发 document token 与 launch nonce。
- [ ] S4 UI 入口：在插件应用区与侧栏 tab 中渲染 surface；复用安装/启用进度与失败提示；session surface 无会话时隐藏。
- [ ] S5 双向通道：保留 guest→host `invoke`，新增 host→guest 的受控事件（`select`、`highlight`、`refresh`），事件只能寻址当前 launch 的 surface。
- [ ] S6 示例与兼容：把 `duya-marketplace` 中一个纯查看型插件迁到资源面；保留一个静态 entry 插件跑回归。

## 发现与决策

- ZCode 的 UI 插件在 manifest 的 `ui.surfaces[]` 中声明 `resourceUri: ui://...`，由插件 MCP server 提供；界面与工具共用一个 server，agent 可在界面内定位、高亮与截取。这是“资源面”而非“静态页面”的核心。
- duya 当前以 `appId + entry + runtime + requiredCapabilities` 声明应用，宿主用 sandboxed iframe 加载包内文件，安全边界已经比较完整，缺少的是资源面声明与宿主→guest 事件。
- 决策：资源优先、静态兼容。先让新清单能声明 surface，再迁移示例；不为了对齐 ZCode 引入第二套运行时或完整 MCP Apps 协议。
- 决策：side pane 仍是唯一 tab registry；surface 打开只提交 tab，不另建状态源，也不把插件页面放进面板 DOM 常驻。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待记录 | Windows / Node | `npm run typecheck:all` + 相关包测试 | 待记录 | S1 完成后填写 |
| 待记录 | Desktop | 安装示例插件并打开 surface | 待记录 | S6 完成后填写 |

## 接续 / 结果

已实现：无。已验证：无。已合并：无。

未提交路径：本计划文档。外部副作用：无。

阻塞：无。S1 需要先核对 `PluginAppDefinitionSchema` 的现有消费方，避免清单迁移造成安装态不可读。

下一步：完成 S1 契约与校验用例，确认静态 entry 兼容路径后再进入 S2。
