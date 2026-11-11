/**
 * identity.ts — the Project Coordinator's product identity.
 *
 * The Coordinator runs on the shared Session runtime, but these values are
 * product decisions rather than runtime mechanics. They live here so the
 * generic Session service never has to recognise a Coordinator by a string
 * literal, and so the agent profile, the dispatch port and the prompt system
 * agree on one definition.
 */

export const PROJECT_COORDINATOR_PROFILE_ID = 'project-coordinator';

/** Work Sessions execute as a real work role, never as the Coordinator. */
export const PROJECT_WORK_SESSION_PROFILE_ID = 'code-expert';

/**
 * Management-only allowlist: no filesystem, shell, browser, device, catalog,
 * or shared todo tools. The Coordinator uses the canonical Host `session`
 * capability because the `duya_app` per-action spawn wrapper does not yet
 * accept `projectTask`, which is required to create and bind the canonical
 * Project Task. The shared todo replace operation can delete those Tasks.
 */
export const PROJECT_COORDINATOR_ALLOWED_TOOLS = ['session', 'project'] as const;

export const PROJECT_TASK_SUBJECT_MAX_LENGTH = 160;
export const PROJECT_TASK_DESCRIPTION_MAX_LENGTH = 12_000;

export function isProjectCoordinatorProfile(
  profileId: string | null | undefined,
): boolean {
  return profileId === PROJECT_COORDINATOR_PROFILE_ID;
}
