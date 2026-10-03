# 非阻塞后续轨：保留旧范围，不混进架构迁移

> Pending / explicitly deferred。这些事项有owner和验收，但不阻塞纯拆包主线。
> 如果核对发现未修的真实安全缺口影响即将开放的host/工具，该具体事项成为对应能力的硬前置。
> 不新建独立计划入口；需要启动时在587主Next明确选X任务，或由已有独立功能plan承担。

## X1 外部 Channel 与凭证接缝

来源583 ISS17/20/23/50。先核对已有PR，已修只复验。

- [ ] Feishu缺token/错签名/重放拒绝；payloadschema与ack后dispatchfailure可观测。handler接受只表示持久接收，异步执行成功另receipt。
- [ ] connectorsecretstore agent/platform/path参数严格validate；vault损坏不返回“没有凭证”的假状态，保留文件并typederror。
- [ ] Telegramoffset持久化、restartduplicatebacklog、delivery幂等；外部media真实发送而非textlink冒充上传。
- [ ] channel测试+MCP相关conformance、hostbuild与配置真实smoke；不自动向用户联系人发送测试消息，使用fixture/testchannel。

## X2 Provider fallback / per-role model

来源429建议5/451关联。

- [ ] 配置fallbackchain与fanout/skeptic/compactmodelref，复用aiadapter；每attempt记录真实provider/usage。
- [ ] 仅在00规定的安全retryboundary切换；partialstream/toolalreadyexecuted不盲重放。
- [ ] mock5xx/overload/断网/partialstream，role选择与成本统计通过；live测量不替代离线断言。

## X3 Windows hard sandbox / Plugin Trust

来源429建议4、583ISS05。

- [ ] 明确可实现backend、restrictedtoken/ACL/networkpolicy与进程树资源控制职责；JobObject不独立提供FS/networkdeny。
- [ ] 根据可实施backend定义read/write/spawn/network/MCPplugin权限，policy与OSenforcement分别声明。
- [ ] 插件source/signature/capability与实际安装/启动MCP/hook路径相连；marketplace来源不是签名验证。
- [ ] 真实逃逸/childprocess/junction/networktests后才开放sandboxedcapability。平台不可用明确unsupported，不加入装饰开关。

## X4 UI / 可见性与编辑事务

来源429建议6及583ISS26–28/41/42/45/49。

- [ ] subagenttree利用已有parentchildrun，不改变后台执行语义；任务状态投影与CP一致。
- [ ] CodeReviewscope切换旧请求不覆盖新结果；readonlyGit契约不变。
- [ ] 编辑回溯采用preparedsnapshot→发送成功→提交/失败恢复，附件身份与文件rewind保持；故障注入确认不丢transcript。
- [ ] Gitpolling/themehook重复先查实际consumer再提纯复用；CSStokens/品牌色边界按已有style约定。
- [ ] Widgethref只允许已验证协议与安全打开；host/schema修复与UI样式分PR。
- [ ] 所有UI变更Playwrightlight/dark/hover/loading，IPC相关真实Electron；不为纯移动新写镜像实现测试。

## X5 Memory 保留与仓库卫生

来源583ISS32–34/40/44/47–51。

- [ ] RAG/tier查询limit、分页与性能，保持召回正确性；不在hotpath同步全量embedding加载。
- [ ] retention按范围/size/age和引用定义，保留活跃run/checkpoint/ProjectMemory；dry-run先于删除，不顺手清用户数据。
- [ ] scopeddeadcode确认无生产consumer后删；structuredlogger/UTF8/exportsdoc按切片同步，不全仓无证据rewrite。
- [ ] tsbuildinfo/ignoredcache清理验证，版本化数据与用户memory不作为垃圾删除。

## X6 独立 Website 事项

来源583ISS37/38/39/49/50。独立仓库，当前Duya重构只保留关联，不跨仓库写入。

- [ ] 确认对应websitePR是否已merge；安全headers、docsredirect、slug/downloadtests和构建期数据fetch按当前实际来源验证。
- [ ] ISS39历史已证伪，不执行“两套认证合并”推测；新问题需重新立证。
- [ ] 后续实施需该仓库范围/环境可用，由其owner管理PR与deploy；不能在Duya成功中声称website已完成。

## 后续任务关闭

每项补实际source/taskID/证据；已经完成归revalidated，未执行归deferred并写具体下一步。所有旧scope都保留，但不制造“为了完成架构必须先修全部UI/网站”的依赖。
