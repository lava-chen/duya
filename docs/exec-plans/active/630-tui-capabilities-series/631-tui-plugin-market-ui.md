# 631 TUI 插件市场管理界面

状态：in review（PR #601 · draft · base 叠在 #598） · 负责人：codex（`codex/tui-plugin-management`） · 更新：2026-11-03
分支：`codex/tui-plugin-management` · worktree：`.claude/worktrees/tui-plugin-management` · base：`c8c78380`（`codex/tui-plugin-display-name` / #598，叠加） · 当前 head：`6640ccca`（已推送） · owner：codex

原计划写的两个阻塞都已解除：630a 面板原语 #512 于 2026-10-27 合入 master，通用 TOML 命名空间写侧（`writeConfigNamespace`）随 #514 同批合入。本切片不再等任何分支。

## 目标与边界

用户在 TUI 输入 `/plugin` 得到多 tab 界面：Discover（全市场浏览，`/` 搜索、空格多选、`i` 批量安装、Enter 进安装范围菜单）、Installed（按 user/project 分组、状态图标、Enable/Disable/Update/Uninstall）、Marketplaces（列表 + `a` 添加源，接受 `owner/repo`、git URL、本地目录/json）、Errors。所有变更走 Host HTTP，不依赖 Electron 进程。

允许修改：`packages/host/src/`（新写路由）、`packages/plugin-core/src/`（安装执行上收）、`packages/cli/src/tui/slash/plugin.ts` 及面板、`packages/command-catalog/src/index.ts`（`/plugin` 的 surfaces/description 已存在，只校准文案）。
本次不处理：插件内 MCP 子项配置向导、userConfig 询问流、市场信任策略/blocklist、Errors tab 可先降级为结果行文本。

关联：[系列](README.md)；依赖 630a 面板原语；安装目录发现逻辑见 443（[2026-10-25 插件安装路径](../2026-10-25-host-plugin-install-path.md)已合并）。

## 现状事实（2026-10-26 核对）

下面是开工前的只读快照，行号对应 base `d80ca3c6`；本切片落地后 `packages/cli/src/tui/slash/plugin.ts` 与 Desktop `plugins/marketplace/*` 已被改写，行号不再成立，保留原文是为了记下当初的判断依据。

- 持久化真源是 `config.toml [plugins]`，key `<id>@<marketplace>`，值只存 `enabled` 用户意图（`packages/host/src/local-plugin-registry-api.ts:1-30`，plan 334 决策 11）；installPath 由磁盘探测派生。
- Host 对外只有只读 `GET /v1/local/plugins`（`packages/host/src/http-server.ts:1695`）。
- 变更能力全在 Desktop Electron IPC：`installFromCatalog` / `installFromPath` / `setEnabled` / `remove`（`apps/desktop/src/main/plugins/PluginManager.ts:90` 起）、marketplace add/remove/refresh（`apps/desktop/src/main/ipc/plugin-handlers.ts:251-286`，Plan 455）。marketplace 缓存目录与 git clone 执行也在 Desktop 的 `plugins/marketplace/manager.ts`。
- `plugin-core` 只有源解析（`parseMarketplaceSource`：git URL / `owner/repo` 简写 / 本地目录，https-only 校验，`packages/plugin-core/src/marketplace/source-parse.ts:50-138`），无 clone/安装执行。
- TUI `/plugin` 现为纯列表（`packages/cli/src/tui/slash/plugin.ts:270` showEntries）。

## 验收

- 无 Electron 在场：`duya tui` 内添加一个本地目录市场 + 一个 `owner/repo` git 市场，浏览、安装、禁用、卸载各走通，`config.toml [plugins]` 结果与 Desktop 设置面板读数一致；Desktop 打开后能看到 TUI 装的插件。
- 安装后退出面板提示 reload/重启会话生效，不在面板内热生效。
- `typecheck:all`、`architecture:check`、`npm test -- packages/plugin-core packages/host packages/cli` 相对基线零新增失败；架构门禁无新增违规（host/plugin 相关 managed 模块零容忍）。

## 进度

- [x] 安装执行从 Desktop 上收 `plugin-core`（clone、缓存目录、install/uninstall 纯函数化），Desktop 改调用、行为不变。
- [x] Host 写路由：marketplace add/remove/refresh、plugin install/setEnabled/remove；边界 schema 用现有 zod helper。
- [x] TUI 三 tab 面板（Installed/Discover/Marketplaces）基于 630a 原语。
- [x] catalog 文案校准 + 双端平价测试更新。

落地范围与原计划有三处偏离，都是对照合并后的 630a 原语实测得出的，不是省工：

1. **四个 tab 变三个**。计划里的 Errors tab 按其自身许可降级为结果行文本：写失败经 `printError` 落在 transcript，面板不复制一份错误列表。
2. **`/` 搜索与空格多选、`i` 批量安装没有照搬**。合并后的 `RichPanelController` 在内容焦点下把每个可打印字符喂给行过滤器（`packages/cli/src/tui/window.ts:777-781`），空格与字母在列表里不是 free chord。所以批量安装改成一个都不做，单行动词换成：`Tab`/`Enter` 在列表内生效，`i`/`u`/`t`/`r`/`x` 在 tab strip 内生效。
3. **`Tab` 需要面板原语开一个口子**。630a 合入版把 `Tab` 无条件当作 tab 切换（`packages/cli/src/tui/window.ts` 的 `tab` 分支），而 codex 的开关手势正压在 `Tab` 上。改法是 opt-in：列表焦点下、且该 tab 显式绑定了 `tab` 行动作时，`Tab` 才归该行；strip 焦点下与所有未绑定 `tab` 的既有面板行为不变。最终只有 Installed 认领它——Discover 上按 `Tab` 就装插件，是一个用户没打算做的写；那里的动词留给 `Enter`。`Shift+Tab` 不受影响，任何列表都出不去。

## 发现与决策

- 「安装目录在 Electron userData」是独立 Host 的历史妥协（registry-api 头注释）。**写根的选择最终没有按计划直接落到 data root**：`resolvePluginWriteRoot`（`packages/host/src/plugin-install-paths.ts`）按「显式 config root → CLI 的 `USER_DATA_OVERRIDE_ENV` → 已存在的平台 `userData` → config root」定一个答案。理由是读侧探测多个根、写侧只能选一个——写到 data root 而 Desktop 仍从 `userData` 列，结果是 TUI 装了插件而 Desktop 自己的页面说没有。
- enabled 与 install 分离的既有模型正好对应参考实现的「installed 记录 + settings 级联 enabled」，不需要新配置文件。
- **上收成本实测比计划预估低**：Desktop 侧 `apps/desktop/src/main/plugins/marketplace/git-source.ts` 只有 `getMarketplacesCacheRoot()` 一处 `import { app } from 'electron'`，其余每个函数都已带 `rootOverride?: string` 形参（`:30/:35/:195/:250/:275/:300/:358`）；`manifest.ts` 与 `manager.ts` 不引 electron。也就是说搬动主要是换 root getter，不是重写调用链。
- ~~**Host `[plugins]` / `[marketplaces]` 写路由被 PR #514 阻塞**~~（2026-10-26 核对，推翻「只被 630a 阻塞」的原假设）：当时 master 的 `packages/host/src/config-agents/config-file.ts` 外科手术 TOML 编辑器对 `[agents]` 硬编码，通用化的 `readConfigNamespace` / `editConfigNamespace` / `verifyConfigNamespace` / `writeConfigNamespace` 只存在于未合并分支 `codex/632-provider-write-routes`（#514）。631 不把分支叠在 632 上——那会把 631 的提交带进 #514 的 diff，评审面失控。**2026-10-27 #514 与 #512 合入 master，本条阻塞解除**；本切片直接消费 `writeConfigNamespace`（外科编辑 + 重解析校验 + 原子写），revision 取 `sha256(raw).slice(0,16)` 做乐观并发，未走「先做不受阻塞的两项」的分批路径。
- 因此第一项（安装执行上收 `plugin-core`）与第三项（TUI 面板）都不受该阻塞，可先行；只有第二项「Host 写路由」等 #514 合入。
- **上收时保持 Desktop 语义，不顺手修 Desktop 的历史行为**。两处实测到的既有语义被原样搬进 `plugin-core` 并写成测试，而不是在本 PR 里改：
  - `listCachedVersions` 按字典序排缓存目录，`1.10.0` 排在 `1.2.0` 之前（Desktop `plugins/cache/layout.ts` 一直如此）。这是真实缺陷，但改它等于改 Desktop「取最新版本」的选择结果，应独立立项。
  - `ensurePluginRoots` 只创建 `installed` / `staging` / `plugins-data`，不创建 `plugins/cache`；缓存根由 marketplace clone 路径按需创建。测试原先断言四者全建，是断言错了，不是实现错了。
- `readMarketplaceManifest(dir)` 对不存在的目录抛 ENOENT（`resolveContainedPath` → `fs.realpathSync`），调用方必须先探 `existsSync`；refresh 的「目录已消失」结局据此写成 `local marketplace directory is gone` 文本，而不是崩溃。
- Host 的可选写面按仓库惯例回答带名字的 404：没有可写插件根的 Host 用 `plugin_management_api_unavailable`，让 TUI 把「这台 Host 不能答」和「这台机器没有插件」分开——后者是空列表，前者降级为只读清单并写明降级原因。
- `#readJson` 已把返回值窄化成 `Record<string, unknown> | null`，新路由里再加 `isRecord(body)` 是死代码；第一次写时加了，已删。
- 面板的「详情」压在行上（`WindowItem.detail`）而不是另开一页：dock 同时只持有一个窗口，详情窗口会抢走 dock 并让 `showRichPanel` 的 promise 提前 settle，用户返回时面板已经没了。因此 `Enter` 留给动词（Installed 切换、Discover 安装、Marketplaces 刷新），解释文本随选中行显示在列表下方。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6`（只读核对，未改动） | win32 / Node 24 | grep `electron` / `rootOverride` 于 `apps/desktop/src/main/plugins/marketplace/*`；读 `packages/host/src/config-agents/config-file.ts` 与 #514 diff | — | 「现状事实」与「发现与决策」第 3、4 条的证据来源 |
| `c8c78380` + 本任务工作区改动（提交后为 `e8bef1e2..b4d80d88`） | win32 / Node 24.18 / vitest 5.0.5 | `npx vitest run packages/cli/src/tui/slash/__tests__/{plugin,interactive-list}.test.ts packages/cli/src/tui/__tests__/{tui-rich-panel,plugin-candidates}.test.ts` | 0 · 4 files / 49 tests passed | 面板 20 例、富面板 21 例（含 3 条新增 `Tab` 开口用例） |
| 同上 | 同上 | `npx vitest run packages/cli` | 1 failed / 136 files, 1666 passed / 1 expected fail | 唯一失败 `packages/cli/src/tui/slash/__tests__/presets.test.ts:20`（`statSync(file).mode & 0o077` 期望 0，实得 54）。基线判定：本机 `node -e` 以 `mode:0o600` 写临时文件后同一表达式恒为 `0o66`（NTFS 继承 ACL）；`presets.ts` 与 `presets.test.ts` 相对 base blob 相同（`git hash-object` == `git rev-parse HEAD:`），本任务未触碰 → 环境既有失败，非回归 |
| 同上 | 同上 | `npx vitest run packages/plugin-core/tests packages/host/tests/plugin-management-http.test.ts packages/host/tests/local-plugin` | 0 · 23 files / 413 tests passed | 含新增 `plugin-core/tests/install-and-marketplace.test.ts` 22 例与 `host/tests/plugin-management-http.test.ts` 12 例（离线 fixture，不联网） |
| 同上 | 同上 | `npx vitest run apps/desktop/src/main/plugins` | 0 · 19 files / 197 tests passed | 安装执行上收后 Desktop 侧回归不变 |
| 同上 | 同上 | `npx vitest run packages/command-catalog` | 0 · 30 passed | catalog 文案校准未破平价测试 |
| 同上 | 同上 | `npm run typecheck:all`（含 `check:encoding` / `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` / `check:packaged-artifacts` / `build:packages` 22 包） | 0 | 全链绿；其后又跑 `npx tsc -b packages/cli --force` = 0，覆盖最后一次 `plugin.ts` 文案改动 |
| 同上 | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；`tolerated (baselined) 3122`；另有提示 `20 baseline fingerprint(s) no longer triggered. Re-record with --write to shrink the debt.`——上收后 Host 不再走 Desktop 的旧边界，属债务减少，本 PR 不重记 baseline |
| 同上 | 同上 | `npm run bundle:worker` | 0 | `worker-entry.js` 4.57 MB、`BashTool/BashWorker.js` 49.96 KB；`packages/host/bundle/{worker-entry.js,BashTool/BashWorker.js,package.json,worker-metafile.json}` 4 文件在全部 bundle 输入提交完成后重跑一次，单独 `chore(host)` 提交（沿用 #598 的 `6b584883` 先例） |
| `b4d80d88`（bundle 提交后） | 同上 | `npm run bundle:verify` | 0 | `FRESH 0/1077 bundle inputs changed after the bundle commit`；在 bundle 提交之前同一命令报 `STALE 6/1077`（6 个输入还是未提交的工作区改动），脚本按 bundle 的提交时点比对，先提交源码再提交 bundle 即闭合 |
| `6640ccca`（全部提交完成，工作树干净） | 同上 | `npm run check:encoding` · `npm run architecture:check` · `npm run bundle:verify` · `npx vitest run` 六个本任务套件 + `apps/desktop/src/main/plugins` + `packages/command-catalog` | 0 / 0 / 0 / 0 | `no new violations (11 known)`；`OK — no new boundary violations`；`FRESH`；24 files / 302 tests passed（面板 20 + 富面板 21 + Host 写面 12 + plugin-core 22 + catalog 30 + Desktop 插件 197） |
| 同上 | GitHub | `git push -u origin codex/tui-plugin-management` · `gh pr create --draft --base codex/tui-plugin-display-name` | 0 | [PR #601](https://github.com/lava-chen/duya/pull/601) head `6640ccca`；`gh pr checks 601` = `no checks reported`，原因是 `test.yml` 的 `pull_request` 只监听 `branches: [master]`，stacked base 不触发 run——已在 PR 评论写明，本 PR 的绿目前只到本机门禁 |

`packages/capabilities/src/ModuleTool/inline-content.ts` 出现在 `git status` 里但工作区 blob 与 base 相同（纯 CRLF/stat 假象），未随本任务提交。

## 接续 / 结果

已实现并提交在 `codex/tui-plugin-management`（base `c8c78380`）：
`e8bef1e2` plugin-core 上收 · `f84b5601` Host 插件管理写面 · `31a84fd9` 面板 `Tab` 开口 · `d751264b` `/plugin` 三 tab 面板 · `b4d80d88` worker bundle 重建 · `6640ccca` 本计划更新。
PR：**#601**（draft，base `codex/tui-plugin-display-name`，即 #598）。
已验证：见上表；离线文件级测试覆盖 Host 写面与面板交互，未跑真机。

未闭合的验收项（本 PR 不声称已完成）：
- 「无 Electron 在场，`duya tui` 内添加本地目录市场 + `owner/repo` git 市场并装/禁/卸一轮，Desktop 打开后能看到 TUI 装的插件」——需要一次真机跑，面板与写面都只被离线测试覆盖过。
- 「安装后退出面板提示 reload/重启会话生效」——未实现：面板 repaint，但不提示重启会话。要加就在 `showRichPanel` 的 promise settle 之后按「本次是否发生过成功的 install/uninstall」给一条 `printNotice`。

下一步：等 #598 合入后把本 PR 的 base 改回 `master`（`gh pr edit 601 --base master`），那时才有 CI 信号——`test.yml` 的 `pull_request` 只监听 `master`，叠在 #598 上的当前形态不排 run，已在 PR 里注明。真机验收两项仍未闭合（见上）。
阻塞：无（PR 是 draft，验收未闭合与 CI 未跑都不构成合并条件）。检出 `.claude/worktrees/631-plugin-host` 是本计划早期分配、从未使用的一个，与本任务的 `.claude/worktrees/tui-plugin-management` 无关，可在确认无 owner 后回收。
