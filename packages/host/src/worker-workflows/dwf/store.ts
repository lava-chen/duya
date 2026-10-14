/**
 * store.ts — dwf 保存工作流的存储层：作用域根目录 + 解析 / 枚举 / 写入
 * （对照 ZCode saved-workflows/store.ts，目录由 `.zcode` 换成 `.duya`）。
 *
 * 全部是**同步** fs。理由不是图省事：确认窗的 prepareApproval 契约是同步的，而以
 * `saved` 源发起的 run 必须在弹窗**之前**把脚本读出来——没有脚本就没有因果图，用户
 * 就会在一个空窗口上批准执行。这些文件是本地的、单个的、以 KB 计的，同步读的代价
 * 远小于为它另开一条异步审批路径。
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
  SAVED_WORKFLOW_PROJECT_DIR,
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
 * 本次会话的查找根，**按优先级排列**：`[project, global]`。
 *
 * 项目档落在会话工作目录的 `.duya/workflows/`，全局档落在家目录的 `~/.duya/workflows/`。
 * 所有查找按顺序 first-wins：项目里的那份永远赢过全局那份（同名遮蔽）。
 */
export function savedWorkflowRoots(cwd: string, options?: SavedWorkflowRootsOptions): SavedWorkflowRoot[] {
  return [
    { scope: 'project', dir: join(cwd, SAVED_WORKFLOW_PROJECT_DIR) },
    { scope: 'global', dir: join(options?.homeDir ?? homedir(), SAVED_WORKFLOW_GLOBAL_DIR) },
  ];
}

/** 单个作用域的查找根。作用域是已知枚举，`savedWorkflowRoots` 里必然有它。 */
export function savedWorkflowRoot(cwd: string, scope: SavedWorkflowScope, options?: SavedWorkflowRootsOptions): SavedWorkflowRoot {
  const root = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === scope);
  // scope 是 SavedWorkflowScope 枚举成员，roots 覆盖全部成员，find 不会落空。
  return root!;
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
 */
export function savedWorkflowShadowing(
  cwd: string,
  scope: SavedWorkflowScope,
  name: string,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowShadowing | null {
  const otherScope: SavedWorkflowScope = scope === 'project' ? 'global' : 'project';
  const otherRoot = savedWorkflowRoot(cwd, otherScope, options);
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
   * 名字 → 定义。查找顺序 project → global，first-wins。
   * 失败四态与 ZCode core store 的 resolve 逐字对应。
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
   * 枚举两档下的全部定义（不含脚本正文）。**不因为一个坏文件而失败**——坏文件进
   * `invalid`，指名道姓；同名时项目档遮蔽全局档。
   */
  list(cwd: string, options?: SavedWorkflowRootsOptions): SavedWorkflowListResult {
    const entries: SavedWorkflowEntry[] = [];
    const invalid: SavedWorkflowInvalidEntry[] = [];
    const dirs: string[] = [];
    const byName = new Map<string, SavedWorkflowEntry>();

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
        if (byName.has(name)) continue; // 项目档先扫（roots 有序），后来者是被遮蔽的全局档。
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
        byName.set(name, entry);
        entries.push(entry);
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, invalid, dirs };
  }

  /**
   * 保存（或覆盖）一个定义到指定档。原子写：先写临时文件再 rename，崩在半路也不会
   * 留下一个半截文件冒充合法定义。返回文件绝对路径与遮蔽事实（供确认窗展示）。
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

  /** 删除指定档里的一个定义。返回是否真的删了东西。 */
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
