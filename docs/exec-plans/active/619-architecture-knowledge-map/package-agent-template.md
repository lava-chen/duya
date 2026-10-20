# 包级 AGENTS.md 模板（worker 必须遵守）

每个包一份 `packages/<pkg>/AGENTS.md`（`apps/<app>/AGENTS.md` 同理）。
目标读者是**下一个来这个包排障的 agent**，不是来读产品介绍的。

## 结构（固定五段，顺序不变）

```markdown
# @duya/<pkg>

> 一句话职责：**它拥有什么**，以及**它明确不拥有什么**。

## 1. 负责 / 不负责

| 负责 | 不负责（去哪个包） |
| --- | --- |
| ... | ... → `@duya/xxx` |

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/<pkg>/src/...ts:12` | ... |

## 3. 对外接口

被谁依赖、依赖它的契约是什么。写清楚**入参 / 出参 / 状态存哪**。

## 4. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| ... | `packages/<pkg>/src/...ts:88` | ... |

## 5. 边界约束

这个包受哪条架构规则约束（`architecture-policy.yaml` 的 layer / managed 状态），
以及本地开发时最常踩的坑。
```

## 硬性要求

1. **≥ 200 字节**（`tests/rules-compliance.test.mjs` 测试 3）。
2. **每条非平凡断言都要带 `path:line`**，相对仓库根。
   反例：「这个包负责运行引擎」——不可查。
   正例：「`RunEngineImpl` 在 `packages/agent-runtime/src/engine/run-engine.ts:31`」。
3. **第 4 节是核心**。至少 3 行症状→文件。宁可少写一句套话，也要把入口写准。
4. **第 1 节的「不负责」列必须指向真实存在的另一个包**，不要写「不负责 UI」这种没有落点的说法。
   这正是「知道去哪找」的关键。
5. **不要复述根 `AGENTS.md` 或 `ARCHITECTURE.md` 的通用内容**（日志规范、提交规范、门禁命令）。
   包级文档只写**这个包特有**的东西。
6. **引用的路径必须真实存在**。写之前确认文件在磁盘上。
   注意：`tests/rules-compliance.test.mjs` 测试 5 的正则只匹配
   `packages|scripts|src|docs|.cursor|.claude|electron|e2e|extension|assets` 开头的引用，
   `apps/` 开头的**不被校验**——但仍要写对。
7. **UTF-8 无 BOM**。不要用 PowerShell 的 `Set-Content -Encoding UTF8`（会写 BOM），
   用编辑工具写文件。
8. **代码标识符、命令、路径、报错原文保持原样**。中文只用于叙述。
9. **如果这个包是 legacy / 已退役 / 待退役**，在第 1 节明确写出来，
   并给出退役门禁命令和当前状态（实测值，不是猜的）。
   例：`packages/agent/` 是 legacy shell，门禁
   `node scripts/architecture/agent-retirement-gate.mjs --json` 当前报 `status: OPEN`。
10. **不要在包级文档里写日期戳**（「截至 2026-10-20」）。写会立刻过期的数字，
    除非它来自机器可执行的门禁输出。

## 自检

写完每个文件后确认：

```powershell
# 存在且够大
(Get-Item packages/<pkg>/AGENTS.md).Length -ge 200

# 引用的 packages/ 路径都存在（逐条人工核对，测试 5 只 warn 不 fail）
```

最后整体跑一次：

```powershell
node tests/rules-compliance.test.mjs   # 测试 2 必须转绿
npm run check:encoding                # 必须绿
```
