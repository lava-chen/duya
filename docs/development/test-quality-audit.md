# Test Quality Audit

审计日期：2026-10-22。基线：`origin/master` @ `b6f69507`。所有数字都在这台机器、同一条件下测得；CI 数字注明来自哪个 run。

## 结论

套件的数量不是问题：**1,178 个测试文件、13,414 个用例里没有一个是精确重复，也没有一个 `.only` 残留**。真正的问题是三件可量化的：

1. **PR 关键路径被重复构建吃掉 145s（实测 145–187s）。** `npm test` 的 `pretest` 钩子会再跑一次 `build:packages` 加重建 worker bundle，而 CI 在它前面已经构建过同一个工作区。
2. **单测只需要 19 个包的 `dist/`，CI 构建了 22 个。** 多出来的 `@duya/ui` 是一次完整的渲染层 `tsc`。
3. **每个测试文件有约 370ms 的固定开销**，与用例数无关：1,178 个文件 × 370ms ≈ 436s CPU，占全量运行墙钟的 45%。

## 基线怎么量的

| 项 | 值 | 来源 |
| --- | --- | --- |
| 被跟踪的测试文件 | 1,198 | `git ls-files`（其中 20 个由 vitest 之外的其他 runner 收集） |
| vitest 实际收集 | 1,178 | 全量 run |
| 运行时用例 | 13,414（13,387 通过 / 27 pending / 0 失败） | vitest JSON reporter |
| 静态用例调用点 / 断言调用点 | 12,917 / 31,803 | Test Inventory 静态扫描（`it(`/`test(`/`expect(`） |
| 全量运行墙钟（改前） | 440.24s | `--maxWorkers=2`（与 CI 同） |
| 全量运行墙钟（改后） | 420.79s | 同上 |
| 其中：collect | 237.38s | vitest 阶段分解 |
| 其中：tests | 354.31s | vitest 阶段分解 |
| 其中：environment | 37.22s | 118 个 jsdom 文件 |
| 其中：setup | 64.42s | 全局 setup 文件，每个文件都付 |
| 其中：prepare | 58.44s | 每个文件都付 |
| CI：test job 步骤（改前，全量范围） | install 54s · build 166s · pretest 145s · vitest 503s | run 39639233610 |

`collect + setup + prepare + environment + transform` = 458s 的 CPU，对 354s 的用例体。**开销比被测代码还多。**

两个用例数不是笔误：**运行时 13,414** 个用例，**静态 12,917** 个调用点。差在 `it.each` 与循环——它们一个调用点展开成多个运行时用例。断言同理：vitest 的 JSON reporter 不报断言总数，31,803 是静态 `expect(` 调用点。引用哪个数要说清楚是哪个口径。

## 发现

### F1 · 重复构建（已修）

`pretest` = `bundle:agent` = `build:packages` + 重建 worker bundle。CI 的 "Run tests" step 前一个 step 已经跑过 `build:packages`。全量范围的 run 39639233610 里，`pretest` 花了 **144.8s**（17:00:14 → 17:02:39），期间 vitest 一个用例都没跑；另一个 run（39653107412，那次 PR 只跑了 139 个文件）里同一个 hook 花了 186.8s——**这个代价与测试范围无关**，它每次都把整个工作区重编一遍。

worker bundle 那一半同样是多余的：`packages/host/bundle/` 是 git 跟踪的产物（57 个文件），checkout 里已经带着它，而 `architecture` job 的 `bundle:verify` 门禁用 git 历史判定它是否过期。bundle 过期时 PR 本来就是红的——测试 job 重建一遍等于把那个红信号盖过去。

### F2 · 构建了用不上的包（已修）

`build:packages` 构建 22 个包，单测真正从 `dist/` 解析的只有 19 个。从干净的 `dist/` 与 `tsconfig.tsbuildinfo` 测：

| | 包数 | 耗时 |
| --- | ---: | ---: |
| 全量构建 | 22 | 151.8s |
| `unit-suite` 档位 | 19 | 39.8s |

省下的 112s 几乎全部来自 `@duya/ui`——一次完整的渲染层 `tsc`，而单测通过 vitest 别名直接读它的源码。

**一个反直觉的依赖**：`@duya/host` 不被任何测试文件 import，但档位里必须有它。`packages/host/tests/worker-product-runtime/agent-runtime-real-worker.mjs` 是子进程传输测试真正拉起的程序，它加载 `packages/host/dist/worker-transport.js`；架构门禁要求这个 import 留在拥有 worker 的模块内，所以它不能搬走。档位少了它，全量跑会少 8 个断言变绿——`subprocess-framing.test.ts` 与 `transport-equivalence.test.ts` 拉起的 worker 没有输出。套件自带的守卫（"needs the built worker, and says so rather than skipping"）如实报了出来，这正是它存在的意义。

**推论**：单测的构建需求**不能**只从测试文件的 import 推导，跨进程边界的 fixture 会引入 import 图看不见的依赖。

**而且这个依赖会漂**：审计进行期间，master 把这个 fixture 从 agent 层挪到了 host 层（#341），档位里的 `@duya/agent` 随之变成 `@duya/host`。档位是测出来的，不是推出来的，所以它必须被重新测。

### F3 · 每个文件都付的固定成本（部分已修）

`test-setup.ts` 无条件 `import '@testing-library/jest-dom/vitest'`。DOM 匹配器只有在 jsdom 环境下才有意义，而 1,178 个文件里 1,060 个跑在 node 环境。30 个探针文件实测：

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
| `skipped`（自己跳过自己的用例） | 4 |
| 精确重复的文件 | 0 |
| `.only` 残留 | 0 |

`mock-heavy` 的 34 个文件里最极端的是 `packages/ui/src/components/extensions/__tests__/ExtensionsPage.test.tsx`（18 个 mock / 3 个用例）。**这不是判决**——mock 密集在 UI 组件测试里是常态，判定要靠故障注入，不是靠计数。

### F5 · 一个余量只有 1ms 的时序用例（已修）

本 PR 自己的 CI 把它拉红过两次，失败文件是 `packages/agent-runtime/test/run-cancel-budget.test.ts` 里"墙钟上限触发停止"那一条：`expected 'cancelled' to be 'budget_exhausted'`。

它**不在本 PR 的 diff 里**（16 个文件没有一个在 `packages/agent-runtime`），但它暴露了一类问题，所以写在这里。

**余量只有 1ms。** 预算判定发生在 settle 时，测的是 `Date.now() - startedAt >= 30`；`Date.now()` 只有毫秒精度，而 `setTimeout(30)` 在负载下会提前 1ms 触发，于是测得 29ms → 判定"未越界" → 终态从 `budget_exhausted` 落回 `cancelled`。

实测（不是推断）：

| 条件 | 结果 |
| --- | --- |
| 空闲：`setTimeout(30)` 的 300 次采样 | 最小 30ms，0 次低于上限 |
| 8 个 CPU burner 在跑：同样 300 次采样 | **出现 1 次 29ms** |
| 该测试文件，空闲连跑 20 次 | 20/20 通过 |
| 该测试文件，负载下连跑 12 次 | **红 1 次**（修复前） |
| 修复后，负载下连跑 12 次 | 0/12 |

修法用控制器**本来就有的 clock 接缝**（`RunController` 的 `clock`）：把"测量"变确定，**保留真实定时器**——上限仍然必须真实触发，运行时若不再挂墙钟计时器，测试照样红。

**检测能力没有被削弱**（变异检验）：把计时器回调里的 `reason: 'budget'` 改成 `'user'`，该用例立刻报 `expected 'user' to be 'budget'`。改的是测量方式，不是断言。

## 改动的效果

同一台机器、同一条件（`--maxWorkers=2`，与 CI 同），两次运行都只构建 `unit-suite` 档位：

| | 改前 | 改后 | 变化 |
| --- | ---: | ---: | ---: |
| 全量运行墙钟 | 440.24s | 420.79s | −4.4% |
| — collect | 237.38s | 242.53s | +5.15s |
| — setup | 64.42s | 14.22s | **−50.20s** |
| — environment | 37.22s | 37.74s | +0.52s |
| — tests | 354.31s | 349.68s | −4.63s |
| 工作区构建 | 151.8s | 39.8s | **−73.8%** |

改后那次运行是 **1,176 个文件全绿、2 个跳过、0 失败**。改前那次有 1 个文件红——是编码门禁正确地报出了**测量脚本自己**用 PowerShell `Set-Content -Encoding utf8` 写进 `test-setup.ts` 的一个 UTF-8 BOM（PowerShell 5.1 的 `-Encoding utf8` 带 BOM）。不是仓库的问题，但也不是一次干净的对照，所以下面这张表里的"改前"用的是这次运行的耗时、而不是它的通过状态。

映射到 CI（**实测**，两次都是 `unit_scope=full` 的全量套件，同一个 job，同一台 ubuntu runner）：

| 环节 | 改前 | 改后 | 依据 |
| --- | ---: | ---: | --- |
| 安装依赖 | 54s | 57s | run 39639233610 / 39659948364 的 step 耗时 |
| 构建工作区 | 166s | 64s | 同上；改后是 `--profile unit-suite` |
| `pretest` 重复构建 | 145s | 0s | 改前：`pretest` 17:00:14 → 17:02:39；改后这个 hook 不再被调用 |
| vitest | 503s | 483s | 改前 17:02:39 → 17:11:02；改后 19:17:20 → 19:25:22 |
| **test job** | **879s** | **616s** | |
| **PR 关键路径** | **893s** | **627s（−29.8%）** | 从 run 开始到最后一个 job 结束 |

两次 run 都全量收集了套件（改前 1,177 个文件，改后 1,178 个），改后 **1,176 通过 / 2 跳过 / 0 失败**。

`typecheck` job 改前 455s、改后 461s，仍短于 test job，所以关键路径没有换人。

**这组数是实测，不是投影。** 改前取 run 39639233610（PR #343 的分支，绿，全量范围），改后取本 PR 自己的 run 39659948364。另一个参照是 master 的手动触发 run 39655210137：同样的全量范围，test job 924s，其中 "Run tests" 670s 期间套件是红的——那个红是 master 既有的，不是本 PR 引入的。

**但本 PR 之后的两次 CI 是红的**，红在 F5 那个 1ms 余量的用例上，与本 PR 的改动无关。修掉它之后才有"本 PR 的 CI 是绿的"这句话——这条经历本身就是为什么"红了要先归因"：同一个 commit 重跑两次都红，看起来像回归，其实是 runner 一挤就翻的旧账。

## 故障注入

见 [test-fault-injection 报告](test-fault-injection-report.md)。抽样的 6 个缺陷覆盖 5 类核心契约，**6 个全部被现有套件杀死**：协议兼容的 MINOR 下限、canonical JSON 键序、SHA-256 填充、持久化的 bot 会话前缀、bypass 模式下的 config 硬边界、以及 `WorkerEvent` 联合类型少一个成员。

## 剩余技术债

| # | 债 | 影响 | 建议 |
| --- | --- | --- | --- |
| D1 | 34 个 `mock-heavy` 文件的检测能力未经抽样验证 | 未知 | 扩展故障注入的抽样面 |
| D2 | 11 个测试直接写 stdout/stderr | 污染 CI 日志，失败可能被淹没 | 改用注入的 logger |
| D3 | 4 个文件跳过自己的用例 | 覆盖面上的空洞 | 逐个确认是"暂缓"还是"永不" |
| D4 | `collect` 仍是最大单项（237s） | 每文件 202ms 的模块图加载 | 按包压测 import 图，找可裁剪的重依赖 |
| D5 | 118 个 jsdom 文件，每次环境初始化 315ms | environment 阶段 37s | 评估更轻的 DOM 实现，或减少真正需要 DOM 的文件数 |
| D6 | E2E 不在 PR 路径上 | 真实链路无 PR 级信号 | 重建套件后恢复 |
| D7 | `unit-suite` 档位是测出来的，不是推出来的 | master 把 fixture 挪个层，档位就过期 | 每次改到跨进程 fixture 都要重测档位 |
| D8 | `packages/agent/tests/process/fixtures/real-worker.mjs` 已无人引用 | 退役层里留着一份死 fixture | 随 agent 层一起退役 |
| D9 | 余量只有 1ms 的时序用例没有普查（F5 只抓到了实际翻红的那一个） | 下一台更挤的 runner 就可能再翻一个 | 按"断言依赖真实时钟 + 阈值 < 100ms"筛一遍，逐个改成确定测量 |
