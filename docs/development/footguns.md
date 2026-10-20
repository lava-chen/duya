# 按症状排障

只保留定位动作；常驻约束见根 AGENTS，历史版本与测量不作当前基线。

| 症状 | 首先检查 |
| --- | --- |
| main / preload 改动不生效 | 重跑 `npm run build:electron`，确认启动的是当前检出的产物 |
| 新 worktree 的 TUI 报 MODULE_NOT_FOUND | 先 `npm run build:cli-dev`；`dev:tui` 不会自动构建 |
| workspace 类型像来自另一个分支 | 检查 junction overlay 与当前检出 dist，见 [worktree](worktree.md)；不要在共享链接上安装依赖 |
| UI 测试看到旧页面或一直找不到元素 | 核对 Vite 服务所属检出、renderer URL、应用挂载与 onboarding 状态；桥对象存在不等于 UI 就绪 |
| Electron 可执行文件缺失 | 查 `scripts/electron-binary.mjs` 与安装输出；冷环境可能需要下载，不伪造 path.txt |
| SQLite 提示 NODE_MODULE_VERSION 不匹配 | 先看实际加载的绑定；确认不匹配后分别用 `npm run rebuild:node` 或 `npm run rebuild` |
| 打包后工具或提示词无法加载 | 核对独立 worker、外部依赖和资源映射，见 [构建](build.md) |
| Web BFF 新路由拒绝或越权 | 检查 `apps/web/src/server/web-bff.ts` 的 origin / CSRF 守卫 |
| worktree 回收或恢复异常 | 停止写入并保留现存成果，按 [worktree](worktree.md)对账；不追加递归删除或整树恢复 |

保留首个可执行错误、进程、命令和环境；错误未复现前，不通过改断言、加 baseline 或反复重建掩盖原因。
