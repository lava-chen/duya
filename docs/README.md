# 文档地图

从本次任务进入，只读需要的分支。当前实现由源码与可复跑证据确认，计划描述目标。

| 要解决的问题 | 位置 | 维护内容 |
| --- | --- | --- |
| agent 开工规则 | [根 AGENTS.md](../AGENTS.md)、子树 AGENTS.md | 全仓约束、局部例外 |
| 系统如何工作 | [ARCHITECTURE.md](../ARCHITECTURE.md)、[ARCHITECTURE_MAP.md](../ARCHITECTURE_MAP.md) | 职责、数据流、定位入口 |
| 本次做什么、接着做什么 | [exec-plans/](exec-plans/README.md) | 任务、验收、证据、接续 |
| 开发操作怎么做 | [development/](development/README.md) | 构建、测试、worktree、发布 |
| 为什么这样设计 | [design-docs/](design-docs/README.md) | 决策、理由、替代方案 |
| 产品应该如何表现 | [product-specs/](product-specs/index.md) | 用户场景、行为、验收 |
| 外部方案如何工作 | [references/](references/README.md) | 提炼后的一手依据、版本与适用范围 |
| 已发布什么 | [release-notes/](release-notes/) | 对应版本的用户可见变化 |

## 历史与本地材料

- `exec-plans/archive/` 保存新完成或被替代的计划；已有计划进入归档时保留证据并更新引用。
- `exec-plans/completed/` 混有已跟踪与未跟踪的旧档案，保持原位；它不是当前队列，也不要批量加入 Git。
- [architecture/](architecture/README.md) 是旧架构资料的兼容入口；恢复材料的来源与契约并入所属执行计划。
- `docs-local/` 是本机的研究、草稿与运行产物。可复现开发所需的规则、结论和证据摘要必须提升到 `docs/`。

## 新文档放哪里

先找现有主题并更新；独立主题才新建。按文档用途选择上表目录，不按 agent 名称或工具品牌建平行体系。
根目录只保留地图和规则。写作、命名、归档和链接检查见 [AGENTS.md](AGENTS.md)。
