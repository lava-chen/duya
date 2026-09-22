/**
 * frontmatter.ts — dwf 保存文件的头编解码（对照 ZCode saved-workflows/frontmatter.ts）。
 *
 * 文件形状：
 *
 *     /* duya-workflow
 *     description: ...
 *     args:
 *       pr: { type: string, required: true }
 *     （块注释收尾）
 *     <plain dwf script>
 *
 * 为什么是**块注释**而不是 Markdown 那样的 `---` 围栏：保存的文件扩展名是 `.dwf.ts`，
 * 用户会在编辑器里打开它、也可能直接手改。块注释让整个文件仍是合法 TypeScript，于是
 * 高亮、括号匹配、格式化全都照常工作；`---` 会把文件第一行就变成语法错误。
 *
 * body 用 YAML 而不是 JSON：`yaml` 已经是 @duya/agent 的直接依赖（不新增依赖），而
 * 手改一段 YAML 比手改一段带引号和逗号的 JSON 容错得多——这个文件的读者是人。
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { SavedWorkflowMetaSchema, type SavedWorkflowMeta } from './contracts.js';

/** frontmatter 的开启标记。必须是文件的第一段非空白内容。 */
export const SAVED_WORKFLOW_SENTINEL = '/* duya-workflow';

/** frontmatter 的结束标记：一行只有块注释的收尾符。 */
const SAVED_WORKFLOW_TERMINATOR = '*/';

export type SavedWorkflowParseErrorReason =
  | 'missing_frontmatter'
  | 'unterminated_frontmatter'
  | 'invalid_yaml'
  | 'invalid_metadata';

export type SavedWorkflowParseResult =
  | {
      ok: true;
      meta: SavedWorkflowMeta;
      /** 终止行之后的脚本本体，逐字节。 */
      script: string;
      /**
       * 正文之前有多少行（前导空行 + 起始标记 + YAML + 终止行）。诊断按**文件行**
       * 报出来时就要加它：`fileLine = bodyLine + bodyLineOffset`。编译看的是终止行
       * 之后那一段，所以两套行号必然相差这个常数；让每个调用点自己数一遍，是
       * 「诊断行号对不上文件」这种 bug 的标准产地。
       */
      bodyLineOffset: number;
    }
  | { ok: false; reason: SavedWorkflowParseErrorReason; detail: string };

/**
 * 元数据 + 脚本 → 文件正文。
 *
 * 脚本**逐字节**放在终止行之后：保存再读回来必须拿到作者写的那一份，否则 run 的
 * 脚本哈希与用户在编辑器里看到的东西对不上（resume 的比对基准正是脚本原文）。
 */
export function serializeSavedWorkflow(meta: SavedWorkflowMeta, script: string): string {
  // 键序固定（description → whenToUse → args）而不是随对象字面量的插入序：保存两次
  // 要得到逐字节相同的文件，否则每次保存都在 git 里造一个无意义的 diff。
  const body: Record<string, unknown> = { description: meta.description };
  if (meta.whenToUse !== undefined) body.whenToUse = meta.whenToUse;
  if (meta.args !== undefined) body.args = meta.args;

  // stringify 自带尾换行，所以终止行直接跟在它后面。
  return `${SAVED_WORKFLOW_SENTINEL}\n${stringifyYaml(body)}${SAVED_WORKFLOW_TERMINATOR}\n${script}`;
}

/**
 * 文件正文 → 元数据 + 脚本。
 *
 * 四种失败各有各的名字，因为它们要给用户不同的建议：没有 frontmatter 是"这不是一个
 * 保存的 workflow"，没闭合是"你删掉了一行"，YAML 坏是"缩进错了"，schema 不过是
 * "字段名写错了"。一个笼统的 "parse error" 三种情况都帮不上忙。
 */
export function parseSavedWorkflow(source: string): SavedWorkflowParseResult {
  const lines = source.split('\n');

  let start = 0;
  while (start < lines.length && lines[start]!.trim() === '') start += 1;
  if (start >= lines.length || lines[start]!.trim() !== SAVED_WORKFLOW_SENTINEL) {
    return {
      ok: false,
      reason: 'missing_frontmatter',
      detail: `file does not start with the \`${SAVED_WORKFLOW_SENTINEL}\` metadata block`,
    };
  }

  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== SAVED_WORKFLOW_TERMINATOR) end += 1;
  if (end >= lines.length) {
    return {
      ok: false,
      reason: 'unterminated_frontmatter',
      detail: `metadata block is never closed with \`${SAVED_WORKFLOW_TERMINATOR}\``,
    };
  }

  const bodyText = lines.slice(start + 1, end).join('\n');
  // 终止行之后的一切都是脚本，原样保留（末行无换行的文件同样成立：slice 给出空数组）。
  const script = lines.slice(end + 1).join('\n');

  let body: unknown;
  try {
    body = parseYaml(bodyText);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_yaml',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = SavedWorkflowMetaSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid_metadata',
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    };
  }

  // 正文从终止行的下一行开始，所以它前面正好有 `end + 1` 行。
  return { ok: true, meta: parsed.data, script, bodyLineOffset: end + 1 };
}
