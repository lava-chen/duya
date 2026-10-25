/**
 * Executor domain modules — importing this file registers every executor.
 *
 * Domain files (export their executor maps; registration happens here so the
 * module graph stays flat and side effects are explicit):
 * - info.ts    help / status / cost / context / transcript / usage / skills
 * - model.ts   model / effort
 * - auth.ts    login / logout / permission
 * - session.ts new / clear / export / copy / rename / resume / stop / queue / compact / app
 * - view.ts    goal / deep-research / diff / loop / memory / mcp / add-dir / image / btw / workflow
 * - extensions.ts apps / plugin
 * - doctor.ts  doctor
 * - init.ts    init
 */

import { registerCommandExecutors } from './registry';
import { INFO_EXECUTORS } from './info';
import { MODEL_EXECUTORS } from './model';
import { AUTH_EXECUTORS } from './auth';
import { SESSION_EXECUTORS } from './session';
import { VIEW_EXECUTORS } from './view';
import { EXTENSION_EXECUTORS } from './extensions';
import { DOCTOR_EXECUTORS } from './doctor';
import { INIT_EXECUTORS } from './init';

registerCommandExecutors(INFO_EXECUTORS);
registerCommandExecutors(MODEL_EXECUTORS);
registerCommandExecutors(AUTH_EXECUTORS);
registerCommandExecutors(SESSION_EXECUTORS);
registerCommandExecutors(VIEW_EXECUTORS);
registerCommandExecutors(EXTENSION_EXECUTORS);
registerCommandExecutors(DOCTOR_EXECUTORS);
registerCommandExecutors(INIT_EXECUTORS);

export * from './bridge';
export * from './registry';
