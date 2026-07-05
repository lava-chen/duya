import { ToolBatch } from './types.js'

const TOOL_BATCH_MAP: Record<string, ToolBatch> = {
  // READ batch — 只读，可并行
  read: ToolBatch.READ,
  grep: ToolBatch.READ,
  glob: ToolBatch.READ,
  browser: ToolBatch.READ,
  vision_analyze: ToolBatch.READ,
  duya_sessions: ToolBatch.READ,
  duya_info: ToolBatch.READ,
  duya_restart: ToolBatch.READ,
  duya_health: ToolBatch.READ,
  duya_logs: ToolBatch.READ,

  // Skill tools — READ (查询/调用)
  skill: ToolBatch.READ,
  Skill: ToolBatch.READ,
  skill_manage: ToolBatch.WRITE,

  // Brief — READ
  brief: ToolBatch.READ,
  Brief: ToolBatch.READ,

  // Session search — READ
  session_search: ToolBatch.READ,
  SessionSearch: ToolBatch.READ,

  // Task tool — READ (all actions go through the unified Task tool)
  task: ToolBatch.READ,
  Task: ToolBatch.READ,

  // MCP resource tools — READ
  list_mcp_resources: ToolBatch.READ,
  ListMcpResources: ToolBatch.READ,
  read_mcp_resource: ToolBatch.READ,
  ReadMcpResource: ToolBatch.READ,

  // Web tools (disabled but keep mapping for safety)
  web_search: ToolBatch.READ,
  web_fetch: ToolBatch.READ,

  // WRITE batch — 修改文件系统，串行
  write: ToolBatch.WRITE,
  edit: ToolBatch.WRITE,
  cron: ToolBatch.WRITE,
  memory: ToolBatch.WRITE,
  Memory: ToolBatch.WRITE,

  // SYSTEM batch — 独占执行
  bash: ToolBatch.SYSTEM,
  powershell: ToolBatch.SYSTEM,
  Agent: ToolBatch.SYSTEM,
  TeamCreate: ToolBatch.SYSTEM,
  TeamDelete: ToolBatch.SYSTEM,
  show_widget: ToolBatch.SYSTEM,
  SwitchMode: ToolBatch.SYSTEM,

  // Worktree tools — SYSTEM
  enter_worktree: ToolBatch.SYSTEM,
  EnterWorktree: ToolBatch.SYSTEM,
  exit_worktree: ToolBatch.SYSTEM,
  ExitWorktree: ToolBatch.SYSTEM,

  // Plan mode tools — SYSTEM
  enter_plan_mode: ToolBatch.SYSTEM,
  EnterPlanMode: ToolBatch.SYSTEM,
  exit_plan_mode: ToolBatch.SYSTEM,
  ExitPlanMode: ToolBatch.SYSTEM,

  // Canvas Conductor tools (plan 221) — SYSTEM (mutate canvas state)
  canvas_create_element: ToolBatch.SYSTEM,
  canvas_delete_element: ToolBatch.SYSTEM,
  canvas_move_element: ToolBatch.SYSTEM,
  canvas_resize_element: ToolBatch.SYSTEM,
  canvas_fill_content: ToolBatch.SYSTEM,
  canvas_style_element: ToolBatch.SYSTEM,
  // canvas_capture is read-only but kept SYSTEM to avoid parallel
  // screenshot races on the html2canvas renderer.
  canvas_capture: ToolBatch.SYSTEM,

  // Legacy Canvas Orchestrator tools — kept for backward compat.
  // canvas_update_element / canvas_arrange_elements / canvas_get_snapshot /
  // canvas_align / canvas_layout_grid are no longer registered by plan 221
  // but remain in the batch map so any stale references classify safely.
  canvas_update_element: ToolBatch.SYSTEM,
  canvas_arrange_elements: ToolBatch.SYSTEM,
  canvas_get_snapshot: ToolBatch.SYSTEM,
  canvas_align: ToolBatch.SYSTEM,
  canvas_layout_grid: ToolBatch.SYSTEM,
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
