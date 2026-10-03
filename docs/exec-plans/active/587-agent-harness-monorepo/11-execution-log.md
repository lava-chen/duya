# 执行记录与 Handoff

本文件只记录简洁事实、证据位置和下一动作。完整原始输出放忽略验证目录；不记录credentials、用户消息、原始大量终端日志。

## 当前基线

2026-10-03计划整合时HEAD `4be6ec7a`；共享checkout可能继续前进，G0开工必须刷新。

- 已有：Desktop物理迁移、新三包reference实现、runs/events存储、cleanbuild次序修复、CIheap修复。
- 上轮评审：9文件142tests通过；暖typecheckall、architecturecheck/selftest通过；802存量违规被容忍。
- 上轮CI37095446083：Ubuntutypecheck通过、macOSheapOOM失败，随后`5bf3220a`添加heap配置；修复后完整CI本记录未验证。
- 完整test历史基线42–45failing suites/109–111failing tests，实际集合见项目索引；本次文档整合不重跑runtimefullsuite。
- 四个run接缝为上轮隔离源码探针证据，本次G0/R1必须核对最新修复状态。
- Electron/provider P6与executionresume无本轮完成声明。

## 本次计划整合

| 项目 | 状态 |
| --- | --- |
| 单主入口、阶段合同、文件范围/验收/回退 | 文档已写；阶段执行未开始 |
| 原计划与设计资料迁入同一dossier | 以实际Gitdiff和链接检查验收 |
| 旧任务接管与依赖 | 接管表+原checkboxinventory；旧checked不自动完成 |
| 修改runtime或产品UI | 本次未执行 |
| 提交/推送/PR | 本次未执行；交付为可审阅工作区文档 |

## 每个任务更新模板

```text
Task: R1.2 / named slice
State: implemented | typechecked | tested | merged | runtime-verified | blocked
Head / branch / PR:
Changed files and public entry:
Old caller → new caller / ownership:
Baseline failure set and new failure diff:
Checks: command, exit, environment, clean/warm, artifact location
Capabilities actually verified / still unsupported:
Shim consumers + removal criterion:
Rollback/data compatibility:
Remaining blocker: specific evidence, required external input if any
Next task: exact ID + file + first action
```

## 阶段证据账本

| 阶段 | Commit/PR | targeted / fullsetdiff | clean / CI | host / artifacts | Exit |
| --- | --- | --- | --- | --- | --- |
| G0 | — | — | — | — | 未验收 |
| R1 | — | — | — | — | 未验收 |
| R2 | — | — | — | — | 未验收 |
| T3 | — | — | — | — | 未验收 |
| E4 | — | — | — | — | 未验收 |
| M5 | — | — | — | — | 未验收 |
| C6 | — | — | — | — | 未验收 |
| D7 | — | — | — | — | 未验收 |
| H8 | — | — | — | — | 未验收 |

不要用“已定位/已改文件/已merge”替代runtimeverified。修改主Next时同步阶段入口，阻塞描述给下一agent一条具体可实施动作。
