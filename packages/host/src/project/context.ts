/**
 * context.ts — the bounded, prompt-ready view of a project.
 *
 * The durable ledger holds more than any one turn should carry. This module
 * decides what a Coordinator or work Session sees now: current state and next
 * step first, then accepted decisions, active memories ranked against the
 * current task, open tasks, and recent activity — each with the source it came
 * from so a later reader can cite or re-read the original.
 */

import type {
  ProjectContinuitySnapshot,
  ProjectContinuitySource,
} from '@duya/agent-protocol/projects';
import type { ProjectActivityRow } from '@duya/data/project-store';
import { assembleProjectContinuityContext, rankProjectMemory } from '@duya/memory';

export interface BuildProjectContextInput {
  readonly snapshot: ProjectContinuitySnapshot;
  readonly recentActivity: readonly ProjectActivityRow[];
  readonly taskId?: string;
  readonly maxCharacters?: number;
}

export interface ProjectContext {
  readonly text: string;
  readonly sourceRefs: readonly ProjectContinuitySource[];
}

export function buildProjectContext(input: BuildProjectContextInput): ProjectContext {
  const { snapshot, recentActivity } = input;
  const taskId = input.taskId;
  const task = taskId ? snapshot.tasks.find((row) => row.link.taskId === taskId)?.task : null;
  const relevantTasks = taskId
    ? snapshot.tasks.filter((row) => row.link.taskId === taskId)
    : snapshot.tasks.filter(({ task: item, link }) => item && (item.status !== 'completed' || link.acceptanceStatus === 'pending'));
  const accepted = snapshot.decisions.filter((item) => item.status === 'accepted');
  const memories = rankProjectMemory(snapshot.memories.filter((item) => item.status === 'active')
    .map((item) => ({ ...item, sourceType: item.source.type, sourceId: item.source.id })), task ? `${task.subject} ${task.description}` : '').slice(0, 20);
  const activity = recentActivity.map((item) => ({
    key: String(item.event_id),
    content: `${item.event_type}${item.task_id ? ` · task ${item.task_id}` : ''}${item.session_id ? ` · session ${item.session_id}` : ''}`,
    sourceType: item.source_type, sourceId: item.source_id, updatedAt: item.created_at,
  }));
  const text = assembleProjectContinuityContext({
    projectName: snapshot.project.name || snapshot.project.project_id,
    ...(snapshot.state ? { currentState: snapshot.state.currentState, nextStep: snapshot.state.nextStep } : {}),
    decisions: accepted.map((item) => ({ key: item.key, content: item.content, sourceType: item.source.type, sourceId: item.source.id, updatedAt: item.updatedAt })),
    memories,
    recentActivity: activity,
    ...(relevantTasks.length ? { taskBrief: relevantTasks.map(({ task: item, link }) => item
      ? `- ${item.id} [${item.status}; acceptance=${link.acceptanceStatus}] ${item.subject}${link.workSessionId ? ` (work session ${link.workSessionId})` : ''}\n  ${item.description}`
      : `- ${link.taskId} [Task record unavailable; acceptance=${link.acceptanceStatus}]${link.workSessionId ? ` (work session ${link.workSessionId})` : ''}`).join('\n') } : {}),
    ...(input.maxCharacters === undefined ? {} : { maxCharacters: input.maxCharacters }),
  });
  const sourceRefs: ProjectContinuitySource[] = [
    ...(snapshot.state ? [snapshot.state.source] : []),
    ...accepted.map((item) => item.source),
    ...memories.map((item) => ({ type: item.sourceType, id: item.sourceId })),
    ...activity.map((item) => ({ type: item.sourceType, id: item.sourceId })),
    ...(task ? [{ type: 'task', id: task.id }] : []),
  ];
  return { text, sourceRefs };
}
