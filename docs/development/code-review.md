# Code Review 面板

修改此功能前核对以下产品与安全契约；它与开发时的 PR review 是两件事。

## 契约

- 比较当前工作区的 `HEAD` 与工作树，保持只读；不增加 stage、commit、push 或 reset 控件。
- diff 请求只接受已变更的项目相对路径；拒绝绝对路径、穿越、`.git` 元数据及逃出工作区的未跟踪符号链接。
- 输出限制为 1 MB，超限时保留安全的部分输出；不要为展示完整内容绕过上限。
- 默认 unified，展开后可 split；保留过滤、折叠、换行及文件转交聊天的能力。
- 行评论按工作区隔离，发送时由 composer 读取，避免跨工作区串入。

## 实现入口

| 层 | 入口 |
| --- | --- |
| 面板与注册 | `packages/ui/src/components/layout/panels/CodeReviewPanel.tsx`、同目录 `registry.ts` |
| renderer 契约 | `packages/ui/src/lib/git-ipc.ts`、`code-comment-store.ts` |
| IPC 边界 | `apps/desktop/src/preload/index.ts`、`apps/desktop/src/main/ipc/git-handlers.ts` |

核对 `git:review` / `git:review-diff` 的两端形状；修改形状时一起更新。
验证 diff parser 与 IPC 测试，再在真实 Electron 中操作面板、行评论和聊天转交；浏览器预览无法证明 preload 接线。
