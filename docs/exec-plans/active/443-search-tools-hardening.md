# Plan 443: Search Tools Hardening（对照 harness-comparison 审计整改）

> 来源：`docs/references/harness-comparison/search-tools-deep-dive.md` 对照审计
> （2026-08-25 会话）。五个 harness 的 Grep/Glob 实现对比中列出的差距逐项落地。
> 范围：`packages/agent/src/tool/GrepTool/`、`GlobTool/`、rg 打包链路。

## 背景

duya 的 GrepTool（spawn 裸名 rg + Node 回退）与 GlobTool（纯 Node 遍历 + picomatch）
在输出治理上多数达标，但对照文档有明确缺口：

1. rg 未随包打包 —— 打包版静默降级 Node 引擎（性能差一个量级）
2. rg spawn 无 timeout、未接 abortController —— 恶意 .gitignore 全盘扫描可挂死回合
3. rg exit 2 直接 reject 全部结果 —— 已流式收集的有效 match 一并丢弃
4. UNC 路径只在 glob pattern 拒绝，`path` 参数入口未堵（Windows NTLM 凭据泄漏面）
5. 无 multiline 支持 —— 模型搜跨行 pattern 烧一整回合
6. Glob/Grep ignore 默认值相同 —— 「找被 ignore 的构建产物」场景两边都做不到
7. 杂项：Node 回退每行重编译 RegExp、glob 不下钻隐藏目录、错误无相似路径建议

## Tasks

- [ ] A. Grep：rg spawn timeout + abortController 接线（execute 第三参 context）
- [ ] B. Grep：exit 2 有匹配则返回部分结果 + stderr warning
- [ ] C. Grep：multiline 参数（-U --multiline-dotall + --json 解析分支）
- [ ] D. Grep/Glob：include_ignored 开关（grep 去 skipDirs globs + --no-ignore；
      glob 绕过 gitignore 与重目录 fallback）；默认行为不变
- [ ] E. Grep/Glob：path 入口 UNC 拒绝（utils/path 加 isUncPath）
- [ ] F. Glob：下钻隐藏目录（除 .git）+ 不存在路径给 cwd 相似名建议
- [ ] G. 杂项：searchWithNode RegExp 外提；spawn cwd 用每调用 baseDir
- [ ] H. rg 打包：scripts/fetch-ripgrep.mjs（固定版本，下载到 resources/ripgrep/，
      gitignore）+ electron-builder extraResources + 主进程向 agent 子进程注入
      DUYA_RIPGREP_PATH（仿 DUYA_BETTER_SQLITE3_PATH）+ GrepTool 解析顺序
      option > env > PATH
- [ ] I. 测试：更新/新增 GrepTool / GlobTool 单测；vitest 从仓库根跑；
      `npm run typecheck:all` 过

## 决策记录

- multiline 用 --json 分支解析而非改主解析器：行式解析器已被测试锚定，
  -U 下多行 match 的续行无前缀会误判。
- include_ignored 做成 opt-in 而非翻转 glob 默认值：保持现有用户预期，
  同时解决「搜 dist/build 构建产物」场景。
- rg 打包用构建期下载脚本（仿 pi tools-manager 思路）而非新增 npm 依赖：
  避免 npm install 网络依赖扩散到所有开发者；版本固定可复现。

## 进度

- 2026-08-25: 立项，开始 Task A–I。
