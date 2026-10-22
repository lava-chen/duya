# Fault Injection Report

采样范围：**11 个注入的缺陷**，覆盖 5 类核心契约 + UI 组件层。运行日期 2026-10-22。

| 判定跑在哪棵树上 | 覆盖 | 结果 |
| --- | --- | --- |
| `origin/master` @ `b6f69507` | 契约层 6 条 | 6 killed（在更早的 `16ee9dda` 上是同样的判定） |
| 本分支（`codex/test-quality-optimization`，含本轮补的断言） | UI 层 5 条 | 5 killed |

在本分支的 tree 上把 11 条整批重跑一遍：**11 killed / 0 survived / 0 errored / 0 skipped**。

## 方法

`scripts/test-fault-injection.mjs` 把一个**字面量源码替换**打进生产代码，跑负责覆盖它的测试文件，然后判定：

| 判定 | 含义 |
| --- | --- |
| `killed` | 套件变红——检测到了这个缺陷 |
| `survived` | 套件仍绿——**没检测到**，这是一条发现 |
| `errored` | 运行因断言以外的原因失败（收集错误、崩溃）——**不算检测到** |
| `skipped` | 替换没打进去（锚点不唯一或不存在）——不计入 |

`errored` 单独成类是有意的：套件在变异源码上崩溃，并不能证明它检查了任何东西。

缺陷清单在 `scripts/fault-injection.spec.json`，每条都写明注入的是什么缺陷，评审者可以先读缺陷、再读判定。源码在每次变异后由 `git checkout --` 还原，所以中断不会留下被改写的树。

## 结果：契约层（6 / 6）

| 契约 | 注入的缺陷 | 判定 | 捕获它的测试 |
| --- | --- | --- | --- |
| 协议兼容 | MINOR 版本下限被去掉，一个主版本低的主机被放行 | `killed` | `compatibility-gating.test.ts` |
| 清单指纹 | canonical JSON 不再排序键，指纹取决于构造顺序而非取值 | `killed` | `hash.test.ts` |
| 清单指纹 | SHA-256 填充用 0x81 代替 FIPS 180-4 的 0x80 | `killed` | `hash.test.ts` |
| 会话 id 线契约 | 持久化的 bot 会话前缀从 `bot:` 变成 `bots:` | `killed` | `session-ids.test.ts` |
| 权限安全 | DUYA config 只读硬边界在 bypass 模式下失效 | `killed` | `policy-read-permission.test.ts` |
| 事件一致性 | `WorkerEvent` 联合类型少一个成员 | `killed` | `worker-event-completeness.test.ts` |

## 结果：UI 组件层（5 个变异，采样 3 个 mock-heavy 文件）

| 契约 | 注入的缺陷 | 判定 | 捕获它的测试 |
| --- | --- | --- | --- |
| 消息模式分发 | composer 不再把 conductor 排除在消息模式之外，agent 解析到错误的模式分发 | `killed` | `MessageInput.test.tsx` |
| 消息模式重置 | 发送后 session 级开关（plan-task / research / conductor）被一起清掉 | `killed` | `MessageInput.test.tsx` |
| 扩展页 tab 切换 | marketplace 区块在 installed tab 激活时渲染：点"市场"空白，点"已安装"两块都在 | `killed` | `ExtensionsPage.test.tsx` |
| 扩展页默认 tab | 扩展页默认打开 installed 而不是 marketplace | **先 `survived`，补断言后 `killed`** | `ExtensionsPage.test.tsx` |
| Provider 测试横幅 | "Connection OK" 横幅丢掉实测延迟，用户唯一能看到端点快慢的数字消失 | `killed` | `ProviderManagement.test.tsx` |

**11 / 11 被检测，0 存活，0 错误，0 跳过。**

## 抽样在 UI 层找到了一个真的洞，并把它堵上了

`mock-heavy` 的文件是检测能力最可能不足的地方，所以第二轮抽样刻意落在那里。**其中一条存活了**：

> **扩展页默认打开哪个面板，从没有任何测试断言过。** 注入"默认 tab 从 marketplace 改成 installed"之后，`ExtensionsPage.test.tsx` 的 3 个用例**全部通过**——用户打开扩展页会落在另一个面板上，而套件一声不响。

补法是给已有的第一个用例加一条断言（打开时 marketplace 面板在场），然后**重跑注入证明洞被堵上**。这是一组只差这一条断言的对照——把 `ExtensionsPage.test.tsx` 换回 master 的版本，别的什么都不动：

| 树 | 变异 | 判定 |
| --- | --- | --- |
| master @ `b6f69507` 的测试文件 | `ui-extensions-2` | `survived`——3 个用例全过 |
| 本分支的测试文件（多一条断言） | `ui-extensions-2` | `killed`——1 个用例变红 |

未变异的源码上加强后的用例仍然全绿。

这一条是"抽样的价值"的最好证明：抽样不是走过场，它真的找出过一个用户看得见、套件看不见的缺陷，并且这个缺陷现在是关着的。

## 这证明了什么，没证明什么

证明了：这几条核心契约**不是靠测试名和断言数撑着的**，是真的有检测能力。协议兼容的 fail-open 曾经真实存在过（`compatibility.ts` 自己的注释记着），它被放回来时套件立刻变红。UI 层抽样则证明：**mock 密集不等于没有检测能力**——11 个 mock-heavy 文件里，被抽到的 3 个都抓到了注入的缺陷，其中一个还顺带暴露了它们共同的一个盲区（初始状态没被断言）。

没有证明：

- **34 个 `mock-heavy` 文件里只抽了 3 个。** 剩下 31 个的检测能力仍然未知——这是技术债 D1，本轮把它从"完全未知"缩小到"31 个未知"，而不是消灭。
- **11 个缺陷不是 11 个类别的穷举。** 抽样的价值在于"能证伪"，不在于"证明了全部"。
- **没有测覆盖率。** 变异存活与代码覆盖是两个量：一个 100% 覆盖但只断言返回值的函数，照样能让所有变异存活。

## 怎么复跑

```bash
npm run test:fault-injection
```

它会打乱工作区里的生产源码再还原。跑之前工作区应当是干净的，否则还原会丢掉未提交的改动。

**复核者的预期值**：在 master 上跑同一条 spec 会得到 **10/11**（`ui-extensions-2` 存活），在本分支上是 **11/11**。差的那一条是本分支关掉的洞，不是 master 自带的。
