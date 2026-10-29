# Desktop 与 CLI 独立发布

状态：active · 负责人：Codex 会话 · 更新：2026-10-29
分支：`codex/product-release-split` · worktree：`/workspace/duya-product-releases` · base：`73710504850001e5645dc09844d7c69c4e7853d0`

## 目标与边界

Desktop 与 CLI/TUI 在同一仓库独立管理版本和发布流水线。Desktop 使用 `desktop/vX.Y.Z` 标签，CLI 使用 `cli/vX.Y.Z` 标签。新增 Codex 风格的 POSIX `install.sh`，下载自包含的 macOS/Linux CLI 包、校验 SHA-256，并以版本目录和原子软链接更新。Web 继续独立部署，本次不改其发布。

## 验收

- Desktop 发布 workflow 只匹配 `desktop/v*`；CLI workflow 只匹配 `cli/v*`。
- CLI workflow 为 macOS Intel/ARM 与 Linux x64/ARM 构建独立运行包并上传 GitHub Release。
- `install.sh` 支持 latest/指定版本、平台识别、校验、无 sudo 安装、原子切换和更新；不依赖预装 Node.js、npm 或 jq。
- 本任务不创建 tag、不执行正式发布。

## 进度

- [x] 拆分 Desktop workflow 触发并保留其打包与自动更新行为。
- [x] 增加 CLI 独立包构建与 Release workflow。
- [x] 增加安装器及其可从 CLI release tag 获取最新版本的解析逻辑。
- [x] 静态审阅变更，记录验证范围与未覆盖的实机安装验收。

## 发现与决策

- 现有 `packages/cli/bundle/cli.cjs` 将 `better-sqlite3`、`blessed` 等列为外部依赖，Host worker 也外置 `better-sqlite3` 与 `esbuild`；CLI 包要附带 Node runtime 与对应 ABI 的运行依赖，不能只上传 `.cjs`。
- Desktop 的 electron-builder GitHub provider 支持 `tagNamePrefix`；可用 `desktop/v` 与 `cli/v` 保持发布 tag 隔离。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base `7371050`; 尚无改动 | Linux / Node 22 | 只读检查 workflow、CLI bundle 与 Electron 发布配置 | 0 | `release.yml`、`packages/cli/package.json`、两个 bundle 脚本 |
| dirty worktree | Linux / Node 24.19 | `sh -n install.sh`; `node --check scripts/package-cli-release.mjs`; YAML 解析三个 workflow 与 electron-builder 配置；`git diff --check` | 0 | shell 与 JS 语法、YAML 结构通过；未跑构建或测试套件 |

## 接续 / 结果

已实现，尚未提交或推送。CLI 包构建、macOS/Linux 原生依赖和真机安装尚未执行；需要 PR CI 验证构建，再由首次 CLI 发布进行实机验收。未创建 tag 或 Release。
