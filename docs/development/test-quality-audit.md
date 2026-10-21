# Test Quality Audit

审计日期：2026-10-22。基线：`origin/master` @ `16ee9dda`（PR #343 合并后）。所有数字都在这台机器、同一条件下测得。

## 结论

套件的数量不是问题：**1,195 个测试文件、13,401 个用例里没有一个是精确重复，也没有一个 `.only` 残留**。真正的问题是三件可量化的：

1. **PR 关键路径被重复构建吃掉 145s。** `npm test` 的 `pretest` 钩子会再跑一次 `build:packages`，而 CI 在它前面已经构建过同一个工作区。
2. **单测只需要 20 个包的 `dist/`，CI 构建了 23 个。** 多出来的 `@duya/ui` 是一次完整的渲染层 `tsc`，占构建时间的大头。
3. **每个测试文件有约 370ms 的固定开销**，与用例数无关：1,177 个文件 × 370ms ≈ 436s CPU，占全量运行墙钟的 45%。

## 基线怎么量的

| 项 | 值 | 来源 |
| --- | --- | --- |
| 被跟踪的测试文件 | 1,195 | `git ls-files` |
| vitest 实际收集 | 1,177 | 全量 run |
| 用例 / 断言 | 13,401 / 32,176 | vitest JSON reporter |
| 全量运行墙钟 | 483.87s | `--maxWorkers=2`（与 CI 同） |
| 其中：collect | 281.15s | vitest 阶段分解 |
| 其中：tests | 372.51s | vitest 阶段分解 |
| 其中：environment | 52.09s | 118 个 jsdom 文件 |
| 其中：setup | 66.39s | 全局 setup 文件，每个文件都付 |
| 其中：prepare | 60.31s | 每个文件都付 |
| PR 关键路径 | 893s | run 39639233610，16:56:11 → 17:11:04 |

`collect + setup + prepare + environment + transform` = 487.79s 的 CPU，对 372.51s 的用例体。**开销比被测代码还多。**

## 发现

### F1 · 重复构建（已修）

`pretest` = `bundle:agent` = `build:packages` + 重建 worker bundle。CI 的 "Run tests" step 前一个 step 已经跑过 `build:packages`。run 39639233610 上 `pretest` 花了 **145s**（17:00:14 → 17:02:39），期间 vitest 一个用例都没跑。

worker bundle 那一半同样是多余的：`packages/host/bundle/` 是 git 跟踪的产物（57 个文件），checkout 里已经带着它，而 `architecture` job 的 `bundle:verify` 门禁用 git 历史判定它是否过期。bundle 过期时 PR 本来就是红的——测试 job 重建一遍等于把那个红信号盖过去。

### F2 · 构建了用不上的包（已修）

`build:packages` 构建 23 个包，单测真正从 `dist/` 解析的只有 20 个。从干净的 `dist/` 与 `tsconfig.tsbuildinfo` 测：

| | 包数 | 耗时 |
| --- | ---: | ---: |
| 全量构建 | 23 | 174.1s |
| `unit-suite` 档位 | 20 | 34.7s |

省下的 139s 几乎全部来自 `@duya/ui`——一次完整的渲染层 `tsc`，而单测通过 vitest 别名直接读它的源码。

**一个反直觉的依赖**：`@duya/agent` 不被任何测试文件 import，但档位里必须有它。`packages/agent/tests/process/fixtures/real-worker.mjs` 是子进程传输测试真正拉起的程序，它加载 `packages/agent/dist/process/worker-protocol.js`；架构门禁要求这个 import 留在拥有 worker 的模块内，所以它不能搬走。档位少了它，全量跑会少 8 个断言变绿——`subprocess-framing.test.ts` 与 `transport-equivalence.test.ts` 拉起的 worker 没有输出。套件自带的守卫（"needs the built worker, and says so rather than skipping"）如实报了出来，这正是它存在的意义。

**推论**：单测的构建需求**不能**只从测试文件的 import 推导，跨进程边界的 fixture 会引入 import 图看不见的依赖。

### F3 · 每个文件都付的固定成本（部分已修）

`test-setup.ts` 无条件 `import '@testing-library/jest-dom/vitest'`。DOM 匹配器只有在 jsdom 环境下才有意义，而 1,177 个文件里 1,059 个跑在 node 环境。30 个探针文件实测：

| | setup | collect | 合计 |
| --- | ---: | ---: | ---: |
| 带导入 | 1.69s | 496ms | 3.45s |
| 不带导入 | 0.32s | 300ms | 2.68s |

即每个文件约 52ms。已改为按环境条件加载。

### F4 · 质量信号（未处理，见技术债）

| 信号 | 文件数 |
| --- | ---: |
| `mock-heavy`（mock 数 ≥ 用例数） | 34 |
| `stdout-write`（测试直接写 stdout/stderr） | 11 |
| `skipped`（自己跳过自己的用例） | 5 |
| 精确重复的文件 | 0 |
| `.only` 残留 | 0 |

`mock-heavy` 的 34 个文件里最极端的是 `packages/ui/src/components/extensions/__tests__/ExtensionsPage.test.tsx`（18 个 mock / 3 个用例）。**这不是判决**——mock 密集在 UI 组件测试里是常态，判定要靠故障注入，不是靠计数。

## 改动的效果

同一台机器、同一条件（`--maxWorkers=2`，与 CI 一致）：

| | 改前 | 改后 | 变化 |
| --- | ---: | ---: | ---: |
| 全量运行墙钟 | 483.87s | 420.97s | −13.0% |
| — collect | 281.15s | 243.13s | −38.02s |
| — setup | 66.39s | 14.36s | −52.03s |
| — environment | 52.09s | 38.16s | −13.93s |
| — tests | 372.51s | 353.40s | −19.11s |
| 工作区构建 | 174.1s | 34.7s | −80.1% |

两次运行的用例结果完全相同：**1,175 个文件、13,374 个用例、27 个跳过，0 失败**。

映射到 PR 关键路径（以 run 39639233610 的 step 耗时为基准，用本地与 CI 的比值换算）：

| 环节 | 改前 | 改后 | 依据 |
| --- | ---: | ---: | --- |
| 安装依赖 | 54s | 54s | 不变 |
| 构建工作区 | 166s | 33s | 本地 174.1s → 34.7s，按 CI/本地 0.953 换算 |
| `pretest` 重复构建 | 145s | 0.1s | 日志里这 145s 几乎全是 `bundle:agent`；`ensure-sqlite-abi` 只占 0.08s |
| vitest | 503s | 437s | 本地 483.87s → 420.97s，按 CI/本地 1.039 换算 |
| 其余 | 11s | 11s | 不变 |
| **test job** | **879s** | **535s** | |
| **PR 关键路径** | **893s** | **549s（−38.5%）** | |

`typecheck` job 是 455s，仍短于 test job，所以关键路径没有换人。

**这是投影，不是实测。** 投影的每一步都来自本机实测或该 run 的日志；真实的 CI 数字要等这个 PR 的 run 出来才能填。

## 故障注入

见 [test-fault-injection 报告](test-fault-injection-report.md)。抽样的 6 个缺陷覆盖 5 类核心契约，**6 个全部被现有套件杀死**：协议兼容的 MINOR 下限、canonical JSON 键序、SHA-256 填充、持久化的 bot 会话前缀、bypass 模式下的 config 硬边界、以及 `WorkerEvent` 联合类型少一个成员。

## 剩余技术债

| # | 债 | 影响 | 建议 |
| --- | --- | --- | --- |
| D1 | 34 个 `mock-heavy` 文件的检测能力未经抽样验证 | 未知 | 扩展故障注入的抽样面 |
| D2 | 11 个测试直接写 stdout/stderr | 污染 CI 日志，失败可能被淹没 | 改用注入的 logger |
| D3 | 5 个文件跳过自己的用例 | 覆盖面上的空洞 | 逐个确认是"暂缓"还是"永不" |
| D4 | `collect` 仍是最大单项（281s） | 每文件 239ms 的模块图加载 | 按包压测 import 图，找可裁剪的重依赖 |
| D5 | 118 个 jsdom 文件，每次环境初始化 441ms | environment 阶段 52s | 评估更轻的 DOM 实现，或减少真正需要 DOM 的文件数 |
| D6 | E2E 不在 PR 路径上 | 真实链路无 PR 级信号 | 重建套件后恢复 |
