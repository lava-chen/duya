# 16 — A8 UI 抽取普查:跨端红线、顺序与验收

> 纯测量。本文件不修改任何生产代码,不新建包,不新建门禁。
> 基线:`master @ c3a1ed41`,共享 checkout `E:\Projects\duya`。

---

## 1. 口径与作用域

### 1.1 门禁分析的是哪棵树(必读)

G11-0(`browser-runnable-gate.mjs`)的 `ROOT` **不是 cwd,是脚本所在目录**:

```
.claude/worktrees/browser-runnable-gate/scripts/architecture/import-graph.mjs:50
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
```

`boundary-gates.mjs` 的 `REPO_ROOT` 同理。因此在 `E:\Projects\duya` 下运行
`node .claude/worktrees/browser-runnable-gate/scripts/architecture/browser-runnable-gate.mjs`,
它分析的是 **worktree 树**
(`E:\Projects\duya\.claude\worktrees\browser-runnable-gate`),
不是共享 checkout。

**陷阱在于输出看起来完全正常**:`rel()` 把路径相对于那个 ROOT 输出,所以每一行都是
`apps/desktop/src/renderer/...`,不带任何 `.claude/worktrees` 前缀。只看输出**无法**
判断分析对象——这正是交底要求先验证的原因。

验证方式不是看路径,而是比较两棵树:

| 检查 | 结果 |
| --- | --- |
| 共享 checkout HEAD | `c3a1ed41` |
| worktree HEAD | `181c4f41` |
| `git diff --name-only c3a1ed41 181c4f41 -- apps/desktop/src/renderer packages/conductor` | **空** |
| 共享 checkout 的 6 个 `M` 文件是否落在作用域内 | 否(全在 `AGENTS.md` / `ARCHITECTURE.md` / `docs/` / `package*.json` / `scripts/`) |
| 共享 checkout 的 9 个 `??` 是否落在作用域内 | 否(`fixtures/` 在仓库根,不在门禁 `ROOTS = ["apps","packages","evals"]`) |
| worktree 未提交改动 | 仅 `?? scripts/architecture/__mutation.ps1`,不在 `ROOTS` |

**结论:门禁数字对共享 checkout 有效**,因为它扫描的两个子树在两棵树之间逐字节相同。
这不是推测,是 diff 结果。

### 1.2 门禁输出口径

```
apps/desktop/src/renderer: 601 seeds, 863 files in closure
(type-only, not counted) apps/desktop/src/renderer/lib/bot-channels-ipc.ts:32 typeof window.electronAPI
entries not on this tree yet: apps/web/src/main.tsx
channels: 115 files / 518 refs to window.electronAPI, 0 files / 0 refs to Node built-ins
G11-0  FAIL  115/863 files are not browser-runnable
```

- **分母 863** = `apps/desktop/src/renderer` 下 601 个非测试种子文件的值导入闭包大小。
- **分子 115 / 518** = 闭包内存在 `PropertyAccessExpression(.electronAPI)` 的文件数与引用数。
- 1 处 `typeof window.electronAPI`(`bot-channels-ipc.ts:32`)是 `TypeQueryNode`,
  被报告但不致命,与 G10 对 type-only import 的处理一致。
- `apps/web/src/main.tsx` 尚不存在,记为 absentEntry。

### 1.3 独立复算(不采信门禁)

门禁的 115 来自它自己。我用 **ROOT 硬编码为共享 checkout** 的独立脚本重算了整条链路,
只为回答一个问题:门禁的数在共享 checkout 上是否成立。

- 闭包算法:复用 `import-graph.mjs` 的 `importsOf` / `walk`(纯函数,接绝对路径),
  `resolveRepoSpecifier` 用 ROOT=`E:/Projects/duya` 重写。
- 命中判定:`ts.createSourceFile` + AST,只取 `PropertyAccessExpression` 且
  `node.name.text === 'electronAPI'`;`TypeQueryNode` 分开计数。
- 不使用任何正则做统计。

结果:

```
seeds=601  closure=863  offenders=115  refs=518  clean=748  transitively-clean=658  typeOnly=1
```

**独立复算与门禁完全一致:115 文件 / 518 引用。** 这是本文所有数字的来源。

### 1.4 为什么不能用正则(交底点名的那两个错误)

1. **双重计数**:`window.electronAPI` 同时命中 `/electronAPI/g` 和 `/\bwindow\./g`,
   于是 `ipc-client.ts` 被算成 167。AST 实测该文件 81 处。同一 AST 节点在两种正则下各计一次。
2. **`window.*` 误伤**:`window.document` / `window.location` 在浏览器里**存在**,
   匹配 `window.*` 会把它们算成宿主耦合。
3. **注释污染**:`electronAPI` 出现在注释里会被文本扫描计入。AST 不会。
4. **非空断言打断链**:`window.electronAPI!.thread!.list()` 里 `!` 是
   `NonNullExpression`。我第一版链式提取没有解开它,把 73 个真实命名空间引用记成了
   `<direct>`。引用**计数**不受影响(每个 `electronAPI` 仍是 1 个节点),但
   「命中通道」列会错。最终版解开了 `!` / `as` / 括号。

### 1.5 口径冲突:A 类与 115 在定义上不相交(必须先说)

交底要求 `A + B + C == 115`。但交底同时把 A 类定义为:

> 文件本身零 electronAPI 值引用,且其 import 闭包内也无。

而任务对象是「闭包内**每一个有 electronAPI 值引用**的文件」。这两个集合**按定义互斥**:
A 类成员不可能是 115 的一员。因此 `A + B + C == 115` 在字面口径下无解。

我按实测口径处理,给出两个恒等式,不用推测填空:

```
闭包 863 = 115(自身有 electronAPI 值引用) + 658(A 类,自身及其传递闭包均干净) + 90(自身干净但传递闭包被污染)
115 = 100(B 类) + 15(C 类)
518 = 461(B 类) + 57(C 类)
```

A + B + C = 658 + 100 + 15 = **773**,加 90 个「被上游拖住」的文件 = 863。
下文第 4 节按这个口径给表。

### 1.6 另一个口径差:闭包 115 vs 整目录 134

直接扫 `apps/desktop/src/renderer` + `packages/conductor/src/renderer` 两棵树的**全部**
`.ts/.tsx`,得到 **134 文件 / 563 引用**,比闭包多 19 文件 / 45 引用。

这 19 个文件不在 863 闭包内(不可达,或只在测试路径下可达)。本文 A/B/C 三类
**一律基于闭包 115**,不是目录扫描结果。差异原因未逐个查明,列入第 7 节。

---

## 2. 分类口径

判定全部基于 AST 事实,不靠命名感觉。每个引用可复现地回答三问:
命中哪个 AST 节点类型 → 在哪个符号上(文件:行)→ 该符号绑定到哪个 electronAPI 通道。

| 类别 | 判据 | 是否可判定 |
| --- | --- | --- |
| A `presentation-only` | 自身零 `PropertyAccessExpression(.electronAPI)`,**且**值导入传递闭包内也没有 | 可判定(纯图计算) |
| B `needs-host-capability` | 引用了宿主能力,但换成 HTTP/SSE 或另一个 client port **能**实现 | 需人判断能力可替换性 |
| C `electron-only` | 引用了浏览器里**根本不存在**的东西 | 需人判断,一旦判定应长期冻结 |

B 与 C 的边界是唯一的判断题,本文采取**保守规则**:
**一个文件只要引用了任意一个 C 通道,整文件归 C。** 哪怕它同时引用了 B 通道。
15 个 C 文件里有 8 个同时含 B 通道(BridgeSection 之类),这条规则让「哪些文件永远
搬不走」这个答案不随讨论漂移。

C 通道词表(浏览器里没有对应物):

| 标记 | 含义 | 证据 |
| --- | --- | --- |
| `CHROME` | BrowserWindow 窗口控件 / 原生菜单 | `appChrome.editCommand` / `zoom` / `toggleFullscreen` |
| `UPDATER` | 应用自更新安装 | `updater.install` / `onReady` |
| `WEBVIEW` | `<webview>` 标签 | `browserWebview.registerWebview` |
| `PTY` | node-pty 终端 | `terminal.kill`,实现在 Electron 主进程 |
| `COOKIE` | Electron session cookie 存储 / 本机 Chrome profile | `browserCookie.detectProfiles` |
| `EXTENSION` | Chromium 扩展装卸 | `browserExtension.approvePending` |
| `WEBUTILS` | `electron.electronWebUtils` | `useFileParsing.ts:30` |
| `OSUI` | macOS TCC 权限面板 / 登录项 / nativeTheme | `computerUsePermissions.openPane` / `settings.setAutoStart` / `system.setNativeThemeSource` |

B 通道词表(有可替换实现,只是还没接):

`DIALOG` 对话框 · `SHELL` 打开本机路径 · `FS` 文件读写 · `GIT` git · `SETTINGS` 设置 ·
`PROJECT` 项目 · `SESSION` 会话持久化 · `STREAM` 流式 · `NOTIFY` 通知 · `VOICE` 语音 ·
`RECORDER` 录制 · `AUTOMATION` 定时 · `WORKFLOW` 工作流 · `SKILL` 技能 · `HOOK` 钩子 ·
`MAILBOX` 收件箱 · `GATEWAY` 外部通道 · `PLUGIN` 插件 · `CONDUCTOR` 画布 · `ORB` 悬浮球 ·
`NET` 网络 · `LOG` 日志 · `VISION` 视觉开关 · `PROVIDER` 供应商 · `PERM` 权限 ·
`PORT` 端口发现 · `IMP` 导入

---

## 3. 表 A —— presentation-only

**658 个文件 / 0 引用**,占闭包 863 的 76.2%。这是「现在就能搬」的清单。

传递闭包里第一个碰 electronAPI 的文件:**全部为「无」**(这正是 A 类的定义)。

658 行不适合逐行展开(它是闭包的机械计算结果,规则已在 1.3 / 2 写死,可完全复现)。
下表是**第一批可直接搬的子集**,按目录分组,全部经独立脚本验证为传递闭包干净:

| 目录 | 文件数 | LOC | 传递闭包第一个 offender |
| --- | --- | --- | --- |
| `apps/desktop/src/renderer/components/ui/` | 18 | 2 247 | 无 |
| `apps/desktop/src/renderer/components/diff/` | 4 | 649 | 无 |
| `apps/desktop/src/renderer/types/` | 11 | 1 659 | 无 |
| `apps/desktop/src/renderer/i18n/` | 3 | 6 625 | 无 |
| `apps/desktop/src/renderer/lib/diff/` | 1 | 344 | 无 |
| `apps/desktop/src/renderer/lib/errors/` | 1 | 157 | 无 |
| **小计** | **38** | **11 681** | — |

明细(`components/ui/` 18 个,`CreateProjectDialog.tsx` 因 `dialog.openFolder`
不在 A 类,见 B 表):

| 文件 | LOC |
| --- | --- |
| `components/ui/AutoResizeTextarea.tsx` | 61 |
| `components/ui/Button.tsx` | 87 |
| `components/ui/DropdownMenu.tsx` | 540 |
| `components/ui/HoverPopover.tsx` | 222 |
| `components/ui/IconButton.tsx` | 95 |
| `components/ui/Input.tsx` | 160 |
| `components/ui/InputDialog.tsx` | 71 |
| `components/ui/OptionPanel.tsx` | 208 |
| `components/ui/Switch.tsx` | 40 |
| `components/ui/toast.tsx` | 339 |
| `components/ui/usePopoverPlacement.ts` | 147 |
| `components/ui/page/EmptyState.tsx` | 33 |
| `components/ui/page/Modal.tsx` | 131 |
| `components/ui/page/PageCard.tsx` | 42 |
| `components/ui/page/PageFrame.tsx` | 54 |
| `components/ui/page/PageHeader.tsx` | 28 |
| `components/ui/page/PageTabs.tsx` | 66 |
| `components/ui/page/index.ts` | 13 |
| `components/diff/CodeViewer.tsx` | 57 |
| `components/diff/DiffViewer.tsx` | 401 |
| `components/diff/SimpleDiffViewer.tsx` | 183 |
| `components/diff/index.ts` | 8 |
| `types/automation.ts` | 155 |
| `types/bash-task.ts` | 40 |
| `types/hook-task.ts` | 30 |
| `types/hooks.ts` | 58 |
| `types/index.ts` | 144 |
| `types/message.ts` | 376 |
| `types/mode-id.ts` | 117 |
| `types/research.ts` | 290 |
| `types/slash-command.ts` | 53 |
| `types/stream.ts` | 222 |
| `types/usage.ts` | 174 |
| `i18n/en.ts` | 3 280 |
| `i18n/index.ts` | 90 |
| `i18n/zh.ts` | 3 255 |
| `lib/diff/diff-utils.ts` | 344 |
| `lib/errors/extractErrorMessage.ts` | 157 |

A 类其余 620 个文件按前缀分布(闭包内、传递干净):

| 前缀 | 文件数 |
| --- | --- |
| `apps/desktop/src` | 457 |
| `packages/conductor/src` | 35 |
| `packages/ai/src` | 73 |
| `packages/agent-protocol/src` | 69 |
| `packages/plugin-core/src` | 19 |
| `packages/input-completion/src` | 6 |
| `packages/command-catalog/src` | 1 |
| `packages/connectors/src` | 1 |

另有 **90 个文件自身干净但传递闭包被污染**,既不是 A 类也不是红点,
典型如 `components/chat/tools/**`(经 `SessionToolRow.tsx` 拖进
`conductor-bridge.ts`)。它们是「上游一改就能进 A 类」的候选,不是当前可搬清单。

---

## 4. 表 B —— needs-host-capability

**100 个文件 / 461 引用**,占 115 的 87.0%、518 的 89.0%。
「传递闭包里第一个 offender」一列,凡是自身即为 offender 的都记「自身」。

LOC 与引用数经脚本逐行比对源码,MISMATCHES = 0。

| 文件 | LOC | refs | 命中通道 | 能力 | 归类理由 | 首个 offender |
| --- | --- | --- | --- | --- | --- | --- |
| `App.tsx` | 927 | 6 | `message.onMessageNew` `notification.onNotificationClicked/onNotificationAction` `botTurn.sendTurn` `agent.setAgentPermissionMode` | SESSION / NOTIFY / STREAM / PERM | 全部可由 HTTP+SSE + Web Notification 实现 | 自身 L304 |
| `components/automation/AutomationView.tsx` | 676 | 1 | `automation` | AUTOMATION | 服务端定时任务,浏览器无状态 | 自身 L134 |
| `components/automation/CronEditorModal.tsx` | 711 | 2 | `dialog.openFolder` | DIALOG | 选目录必须由宿主执行,见 4.1 | 自身 L480 |
| `components/chat/AttachmentPreviewModal.tsx` | 259 | 2 | `shell.openPath` | SHELL | 用系统默认程序打开本机文件 | 自身 L67 |
| `components/chat/BotDirectChatView.tsx` | 1 345 | 3 | `message.botDirectGetTranscript` `sse.onConnected` `toolApproval.resolve` | SESSION / STREAM / PERM | 三者均已有 HTTP/SSE 对应 | 自身 L469 |
| `components/chat/ChatView.tsx` | 1 732 | 15 | `thread.updateTask` `dialog.openFolder` `app.createProjectFolder` `session.setConductorMode/setPlanMode/setGoalMode` `conductor.getCanvasByProjectPath/createCanvas` `recap.request/setActiveSession/onRecapResult` `getConductorPort` | SESSION / PROJECT / CONDUCTOR / DIALOG / PORT | 12 个独立通道,全是数据与端口,无窗口能力 | 自身 L224 |
| `components/chat/GoalStatusChip.tsx` | 155 | 1 | `modeState.get` | SESSION | 模式状态随会话流下发 | 自身 L71 |
| `components/chat/GroupRoomChatView.tsx` | 380 | 4 | `room.ensure/members/post` `groups.get` | SESSION | 房间是服务端概念 | 自身 L103 |
| `components/chat/MessageInput.tsx` | 2 601 | 13 | `settings.getMcpServers/setMcpServers/reloadMcp` `settingsDb.getJson` `skills.list` `recap.request` | SETTINGS / SKILL | 全部键值与列表读写 | 自身 L1467 |
| `components/chat/NewChatView.tsx` | 501 | 8 | `dialog.openFolder` `app.createProjectFolder/getDefaultWorkspace` `projects.getRecentFolders` `session.setPlanMode/setGoalMode` | DIALOG / PROJECT / SESSION | 同上 | 自身 L252 |
| `components/chat/TurnChangesCard.tsx` | 447 | 2 | `message.restoreFiles` `shell.showItemInFolder` | SESSION / SHELL | 回滚由宿主执行 | 自身 L201 |
| `components/chat/VoiceButton.tsx` | 183 | 1 | `voice` | VOICE | Web 有 `MediaRecorder`,可实现 | 自身 L38 |
| `components/chat/bot/send/scheduled-turns.ts` | 106 | 2 | `botTurn.cancelQueuedTurn` | STREAM | 取消排队轮次,纯数据 | 自身 L52 |
| `components/chat/bot/use-agent-dm-pair.ts` | 92 | 2 | `message.getBySession/onMessageNew` | SESSION / STREAM | 同上 | 自身 L46 |
| `components/chat/bot/use-bot-direct-transcript.ts` | 212 | 2 | `message.getBySession/onMessageNew` | SESSION / STREAM | 同上 | 自身 L121 |
| `components/chat/bot/use-room-transcript.ts` | 141 | 3 | `room.getTranscript` `message.onMessageNew` | SESSION / STREAM | 同上 | 自身 L79 |
| `components/chat/preview/ImagePreviewPanel.tsx` | 298 | 2 | `shell.openPath` | SHELL | 同 AttachmentPreviewModal | 自身 L181 |
| `components/chat/tools/rows/SessionToolRow.tsx` | 229 | 3 | `thread.getCard/cancelChild` `recap.setActiveSession` | SESSION | 纯数据 | 自身 L86 |
| `components/extensions/ExtensionsPage.tsx` | 1 176 | 8 | `files.browse/preview` `skills.list/setEnabled` | FS / SKILL | 文件树由宿主提供 | 自身 L114 |
| `components/extensions/SkillUploadDialog.tsx` | 185 | 1 | `skills.uploadSkill` | SKILL | 上传到本机目录,可改 multipart | 自身 L83 |
| `components/home/WelcomeView.tsx` | 376 | 4 | `dialog.openFolder` `app.createProjectFolder` | DIALOG / PROJECT | 同上 | 自身 L95 |
| `components/layout/app-shell.tsx` | 303 | 1 | `versions.platform` | — | Electron 进程版本,可用构建期常量或 UA 探测替代 | 自身 L93 |
| `components/layout/panels/CodeReviewPanel.tsx` | 1 085 | 1 | `files.preview` | FS | 读取本机文件内容 | 自身 L676 |
| `components/layout/panels/FilePreviewPanel.tsx` | 926 | 8 | `ide.getDefault/list/open` `files.preview` `shell.openPath/showItemInFolder` | FS / SHELL | 打开本机 IDE 与路径 | 自身 L342 |
| `components/layout/panels/FileTreePanel.tsx` | 485 | 4 | `files.browse/rename/delete` | FS | 文件写操作由宿主执行 | 自身 L271 |
| `components/layout/panels/RoomSettingsPanel.tsx` | 272 | 4 | `groups.get/update/delete` | SESSION | 房间 CRUD | 自身 L82 |
| `components/layout/panels/WorkflowPanel.tsx` | 1 176 | 1 | `workflow` | WORKFLOW | 服务端工作流 | 自身 L158 |
| `components/layout/sidebar/use-bot-contacts.ts` | 330 | 4 | `settingsDb.getJson/setJson` `groups.list` `configAgents.onBotsChanged` | SETTINGS / SESSION | 键值读写 + 订阅 | 自身 L57 |
| `components/onboarding/steps/ConfigStep.tsx` | 295 | 2 | `dialog` `dialog.openFolder` | DIALOG | 见 4.1 | 自身 L108 |
| `components/projects/ProjectsView.tsx` | 788 | 8 | `projects.delete/removeRecentFolder/getRecentFolders/update/register` `app.createProjectFolder` | PROJECT | 项目注册表 | 自身 L252 |
| `components/settings/BridgeSection.tsx` | 1 761 | 21 | `gateway.getStatus/getProxyStatus/allowlist*/reload/start/stop/testChannel/feishuQrBegin/feishuQrPoll` `weixin.getAccounts/updateAccount/deleteAccount` `net.weixinQrPoll/weixinQrStart/weixinQrCancel` `settingsDb.getAll/set` | GATEWAY / SETTINGS | 外部通道账号管理,全是数据 | 自身 L163 |
| `components/settings/HostToolPermissionCard.tsx` | 135 | 4 | `settings.getHostToolPermission/setHostToolPermission` | SETTINGS / PERM | 键值读写 | 自身 L44 |
| `components/settings/MCPSection.tsx` | 1 252 | 2 | `sse` `settings` | STREAM / SETTINGS | 同上 | 自身 L274 |
| `components/settings/ModelSelectionSection.tsx` | 383 | 6 | `vision.get/set` `settingsDb.getJson/setJson` `provider.getConfig` | VISION / SETTINGS / PROVIDER | 同上 | 自身 L135 |
| `components/settings/ProvidersSection.tsx` | 341 | 4 | `settingsDb.setJson` | SETTINGS | 同上 | 自身 L256 |
| `components/settings/SkillsSection.tsx` | 787 | 17 | `skills.*` `files.browse/preview` `config.get/set` `dialog.openFolder` | SKILL / FS / SETTINGS / DIALOG | 同上 | 自身 L249 |
| `components/settings/SupportSection.tsx` | 203 | 13 | `logger.getPath/export/exportToFile/clear` `app.getVersion` `dialog.openFolder` `shell.openPath` | LOG / SHELL | 日志导出在 Web 上退化为浏览器下载 | 自身 L34 |
| `components/settings/VoiceSection.tsx` | 661 | 10 | `voice.*` `provider.list` `getConfigPort` | VOICE / PROVIDER / PORT | 同上 | 自身 L122 |
| `components/settings/WakeAgentSection.tsx` | 164 | 2 | `settings` | SETTINGS | 同上 | 自身 L55 |
| `components/skills/SkillsView.tsx` | 410 | 4 | `skills.list/setEnabled` | SKILL | 同上 | 自身 L245 |
| `components/ui/CreateProjectDialog.tsx` | 441 | 1 | `dialog` | DIALOG | 见 4.1 | 自身 L186 |
| `components/usage/ProviderQuotaView.tsx` | 227 | 1 | `net.getProviderUsage` | NET | 查询供应商配额 | 自身 L61 |
| `conductor-host-provider.tsx` | 246 | 4 | `settingsDb.getJson/setJson/get/set` | SETTINGS | 键值读写 | 自身 L69 |
| `contexts/FontContext.tsx` | 68 | 2 | `settingsDb.getJson` | SETTINGS | 同上 | 自身 L21 |
| `hooks/useBangMode.ts` | 95 | 1 | `bang` | STREAM | 触发一次 bang turn | 自身 L43 |
| `hooks/useBashTaskOutput.ts` | 118 | 1 | `bashTasks.readOutput` | SESSION | 读取后台任务输出 | 自身 L72 |
| `hooks/useBashTasks.ts` | 47 | 1 | `onBashTaskUpdate` | STREAM | 事件订阅 | 自身 L27 |
| `hooks/useHookTasks.ts` | 47 | 1 | `onHookTaskUpdate` | HOOK / STREAM | 同上 | 自身 L27 |
| `hooks/useLinkOpener.ts` | 62 | 2 | `shell.openExternal` | SHELL | 浏览器有 `window.open` | 自身 L30 |
| `hooks/useNextStepSuggestions.ts` | 89 | 1 | `nextSteps` | STREAM | 随流下发 | 自身 L61 |
| `hooks/usePermissions.ts` | 305 | 1 | 权限查询 | PERM | 权限状态随流下发 | 自身 L249 |
| `hooks/useSettings.ts` | 387 | 13 | `settings.getMcpServers/setMcpServers` `vision.get/set` `settingsDb.setJson/getJson/set` | SETTINGS / VISION | 键值读写 | 自身 L283 |
| `hooks/useSlashCommands.ts` | 586 | 2 | `skills.list` | SKILL | 同上 | 自身 L477 |
| `hooks/useSubagentRuntimeStream.ts` | 197 | 1 | `getAgentServerPort` | PORT | 见 4.2 | 自身 L155 |
| `hooks/useTaskList.ts` | 56 | 1 | `thread.getTasks` | SESSION | 同上 | 自身 L31 |
| `lib/agent-http-client.ts` | 798 | 1 | `agentServer` | PORT | **这正是 Web 要用的那条通道本身** | 自身 L143 |
| `lib/agent-profile-ipc.ts` | 200 | 12 | `agentProfile.list/get/create/update/delete` `configAgents.listBots/create/update/delete/updateBotProfile` `thread.update` | SETTINGS / SESSION | 全是数据 CRUD | 自身 L61 |
| `lib/agent-sse-client.ts` | 887 | 3 | `getAgentServerPort` `getInterruptedSessions` | PORT / SESSION | SSE 客户端,Web 直接复用 | 自身 L80 |
| `lib/app-connection-ipc.ts` | 216 | 1 | `appConnection` | SETTINGS | 同上 | 自身 L63 |
| `lib/asset-url.ts` | 41 | 1 | `app` | — | 应用资源 URL,构建期常量可替代 | 自身 L27 |
| `lib/automation-ipc.ts` | 38 | 7 | `automation.listCrons/createCron/updateCron/deleteCron/runCron/listCronSessions/listTemplates` | AUTOMATION | 全是 CRUD | 自身 L11 |
| `lib/bot-channels-ipc.ts` | 85 | 1 | `botChannels` | SESSION | 同上(另有 1 处 type-only,未计入) | 自身 L35 |
| `lib/capability-management-ipc.ts` | 48 | 1 | `capabilityManagement` | SETTINGS | 同上 | 自身 L30 |
| `lib/chat-file-links.ts` | 432 | 2 | `shell.openPath` | SHELL | 同 AttachmentPreviewModal | 自身 L286 |
| `lib/commands/executors/info.ts` | 490 | 1 | `skills` | SKILL | 同上 | 自身 L447 |
| `lib/commands/executors/view.ts` | 301 | 1 | `dialog` | DIALOG | 见 4.1 | 自身 L198 |
| `lib/config-port-bus.ts` | 119 | 1 | `getConfigPort` | PORT | 见 4.2 | 自身 L32 |
| `lib/git-ipc.ts` | 108 | 10 | `git.status/review/reviewLatestTurn/reviewTurnHistory/reviewTurnDetail/reviewTurnByTurnId/reviewScoped/listCommits/listBranches/repoState` | GIT | **协议层完全没有 git 表述**,见第 6 节 | 自身 L56 |
| `lib/hooks-ipc.ts` | 53 | 2 | `hooks.overview/setDisabled` | HOOK | 全是数据 | 自身 L39 |
| `lib/import-ipc.ts` | 46 | 2 | `import` | IMP | 导入流程,可 multipart | 自身 L15 |
| `lib/ipc-client.ts` | 1 511 | 81 | `thread.*` `message.*` `session.*` `rollout.export` `provider.*` `agent.reinitProvider` `usage.summary` `projects.*` `app.getNoProjectWorkspace` | SESSION / PROVIDER / PROJECT | **单文件最大的耦合点**,73 处经 `!` 断言写成形如 `window.electronAPI!.thread!.list()` | 自身 L540 |
| `lib/notification.ts` | 212 | 2 | `notification.show` | NOTIFY | Web Notification API 可实现 | 自身 L78 |
| `lib/plugin-ipc.ts` | 141 | 1 | `plugin` | PLUGIN | 插件注册表 | 自身 L45 |
| `lib/project-actions.ts` | 300 | 4 | `sync.notifyThreadsChanged` `projects` `shell.openPath` | SESSION / PROJECT / SHELL | 同上 | 自身 L48 |
| `lib/providers/hooks/useDeleteProviderMutation.ts` | 88 | 1 | `agent.reinitProvider` | PROVIDER | 同上 | 自身 L65 |
| `lib/providers/hooks/useUpsertProviderMutation.ts` | 147 | 1 | `agent.reinitProvider` | PROVIDER | 同上 | 自身 L143 |
| `lib/recorder-ipc.ts` | 102 | 1 | `recorder` | RECORDER | 屏幕录制,浏览器有 `getDisplayMedia` | 自身 L36 |
| `lib/search-ipc.ts` | 45 | 1 | `search` | — | 全文检索,可 HTTP | 自身 L42 |
| `lib/sidebar-sections-ipc.ts` | 154 | 9 | `sidebarSections` | SETTINGS | 侧栏布局持久化 | 自身 L77 |
| `lib/stream-session-manager.ts` | 5 121 | 11 | `mailbox.list/cancel/promoteQueued` `session` `skills` `plugin.registry.list` `appConnection` | MAILBOX / SESSION / SKILL / PLUGIN | **全树 LOC 最大文件**,11 个通道全是数据 | 自身 L170 |
| `lib/useCapabilityManagementSnapshot.ts` | 93 | 1 | `sse` | STREAM | 同上 | 自身 L43 |
| `lib/voice/useVoiceInput.ts` | 211 | 8 | `voice.getConfig/transcribeChunk/start/stop/cancel` | VOICE | 语音转写走宿主模型 | 自身 L51 |
| `lib/workflow-ipc.ts` | 429 | 17 | `workflow` | WORKFLOW | 全部 CRUD + 流 | 自身 L39 |
| `lib/workflow-run-stream.ts` | 202 | 1 | `getAgentServerPort` | PORT | 见 4.2 | 自身 L62 |
| `orb/OrbApp.tsx` | 223 | 1 | `orb.showInput` | ORB | 悬浮球是桌面叠加层 | 自身 L156 |
| `orb/components/OrbBall.tsx` | 135 | 1 | `orb.showInput` | ORB | 同上 | 自身 L70 |
| `orb/components/OrbSessionCard.tsx` | 856 | 3 | `orb.chatConfig/setModel` `plugin.registry` | ORB / PLUGIN | 同上 | 自身 L499 |
| `orb/hooks/useOrbPointer.ts` | 54 | 1 | `orb.pointer` | ORB | 屏幕边缘拖拽,Web 无对应形态 | 自身 L35 |
| `orb/hooks/useOrbState.ts` | 410 | 8 | `orb.markSubmitting/submit/openResult/insertTab/collapse/resetConversation` | ORB | 同上 | 自身 L105 |
| `stores/conversation-store.ts` | 1 796 | 7 | `sync.notifyThreadsChanged/onThreadsChanged` `session.setPinned` | SESSION | 同上 | 自身 L308 |
| `stores/mailbox-store.ts` | 453 | 6 | `mailbox` | MAILBOX | 别名写法 `const electronAPI = window.electronAPI`,12 处 `mailbox.*` | 自身 L168 |
| `stores/projects-store.ts` | 112 | 1 | `projects` | PROJECT | 同上 | 自身 L78 |
| `packages/conductor/src/renderer/components/CanvasSelector.tsx` | 345 | 1 | `dialog.openFolder` | DIALOG | 见 4.1 | 自身 L65 |
| `packages/conductor/src/renderer/components/CanvasToolbar.tsx` | 488 | 1 | `orb.resetConversation` | ORB | 同上 | 自身 L321 |
| `packages/conductor/src/renderer/components/DocumentCreateDialog.tsx` | 179 | 3 | `files.browse` `session.setConductorMode` `dialog.openFile` | FS / DIALOG / SESSION | 同上 | 自身 L86 |
| `packages/conductor/src/renderer/database/project-database-ipc.ts` | 121 | 1 | `projectDatabase` | FS | 本机 SQLite,需宿主 | 自身 L26 |
| `packages/conductor/src/renderer/hooks/useCanvasCaptureRequest.ts` | 233 | 3 | `getConductorPort` | PORT / CONDUCTOR | 见 4.2 | 自身 L32 |
| `packages/conductor/src/renderer/hooks/useCanvasManagement.ts` | 151 | 2 | `getConductorPort` | PORT / CONDUCTOR | 同上 | 自身 L80 |
| `packages/conductor/src/renderer/ipc/conductor-bridge.ts` | 101 | 2 | `getConductorPort` | PORT / CONDUCTOR | 同上 | 自身 L14 |
| `packages/conductor/src/renderer/ipc/conductor-ipc.ts` | 308 | 1 | `conductor` | CONDUCTOR | 同上 | 自身 L14 |

### 4.1 `DIALOG` 在 Web 上的真实边界

交底把「目录选择」列为 B 类能力,我按此归类,但必须记下它的实际约束:
浏览器**不能**授予后端一个任意本机绝对路径。`<input type="file" webkitdirectory>`
给出的是 `File` 列表,不是一个路径。

因此 `DIALOG` 在 Web 上的实现只能是:**由本机宿主进程弹窗,浏览器不弹**。
这条通道能被 port 抽象接管,但 Web 客户端无法自己完成交互——这是 B 类里唯一一条
「接口可换、交互不可换」的通道。

### 4.2 `PORT` 在 Web 上的真实边界

`getAgentServerPort` / `getConfigPort` / `agentServer` 共 8 个引用分布在 6 个文件。
Web 客户端需要知道 Agent Server 在哪。这个值可以是构建期注入、配置文件或
相对同源路径——**可实现**,但它必须被显式定义,而不是继续从 preload 拿。

注意 `lib/agent-http-client.ts`(1 处)与 `lib/agent-sse-client.ts`(3 处)
本身就是 Web 要复用的那条通道的实现。它们归 B 类只是因为它们顺手读了端口,
不是因为它们本身不可移植。

---

## 5. 表 C —— electron-only

**15 个文件 / 57 引用**,占 115 的 13.0%、518 的 11.0%。

这些不需要消除,但必须写下来,否则下一次会有人重新讨论它们。

| 文件 | LOC | refs | 命中通道 | 不可替换的理由 |
| --- | --- | --- | --- | --- |
| `components/layout/TitleBar.tsx` | 275 | 8 | `appChrome.editCommand` `appChrome.zoom` `appChrome.toggleFullscreen` `versions.platform` `updater.check` `shell.openExternal` | 自绘标题栏 + 原生菜单 + 全屏,只有 `BrowserWindow` 有 `menuBar` 与 `setFullScreen` |
| `components/update/UpdateBadge.tsx` | 80 | 4 | `updater.onDownloading/onProgress/onReady/install` | `electron-updater` 在浏览器标签页里没有安装动作 |
| `components/layout/panels/AgentBrowserTab.tsx` | 223 | 2 | `browserWebview.registerWebview/unregisterWebview` | `<webview>` 是 Electron 专有标签,DOM 标准里没有 |
| `hooks/usePanel.ts` | 1 075 | 5 | `browserWebview.onOpenAgentTab/closeAgentBrowser/browserWebview` `terminal.kill` | 同上 + node-pty |
| `lib/terminal-ipc.ts` | 123 | 2 | `terminal.*` | 终端在 Electron 主进程跑 `node-pty`,浏览器没有 PTY 概念 |
| `components/layout/panels/BrowserPanel.tsx` | 898 | 1 | `browserCookie.clearData` | 清的是 Electron `session` 的 cookie store,浏览器的 cookie 不允许脚本清除 |
| `components/settings/ImportCookiesDialog.tsx` | 301 | 2 | `browserCookie.detectProfiles/importCookies` | 要读本机 Chrome 的 Cookies 文件,浏览器沙箱内做不到 |
| `components/settings/BrowserExtensionSection.tsx` | 516 | 7 | `browserExtension.getExtensionPath/approvePending/denyPending` `browserBackend.updateMode` `shell.openPath` | 装卸 Chromium 扩展需要 `session.loadExtension` + BrowserWindow 权限 |
| `components/browser/ExtensionInstallPrompt.tsx` | 597 | 4 | `browserExtension.getExtensionPath` `shell.openExternal/openPath` | 同上 |
| `hooks/useBrowserExtension.ts` | 347 | 1 | `browserExtension` | 同上 |
| `components/settings/BrowserAdvancedSection.tsx` | 265 | 2 | `browserCookie.clearData` `dialog.selectDownloadFolder` | 含 C 通道,整文件归 C |
| `hooks/useFileParsing.ts` | 61 | 1 | `electronWebUtils` | `electron.electronWebUtils.getPathForFile` 把 `File` 变成真实路径,只在 Electron 存在 |
| `components/automation/MacPermissionsCard.tsx` | 142 | 2 | `computerUsePermissions.get/openPane` | 打开 macOS TCC 设置面板,只能由本机进程 `open x-apple.systempreferences:` |
| `components/settings/GeneralSection.tsx` | 725 | 8 | `settings.getAutoStartStatus/setAutoStart` `dialog` `dialog.openFolder` | 登录项是 OS 级的(`app.setLoginItemSettings`),浏览器无对应物 |
| `components/layout/app-sidebar.tsx` | 2 105 | 8 | `system.setNativeThemeSource` `settingsDb.getJson` `botTurn.kickstart` `groups.create` `app.createProjectFolder` `projects.register` | 含 `nativeTheme` —— OS 级原生主题源,浏览器只有 `prefers-color-scheme` |

后 8 个文件同时含 B 通道,按 2 节的保守规则整文件归 C。若将来有人愿意为
`app-sidebar` 做拆分(把 `system.setNativeThemeSource` 隔离到一个 20 行的宿主适配文件),
它可以降级为 B——但**在拆分发生之前**,它归 C。

---

## 6. 计数与占比

| 类别 | 文件数 | 占 863 | 占 115 | 引用数 | 占 518 |
| --- | --- | --- | --- | --- | --- |
| A `presentation-only` | 658 | 76.2% | —(不在 115 内) | 0 | 0% |
| B `needs-host-capability` | 100 | 11.6% | 87.0% | 461 | 89.0% |
| C `electron-only` | 15 | 1.7% | 13.0% | 57 | 11.0% |
| 被上游拖住(自身干净、传递闭包不干净) | 90 | 10.4% | — | 0 | — |
| **合计** | **863** | **100%** | **115** | **518** | **100%** |

自洽校验:

- `100 + 15 = 115` ✓
- `461 + 57 = 518` ✓
- `658 + 100 + 15 + 90 = 863` ✓
- 另有 1 处 type-only 引用(`lib/bot-channels-ipc.ts:32`)按 G10 规则不计入,
  它所在的 `bot-channels-ipc.ts` 仍因 L35 的 1 处值引用落在 B 类。

---

## 7. 抽取顺序建议

### 7.1 为什么不能从 C 类开始

C 类是「不用搬」的一类。它的工作是**冻结**:写进本文件,在代码里加注释指向本文件,
让它不再被当成待办。搬 C 类不会让任何数字下降。

### 7.2 三步走

**第 0 步 — 冻结 C 类(0 代码改动)**

验收:这 15 个文件的文件头注释引用本文档;G11-0 数字不变(115/518)。
这一步的价值是让 87% 的讨论不再发生。

**第 1 步 — 搬 A 类第一批(38 文件 / 11 681 LOC)**

具体清单(全部零 electronAPI 引用、传递闭包干净、彼此零依赖):

```
apps/desktop/src/renderer/components/ui/AutoResizeTextarea.tsx
apps/desktop/src/renderer/components/ui/Button.tsx
apps/desktop/src/renderer/components/ui/DropdownMenu.tsx
apps/desktop/src/renderer/components/ui/HoverPopover.tsx
apps/desktop/src/renderer/components/ui/IconButton.tsx
apps/desktop/src/renderer/components/ui/Input.tsx
apps/desktop/src/renderer/components/ui/InputDialog.tsx
apps/desktop/src/renderer/components/ui/OptionPanel.tsx
apps/desktop/src/renderer/components/ui/Switch.tsx
apps/desktop/src/renderer/components/ui/toast.tsx
apps/desktop/src/renderer/components/ui/usePopoverPlacement.ts
apps/desktop/src/renderer/components/ui/page/EmptyState.tsx
apps/desktop/src/renderer/components/ui/page/Modal.tsx
apps/desktop/src/renderer/components/ui/page/PageCard.tsx
apps/desktop/src/renderer/components/ui/page/PageFrame.tsx
apps/desktop/src/renderer/components/ui/page/PageHeader.tsx
apps/desktop/src/renderer/components/ui/page/PageTabs.tsx
apps/desktop/src/renderer/components/ui/page/index.ts
apps/desktop/src/renderer/components/diff/CodeViewer.tsx
apps/desktop/src/renderer/components/diff/DiffViewer.tsx
apps/desktop/src/renderer/components/diff/SimpleDiffViewer.tsx
apps/desktop/src/renderer/components/diff/index.ts
apps/desktop/src/renderer/types/automation.ts
apps/desktop/src/renderer/types/bash-task.ts
apps/desktop/src/renderer/types/hook-task.ts
apps/desktop/src/renderer/types/hooks.ts
apps/desktop/src/renderer/types/index.ts
apps/desktop/src/renderer/types/message.ts
apps/desktop/src/renderer/types/mode-id.ts
apps/desktop/src/renderer/types/research.ts
apps/desktop/src/renderer/types/slash-command.ts
apps/desktop/src/renderer/types/stream.ts
apps/desktop/src/renderer/types/usage.ts
apps/desktop/src/renderer/i18n/en.ts
apps/desktop/src/renderer/i18n/index.ts
apps/desktop/src/renderer/i18n/zh.ts
apps/desktop/src/renderer/lib/diff/diff-utils.ts
apps/desktop/src/renderer/lib/errors/extractErrorMessage.ts
```

顺序:`types/` → `lib/diff` → `lib/errors` → `components/ui/` → `components/diff/` → `i18n/`
(依赖在前;`components/ui/` 内部 19 个文件彼此零 import,可任意次序)。

每步验收:

| 步 | 验收 |
| --- | --- |
| 搬完 `types/` | `npm run typecheck:all` 通过;G11-0 仍为 `115 files / 518 refs`(见 7.3) |
| 搬完 `components/ui/` | `typecheck:all` 通过;`npm run test` 中 renderer 相关测试通过;Electron 渲染器实机启动,UI 无回归 |
| 全部搬完 | `G11-0` 分母从 863 下降到约 825;**分子仍是 115** |

**第 2 步 — B 类,从「已有 HTTP/SSE 替身」的文件开始**

第一批候选(它们是 Web 本来就要用的通道,改完即两端共用):

```
apps/desktop/src/renderer/lib/agent-http-client.ts     (798 LOC,  1 ref)
apps/desktop/src/renderer/lib/agent-sse-client.ts      (887 LOC,  3 refs)
apps/desktop/src/renderer/lib/git-ipc.ts               (108 LOC, 10 refs)
apps/desktop/src/renderer/lib/ipc-client.ts           (1511 LOC, 81 refs)
apps/desktop/src/renderer/lib/stream-session-manager.ts(5121 LOC, 11 refs)
apps/desktop/src/renderer/stores/conversation-store.ts (1796 LOC,  7 refs)
apps/desktop/src/renderer/stores/mailbox-store.ts       (453 LOC,  6 refs)
```

`ipc-client.ts` 是单点收益最大的一个:81 个引用、14 个命名空间,全部是数据 CRUD。
拆成「`ClientPort` 接口 + Electron 实现 + HTTP 实现」之后,`ChatView`、`NewChatView`、
`MessageInput` 等下游文件的引用会跟着从「直接打 electronAPI」变成「打 port」,
这才开始真正压低红点。

第 2 步的验收是**数字验收**:每转一个文件,G11-0 的 `channels:` 行少一个文件。
这是本文能给出的唯一可自动检查的进度指标。

### 7.3 第 1 步不会让 G11-0 的红点下降——这一点必须说清楚

A 类文件**自身零 electronAPI 引用**。把它们从 `apps/desktop/src/renderer` 搬到共享包:

- 分子 `115 files / 518 refs`:**不变**。
- 分母 `863`:**下降**(被搬走的文件不再在桌面 renderer 的种子集合里)。
- G11-0 的通过条件是 `badFiles.size === 0`,与分母无关。

所以搬 A 类是一个**纯收益但不产生门禁进展**的动作。它降低的是「以后搬 B/C 时的
摩擦」,不是当前的债。A 类搬完后 G11-0 依然红。

---

## 8. 真验收标准:红 → 绿

### 8.1 诚实结论

**在当前形态下 G11-0 无法转绿。**

门禁的 `BROWSER_ENTRIES` 显式声明了
`{ rel: 'apps/desktop/src/renderer', kind: 'dir' }`
(`browser-closure-gate.mjs:85`)。Desktop renderer 是一个 Electron 渲染进程,
它**必须**调用 preload 注入的 `window.electronAPI`,否则它就不是 Electron 应用了。
只要这个条目还在,闭包里就必然有至少一个 `PropertyAccessExpression(.electronAPI)`,
`isBrowserRunnable` 就永远返回 `false`。

这不是可以靠努力工作解决的问题,这是一个**作用域决定**。

### 8.2 各阶段红点的真实下界

| 阶段 | 红点文件数 | 说明 |
| --- | --- | --- |
| 今天 | 115 | 实测 |
| A 类全搬完(658 文件) | **115** | 分子不变,只有分母降 |
| B 类全转 port(100 文件) | **15** | C 类是硬下界 |
| B 类全转 + C 类拆分出宿主壳层 | **0 或 ~15** | 取决于桌面壳层是否仍被声明为浏览器入口 |
| 把 `apps/desktop/src/renderer` 从 `BROWSER_ENTRIES` 移除,只留 `apps/web/src/main.tsx` | **0** | 此时门禁检查的是 Web 入口的闭包,不是桌面 renderer 的 |

**永不归零的红点**:在「桌面 renderer 仍是浏览器入口」的前提下,
`lib/terminal-ipc.ts`、`components/layout/TitleBar.tsx`、
`components/layout/panels/AgentBrowserTab.tsx`、`hooks/useFileParsing.ts`、
`components/automation/MacPermissionsCard.tsx`、`components/settings/GeneralSection.tsx`
这 6 个文件的耦合是它们作为 Electron 组件的**定义**,不是技术债。

### 8.3 可立即引入的、真的会下降的指标

G11-0 目前是二值的(115 或 0),没有中间刻度。建议补一条**预算门禁**,让进度可测量:

```
G11-B  preloadFiles <= 115        (今天 = 115,红)
      每次转一个 B 类文件,减 1
      下界 15(C 类),下界以下不允许再改
```

这条门禁的红点会真实下降,且下降量等于已完成的工作量。A 类搬运对它没有影响
(这本身就是应该说明的事实:门禁数字不覆盖 A 类)。

### 8.4 建议的最终作用域

把 G11-0 的语义改成「**Web 入口**的浏览器可运行性」,而不是「桌面 renderer 的浏览器可运行性」:

1. `BROWSER_ENTRIES` 只保留 `apps/web/src/main.tsx`(骨架落地后自动生效,
   `absentEntries` 机制已经为这一天准备好了)。
2. 桌面 renderer 的可移植性另开一条门禁,用**预算**形式(`preloadFiles <= 15`),
   不设 PASS/FAIL 的零目标。
3. 这样 G11-0 会在 `apps/web` 骨架落地当天第一次真正变绿——而且它是**有意义的绿**:
   它检查的是「Web 客户端引用的东西里有没有宿主耦合」。

---

## 9. 能力清单(B 类汇总)

### 9.1 协议层已有表述的部分

`packages/agent-protocol/src/capabilities.ts:47` 的 `RuntimeCapabilities` 覆盖:

| 已有字段 | 位置 | 对 B 类的覆盖 |
| --- | --- | --- |
| `transports: TransportKind`,含 `'http-sse'` | `capabilities.ts:121` | **部分覆盖**。会话/消息/线程/recap/room/groups/mailbox 的流式与状态传递已有协议载体 |
| `events.{durable,volatile,ephemeral}` + `eventTypes` | `capabilities.ts:74` / `:126` | **部分覆盖**。宿主要下发给 UI 的事件词汇表已有位置 |
| `catalog.connectorProviders` | `capabilities.ts:119` | **部分覆盖**。`BridgeSection` 的网关/微信/飞书账号属于 connector provider 概念 |
| `limits.maxEventBytes` | `capabilities.ts:31` | **部分覆盖**。文件预览/附件传输的大小约束已有表达 |
| `run.resume` / `run.cancel` / `permissions.actions` | `capabilities.ts:50` / `:100` | **部分覆盖**。`usePermissions`、取消排队轮次有对应 |

### 9.2 协议层完全没有表述的部分

`RuntimeCapabilities` 描述的是「**runtime 在一次 run 里能做什么**」,
它**不是 UI 宿主能力表**。B 类需要的下列能力,在整个 `agent-protocol` 里
没有任何字段可以容纳:

| 能力 | 涉及引用数 | 相关 B 类文件 |
| --- | --- | --- |
| 文件系统读写 / 树 / browse / rename / delete / preview | ~24 | `FileTreePanel` `FilePreviewPanel` `CodeReviewPanel` `ExtensionsPage` `SkillsSection` `chat-file-links` 等 |
| Git(status / diff / commits / branches / review) | 10 | `lib/git-ipc.ts` 独占 |
| 目录与文件选择对话框 | ~16 | `CronEditorModal` `ConfigStep` `CreateProjectDialog` `WelcomeView` `NewChatView` `ChatView` `CanvasSelector` `DocumentCreateDialog` `view.ts` 等 |
| 操作系统 shell(打开本机路径 / 外部链接 / 在文件夹中显示) | ~13 | `useLinkOpener` `SupportSection` `TurnChangesCard` `ImagePreviewPanel` `AttachmentPreviewModal` `project-actions` 等 |
| 设置键值存储(`settings` + `settingsDb` 双层) | ~48 | `useSettings` `MessageInput` `FontContext` `conductor-host-provider` `ProvidersSection` `ModelSelectionSection` 等 |
| 系统通知 | 3 | `lib/notification.ts` `App.tsx` |
| 剪贴板 | 0(经 `dialog` 间接) | — |
| 视觉模型开关 | 6 | `useSettings` `ModelSelectionSection` |
| 模型供应商 CRUD + reinit | ~14 | `ipc-client.ts` `agent-profile-ipc.ts` 两个 provider hook |
| 本机端口发现(`getAgentServerPort` / `getConfigPort` / `agentServer`) | 8 | 6 个文件,见 4.2 |
| 语音采集与转写 | ~20 | `useVoiceInput` `VoiceSection` `VoiceButton` |
| 屏幕录制 | 1 | `lib/recorder-ipc.ts` |
| 日志文件路径 / 导出 / 清空 | 13 | `SupportSection` |
| 会话与线程持久化(`thread` `message` `session` `rollout`) | ~150 | `ipc-client.ts` `conversation-store` `stream-session-manager` 及全部聊天视图 |
| 项目与工作区注册表 | ~20 | `ProjectsView` `project-actions` `projects-store` `NewChatView` |
| 定时任务 / 工作流 / 技能 / 钩子 / 收件箱 / 插件 / 画布端口 / Orb | ~90 | 各自 `lib/*-ipc.ts` 与对应面板 |

**结论:需要一份独立于 `RuntimeCapabilities` 的宿主能力契约**(例如
`HostCapabilities`,与 agent 的 `RuntimeCapabilities` 平级)。
否则 Web 客户端无法做能力协商,只能在每个调用点 try/catch feature detection,
那正是今天 `window.electronAPI?.` 已经在做的事,只是更分散。

---

## 10. 未确认 / 无把握的部分

1. **交底的 git 基线 14 条与实测 15 条不符**。实测为 9 个 `??` + 6 个 `M`。
   我开始前与结束后各测一次,两次一致;我没有「事故前」的快照,无法判断多出的
   那一条是何时出现的。完整状态见交付说明。

2. **闭包外还有 19 个文件 / 45 个引用**不在 863 闭包内(目录扫描 134/563
   vs 闭包 115/518)。我没有逐个查明这 19 个为何不可达。**若其中任何一个将来
   变为可达,G11-0 的数字会从 115 起跳**,本文的红点下界会相应上移。

3. **`<direct>` 别名引用的通道是推导出来的,不是 AST 直接读出的**。105 处引用
   写成 `const api = window.electronAPI` 再用 `api.x` 访问,我通过在同文件内
   解析别名变量再统计 `api.*` 得到通道名。若某个别名跨函数传递再传递,
   这条推导会漏。当前 115 个文件里没有发现跨函数传递的情形,但我没有穷举证明。

4. **B/C 边界是判断,不是 AST 事实**。15 个 C 文件里有 8 个同时含 B 通道
   (`app-sidebar` `GeneralSection` `BrowserAdvancedSection` `BrowserExtensionSection`
   `ExtensionInstallPrompt` `usePanel` `Terminal` 相关),我按「整文件归 C」的
   保守规则处理。这条规则可能被人推翻;推翻后 C 会缩到 7 个文件 / 约 25 个引用。

5. **LOC 口径**是文本按 `\n` 切分的行数,不是「非空非注释行」。
   `i18n/en.ts` 的 3 280 与 `i18n/zh.ts` 的 3 255 是对象字面量,行数不代表复杂度。

6. **`import-graph.mjs:62` 自己记录了一个盲区**:`SKIP_DIRS` 按**目录名**跳过
   `build` / `release` / `coverage`,不按路径锚定。若某个源码目录恰好叫这些名字,
   会被静默丢弃,而闭包与违规两半会同时漏掉它并自洽。当前树上没有这种情况,
   但我没有全树验证过。

7. **`apps/web` 的实际形态未定**。门禁报 `entries not on this tree yet:
   apps/web/src/main.tsx`。我假设 Web 走 HTTP/SSE 到本机 Agent Server
   (依据是 `RuntimeCapabilities.transports` 含 `'http-sse'` 与
   `ARCHITECTURE.md` 的三层分离),但没有独立验证过 apps/web 的设计。

8. **C 类「不需要消除」这个前提来自交底**,不是我从代码推出来的。
   如果产品上决定在 Web 上也提供终端能力,`terminal-ipc.ts` 和 `usePanel.ts`
   应当重新评估。

9. **我没有跑过一次真实的 UI 验证**。第 7.2 节的验收步骤里写了
   「Electron 渲染器实机启动」,但本次是纯测量,没有执行。
