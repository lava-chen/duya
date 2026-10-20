# 结构化日志

修改日志前按根规则使用所属包的结构化 logger，不记录密钥、消息正文或含个人信息的数据。

| 级别 | 用途 |
| --- | --- |
| DEBUG | 有界诊断信息 |
| INFO | 启动、用户动作、生命周期里程碑 |
| WARN | 可恢复异常、重试、降级 |
| ERROR | 影响操作结果的失败 |

沿用 component 标识，关联非敏感 run / task ID，记录动作、结果和失败原因；避免整对象与结果集输出。
Desktop 入口：`apps/desktop/src/main/logging/logger.ts`。共享包使用本包 logger，不反向依赖 Electron。

Desktop 文件日志位于当前 Electron userData 的 `logs/app.log`；先核对 namespace、初始化、过滤级别与输出目标。
调试产物留在本地，任务计划只保存复现步骤与必要摘要。
