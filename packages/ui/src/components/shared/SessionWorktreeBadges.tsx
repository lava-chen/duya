/**
 * SessionWorktreeBadges — the branch / pull-request / merge glyphs on a
 * session row (Claude parity, 2026-10-27).
 *
 * Claude Code renders a green "PR" glyph and a purple "merge" glyph at the
 * trailing edge of a session row, each followed by a count when the session
 * touched more than one pull request. Duya adds a neutral "branch" glyph for
 * the sessions that own a managed checkout.
 *
 * The count only appears when it is greater than one — a single pull request
 * is the common case and the digit would be noise. The colours are the ones
 * measured off a live Claude Code desktop window (3.6556.2.0): PR `#32D64B`,
 * merge `#B796FF`.
 */

import { useTranslation } from "@/hooks/useTranslation";
import { useSessionWorktreeBadges } from "@/hooks/useSessionWorktreeBadges";
import { GitBranchIcon, GitMergeIcon, GitPullRequestIcon } from "@/components/icons";

function Badge({
  className,
  count,
  label,
  children,
}: {
  className: string;
  count: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`thread-item-badge ${className}`} title={label} aria-label={label}>
      {children}
      {count > 1 && <span className="thread-item-badge-count">{count}</span>}
    </span>
  );
}

export function SessionWorktreeBadges({
  sessionId,
  workingDirectory,
}: {
  sessionId: string;
  workingDirectory: string | null | undefined;
}) {
  const { t } = useTranslation();
  const { branches, pullRequests, merged } = useSessionWorktreeBadges(sessionId, workingDirectory);
  if (branches === 0 && pullRequests === 0 && merged === 0) return null;

  return (
    <span className="thread-item-badges">
      {branches > 0 && (
        <Badge
          className="thread-item-badge-branch"
          count={branches}
          label={t("thread.badge.branch")}
        >
          <GitBranchIcon size={12} />
        </Badge>
      )}
      {pullRequests > 0 && (
        <Badge
          className="thread-item-badge-pr"
          count={pullRequests}
          label={t("thread.badge.pullRequest")}
        >
          <GitPullRequestIcon size={12} />
        </Badge>
      )}
      {merged > 0 && (
        <Badge className="thread-item-badge-merge" count={merged} label={t("thread.badge.merged")}>
          <GitMergeIcon size={12} />
        </Badge>
      )}
    </span>
  );
}
