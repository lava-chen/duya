// src/lib/open-workflow-node-panel-event.ts
// Broadcast intent to open ONE workflow node's dedicated detail view in the
// sidebar (`workflow` panel page, run-detail sub-view focused on the node).
// Mirrors the `duya:open-workflow-run-panel` contract: emitters only carry
// { runId, nodeId? }; usePanel opens/activates the workflow page and the
// panel component listens for the same event to switch to the run detail
// (reused tabs keep frozen params, so the event is the re-open path).
//
// `nodeId` is the journal record's nodeId — the stage-rail chip key for
// per-kind chips (agent / decision / human / browser). Aggregate chips
// (「脚本」) have no single node behind them and keep opening the run detail.

export const OPEN_WORKFLOW_NODE_PANEL_EVENT = "duya:open-workflow-node-panel";

export interface OpenWorkflowNodePanelDetail {
  runId: string;
  nodeId: string;
}

export function dispatchOpenWorkflowNodePanel(runId: string, nodeId: string): void {
  if (typeof window === "undefined") return;
  const rid = runId.trim();
  const nid = nodeId.trim();
  if (!rid || !nid) return;
  window.dispatchEvent(
    new CustomEvent<OpenWorkflowNodePanelDetail>(OPEN_WORKFLOW_NODE_PANEL_EVENT, {
      detail: { runId: rid, nodeId: nid },
    }),
  );
}
