# computer-use 插件实现审计与硬化

状态：active · 负责人：本会话 · 更新：2026-10-24
分支：feat/computer-use-hardening · worktree：E:/Projects/duya-marketplace/wt/computer-use-hardening · base：origin/main 2959843 · owner：本会话

## 目标与边界

把观察对象限定在 `duya-marketplace` 仓库的 `plugins/computer-use` 本身，而不是 duya 主仓的 MCP 接入接口。目标是把这个 0.3.0 原型推到"插件自证可靠"：驱动生命周期可恢复、观察结果可校验、策略默认安全、审计可追溯、测试在 Windows 上真实执行。

允许修改 `duya-marketplace/plugins/computer-use/` 下的实现、测试、README 与 manifest。本次不修改 duya 主仓的插件加载、权限裁决、审批 UI 或 MCP 工具命名；确有必要时只记录为依赖并另开计划。

关联：[外部能力迁移](2026-10-22-external-capability-migration.md)。插件执行阶段必须在 `duya-marketplace` 建独立 worktree，不复用本计划的文档检出。

## 验收

以下命令与操作在 `plugins/computer-use` 根目录执行，基线须在改动前重录：

- `npm test` 或仓库既有测试入口在 Windows 上退出码为 0，且 `server.test.cjs` 不再整组 skip；假驱动用例覆盖启动、调用、崩溃、重启。
- 注入驱动崩溃后，插件能在有限次数内重启并恢复工具调用；不存在一次启动失败就永久锁死的状态。
- 策略用例证明默认拒绝、读/写分级、应用拦截与撤销写工具；失败时 fail-closed。
- 审计记录包含一次调用的稳定标识、工具名、目标身份、结果与策略结论；轮转与写失败有明确降级。
- Windows 手工冒烟：`get_desktop_state` → `click` → `type_text` → `revoke` 后写工具被拒，读工具仍可用。
- S7 起追加：写操作须携带观测返回的 `state_id`；无状态或越界的坐标按 `STALE_STATE` 拒绝；`stop` 后的写按 `CONTROL_STOPPED` 拒绝；每条拒绝都要带规则进审计。
- S10 起追加：对官方 `cua-driver` 实测——插件转发的参数必须是驱动认识的参数（不得含插件自有句柄），驱动的拒绝必须被报成失败而不是"已送达"；两者都要有自动化用例覆盖。
- `README.md` 的能力、平台、权限与限制描述与实现一致。

## 进度

- [x] S0 基线审计：逐文件读完 `server.cjs`、`policy.cjs`、`identity.cjs`、`control-state.cjs`、`audit.cjs`、`test/*.cjs`、`mcp/servers.json`、`permissions/policy.json`、`README.md`，运行现有测试并记录退出码、skip 清单与失败签名。
- [x] S1 测试可执行：引入假驱动与可控时钟，取消 Windows skip，补齐启动失败、调用失败、撤销、审计写入失败的用例。提交 `0edc71d`。
- [x] S2 驱动生命周期：懒启动、版本握手、健康检查、退避重启；失败状态可观察且可恢复；Host 重载后不复用死 client。提交 `4c85f8f`。
- [x] S3 观察与坐标：为桌面/窗口状态引入快照代次，写操作校验目标来自同一代观察；补 DPI、多显示器与窗口缩放换算。提交 `6f2f2c0`。
- [x] S4 截图能力：增加独立截图工具与缓存，明确裁剪、返回格式与新鲜度；避免每次观察重新抓全屏。提交 `95c807c`。
- [x] S5 策略与审计：默认 deny，读/写分级落到代码路径；审计接入结构化记录、轮转与失败降级；撤销只拦写工具的规则写进测试。提交 `113de49`。
- [x] S6 打包与版本：固定驱动版本并校验，清理 `dist` 与模拟副本，明确数据目录、升级与卸载清理。提交 `999229d`。
- [x] S7 引擎重做：对齐 MiniMax / Codex / zcode / duya 四家 computer-use 实现，引入状态句柄、动作收据、错误码契约、坐标即截图像素、会话租约与停止开关。提交 `211806e`。
- [x] S8 契约文档：SKILL.md 与 README 按新引擎重写，版本升至 0.5.0，三处版本号加一致性守卫。提交 `8788487`。
- [x] S9 审计补全：派发前的拒绝此前不进审计；漏斗纳入审计路径，拒绝记录规则与 `not_delivered`，失败观测与失败本地工具同样记录。提交 `32fedcc`。
- [x] S10 真实驱动契约对齐：下载官方 `cua-driver-rs-v0.38.0`（校验 SHA256SUMS）实测，发现并修复两个致命缺陷——转发 `state_id` 会被驱动拒绝、驱动失败走 `isError` 而非协议错误导致误报"已送达"；新增 `driver-args.cjs` 翻译层，假驱动改为严格模式。提交 `1e97fa0`。
- [x] S11 文档与版本：SKILL/README 写明驱动契约与坐标作用域；工具词表定案（保留驱动原名，不改名）；版本 0.6.0。提交 `03db74a`。

## 发现与决策

### S0 基线（未改动代码）

- 接入走通用 MCP 通道：manifest 声明 setup 与 `mcp/servers.json`，Host 启动 `node server.cjs`；插件不在主仓注册专用桥接。
- 工具面是 19 个驱动工具加 2 个本地工具；截图只能由 `get_desktop_state` / `get_window_state` 附带返回，没有独立工具、裁剪或缓存。
- 驱动在模块加载时 spawn（`server.cjs:105`）；启动失败后 `driverFailure` 永久锁死（`server.cjs:153`），没有监督与重启。
- 默认策略为 allow（`policy.cjs:60`、`policy.cjs:52`），与原生实现默认 deny 的语义相反；主仓对插件来源的 MCP 调用统一 ask，读/写分级没有进入裁决，读工具也会触发批准。
- 测试共 11 例，`server` 的 5 例在 Windows 整组 skip（`test/server.test.cjs:107` 等 `skip: process.platform === 'win32'`）。
- `servers.json` 的 `envPassthrough` 未被能力发现解析，属于声明漂移。**已复核主仓代码确认成立**：`packages/plugin-core/src/plugins/loader/capability-discovery.ts:114-172` 的 `discoverMcpServers` 只保留 transport/command/args/env/url/headers/nameOverride/startupTimeoutSec/toolTimeoutSec/toolTimeouts，`envPassthrough` 被丢弃。已在 S6 删除该声明。
- 插件**没有任何测试入口**：仓库与插件目录都没有 `package.json`，`node --test test/` 在 Windows 上因尾部分隔符被当成模块路径解析，直接 `MODULE_NOT_FOUND` 退出 1；改用 glob 形式才跑得到 6 通过 / 5 skip / 退出 0。计划里"退出码为 1"即由此而来。

### S1-S6 的代码事实

- 插件只向驱动子进程转发白名单环境（`server.cjs` 的 `driverEnv`），因此测试桩无法用任意环境变量配置。改为让假驱动从 `<TMPDIR>/fake-driver-config.json` 读取配置，这同时验证了环境白名单确实生效。
- 假驱动以 `node <fake-driver.cjs> mcp` 启动，Windows 无需 shell 即可 spawn；为此给插件加了可选的 `CUA_DRIVER_ARGS`（JSON 数组），默认仍是 `['mcp']`。
- 驱动目录没有 `dist`、没有模拟副本、没有任何可执行文件，`test/manifest.test.cjs` 把这一点固化为断言。
- 主仓的 setup 字段没有 `default` 能力（`packages/ui/src/lib/plugin-types.ts:520-530`、`PluginSetupFieldDef` 只有 id/label/type/required），所以"默认 deny"只能落在插件自身：策略引擎无配置即拒绝，README 明确写出恢复旧行为的写法 `{"default_access":"allow"}`。
- S3 的"同一代观察"落地为：元素引用只能**选择**窗口，策略判定用的身份永远取自当前代；引用过期、窗口消失或与请求窗口冲突一律拒绝。
- S4 的独立截图工具做成插件本地工具 `computer_use_screenshot`，而不是依赖驱动目录里可能不存在的 `screenshot` 工具；裁剪只支持 PNG，格式不匹配时明确报错而不是改标格式。
- 坐标换算只在观测结果显式给出逻辑坐标空间与缩放比时生效，否则按 driver-native 原样透传并在审计里标注，不猜。

### S7-S9 的代码事实

对照来源（本机只读）：`~/.zcode/cli/plugins/cache/zcode-plugins-official/computer-use/0.6.5`、`~/.codex/plugins/cache/openai-bundled/computer-use/26.1021.31345`、`~/.minimax/v2/plugin-cache/official/sha256-tree-v1-b9fdb15b…/`、`~/.duya/skills/.system/computer-use/SKILL.md`。

- 四家的共同点是本插件此前没有的：动作绑定到某次观察、"可能已经落地"可表达、错误码是回答的一部分、坐标就是截图的像素。zcode 贡献了收据模型与错误码分类法，Codex 贡献了观测绑定与"outcome unknown"包装，MiniMax 明确写了"never multiply all coordinates by a guessed global scale"，duya 自带 skill 有 `dispatch_status: possibly_sent`。
- **坐标契约改为截图像素**：`geometry.cjs` 删掉 `toDriverCoordinates`，只留 `parseDisplayMetrics` 报告观测声明的显示信息，换算交回给 agent 用 `screenshot.width/height`。这条改变了 agent 的用法，因此 `test/geometry.test.cjs` 保留一条"插件不再做任何换算"的回归守卫，而不是删掉用例。
- **写操作必须携带 `state_id`**：坐标动作与元素引用缺少状态句柄时按 `STALE_STATE` 拒绝；带有效状态的写操作不重新观察，一次动作 1 次驱动往返，替代原来的 2-3 次。状态句柄形如 `st_xxxxxxxx`，带代次与 TTL（`COMPUTER_USE_STATE_TTL_MS`，默认 30 s），过期即不可用。
- **一次动作一个收据**：`structuredContent` 追加 `outcome`（delivered / not_delivered / unknown）、`action_sent`（true / false / null）、`dispatch_status`、`code`、`retry`、`duration_ms`。驱动的收据可能出现在 `structuredContent`、文本 JSON 或错误对象的 `data` 里，`errors.cjs` 的 `receiptFrom` 三处都读。
- **错误码契约**：13 个码，统一格式 `<CODE>: <message> (retry: reobserve|retry|never)`，码表在 `errors.cjs` 的 `RETRY_BY_CODE`，未知码降级为 `INTERNAL` 而不是泄漏。
- **会话控制**：`session.cjs` 用 `computer-use-lease.json` 做控制租约，租约带 pid，接管前先探活，崩溃遗留的租约可被接管；`computer_use_stop` 之后所有写操作按 `CONTROL_STOPPED` 拒绝。写工具的 schema 会注入 `state_id` 参数。
- **审计漏记拒绝（S9）**：写漏斗的检查原先在 try 之外，`STALE_STATE` / `POLICY_DENIED` / `CONTROL_STOPPED` / `CONTROL_BUSY` 都不进审计，轨迹里只剩真正改动了桌面的调用。漏斗移进审计路径后，拒绝记录 `code`、`policy.decision=deny`、规则名与 `outcome: not_delivered`；失败观测与失败本地工具同样记录。这是冒烟跑出来的，不是设计时想到的。
- **S7 实现期三个缺陷**：`server.cjs` 三处 `inspectImage(result, snapshotId)` 引用了未定义的 `snapshotId`（`observe` / `ensureObservation` / `captureScreenshot`）；`tools/list` 顺序与测试期望不一致；`receiptFrom` 读不到驱动错误里的收据。

### S10-S11 的代码事实（真实驱动复核）

复核方式：下载官方 release `cua-driver-rs-v0.38.0` 的 `windows-x86_64-binary.zip`（35.9 MB），按发布方 `SHA256SUMS` 校验 sha256 一致，解压到临时目录直接运行，不安装、不写 PATH。`cua-driver manifest` 给出的官方 MCP 调用形状是 `cua-driver mcp`，与插件默认参数一致。

- **驱动工具面 63 个**（MCP 模式），白名单的 19 个全部存在。`cua-driver describe` 给出每个工具的完整 schema。
- **所有 19 个白名单工具都是 `additionalProperties: false`**。实测 `click` 传 `state_id` 直接被拒：`click: unknown argument state_id; accepted: action, button, capture_id, count, delivery_mode, element_token, from_zoom, modifier, pid, scope, session, target, window_id, x, y`。插件此前原样转发 `state_id`，**在真机上每一条动作都会失败**。修复：新增 `driver-args.cjs` 做翻译——`state_id` 不出插件；桌面观测转成 `scope: "desktop"` 且不带窗口身份；窗口观测带上观测到的 `pid`/`window_id`；其余参数原样透传。
- **驱动的失败不走协议错误**：`result.isError === true` + `structuredContent.code`（`invalid_arguments` / `permission_denied` / `window_target_not_found` / `tool_invocation_failed`），有的还带 `effect: "refused"`、`status`、`next_call`。插件此前把任何 JSON-RPC 成功结果都当作动作已送达，**拒绝会被报成 `outcome: delivered`**。修复：`errors.cjs` 的 `driverFailure()` 读 `isError` 与结构化码，拒绝映射为 `not_delivered` + `action_sent: false`，派发后的失败仍报 `unknown`。
- **坐标有作用域**：`get_desktop_state` 是屏幕像素，动作要 `scope: "desktop"` 且不带 pid；`get_window_state` 是窗口局部像素，动作要 `pid`（+ `window_id`）。`get_window_state` 与 `verify_state` 必填 `pid`+`window_id`，`bring_to_front` 必填 `pid`，`drag` 必填四个坐标，`scroll` 必填 `direction`。
- **驱动自带 `capture_id`**：`get_desktop_state` 的 `structuredContent` 含 `capture_id`、`screenshot_width/height`、`screen_width/height`、`scale_factor`。插件的 `screenshot.id` 现在优先取 `capture_id`（桌面观测没有 element snapshot，只有这个 id）。
- **真实驱动的 `get_desktop_state` 不带窗口信息**（"Vision-only: no UIA tree walk"），所以桌面观测的 `target` 为 null，策略判定在 deny 默认下会以 `no-identity` 拒绝——这是 fail-closed 的正确表现，agent 需改用窗口观测。
- **驱动默认后台投递**（`delivery_mode: background`），不抢焦点；不要预先传 `foreground`。
- **驱动还有 `run_steps`（"The default way to act"）与 `run_script`**，本插件**不暴露**：它们把多个动作包成一次调用，会绕过插件的逐动作策略漏斗与审计。
- 假驱动已改为严格模式：`tools/list` 返回真实 schema，未知参数与缺失必填字段都按真实驱动的方式报 `isError`。此前假驱动来者不拒，所以这类缺陷在 CI 里看不见。

### S7-S9 的决策

- 坐标不再由插件换算。依据是三家一致实践与 MiniMax 的明确警告；代价是 agent 需要自己按 `screenshot.width/height` 换算，收益是插件永远不会把点击打到错误的像素上。
- 默认 deny 保留（duya 计划要求），但语义风险分类法不进插件代码——插件看不到"这一步是否在删数据"，该分层归 skill 与文档层。
- 不引入 sharp 等原生依赖（保持不分发二进制、跨平台）；代价是截图裁剪只支持 PNG，格式不匹配时明确报错而不是改标格式。
- 审计保留在插件层（三家插件层都没有，Codex/MiniMax 交给宿主）——duya 计划要求，因此 S9 把拒绝也补进审计。
- 版本号 0.3.0 → 0.4.0（S6）→ 0.5.0（S8，S7 改了引擎契约）。
- 工具词表与 duya 宿主 `computer_cua` 的 14 个工具名不对齐：**已定案——保留驱动原名，不改名**。插件是驱动的前置代理，再造一套词表只会多一层会漂移的翻译；SKILL.md 写出映射表并声明"两条通路互斥，一次任务只用一条"，并加了一条测试：技能文档漏掉任何一个已暴露的工具就红。
- 不暴露驱动的 `run_steps` / `run_script`：它们把多个动作包成一次调用，会绕过逐动作的策略漏斗与审计。

### 决策

- 本计划只修插件自身；审批 UI、默认策略在主仓的落地、以及读工具直通，都作为主仓依赖记录，不在此实现。
- 策略默认 deny 是行为变更：未配置策略时插件拒绝一切桌面输入。README 与 setup 字段标签都写明了解除方式。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 2959843（干净，origin/main） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；11 例 6 通过 / 5 skip / 0 失败 | `test/server.test.cjs` 五处 `skip: process.platform === 'win32'` |
| 2959843（干净，origin/main） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/"` | 1；`MODULE_NOT_FOUND: ...\test` | 尾部分隔符被当成模块路径，插件没有可用测试入口 |
| 0edc71d（clean） | Windows / Node 24.16.0 | `npm test`（`plugins/computer-use`） | 0；15 例全通过、0 skip | `plugins/computer-use/package.json` 新增 test 脚本 |
| 4c85f8f（clean） | Windows / Node 24.16.0 | `node --test test/server.test.cjs test/driver-client.test.cjs` | 0；20 例全通过 | 崩溃恢复用例 `the plugin recovers after the driver crashes mid session`；版本握手用例 `a driver older than the supported minimum is refused at startup` |
| 6f2f2c0（clean） | Windows / Node 24.16.0 | `node --test`（server/driver-client/identity/policy/observation/geometry 六个文件） | 0；45 例全通过 | `test/observation.test.cjs`、`test/geometry.test.cjs` 新增代次与 DPI 用例 |
| 95c807c（clean） | Windows / Node 24.16.0 | `node --test`（除 S5 外的八个文件） | 0；66 例全通过 | `test/screenshot.test.cjs` 裁剪/缓存/新鲜度用例；`test/png.test.cjs` 11 例 |
| 113de49（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；75 例全通过、0 skip | `test/policy.test.cjs` 默认拒绝与漏斗规则；`test/audit.test.cjs` 结构化记录/轮转/降级 |
| 999229d（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；81 例全通过、0 skip | `test/manifest.test.cjs` 6 例：版本一致、权限分级覆盖、env 声明、无 envPassthrough、无模拟副本 |
| 999229d（clean） | Windows / Node 24.16.0 | 手工冒烟脚本（假驱动） | 0；`get_desktop_state`→`click`→`type_text`→`revoke`→写工具被拒、读工具可用，退出码 0 | 审计轨迹：`click`/`type_text` allowed（rule=allowed，target=allowed.exe#202），revoke 后同两例 denied（rule=revoked），`get_desktop_state` 仍 allowed |
| 211806e（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；110 例全通过、0 skip | `test/server.test.cjs` 24 例（状态句柄、坐标契约、收据、未知结果、停止开关、租约、单轮往返）；`test/errors.test.cjs` 10 例；`test/session.test.cjs` 7 例；`test/observation.test.cjs` 按状态句柄重写 13 例；`test/geometry.test.cjs` 保留"不再换算"守卫 |
| 8788487（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；110 例全通过、0 skip | `test/manifest.test.cjs` 新增"server 报告的版本与 manifest 一致"守卫；`package.json` / `.duya-plugin/plugin.json` / `server.cjs` 三处同为 0.5.0 |
| 32fedcc（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；111 例全通过、0 skip | 新增用例 `a refused action is recorded in the audit trail`：两条拒绝各带 `code`、`policy.decision=deny`、规则名与 `outcome=not_delivered` |
| 32fedcc（clean） | Windows / Node 24.16.0 | 手工冒烟脚本（假驱动，新契约） | 0；14 项检查全通过，退出码 0 | observe → 绑定 state 的 click → 复用 state 的 type_text → revoke → 写被拒（POLICY_DENIED/revoked）→ 读仍可用 → stop → 写被拒（CONTROL_STOPPED）；坐标无 state 与越界均按 STALE_STATE 拒绝；审计轨迹含 3 条拒绝记录 |
| 03db74a（clean） | Windows / Node 24.16.0 | `node --test "plugins/computer-use/test/*.test.cjs"` | 0；116 例 115 通过 / 1 skip（真实驱动用例未设环境变量） | `test/server.test.cjs` 27 例（含"插件不把自己的句柄转给驱动""窗口观测把动作绑到目标窗口""驱动工具错误不报成已送达"）；`test/manifest.test.cjs` 新增"技能文档覆盖每个已暴露工具"守卫；`test/real-driver.test.cjs` 默认 skip |
| 03db74a（clean） | Windows / Node 24.16.0 / 官方 cua-driver 0.38.0（sha256 校验一致） | `COMPUTER_USE_REAL_DRIVER=<cua-driver.exe> node --test "plugins/computer-use/test/*.test.cjs"` | 0；116 例全通过、0 skip | 真实驱动实测：握手、工具面、真实 2560x1440 桌面截图、截图工具、参数翻译（`scope: desktop` 被接受，`type_text` 空文本回 "Typed 0 character(s)"）、参数缺失被映射为 `INVALID_REQUEST`；全程未派发真实输入 |
| 03db74a（clean） | Windows / Node 24.16.0 | 手工冒烟脚本（假驱动，严格模式） | 0；15 项检查全通过，退出码 0 | 转发参数实测为 `{"x":3,"y":3,"scope":"desktop"}`（无 `state_id`）；审计轨迹 11 条，含 3 条拒绝 |

未验证项：真实驱动的**输入路径**（真实点击、真实按键）未在用户会话中执行——那会在用户正在使用的桌面上移动指针与键盘。真实驱动的其余部分（工具面、截图、参数校验、拒绝形状、快照与窗口解析）已逐项复核。

## 接续 / 结果

已实现：S1-S6 六个切片 + S7-S11 五个切片，共 11 个提交（`0edc71d`、`4c85f8f`、`6f2f2c0`、`95c807c`、`113de49`、`999229d`、`211806e`、`8788487`、`32fedcc`、`1e97fa0`、`03db74a`），插件版本 0.3.0 → 0.4.0 → 0.5.0 → 0.6.0。已验证：假驱动 116 例（1 skip）与真实驱动 116 例（0 skip）在 Windows 全绿、退出码 0；冒烟序列符合验收；真实驱动复核发现并修复两个致命缺陷。已合并：无。draft PR：#3（`feat/computer-use-hardening` → `main`）。

未提交路径：本计划文档。外部副作用：官方驱动已下载到 `%TEMP%\cua-driver-038`（未安装、未写 PATH），实测结束后驱动守护进程已自行退出（`cua-driver status` 报 not running）。

阻塞：无。遗留：真实驱动输入路径需在用户可控的窗口上手工跑一次；主仓侧仍需另外处理审批 UI 的读工具直通、插件来源 MCP 调用统一 ask、以及 `envPassthrough` 在能力发现层被丢弃的问题。

已知不做（另开计划）：回合结束自动释放控制（Codex hooks 做法）；跨插件并发独占的完整语义（本插件只做了租约 + `CONTROL_BUSY`）；临时目录 `E:\Projects\duya-marketplace\wt\.staging` 的清理——在工作区外，可恢复删除被策略拒绝，移入工作区再删同样被拦（"recursive write/delete target cannot be verified inside the workspace"），**需手动清理**。

下一步：在用户可控的窗口上跑一次真实输入冒烟（点击 + 键入 + 撤销），确认收据的 `outcome`/`action_sent` 与驱动实际行为一致。
