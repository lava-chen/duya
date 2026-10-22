# Architecture

当前系统结构与数据流见 [ARCHITECTURE.md](ARCHITECTURE.md)；按症状定位代码见 [ARCHITECTURE_MAP.md](ARCHITECTURE_MAP.md)。

| 文档 | 用途 |
| --- | --- |
| [Run turn input contract](run-turn-input-contract.md) | Desktop / TUI 调用方输入如何被 Host 接受、收窄并落实 |
| [2026-10-01 architecture audit](2026-10-01-architecture-audit.md) | 固定提交上的历史审计报告，不代表当前缺陷状态 |
| [M5.1 slice inventory](m5-1-slice-inventory.md) | 历史调查记录 |

架构执行顺序只在 [610 执行队列](../exec-plans/active/610-architecture-series/19-fast-track-queue.md)维护。
[587](../exec-plans/active/587-agent-harness-monorepo/README.md)及其 reference / history 是历史合同与推导，不能另排执行队列。

新设计决策放 `docs/design-docs/`；架构文档只维护当前实现、定位入口与可追溯的历史资料。
