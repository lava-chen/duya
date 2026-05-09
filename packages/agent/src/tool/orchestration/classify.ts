import { ToolBatch } from './types.js'

const TOOL_BATCH_MAP: Record<string, ToolBatch> = {
  // READ batch — 只读，可并行
  read: ToolBatch.READ,
  grep: ToolBatch.READ,
  glob: ToolBatch.READ,
  web_search: ToolBatch.READ,
  web_fetch: ToolBatch.READ,
  list_mcp_resources: ToolBatch.READ,
  read_mcp_resource: ToolBatch.READ,
  task_get: ToolBatch.READ,
  task_list: ToolBatch.READ,
  task_output: ToolBatch.READ,
  lsp: ToolBatch.READ,
  repl: ToolBatch.READ,
  skill: ToolBatch.READ,
  brief: ToolBatch.READ,
  browser: ToolBatch.READ,
  session_search: ToolBatch.READ,
  config: ToolBatch.READ,

  // WRITE batch — 修改文件系统，串行
  write: ToolBatch.WRITE,
  edit: ToolBatch.WRITE,
  task_create: ToolBatch.WRITE,
  task_update: ToolBatch.WRITE,
  skill_manage: ToolBatch.WRITE,
  cron: ToolBatch.WRITE,
  memory: ToolBatch.WRITE,

  // SYSTEM batch — 独占执行
  bash: ToolBatch.SYSTEM,
  Agent: ToolBatch.SYSTEM,
  Task: ToolBatch.SYSTEM,
  enter_worktree: ToolBatch.SYSTEM,
  exit_worktree: ToolBatch.SYSTEM,
  enter_plan_mode: ToolBatch.SYSTEM,
  exit_plan_mode: ToolBatch.SYSTEM,
  task_stop: ToolBatch.SYSTEM,
  team_create: ToolBatch.SYSTEM,
  team_delete: ToolBatch.SYSTEM,
  show_widget: ToolBatch.SYSTEM,

  // Conductor tools — 独占
  conductor_get_snapshot: ToolBatch.SYSTEM,
  conductor_update_widget_data: ToolBatch.SYSTEM,
  conductor_create_widget: ToolBatch.SYSTEM,
  conductor_suggest_widget: ToolBatch.SYSTEM,
  conductor_move_widget: ToolBatch.SYSTEM,
  conductor_delete_widget: ToolBatch.SYSTEM,
  conductor_auto_layout: ToolBatch.SYSTEM,

  // Canvas Orchestrator V2 tools — 独占
  canvas_create_element: ToolBatch.SYSTEM,
  canvas_update_element: ToolBatch.SYSTEM,
  canvas_delete_element: ToolBatch.SYSTEM,
  canvas_arrange_elements: ToolBatch.SYSTEM,
  canvas_get_snapshot: ToolBatch.SYSTEM,
}

export function classifyTool(toolName: string): ToolBatch {
  const batch = TOOL_BATCH_MAP[toolName]
  if (batch !== undefined) return batch

  // Fail-closed: unknown tools default to SYSTEM (most restrictive)
  console.warn(
    `[ToolOrchestration] Unknown tool "${toolName}" — classifying as SYSTEM batch (fail-closed)`,
  )
  return ToolBatch.SYSTEM
}