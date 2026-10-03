# 00 — 统一架构合同

> 本文件为587设计权威。Current实现与Target决策分开；新增类型名为建议，不表示已有API。

## A. 包与进程边界

| 层 | 责任 | 允许依赖 | 禁止 |
| --- | --- | --- | --- |
| protocol | JSON契约、schema/codec、事件注册、version、ID/hash、capability | 确有必要的无IO leaf | host、数据库、provider、工具registry、Promise/Map/函数进入wire |
| core | reducer、权限/预算求值、上下文选择、prompt渲染/压缩转换 | protocol、无外部执行能力的纯库 | 自行FS/NET/PROC/数据库/clock；通过AI client间接IO |
| runtime | async run loop、模型与工具调用、hook执行、取消、事件/背压、端口协调 | core/protocol、ai与能力adapter | Electron、renderer、Desktop logger/schema/migration |
| CP services | Run/Task/Goal持久化决策、审批、调度、Workspace解析、lease/checkpoint | runtime/protocol及repository port | UI、worker句柄、另造模型循环 |
| host adapters | IPC/HTTP/进程、secret/vault、SQLite、文件/平台 | 上述公开入口 | 让下层回import host实现 |

ControlPlane先留 `apps/desktop/src/main/control-plane`；纯service不importElectron，SQLite和transportadapter显式注入。第二种真实host需要相同服务时才提取独立包。runtime包可在worker执行，server负责管理；模块边界不等于进程边界。

Browser-safe、仅Desktop消费的DTO首选 `apps/desktop/src/contracts`；多个独立包的稳定公共DTO才提shared。不要把service或全部`types.ts`搬进共享包。现有ai/plugin-core/computer等继续复用。

## B. 身份、输入与Manifest

- `projectId`保持原UUID与私有配置/Memory归属，不以路径重造。
- `sessionId`是durable conversation；一个session可有多run。外部channel另有地址identity，不降格或替代session。
- `runId`由CP/start入口生成，贯穿worker命令、所有事件/审批/指标。workflowRunId/subagentTaskId另存关联，不混用。
- `workspaceId`最终使用device-local持久UUID；Root也有稳定ID。R2可先保存显式legacy binding及snapshot，不能把旧session短hash宣传为持久Workspace；C6负责映射和迁移。
- 输入包含message/input revision、prompt/attachment引用与digest；文件重名不覆盖对象身份。数据留现有transcript/attachmentstore，manifest不塞无限文本。
- manifest是本次解析后的不可变配置：roots/cwd、模型配置ref、tool/catalog版本、profile/modes、预算、permission policy版本、connector binding、context source digests。
- 临时缺字段必须表达unsupported/unknown及来源，不用空数组或`unresolved`声称完全可复现。配置hash不是外部世界快照。

roots取合法绝对路径和realpath，明确read/read-write。执行时继续校验路径、junction/symlink和撤销；manifest freeze不提供OS隔离。

## C. Run 生命周期与结果

逻辑生命周期：created → starting → running → stopping/completing → terminal。初期SQLite可以保持既有status并补逻辑状态，schema迁移不能先假定已有所有状态。

`result()`只等待最终结果；不得调用settle推动终态。多次读取和settle共享完成Promise。executor退出无终态、dispatch失败或hardkill必须合成明确terminal事件。

终态只有一个writer，必要事件确认后CAS提交。终态决策与存储确认分开：内存可已决定，但result/public完成信号必须遵守durablebarrier。DB失败返回明确失败/降级receipt，不伪装completed。Desktop可以兼容旧聊天继续，但需标注存档降级；headless/durable模式拒绝未确认的成功。

CAS/idempotency：相同runId+相同manifest/input可返回既有句柄/记录；不同内容拒绝。同seq同payload重试允许，不同payload冲突报错。CAS未应用必须核对既有终态，不能静默当作本次成功。

## D. Cancel、预算与模型错误

- cancel进入stopping并阻止新模型/工具启动，通知正在执行的adapter；到grace deadline可升级进程终止。默认沿用当前配置，测试可虚拟时间，不把固定时间写死所有host。
- 所有terminal candidate通过同一串行arbiter。已持久提交的terminal不可改；commit前cancel与done竞争遵循现有core outcome策略并用racefixture固定，T3不另造另一套“到达顺序”规则。
- cooperative cancel为cancelled/stopReason；hardkill且缺乏干净退出证据归runtime_crash并记录escalated及请求原因；tool副作用待对账。
- disconnect与cancel分离：Desktop旧行为先adapter保持；有explicit background continuation时断线继续。GET replay不能启动或再次observe。
- turn/toolcall/token/cost/wallclock按定义计费；unavailable cost表达unknown，不能0。检查在新操作前及usage更新时，超限停止后不开始额外动作。runningtool按取消合同完成或标记unknown。
- provider fallback仅在尚未产生用户可见流/工具副作用的安全边界，或新attempt明确标识；不能重复已执行tool。

## E. 权限与secret

保留现有protocol `allow | allow_always | deny | defer`；内部policy `allow/ask/deny`不等于响应。grant带明确scope，sessiongrant不能靠worker“一进程一session”巧合实现。

CP拥有deadline和durable决策，runtime定时wake只是触发，CP以requestId/状态CAS判定迟到。defer不授权；timeout/cancel拒绝并记录reason；unknown action failclosed。updatedInput重新校验并重新求值，不能借修改跳过边界。deny作为policy outcome，失败分类不得污染工具实际error指标。

敏感值不进公开manifest/event/artifact/日志。provider客户端在worker需要凭证是现实约束：R2复用受控private config/toolExec通道，T3区分publicwire和privatecredential delivery；不虚构“模型执行器不接触任何凭证”。MCP/REST尽量由main vault broker执行。service/ref版本可hash，secret原值不hash公开。

Windows Job Object只处理资源/进程树，不单独限制文件与网络；硬沙箱必须由实际token/ACL/隔离backend支持并经逃逸测试。未落地时Trust UI不声称sandboxed。

## F. 事件、replay与流控

- runtime铸造 `(runId,seq)` 单调全事件顺序；durable存储是稀疏子序列，允许seq空洞。
- 对外resume cursor必须限定run/epoch和可用窗口；stream reconnect只补读，不重执行。event replay与execution resume不同capability。
- T3先保持单一seq及durable稀疏语义；不新增ephemeral无seq变体。断线文本通过message snapshot+cursor恢复，不只依赖丢弃的delta。
- 不静默丢durable/terminal。ephemeral可同run/message/contentBlock/type合并；不能跨block、session或semantic barrier。先flush因果上更早delta，再发tool/terminal；不能为了“durable优先”改变顺序。
- 队列按bytes有界、单consumer契约明确；slowconsumer采用coalescing/暂停产出或disconnect+replay，不阻塞取消/审批controlchannel。
- structuraldecode严格；未知合法extension支持前向兼容，无法识别的关键控制/terminal不能偷偷变成成功。registry `since`与peer capability实际校验。

## G. 恢复与兼容

默认pause/resume/determinism unsupported直到D7验收。checkpoint包含运行继续所需的model/context/transcript/mailbox/tool/permission索引，文件pre-image rewind是另一功能，不能代替它。

execution resume形成新attempt/epoch与fence；用户从旧消息分支形成新run+parentRunId。mid-tool恢复必须查副作用账本，unknown默认阻断自动重试。任意外部API不承诺exactly-once。

类型迁移与行为迁移分PR；旧exports/adapter维持至少一个可验证兼容发布窗口，登记消费者与删除任务。schema采用expand/contract，代码回退不撤销已经提交的数据或外部动作。

## H. 固定的质量约束

core通过输入提供clock/seed数据，runtime注入clock/telemetry/执行端口；productionledger不能从`/testing`导入。所有unknown/supported=false可被消费者读取。eval用sameAPI，deterministicoffline与stochasticlive分开。每项任务实现后才能勾选，Moved/Typechecked/Tested/Merged/RuntimeVerified分别记录。
