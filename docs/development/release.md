# 版本与发布

发布必须已获用户授权；只要求推荐版本时，先给出具体数字、变更依据与待验收项，不执行 tag 或发布。
已有明确授权时沿用，不重复确认。

## 准备

1. 核对 `package.json`、最近已发布 tag 及其后提交，区分破坏性变化、功能与修复。
2. 按现有发布线推荐明确版本；`0.x` 的 PATCH 与 MINOR 仍是不同位数，不把二者混用。
   已有策略不能确定候选时先确认版本，不在发布过程中悄悄改策略。
3. 用户要求 beta，或打包、安装、公开接口变化尚待实包验收时，推荐预发布版本并列出缺口。
4. 更新 `docs/release-notes/v<X>.md`、`package.json` 版本及需要同步的锁文件；只暂存发布所需改动。
5. 版本变更先在独立 worktree 经门禁、实包 smoke 与 PR 集成；发布授权不豁免 PR。tag 指向版本匹配的集成提交。

## 执行与验证

以下占位符替换为已授权版本；核对集成 SHA、远端同名 tag 与既有副作用后执行：

```bash
git tag -a v<X> -F docs/release-notes/v<X>.md
git push origin v<X>
gh run list --workflow release.yml --limit 5
gh release view v<X>
```

GitHub Release 只由 `.github/workflows/release.yml` 创建。核对对应 tag 的 workflow 结果、Release、目标平台产物及可下载性；
仅 push 成功、CI 显示 success 或 `gh release view` 返回条目都不足以证明产物完整。

## 中断接续

先核对版本提交、tag 的本地 / 远端指向、workflow 和 Release，再决定补哪一步；不重复提交或覆盖已发布 tag。
把 tag、SHA、CI / Release 链接和实包验证范围写回本次计划。
