# Plan 573 — 内置浏览器内核升级（Cookie/密码/历史/缩放查找）

> 状态背景：2026-09-27 对参考产品（agentic browser）新标签页与菜单做能力盘点后立项。
> 盘点结论：duya 内置浏览器 cookie 导入在合规路线上正确但不覆盖 macOS；密码管理、
> 浏览历史完全缺失；截图菜单 11 项中全有的仅 3 项（截图/清数据/设置）。

## 目标

把内置浏览器（`<webview>` + `persist:duya-local-browser` 分区 + CDP daemon）的
数据能力与日常浏览体验补到"可用浏览器"基线，全部走官方合规路线（不绕 App-Bound、
不解密密码库、密码走 safeStorage vault）。

## 现状证据（2026-09-27 代码盘点）

- Cookie 导入仅 Windows：`electron/services/browser/cookie-importer.ts` 的
  `browserUserDataPath` 依赖 `LOCALAPPDATA`；macOS/ Linux 返回 null。
- v20 App-Bound 刻意不绕过，降级走 duya 桥扩展 live export（正确，保留）。
- DPAPI 解密经 `powershell.exe` 子进程（`unprotectDpapi`）——工程瑕疵，非安全洞。
- 密码/autofill：全库无任何实现。浏览历史：无 history 表、无历史页、无 top sites。
- 缩放 / 页内查找 / 打印 / 设备工具栏：无。
- 清除浏览数据：`browser:clear-browser-data` 一键全清，无分项。
- 下载：`will-download` 落盘 + 设置页路径，无管理器 UI。

## Phases

### Phase 1 — macOS Cookie 导入（P0）代码+单测落地

- [x] `browserUserDataPath` 支持 darwin：`~/Library/Application Support/Google/Chrome`
      与 `.../Microsoft Edge`
- [x] Cookie 文件路径兼容 `Network/Cookies` 与旧版 `Cookies`（macOS 双布局探测）
- [x] macOS 解密链：`security find-generic-password -w -s "<Browser> Safe Storage"`
      → PBKDF2(secret, 'saltysalt', 1003, 16, sha1) → AES-128-CBC（IV=16×0x20）
      → PKCS#7 去填充；Keychain 拒绝时降级 Chromium 硬编码默认值 'peanuts' + warn
- [x] `decryptCookieValue` 增加 cipher 模式参数（默认 `aes-256-gcm` 保持既有契约）；
      非 Windows 平台不再落入 DPAPI 分支
- [x] 设置页平台提示（Keychain 授权弹窗说明 / 平台不支持），zh + en i18n
- [x] 单测：macOS v10 解密 round-trip、PKCS#7 非法填充、默认契约不回归
- [ ] 人工冒烟（需真机 Chrome 登录态 + Keychain 弹窗授权）：导入计数 > 0，登录态生效

### Phase 2 — 缩放 + 页内查找（P1）代码落地

- [x] `BrowserPanel` 键盘缩放：`Cmd/Ctrl + =` / `-` / `0`，zoomFactor ∈ [0.3, 3]，
      状态条显示百分比 1.5s 自动消退
- [x] Guest 焦点下的快捷键经 webview `before-input-event` 拦截（guest 键盘事件
      不会冒泡到 host renderer，普通 onKeyDown 收不到）
- [x] 页内查找：`Cmd/Ctrl + F` 唤出查找条（webview `findInPage` /
      `stopFindInPage('clearSelection')`），Enter / Shift+Enter 前后向，
      `found-in-page` 事件回显 N/M 计数，Esc 关闭
- [x] 样式落在 `src/styles/office-browser.css`（沿用 `.browser-panel-*` 命名）
- [ ] Playwright / Electron 真机验证待人工

### Phase 3 — 浏览历史 + 新标签页推荐（P1，未开工）

- [ ] core-db history 表（migration）+ 记录挂点（webview did-navigate 主框架）
- [ ] `browser:history-*` IPC + preload + 渲染层历史视图
- [ ] 推荐数据源：域名聚合 + 标题可读性过滤（排除 error/内部路径）+
      统一截断策略——修复参考产品里 "Error 页上门面" 的同类问题
- 依赖：core-db（plan 326/328 已收编）；建议先立独立 plan 细化

### Phase 4 — 密码管理（P2，未开工）

- [ ] 路线：`safeStorage` 自建 vault（复用 plan 312 token vault 地基）或 OS autofill
- [ ] 明确不做：解密 Chrome `Login Data`（v20 App-Bound 后已被官方封堵，
      且非密码管理器正道）
- [ ] 表结构 / IPC / 设置 UI / 导入（CSV 显式导出路线）

### Phase 5 — 清数据分项 + 下载管理器（P2，未开工）

- [ ] 清除浏览数据：时间范围 + 数据类型勾选（对齐 Chrome ClearBrowsingData 弹窗）
- [ ] 下载管理器：下载列表 / 进度 / 打开与删除，数据挂 core-db 或内存态

## Gates

- `npx vitest run electron/services/browser/__tests__/cookie-importer.test.ts`
- `npm run typecheck:web`（root tsconfig 覆盖 `electron/**` 与 `src/**`，本次改动面全覆盖）
- 2026-09-27 typecheck:web 实测：HEAD 上存在 12 个与本 plan 无关的存量错误
  （`src/hooks/useGitRepo.ts` 11 个：`GitBranchRef`/`GitRepositoryState` 导出缺失 +
  implicit any；`electron/logging/logger.ts` 1 个：`LogContextValue` 悬空）。本 plan
  改动前后错误集完全一致（stash 对照验证），未新增任何错误；`typecheck:all` 前置
  门禁在 dev/mac HEAD 上即红，修复归口另立，不在本 plan 内混入。
- Phase 1/2 的真机冒烟（Keychain 弹窗、guest 快捷键）需要打包后的 Electron 环境，待人工

## 决策记录

- 2026-09-27: decryptCookieValue 采用可选 mode 参数而非 breaking 签名变更，
  既有测试与调用点零改动。
- 2026-09-27: Phase 2 快捷键拦截选 webview `before-input-event` 而非 host keydown——
  `<webview>` guest 的键盘事件不冒泡到 host，host keydown 只覆盖 URL 栏聚焦场景，
  两条路都接，成本可控。
- 2026-09-27: 密码管理按官方共识走 vault/autofill，不做 Login Data 解密（Phase 4 前置决策）。
