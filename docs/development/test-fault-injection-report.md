# Fault Injection Report

采样范围：6 个注入的缺陷，覆盖 5 类核心契约。运行日期 2026-10-22，基线 `origin/master` @ `b6f69507`（这 6 个缺陷在更早的基线 `16ee9dda` 上也是同样的判定）。

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

## 结果

| 契约 | 注入的缺陷 | 判定 | 捕获它的测试 |
| --- | --- | --- | --- |
| 协议兼容 | MINOR 版本下限被去掉，一个主版本低的主机被放行 | `killed` | `compatibility-gating.test.ts` |
| 清单指纹 | canonical JSON 不再排序键，指纹取决于构造顺序而非取值 | `killed` | `hash.test.ts` |
| 清单指纹 | SHA-256 填充用 0x81 代替 FIPS 180-4 的 0x80 | `killed` | `hash.test.ts` |
| 会话 id 线契约 | 持久化的 bot 会话前缀从 `bot:` 变成 `bots:` | `killed` | `session-ids.test.ts` |
| 权限安全 | DUYA config 只读硬边界在 bypass 模式下失效 | `killed` | `policy-read-permission.test.ts` |
| 事件一致性 | `WorkerEvent` 联合类型少一个成员 | `killed` | `worker-event-completeness.test.ts` |

**6 / 6 被检测，0 存活，0 错误，0 跳过。**

## 这证明了什么，没证明什么

证明了：这几条核心契约**不是靠测试名和断言数撑着的**，是真的有检测能力。协议兼容的 fail-open 曾经真实存在过（`compatibility.ts` 自己的注释记着），它被放回来时套件立刻变红。

没有证明：

- **没有覆盖 34 个 `mock-heavy` 文件。** 抽样落在契约层，不在 UI 组件层。UI 层是 mock 最密集的地方，也是检测能力最可能不足的地方——这是技术债 D1。
- **6 个缺陷不是 6 个类别的穷举。** 抽样的价值在于"能证伪"，不在于"证明了全部"。
- **没有测覆盖率。** 变异存活与代码覆盖是两个量：一个 100% 覆盖但只断言返回值的函数，照样能让所有变异存活。

## 怎么复跑

```bash
npm run test:fault-injection
```

它会打乱工作区里的生产源码再还原。跑之前工作区应当是干净的，否则还原会丢掉未提交的改动。
