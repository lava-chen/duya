/**
 * store.ts — dwf 保存工作流的存储层：作用域根目录 + 解析 / 枚举 / 写入
 * （对照 ZCode saved-workflows/store.ts，目录由 `.zcode` 换成 `.duya`）。
 *
 * 全部是**同步** fs。理由不是图省事：确认窗的 prepareApproval 契约是同步的，而以
 * `saved` 源发起的 run 必须在弹窗**之前**把脚本读出来——没有脚本就没有因果图，用户
 * 就会在一个空窗口上批准执行。这些文件是本地的、单个的、以 KB 计的，同步读的代价
 * 远小于为它另开一条异步审批路径。
 *
 * **只有全局档是定义来源**（plan 583，用户选定 (c)）。项目档 `.duya/workflows/` 是
 * **相对会话工作目录**的，而会话工作目录经常是 `git clone` 来的仓库 —— 里面一个
 * `.dwf.ts` 就是一份能跑的代码。所以项目档不再被解析、也不再被枚举：留着它当查找
 * 根，等于把克隆来的内容变成可一键执行的 workflow。
 *
 * 想要「仓库自带工作流」这个特性，正确形态是**用户自己拷进 `~/.duya/workflows/`**，
 * 那一步就是授权。往项目档写现在会**显式报错**（而不是静默写到没人读的地方）。
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  SAVED_WORKFLOW_DRAFTS_DIR,
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_GLOBAL_DIR,
  isValidSavedWorkflowName,
  savedWorkflowFileName,
  type SavedWorkflowEntry,
  type SavedWorkflowInvalidEntry,
  type SavedWorkflowMeta,
  type SavedWorkflowScope,
  type SavedWorkflowShadowing,
} from './contracts.js';
import { parseSavedWorkflow, serializeSavedWorkflow } from './frontmatter.js';

/** 一个查找根：作用域标签 + 绝对目录。 */
export interface SavedWorkflowRoot {
  scope: SavedWorkflowScope;
  dir: string;
}

/**
 * `savedWorkflowRoots` / 派生函数的可选参数。`homeDir` 只为测试注入：生产恒取
 * `os.homedir()`（agent 进程所在机器的家目录），**不**跟任何 storage.dir 配置走。
 */
export interface SavedWorkflowRootsOptions {
  homeDir?: string;
}

/**
 * 写项目档被拒时给出的原因。`savedWorkflowRoot` 与 `save` / `delete` 共用同一句，
 * 免得两处措辞漂移。
 */
export const PROJECT_SCOPE_NOT_A_SOURCE =
  'project-scope saved workflows are not loaded: .duya/workflows/ travels with a cloned repository, so it is not a definition source. Save to the global scope (~/.duya/workflows) instead — copying it there is the act of approving it.';

/**
 * 本次会话的查找根。**只有全局档**：项目档不再是定义来源（见文件头与
 * `PROJECT_SCOPE_NOT_A_SOURCE`）。
 *
 * 全局档落在家目录的 `~/.duya/workflows/` —— 那里只有用户自己放进去的东西。
 *
 * `cwd` 参数保留但不再参与计算：调用点（GUI 的定义面板、worker 的 runner）都按
 * `(cwd, options)` 的形状传参，留着它比让所有调用点改形更便宜。**别**因为它没被
 * 用到就以为还能靠它区分作用域。
 */
export function savedWorkflowRoots(_cwd: string, options?: SavedWorkflowRootsOptions): SavedWorkflowRoot[] {
  return [{ scope: 'global', dir: join(options?.homeDir ?? homedir(), SAVED_WORKFLOW_GLOBAL_DIR) }];
}

/**
 * 单个作用域的查找根。
 *
 * 找不到就是**调用方错了**，不是「该档为空」：作用域是已知枚举，而 project 档已经
 * 不再有根。所以这里抛错而不是返回 `undefined` —— 静默的 `undefined` 会一路走到
 * `join(undefined.dir)` 才炸，或者更糟：被 `root!` 断言吞掉，变成写到没人读的地方。
 */
export function savedWorkflowRoot(cwd: string, scope: SavedWorkflowScope, options?: SavedWorkflowRootsOptions): SavedWorkflowRoot {
  const root = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === scope);
  if (!root) throw new Error(PROJECT_SCOPE_NOT_A_SOURCE);
  return root;
}

/** 草稿目录（相对会话工作目录）的绝对落点。 */
export function savedWorkflowDraftsDir(cwd: string): string {
  return join(cwd, SAVED_WORKFLOW_DRAFTS_DIR);
}

/** 一个解析成功的保存定义。 */
export interface ResolvedSavedWorkflow {
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  meta: SavedWorkflowMeta;
  script: string;
  /**
   * 文件原文（元数据块 + 正文），**逐字节**。草稿拷贝拿的就是它：拷贝必须与刚读到的
   * 字节一模一样，重新序列化一遍会让 args 的默认值、注释与手写的 YAML 排版在拷贝里
   * 漂移，而那份拷贝正是模型接下来要按 path 回传的东西。
   */
  source: string;
  /** 正文之前的行数；诊断转成文件行时加它（见 parseSavedWorkflow）。 */
  bodyLineOffset: number;
}

export type SavedWorkflowResolveFailure =
  | { ok: false; reason: 'invalid_name'; detail: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'parse_error'; path: string; detail: string }
  | { ok: false; reason: 'read_error'; path: string; detail: string };

export type SavedWorkflowResolveResult =
  | ({ ok: true } & ResolvedSavedWorkflow)
  | SavedWorkflowResolveFailure;

export interface SavedWorkflowListResult {
  entries: SavedWorkflowEntry[];
  invalid: SavedWorkflowInvalidEntry[];
  /** 扫过的目录（本地绝对路径），即使目录还不存在也回：GUI 的文件监听靠它 watch。 */
  dirs: string[];
}

/**
 * 名字在两档查找根下的遮蔽事实（保存时算出，供确认窗展示）。返回 null 即无遮蔽。
 *
 * 单一档之后**恒为 null** —— 另一个作用域已经没有根了。留着这个形状而不是拆掉
 * 返回值：它跨 preload / IPC / GUI 三个面，拆协议的成本高于留一个恒 null 的字段。
 * 这是笔明确的债：真要拆，就该连 `SavedWorkflowShadowing` 类型和渲染层一起删。
 */
export function savedWorkflowShadowing(
  cwd: string,
  scope: SavedWorkflowScope,
  name: string,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowShadowing | null {
  const otherScope: SavedWorkflowScope = scope === 'project' ? 'global' : 'project';
  const otherRoot = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === otherScope);
  if (!otherRoot) return null;
  try {
    statSync(join(otherRoot.dir, savedWorkflowFileName(name)));
    return scope === 'project' ? 'hides_global' : 'hidden_by_project';
  } catch {
    return null;
  }
}

/**
 * 保存工作流的存储层。实例无状态（根目录每次从 cwd 现算），方法全同步。
 */
export class SavedWorkflowStore {
  /**
   * 名字 → 定义。**只查全局档**。失败四态与 ZCode core store 的 resolve 逐字对应。
   *
   * 找不到就是 `not_found`：项目档不再参与查找（见文件头），所以克隆来的
   * `.duya/workflows/x.dwf.ts` 不会因为会话 cwd 恰好落在那个仓库里而变成可运行项。
   */
  resolve(cwd: string, name: string, options?: SavedWorkflowRootsOptions): SavedWorkflowResolveResult {
    if (!isValidSavedWorkflowName(name)) {
      return { ok: false, reason: 'invalid_name', detail: `invalid workflow name: ${name}` };
    }
    for (const root of savedWorkflowRoots(cwd, options)) {
      const file = join(root.dir, savedWorkflowFileName(name));
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        continue; // 本档没有 → 查下一档；读错误与不存在在这里无法区分，统一走 not_found。
      }
      const parsed = parseSavedWorkflow(source);
      if (!parsed.ok) {
        return { ok: false, reason: 'parse_error', path: file, detail: `${parsed.reason}: ${parsed.detail}` };
      }
      return {
        ok: true,
        name,
        path: file,
        scope: root.scope,
        meta: parsed.meta,
        script: parsed.script,
        source,
        bodyLineOffset: parsed.bodyLineOffset,
      };
    }
    return { ok: false, reason: 'not_found' };
  }

  /**
   * 枚举全局档下的全部定义（不含脚本正文）。**不因为一个坏文件而失败**——坏文件进
   * `invalid`，指名道姓。
   */
  list(cwd: string, options?: SavedWorkflowRootsOptions): SavedWorkflowListResult {
    const entries: SavedWorkflowEntry[] = [];
    const invalid: SavedWorkflowInvalidEntry[] = [];
    const dirs: string[] = [];

    for (const root of savedWorkflowRoots(cwd, options)) {
      dirs.push(root.dir);
      let names: string[];
      try {
        names = readdirSync(root.dir);
      } catch {
        continue; // 目录还不存在 = 该档为空，不是错误。
      }
      for (const fileName of names) {
        if (!fileName.endsWith(SAVED_WORKFLOW_FILE_EXTENSION)) continue;
        const name = fileName.slice(0, -SAVED_WORKFLOW_FILE_EXTENSION.length);
        if (!isValidSavedWorkflowName(name)) {
          invalid.push({ path: join(root.dir, fileName), reason: 'invalid_name' });
          continue;
        }
        const file = join(root.dir, fileName);
        let source: string;
        try {
          source = readFileSync(file, 'utf8');
        } catch (err) {
          invalid.push({
            path: file,
            reason: `read_error: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
        const parsed = parseSavedWorkflow(source);
        if (!parsed.ok) {
          invalid.push({ path: file, reason: `${parsed.reason}: ${parsed.detail}` });
          continue;
        }
        const entry: SavedWorkflowEntry = {
          name,
          description: parsed.meta.description,
          ...(parsed.meta.whenToUse !== undefined ? { whenToUse: parsed.meta.whenToUse } : {}),
          ...(parsed.meta.args !== undefined ? { args: parsed.meta.args } : {}),
          scope: root.scope,
          path: file,
        };
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, invalid, dirs };
  }

  /**
   * 保存（或覆盖）一个定义到指定档。原子写：先写临时文件再 rename，崩在半路也不会
   * 留下一个半截文件冒充合法定义。返回文件绝对路径与遮蔽事实（供确认窗展示）。
   *
   * `scope: 'project'` 会**抛错**（`PROJECT_SCOPE_NOT_A_SOURCE`）：项目档不再有根，
   * 而静默写到没人读的地方正是这个改动要消灭的那种失败。调用方要自己把默认值改成
   * global，不要靠这里兜。
   */
  save(
    cwd: string,
    name: string,
    meta: SavedWorkflowMeta,
    script: string,
    scope: SavedWorkflowScope,
    options?: SavedWorkflowRootsOptions,
  ): { path: string; shadowing: SavedWorkflowShadowing | null } {
    if (!isValidSavedWorkflowName(name)) {
      throw new Error(`invalid workflow name: ${name}`);
    }
    const root = savedWorkflowRoot(cwd, scope, options);
    mkdirSync(root.dir, { recursive: true });
    const file = join(root.dir, savedWorkflowFileName(name));
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, serializeSavedWorkflow(meta, script), 'utf8');
    try {
      renameSync(tmp, file);
    } catch {
      rmSync(tmp, { force: true });
      throw new Error(`failed to save workflow "${name}"`);
    }
    return { path: file, shadowing: savedWorkflowShadowing(cwd, scope, name, options) };
  }

  /** 删除指定档里的一个定义。返回是否真的删了东西。`scope: 'project'` 同 `save`，抛错。 */
  delete(cwd: string, name: string, scope: SavedWorkflowScope, options?: SavedWorkflowRootsOptions): boolean {
    if (!isValidSavedWorkflowName(name)) return false;
    const root = savedWorkflowRoot(cwd, scope, options);
    const file = join(root.dir, savedWorkflowFileName(name));
    try {
      statSync(file);
    } catch {
      return false;
    }
    rmSync(file, { force: true });
    return true;
  }
}
