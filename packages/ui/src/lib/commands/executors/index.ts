/**
 * Executor domain modules — importing this file registers every executor.
 *
 * Domain files (export their executor maps; registration happens here so the
 * module graph stays flat and side effects are explicit):
 * - info.ts    help / status / cost / context / transcript / usage / skills
 * - model.ts   model / effort
 * - auth.ts    login / logout / permission
 * - session.ts new / clear / export / copy / rename / resume / stop / queue / compact
 * - view.ts    goal / deep-research / diff / loop / memory / mcp / add-dir / image / btw
 */

import { registerCommandExecutors } from './registry';
import { INFO_EXECUTORS } from './info';
import { MODEL_EXECUTORS } from './model';
import { AUTH_EXECUTORS } from './auth';
import { SESSION_EXECUTORS } from './session';
import { VIEW_EXECUTORS } from './view';

registerCommandExecutors(INFO_EXECUTORS);
registerCommandExecutors(MODEL_EXECUTORS);
registerCommandExecutors(AUTH_EXECUTORS);
registerCommandExecutors(SESSION_EXECUTORS);
registerCommandExecutors(VIEW_EXECUTORS);

export * from './bridge';
export * from './registry';
