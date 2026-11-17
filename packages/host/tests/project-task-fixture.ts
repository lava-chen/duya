import Database from 'better-sqlite3';
import { afterEach } from 'vitest';
import { TaskStore } from '@duya/data/core-stores';
import { ProjectStore } from '@duya/data/project-store';
import { createHostProjectApi } from '../src/project-api.js';
import { createProjectTaskLifecycle } from '../src/project/task-lifecycle.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** Real SQLite, including migrations, transactions and unique open-launch constraint. */
export function projectTaskFixture(coordinatorId = 'coordinator-1', projectId = 'project-1') {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys = ON');
  for (const migration of [...TaskStore.migrations, ...ProjectStore.migrations]) migration.up(db);
  const projects = new ProjectStore(db);
  const tasks = new TaskStore(db);
  projects.insert({ project_id: projectId, canonical_root: `/projects/${projectId}`, name: 'Project' });
  projects.bindCoordinatorSession(projectId, coordinatorId);
  const stores = { projects, tasks };
  return { db, projects, tasks, stores, api: createHostProjectApi(projects, tasks),
    lifecycle: createProjectTaskLifecycle(stores), coordinatorId, projectId };
}
