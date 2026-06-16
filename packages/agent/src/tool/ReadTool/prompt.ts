/**
 * ReadTool Prompt
 *
 * Text-format instructions and tool description used to enrich the
 * tool's prompt at runtime. Most of the description is also embedded
 * in the input_schema of ReadTool.ts.
 */

export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

export const OFFSET_INSTRUCTION_TARGETED =
  '- When you already know which part of the file you need, only read that part. This can be important for larger files.'

/**
 * Renders the Read tool prompt template.  The caller (ReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
  offsetInstruction: string,
): string {
  const BASH_TOOL_NAME = 'Bash'
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file${maxSizeInstruction}
${offsetInstruction}
${lineFormat}
- This tool can read PDFs (.pdf). Use the \`pages\` parameter to read specific page ranges (e.g. pages: "1-5"). For scanned PDFs without embedded text, image extraction may be limited; use the vision tool for visual analysis.
- This tool can read Word documents (.docx) and PowerPoint files (.pptx), extracting their text content along with any embedded images.
- This tool can read image files (PNG, JPEG, GIF, WebP). The tool returns the image as a base64 attachment plus metadata; use the vision tool when you need to reason about the image content.
- This tool can read Jupyter notebooks (.ipynb files). It returns a per-cell summary header, then each cell as \`<cell id="cell-N"><language>python</language>source</cell id="cell-N">\`. Code cell outputs are included unless they exceed 10KB (replaced with a jq hint). Use the \`cell_range\` parameter to read a 1-indexed inclusive subset (e.g. \`cell_range: {start: 5, end: 15}\`, end=-1 for to-end). Image outputs (matplotlib etc.) are written to \`<notebook>.cells/\` and surfaced via the vision tool.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
}
