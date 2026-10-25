/**
 * sync.ts — session-level integration sync (plan 621 slice E).
 *
 * One call, `syncSession(sessionId)`, walks the chain
 *   session → cwd → origin remote → checkpoint refs → PRs → store
 * and lands every successfully observed PR in the `integrations` projection
 * (`upsertObservation`) together with its session link (`linkSession`).
 *
 * Contract rules this module keeps (plan 621 §4.4 / §4.6):
 *   - A ref with no PR (`none`) produces NO row. "There is no PR" is an
 *     answer, not an observation worth caching.
 *   - A failed observation is never written over a previous row. An `unknown`
 *     fact means "GitHub did not answer"; stamping it onto a good projection
 *     row would destroy the last known state for a transient failure. The
 *     failure is reported in the result instead, with its reason.
 *   - Nothing here writes logs or rollout events: observations live in the
 *     tables, and the tables only.
 *
 * The session directory is injected (`getSessionWorkingDirectory`) rather than
 * read from `SessionStore`, and git/gh are injectable runners, so the whole
 * sync is testable without mocking modules.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import type { IntegrationStore } from '@duya/data';
import type {
  HostIntegrationSyncFailure,
  HostIntegrationSyncResult,
  HostIntegrationSyncStatus,
  HostIntegrationSyncWritten,
} from '@duya/agent-protocol';
import { observePrsForRefs, type ScmObserverDeps } from './observe.js';

/**
 * The sync result is a WIRE contract: it travels over the Host's HTTP surface
 * to every surface that may ask for a refresh, so it is defined once in
 * `@duya/agent-protocol` and re-exported here under the names this module has
 * always used.
 */
export type IntegrationSyncStatus = HostIntegrationSyncStatus;
export type IntegrationSyncWritten = HostIntegrationSyncWritten;
export type IntegrationSyncFailure = HostIntegrationSyncFailure;
export type IntegrationSyncResult = HostIntegrationSyncResult;

/** How long one git invocation may run before sync gives up on it. */
const GIT_TIMEOUT_MS = 10_000;

/** `for-each-ref` output is small; 1 MB is generous. */
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * The injected git process boundary. Deliberately the same shape as
 * `GhRunner.run`: args array, explicit cwd, stdout or a rejection — never a
 * shell string.
 */
export type SyncGitRunner = (args: readonly string[], cwd: string) => Promise<string>;

export interface IntegrationSyncDeps {
  /** The observed projection. Written only for successfully observed PRs. */
  readonly store: IntegrationStore;
  /**
   * Session → its working directory. Injected so this module never imports
   * `SessionStore`; `null` means the session has no live cwd to sync from.
   */
  readonly getSessionWorkingDirectory: (sessionId: string) => Promise<string | null>;
  /** Defaults to the real `git` binary; tests inject a stub or use fixtures. */
  readonly git?: SyncGitRunner;
  /** Passed through to the observer; tests use it to stub or fail `gh`. */
  readonly observeDeps?: ScmObserverDeps;
}

/** The one method callers need; built by {@link createIntegrationSync}. */
export interface IntegrationSync {
  syncSession(sessionId: string): Promise<IntegrationSyncResult>;
}

const NO_ORIGIN_REMOTE: IntegrationSyncResult = {
  status: 'no_origin_remote',
  written: [],
  failed: [],
};

const NO_CHECKPOINTS: IntegrationSyncResult = {
  status: 'no_checkpoints',
  written: [],
  failed: [],
};

function defaultGitRunner(): SyncGitRunner {
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      nodeExecFile(
        'git',
        [...args],
        {
          cwd,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          encoding: 'utf8',
          maxBuffer: GIT_MAX_BUFFER_BYTES,
        },
        (error, stdout, stderr) => {
          if (error) {
            const detail =
              (typeof stderr === 'string' ? stderr.split('\n')[0] : undefined)?.trim() ?? '';
            reject(new Error(detail.length > 0 ? detail : error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

/**
 * Resolve `owner/name` from an origin URL, accepting the two forms GitHub
 * documents: `https://host/owner/name(.git)` and the scp-like
 * `git@host:owner/name(.git)` (which covers `ssh://git@host/owner/name.git`
 * too). Anything else — a local path, a single-segment path, an empty URL —
 * is not a GitHub repository and yields `null`, so the caller reports
 * `no_origin_remote` instead of guessing.
 */
export function repoFromOriginUrl(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;

  let tail: string | null = null;
  const httpsLike = /^https?:\/\/[^/]+\/(.+)$/i.exec(trimmed);
  const sshLike = /^ssh:\/\/(?:[^@/]+@)?[^/]+\/(.+)$/i.exec(trimmed);
  const scpLike = /^(?:[^@/]+@)?[^:/]+:(.+)$/.exec(trimmed);
  if (httpsLike !== null) tail = httpsLike[1] ?? null;
  else if (sshLike !== null) tail = sshLike[1] ?? null;
  else if (scpLike !== null) tail = scpLike[1] ?? null;
  if (tail === null) return null;

  const cleaned = tail.replace(/\/+$/, '').replace(/\.git$/i, '');
  const segments = cleaned.split('/').filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  const owner = segments[0];
  const name = segments[1];
  if (!owner || !name) return null;
  return `${owner}/${name}`;
}

/** One checkpoint ref: its full refname and the commit it pins. */
interface CheckpointRef {
  readonly ref: string;
  readonly sha: string;
}

/**
 * Parse `git for-each-ref --format='%(objectname) %(refname)'` output. The
 * combined format is one call instead of two; refnames cannot contain spaces,
 * so splitting on the first space is exact. Malformed lines are dropped, not
 * guessed at.
 */
function parseCheckpointRefs(stdout: string): CheckpointRef[] {
  const refs: CheckpointRef[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(' ');
    if (separator <= 0) continue;
    const sha = trimmed.slice(0, separator);
    const ref = trimmed.slice(separator + 1).trim();
    if (!/^[0-9a-f]{40}$/i.test(sha) || ref.length === 0) continue;
    refs.push({ ref, sha });
  }
  return refs;
}

/**
 * Build the session-level sync. See the module header for the write rules.
 */
export function createIntegrationSync(deps: IntegrationSyncDeps): IntegrationSync {
  const git = deps.git ?? defaultGitRunner();

  const syncSession = async (sessionId: string): Promise<IntegrationSyncResult> => {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new Error('integration-sync: sessionId must be a non-empty string');
    }

    const workingDirectory = await deps.getSessionWorkingDirectory(sessionId);
    // Without a cwd there is no repository to read origin or refs from — the
    // same answer as "this session has no checkpoints", just earlier.
    if (workingDirectory === null) return NO_CHECKPOINTS;

    let originUrl: string;
    try {
      originUrl = (await git(['remote', 'get-url', 'origin'], workingDirectory)).trim();
    } catch {
      return NO_ORIGIN_REMOTE;
    }
    const repo = repoFromOriginUrl(originUrl);
    if (repo === null) return NO_ORIGIN_REMOTE;

    let checkpointRefs: CheckpointRef[];
    try {
      checkpointRefs = parseCheckpointRefs(
        await git(
          ['for-each-ref', '--format=%(objectname) %(refname)', `refs/duya/checkpoint/${checkpointSessionComponent(sessionId)}/`],
          workingDirectory,
        ),
      );
    } catch {
      // An unreadable ref namespace is indistinguishable from an empty one at
      // this layer; fail closed by reporting "nothing to sync" and writing
      // nothing.
      return NO_CHECKPOINTS;
    }
    if (checkpointRefs.length === 0) return NO_CHECKPOINTS;

    // Several checkpoint refs can pin the same commit; the observer matches
    // refs to PRs, so one sha per distinct commit is enough.
    const refs = [...new Set(checkpointRefs.map((entry) => entry.sha))];
    const facts = await observePrsForRefs(repo, refs, deps.observeDeps);

    const written: IntegrationSyncWritten[] = [];
    const failed: IntegrationSyncFailure[] = [];
    const linkedPrs = new Set<number>();
    for (const fact of facts) {
      if (fact.state === 'unknown') {
        // Never stamped onto the projection row: the previous observation
        // stays the last known good state (see the module header).
        failed.push({ ref: fact.ref, reason: fact.observedError ?? 'unknown_observation' });
        continue;
      }
      if (fact.prNumber === null) continue; // `none`: no PR, no row.

      if (!linkedPrs.has(fact.prNumber)) {
        linkedPrs.add(fact.prNumber);
        deps.store.upsertObservation({
          repo,
          prNumber: fact.prNumber,
          state: fact.state,
          headSha: fact.headSha,
          baseRef: fact.baseRef,
          url: fact.url,
          observedError: fact.observedError,
          observedAt: fact.observedAt,
        });
        deps.store.linkSession({ repo, prNumber: fact.prNumber, sessionId });
        written.push({ repo, prNumber: fact.prNumber });
      }
    }

    return {
      status: failed.length > 0 ? 'observation_failed' : 'synced',
      written,
      failed,
    };
  };

  return { syncSession };
}
import { checkpointSessionComponent } from '../workspace/checkpoint-session.js';
