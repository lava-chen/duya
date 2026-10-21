# 构建与打包

先按改动选择命令；workspace 构建顺序由 `scripts/build-packages.mjs` 维护。

| 改动或操作 | 命令 | 产物 / 用途 |
| --- | --- | --- |
| workspace 接口与依赖 | `npm run build:packages` | 按依赖顺序生成各包产物 |
| 新检出运行 TUI | `npm run build:cli-dev` | 准备 CLI 与 worker，再运行 `dev:tui` |
| 新检出运行 Web | Host：`npm run build:cli-dev` → `node packages/cli/bundle/cli.cjs serve`；Web：`npm run build:web-app` → `npm run web-app` | 两个终端启动本地 Host 与 loopback BFF；见 [Web 客户端说明](../../apps/web/README.md) |
| main / preload | `npm run build:electron` | 更新 `dist-electron/`，再启动 Electron 验证 |
| worker bundle | `npm run bundle:agent` | `packages/host/bundle/worker-entry.js` |
| CLI bundle | `npm run build:cli-bundle` | `packages/cli/bundle/cli.cjs` |
| 完整桌面构建 / E2E 前置 | `npm run electron:build` | worker、CLI、Gateway、Vite、Electron |

## 构建边界

- worker 入口是 `packages/cli/src/agent-worker-entry.ts`，输出归 Host；`packages/agent/` 不再承接新实现。
- worker 与 CLI 都是 CJS bundle；`tsc` 的 dist 不等价于可运行 CLI，不能假定提示词资产已复制。
- worker 外部依赖以 `scripts/build-agent-bundle.mjs` 为准，CLI 以 `scripts/build-cli-bundle.mjs` 为准。
  不在文档复制易过期清单，也不要把 CLI 的 externals 直接套给 worker。
- BashWorker 是独立入口，必须能在子进程中加载；提示词资产与原生模块也要验证真实打包路径。
- 生成目录沿用 `bundle/`；改变输出位置时同步打包资源映射和架构扫描规则。
- `packages/host/bundle/` 已跟踪；重建后检查其 diff，不手工合并生成内容。

## 打包验收

检查资源映射 `electron-builder.yml` 与 `scripts/after-pack.js`，确认 worker、CLI、BashWorker、提示词及原生依赖随包可加载。
从实际打包应用完成首轮聊天，核对 worker 就绪、工具结果与最终回答；文件存在或构建退出 0 不足以证明可用。

失败先查[排障表](footguns.md)，保留首个错误与失败进程。构建不替代类型检查，交付门禁见根 AGENTS。
