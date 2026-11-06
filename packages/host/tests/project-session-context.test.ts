import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreDataHost } from '@duya/data';
import { createHostProjectApi } from '../src/project-api.js';
import { createProjectToolService } from '../src/project/tool-service.js';
import { buildProjectContext } from '../src/project/context.js';
import { buildProjectSessionContextBlock } from '../src/worker-context/project-context.js';

const roots: string[] = [];
const databases: CoreDataHost[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'duya-project-prompt-'));
  roots.push(root);
  const db = new CoreDataHost({
    filename: join(root, 'core.db'), rolloutRoot: join(root, 'sessions'), attachmentsRoot: join(root, 'attachments'),
    messageLogPorts: { botSessionIdPrefix: 'bot:', parseBotSessionId: () => null,
      getBotSessionLogPath: (id, base) => join(base, id, 'sessions.jsonl'), getBotSessionsDir: (id, base) => join(base, id) },
  });
  databases.push(db);
  const { projects, tasks, sessions } = db.stores;
  for (const id of ['coordinator', 'work', 'other-work', 'unbound', 'replacement']) sessions.create({ id, workingDirectory: root });
  const project = projects.insert({ canonical_root: root, name: 'Prompt probe' });
  projects.bindCoordinatorSession(project.project_id, 'coordinator');
  for (const [id, session] of [['task', 'work'], ['other-task', 'other-work']]) {
    tasks.create({ id, sessionId: 'coordinator', subject: id, description: `brief-${id}`, status: 'in_progress' });
    projects.bindTask(project.project_id, id, 'coordinator');
    projects.bindWorkSession(project.project_id, id, session);
  }
  const api = createHostProjectApi(projects, tasks);
  const service = createProjectToolService({ stores: { projects }, projectApi: api });
  return { projects, tasks, api, service, projectId: project.project_id };
}

describe('Session-bound project prompt context over the real store', () => {
  it('scopes work to its Task and does not infer membership from an identical cwd', async () => {
    const { service } = fixture();
    const work = await service.getSessionContext('work');
    expect(work).toMatchObject({ role: 'work', taskId: 'task' });
    expect(work?.text).toContain('brief-task');
    expect(work?.text).not.toContain('other-task');
    expect(await service.getSessionContext('unbound')).toBeNull();
    const coordinator = await service.getSessionContext('coordinator');
    expect(coordinator?.text).toContain('other-task');
  });

  it('re-reads a replacement Coordinator binding and revision instead of caching a conversation', async () => {
    const { service, projects, api, projectId } = fixture();
    await api.updateProjectState({ projectId, expectedRevision: 0, currentState: 'first-marker', nextStep: 'review', source: { type: 'session', id: 'coordinator' } });
    expect((await service.getSessionContext('coordinator'))?.text).toContain('revision 1');
    projects.bindCoordinatorSession(projectId, 'replacement');
    expect(await service.getSessionContext('coordinator')).toBeNull();
    expect((await service.getSessionContext('replacement'))?.text).toContain('first-marker');
  });

  it('keeps accepted/active records and only cites records that fit the budget', async () => {
    const { api, projectId } = fixture();
    await api.updateProjectDecision({ projectId, key: 'accepted', content: 'accepted-marker', status: 'accepted', expectedRevision: 0, source: { type: 'user_message', id: 'accepted-source' } });
    await api.updateProjectDecision({ projectId, key: 'proposal', content: 'proposal-marker', status: 'proposed', expectedRevision: 0, source: { type: 'session', id: 'proposal-source' } });
    await api.updateProjectMemory({ projectId, key: 'huge', content: 'X'.repeat(3900), status: 'active', expectedRevision: 0, source: { type: 'user_message', id: 'omitted-source' } });
    const snapshot = (await api.getProjectContinuity(projectId))!;
    const bounded = buildProjectContext({ snapshot, recentActivity: [], maxCharacters: 900 });
    expect(bounded.text.length).toBeLessThanOrEqual(900);
    expect(bounded.text).toContain('accepted-marker');
    expect(bounded.text).not.toContain('proposal-marker');
    expect(bounded.text).toContain('Context truncated');
    expect(bounded.sourceRefs).toContainEqual({ type: 'user_message', id: 'accepted-source' });
    expect(bounded.sourceRefs).not.toContainEqual({ type: 'user_message', id: 'omitted-source' });
    expect(bounded.sourceRefs).not.toContainEqual({ type: 'session', id: 'proposal-source' });
    for (const budget of [200, 500, 16000]) expect(buildProjectContext({ snapshot, recentActivity: [], maxCharacters: budget }).text.length).toBeLessThanOrEqual(budget);
  });

  it('keeps missing Task bindings visible and distinguishes execution from acceptance', async () => {
    const { api, tasks, projectId } = fixture();
    tasks.update('task', { status: 'completed' });
    const snapshot = (await api.getProjectContinuity(projectId))!;
    const completed = buildProjectContext({ snapshot, recentActivity: [] });
    expect(completed.text).toContain('[completed; acceptance=pending]');
    const missing = buildProjectContext({ snapshot: { ...snapshot, tasks: [{ ...snapshot.tasks[0], task: null }] }, recentActivity: [] });
    expect(missing.text).toContain('record unavailable');
  });

  it('replaces successful evidence with an explicit unavailable or unbound snapshot', async () => {
    const { service } = fixture();
    const work = await buildProjectSessionContextBlock(false, () => service.getSessionContext('work'));
    expect(work?.content).toContain('# Project work Session');
    const unavailable = await buildProjectSessionContextBlock(true, async () => { throw new Error('private bridge payload'); });
    expect(unavailable?.id).toBe(work?.id);
    expect(unavailable?.content).toContain('Earlier project snapshots are no longer current');
    expect(unavailable?.content).not.toContain('private bridge payload');
    expect((await buildProjectSessionContextBlock(true, async () => null))?.content).toContain('unavailable');
    expect((await buildProjectSessionContextBlock(false, async () => ({ role: 'work', projectId: 'invalid' })))?.content).toContain('unavailable');
    expect((await buildProjectSessionContextBlock(false, async () => null))?.content).toContain('no current durable Project binding');
  });
});
