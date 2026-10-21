# 07 — 旧 facade 退役

> `packages/agent` 从"唯一执行主体"缩到"空壳",然后删除。
> **这是最后一步,不是第一步。**

---

## 1. 当前定位与目标定位

| | 现在 | 目标 |
| --- | --- | --- |
| 文件数 | 890 | 0(删除) |
| 体积 | 7.7 MB | — |
| 角色 | 唯一执行主体 | 无 |
| bundle 入口 | `src/process/agent-process-entry.ts` | 迁出后改指新位置 |

587 `migration-map.md:25` 的目标写法是 "temporary compatibility facade, shrink then delete" —— **现在连 facade 都还不是**,它是主体。所以 S6 的实际工作量是"先把主体变 facade,再删 facade"。

---

## 2. 删除前置(全部满足才删)

- [ ] 所有能力迁入 `capabilities` / `connectors` / `memory`
- [ ] 所有循环迁入 `runtime`,`agent-process-entry.ts` 不再 import `DuyaAgent`(G4 绿)
- [ ] 所有纯岛迁入 `core`
- [ ] 所有扩展点迁入 `tooling`
- [ ] 所有 CP 域迁入 `control-plane/`
- [ ] 所有持久化实现迁入 `data`
- [ ] CLI / evals / desktop 全部走公开 API
- [ ] `@duya/agent` 的 4 个子路径消费者归零(或全部迁到新包)

---

## 3. 三个子路径的处置

当前 `packages/agent/package.json` 声明 4 个子路径:

| 子路径 | 消费者 | 处置 |
| --- | --- | --- |
| `.` | 3(renderer,**全 type-only**:`Task` `TaskStatus`) | `Task` 迁入 protocol,或改 import `control-plane` 的 DTO |
| `./file-parser` | 0 | **死导出,立即删**(`src/file-parser` 目录不存在) |
| `./message` | 18(desktop main) | 迁入 protocol 或新包 |
| `./context/os-context` | — | 随 context 迁入 core |

**`./tool/allowedRoots` 是后门**(不在 exports 里,靠 tsconfig paths + esbuild alias 双接线),处置见 [01 §2.4](01-migration-map.md#24-duyagenttoolallowedroots-后门)。

---

## 4. bundle 入口迁移

`scripts/build-agent-bundle.mjs` 当前两个入口:

```js
entryPoints: ['packages/agent/src/process/agent-process-entry.ts']   // 主
entryPoints: ['packages/agent/src/tool/BashTool/BashWorker.ts']     // 第二入口
outdir: packages/agent/bundle
```

迁移后必须改指新位置,并同步:
- `apps/desktop/src/main/agents/process-pool/process-manager.ts:49/52/55/61/64` 的路径解析
- `electron-builder.yml` 的 `extraResources`(现为 `resources/agent-bundle/`)
- `scripts/check-packaged-artifacts.mjs` 的门禁路径
- `afterPack` 对 `BashWorker.js` 自包含性的校验

**AGENTS.md「Agent Bundle (MUST FOLLOW)」的三个 pre-release 检查必须继续通过。**

---

## 5. 兼容窗口

**`private: true` 的包不成立"可验证兼容发布窗口"**(587 T3.1 已明确拒绝该声称)。

因此:
- 旧 exports 的删除条件是**消费者归零**,不是"等一个版本"
- 迁移期**只有一个执行 owner**;shadow 观察可以存在,第二个 executor 不可以
- 数据变更用 expand/contract,`git revert` **不撤销已提交数据**(见 [01 §S1.4](01-migration-map.md#14-回退点))

---

## 6. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| G26 | `packages/agent` 消费者归零 | 保留任一 import |
| G27 | bundle 产物路径与打包配置一致 | 改任一路径使其错位 |
| G28 | 无 `file-parser` 死导出 | 加回该子路径 |
| G29 | 迁移期只有一个 executor | 加第二个执行路径 |
