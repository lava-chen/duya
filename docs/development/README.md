# Development Docs

专题文档。`AGENTS.md` 是地图和契约，这里是可执行的细节。

| 文件 | 什么时候读 |
| --- | --- |
| [worktree.md](./worktree.md) | 建/拆 worktree、并行开发、误删恢复 |
| [engineering-loop.md](./engineering-loop.md) | 多 Agent 闭环：Goal → Task → Run → Worktree → PR → Verification → Integration |
| [testing.md](./testing.md) | 三层测试策略、IPC mock 写法、worktree 里怎么跑测试 |
| [build.md](./build.md) | Worker Bundle / CLI bundle 规则、打包前检查 |
| [logging.md](./logging.md) | 结构化 logger 规范 |
| [release.md](./release.md) | 打 tag 的推荐流程与版本号规则 |
| [code-review.md](./code-review.md) | Code Review 面板的边界与验证方式 |
| [footguns.md](./footguns.md) | 已经踩过并且还会再踩的坑 |

其余文档在别处：`docs/exec-plans/`（执行计划）、`docs/design-docs/`（设计决策）、
`docs/product-specs/`（产品规格）、`ARCHITECTURE.md`（架构与数据流）。
