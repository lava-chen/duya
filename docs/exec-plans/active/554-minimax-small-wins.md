# Plan 554: minimax 对比第二梯队「小而美」四项

> **Status**: In Progress (2026-09-20)
> **Priority**: P1
> **Origin**: plan 552 同源对比审查的第二梯队结论。用户指令:"做掉小而美的四项改进"。

## 四项交付物

### ① 子代理 VERDICT 协议 + 父报告 file_change 观测
- [x] 新模块 `tool/task-verification.ts`:严格 VERDICT 语法解析(恰好一行 `VERDICT: PASS|FAIL|PARTIAL`,装饰变体判无效)、`VERDICT_CONTRACT` 提示块、`git status --porcelain` 前后快照差分、父报告块组装
- [x] SubagentTool 同步路径:非只读 agent(explore/plan 除外)的子代理 prompt 追加 VERDICT 契约;结束后解析 verdict + 文件变更差分,父报告块附到返回结果与 metadata
- [x] `buildTaskNotificationXml` 增加 `<model_verdict>`;BackgroundAgentLifecycle 完成路径解析 finalMessage 传入(后台文件差分需 cwd 管道,列为后续)

### ② bash rm 可恢复删除(回收站)
- [x] 新模块 `BashTool/safe-rm.ts`:`parsePlainRmCommand`(仅顶层 `rm`,无 shell 操作符,无 glob 通配)、`buildRecycleScript`(PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` SendToRecycleBin,单引号转义)
- [x] BashTool.execute:win32 下拦截顶层 rm → 回收站;非 win32 / 复合命令 / glob 保持原语义;输出列出已入回收站路径与失败项

### ③ grep 敏感文件恒排除
- [x] GrepTool:ripgrep 路径追加敏感 glob(`.env`/`.env.*`/`*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.jks`/`*.keystore`/`id_rsa*`/`id_ed25519*` 等);Node 回退路径同规则过滤
- [x] `include_sensitive` 参数显式开启(默认排除);工具描述与结果注记说明

### ④ /export /copy /transcript
- [x] 新模块 `session/transcript-md.ts`:Message[] → Markdown(user/assistant 全文,tool_use/tool_result 折叠单行,thinking 折叠)
- [x] CLI slash 注册:/export [path] /copy /transcript(分页)
- [x] 桌面:streamChat 入口拦截(/goal 模式复用);/copy 经新 SSE 事件 `chat:clipboard_write` → router → 渲染器 navigator.clipboard;流式 worker/ai/stream-session-manager 四处登记

## 非目标
- 后台子代理的文件变更差分(需 record 携带 cwd,管道改造单独立项)
- /transcript 的桌面浏览面板(桌面全量 transcript 即聊天本身;/export 覆盖文件诉求)
- PowerShellTool 的 rm 拦截(仅 BashTool,后续可复制同模式)

## 验收
- [x] typecheck:all + electron tsc 手动核查(router.ts 在 electron/,不在 typecheck:all 门内)
- [x] 新增 vitest:task-verification / safe-rm / grep 敏感排除 / transcript-md
- [x] 全量回归失败清单与基线一致(零新增)
