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

  // Brief — READ
  brief: ToolBatch.READ,
  Brief: ToolBatch.READ,

  // Session search — READ
  session_search: ToolBatch.READ,
  SessionSearch: ToolBatch.READ,

  // Task tool — READ (all actions go through the unified Task tool)
  task: ToolBatch.READ,
  Task: ToolBatch.READ,

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
  show_widget: ToolBatch.SYSTEM,
  SwitchMode: ToolBatch.SYSTEM,

  // duya_cli — unified CLI control-plane entry point (plan 99). It can
  // perform both reads (list/info/status) and writes (config set, mcp add,
  // cron create), so it is pinned to SYSTEM (exclusive, serial) to keep
  // the same semantics the fail-closed default already gave it while
  // silencing the "Unknown tool" warning on every call.
  duya_cli: ToolBatch.SYSTEM,

  // Plan mode tools — SYSTEM
  enter_plan_mode: ToolBatch.SYSTEM,
  EnterPlanMode: ToolBatch.SYSTEM,
  exit_plan_mode: ToolBatch.SYSTEM,
  ExitPlanMode: ToolBatch.SYSTEM,

  // Computer Use tool (plan 454) — SYSTEM (exclusive, serial). Desktop
  // actions drive shared OS state (mouse position, keyboard focus);
  // parallel clicks/drag would interleave and corrupt the gesture.
  computer_use: ToolBatch.SYSTEM,

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

  // MCP-derived tools (provider names always start with the `mcp_` prefix,
  // see computeProviderName) are external server calls. They are not in the
  // static map, but treat them as READ so independent MCP queries can run in
  // parallel and no misleading "Unknown tool" warning is logged per call.
  if (toolName.startsWith('mcp_')) return ToolBatch.READ

  // Fail-closed: unknown tools default to SYSTEM (most restrictive)
  console.warn(
    `[ToolOrchestration] Unknown tool "${toolName}" — classifying as SYSTEM batch (fail-closed)`,
  )
  return ToolBatch.SYSTEM
}
