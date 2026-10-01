/**
 * contracts.ts — dwf saved-workflow 词汇表（对照 ZCode contracts/src/tools/saved-workflow.ts）。
 *
 * 本模块**只**声明「一个保存的 dwf workflow 是什么」：名字的合法形状、文件落点、
 * 参数声明与元数据。存储层（./store.ts）与编解码（./frontmatter.ts）都从这里取
 * schema——元数据形状一旦在写侧与读侧各自演化，症状是「刚保存的 workflow 列不出来」。
 *
 * 与 duya 旧 YAML registry（../workflow-files.ts）的差异：
 *   - 文件从纯数据（.yaml）升级为「frontmatter + TS 脚本本体」（.dwf.ts）；
 *   - args 从数组改为 record（对齐 ZCode，键即参数名，O(1) 查找）；
 *   - 作用域仍两档，目录由 `.zcode` 换成 `.duya`。
 */

import { z } from 'zod';

// ─── 文件形状 ───

/**
 * 保存文件的扩展名。`.dwf.ts` 而不是 `.ts`：编辑器按 TypeScript 高亮（frontmatter
 * 是块注释，语法上合法），而 `.dwf` 这一段让扫描不必打开文件就能把它与项目源码区分开。
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = '.dwf.ts';

/**
 * 全局作用域的存放目录（相对 agent 进程的家目录）。落点
 * `~/.duya/workflows/<name>.dwf.ts`，对所有项目可见。
 *
 * 这是**唯一**的作用域根。项目档（原 `.duya/workflows/`，相对会话工作目录）连同它的
 * 常量一起删掉了：它随 `git clone` 进来，所以不是定义来源（plan 583 (c)）。留着一个
 * 没人读的常量，会让下一个读代码的人以为那条路还能走。
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = '.duya/workflows';

/**
 * 草稿目录（相对会话工作目录）。模型在两次提交之间就地编辑的脚本文件落在这里，是
 * `.duya/workflows/`（用户保存的定义）的兄弟目录，机器自有、自带 `.gitignore: *`。
 */
export const SAVED_WORKFLOW_DRAFTS_DIR = '.duya/workflow-drafts';

// ─── 名字 ───

/**
 * 名字的合法形状。沿用 duya 旧 registry 的 kebab-case（assertName 同一条正则）——
 * 名字要同时当文件名用，所以斜杠、`..`、空白一概不允许：这条正则**就是**路径穿越
 * 的防线，不是风格偏好。
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/** 名字长度上限。文件名要在各平台都成立，64 远在任何 PATH_MAX 之内且足够描述性。 */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/** 名字是否可用作文件名（即是否可能指向一个保存的 workflow）。 */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // `.` 与 `..` 通过了上面的字符集检查却是目录项，不是名字（kebab-case 下不可达，
  // 保留这行防御以防正则将来放宽）。
  return name.replaceAll('.', '').length > 0;
}

// ─── 作用域 ───

/**
 * 作用域的词汇表。**只有 `global` 真正可写可读**（`~/.duya/workflows/`）。
 *
 * `'project'` 仍留在类型里，但**不再有根**（plan 583 (c)）：它必须留着，否则
 * `save` / `delete` / IPC 里那条「显式拒绝 project 档」的分支在类型上不可达，也就
 * 无法被测。运行时的实际行为是：传 `'project'` → 抛
 * `PROJECT_SCOPE_NOT_A_SOURCE`（或 IPC 回错），不是静默重定向。
 */
export const SAVED_WORKFLOW_SCOPES = ['project', 'global'] as const;
export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);
export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * 遮蔽事实：另一档已有同名定义。`hides_global` / `hidden_by_project`。
 *
 * **单一档之后这两个值已经不可能产生** —— 另一档没有根了。类型留着是因为它跨
 * preload / IPC / GUI 三个面，拆协议的成本高于留一个恒 null 的字段
 * （`savedWorkflowShadowing` 现在恒返回 `null`）。这是笔明确的债，不是描述现状。
 */
export const SAVED_WORKFLOW_SHADOWING = ['hides_global', 'hidden_by_project'] as const;
export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);
export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

// ─── 参数声明 ───

/**
 * 参数的类型词汇表。三个原语加一个 `json` 兜底：原语能被校验成"传错了"，`json`
 * 明确表示"这里什么都收"，于是「没校验」与「不校验」在声明里就是两件不同的事。
 */
export const SAVED_WORKFLOW_ARG_TYPES = ['string', 'number', 'boolean', 'json'] as const;
export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);
export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema,
    /** 这个参数是什么意思，给后来调用的人看。 */
    description: z.string().optional(),
    /** true 时没有这个参数 workflow 就不能运行。 */
    required: z.boolean().optional(),
    /**
     * 调用方省略该参数时使用的值。刻意是 unknown 而不是按 `type` 判别的联合：
     * 默认值的类型正确性由 validateWorkflowArgs 在**应用默认值之后**与传入值走
     * 同一条校验，一处规则而不是两处。
     */
    default: z.unknown().optional(),
  })
  .strict();
export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

export const SavedWorkflowArgsDeclarationSchema = z.record(
  z.string(),
  SavedWorkflowArgDeclarationSchema,
);
export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

// ─── frontmatter 元数据 ───

/**
 * frontmatter 里的元数据体。`.strict()` 让「拼错一个键」成为一条可见的 invalid 行，
 * 而不是一个被静默丢弃的字段——保存的文件是用户会手改的，错字必须能被指出来。
 */
export const SavedWorkflowMetaSchema = z
  .object({
    description: z.string().min(1),
    whenToUse: z.string().min(1).optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();
export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

// ─── 列表条目 ───

/** 列表里的一行：元数据 + 落点，**不含脚本正文**（枚举不是读取）。 */
export const SavedWorkflowEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    scope: SavedWorkflowScopeSchema,
    path: z.string().min(1),
  })
  .strict();
export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * 一个存在但读不出来的文件。列表**不因为一个坏文件而失败**：用户手改坏了一个
 * frontmatter 时，其余 workflow 必须照常可用，而那个坏文件必须被指名道姓，
 * 否则它只是消失了。
 */
export interface SavedWorkflowInvalidEntry {
  path: string;
  reason: string;
}

/** 名字 → 文件名。名字已经过 {@link isValidSavedWorkflowName}，此处不再兜底。 */
export function savedWorkflowFileName(name: string): string {
  return `${name}${SAVED_WORKFLOW_FILE_EXTENSION}`;
}
