/**
 * Read-only inventory of the skills a session can use.
 *
 * ## Why the Host answers this
 *
 * Skill discovery reads the filesystem and decides which skill wins a name.
 * That code reaches `@duya/agent-core`, and a CLIENT entry point is not
 * allowed to reach it — the `architecture:client-closure` gate stops a CLI
 * that imports the discovery service in process. So a client that can only
 * speak HTTP asks the Host, and this contract is what the answer looks like
 * on the wire.
 *
 * ## Why it is a projection
 *
 * The projection carries an id, a name, a description, a source and two
 * flags. It carries no absolute path and no SKILL.md body: the answer travels
 * to every client that can reach the Host, and the directories it was read
 * from say more about the user's machine than a client needs to know.
 *
 * The list is about ONE session, because project skills live next to the
 * project the session works in. The session's working directory therefore
 * travels with the list: a client that renders "the skills of this project"
 * needs to be able to say which project it meant.
 */

/**
 * One skill as the Host knows it.
 *
 * `source` is the wire string ('user', 'project', 'system', 'custom',
 * 'plugin', 'bundled', 'agent', 'mcp') rather than the Host's own union: the
 * protocol must not restate a Host-side type, because a second copy of that
 * union is a second thing to keep in step.
 */
export interface HostSkillEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: string;
  /** Whether the user's per-skill override leaves this skill usable. */
  readonly enabled: boolean;
  /** Whether the skill's frontmatter lets the user invoke it by name. */
  readonly userInvocable: boolean;
}

export interface HostSkillInventoryApiV1 {
  listSkills(input: { readonly sessionId: string }): Promise<{
    readonly skills: readonly HostSkillEntry[];
    /** The session's working directory — the project the list is about. */
    readonly workingDirectory: string;
  }>;
}
