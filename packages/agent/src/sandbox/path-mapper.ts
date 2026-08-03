/**
 * Bidirectional path mapping between host paths and container paths.
 *
 * In Docker sandbox mode, the host working directory is mounted to /workspace
 * inside the container. The LLM emits commands using host paths (e.g.
 * "E:\\Projects\\duya\\src") because that is what the system prompt told it.
 * Without translation, those paths do not exist inside the container and
 * every file operation fails silently or returns "no such file".
 *
 * This module closes the loop:
 *   - Before execution: host paths in the command → container paths
 *   - After execution: container paths in the output → host paths
 *
 * The LLM only ever sees host paths; the container only ever sees /workspace.
 */

export interface PathMapperOptions {
  /** Host working directory path (e.g. "E:\\Projects\\duya") */
  hostCwd: string;
  /** Container mount point (default: "/workspace") */
  containerRoot?: string;
}

export class PathMapper {
  private readonly hostCwd: string;
  private readonly containerRoot: string;

  /** Host cwd with forward slashes: "E:/Projects/duya" */
  private readonly hostForward: string;
  /** Host cwd with backslashes: "E:\\Projects\\duya" */
  private readonly hostBackslash: string;
  /** Git Bash POSIX style: "/e/Projects/duya" (empty if not a drive path) */
  private readonly hostPosix: string;

  constructor(options: PathMapperOptions) {
    this.hostCwd = options.hostCwd;
    this.containerRoot = options.containerRoot ?? '/workspace';

    this.hostForward = this.hostCwd.replace(/\\/g, '/');
    this.hostBackslash = this.hostCwd.replace(/\//g, '\\');

    // Build Git Bash POSIX variant: E:/Projects/duya → /e/Projects/duya
    const driveMatch = this.hostForward.match(/^\/?([a-zA-Z]):\//);
    if (driveMatch) {
      this.hostPosix = '/' + driveMatch[1]!.toLowerCase() + this.hostForward.slice(2);
    } else {
      this.hostPosix = '';
    }
  }

  /**
   * Rewrite a command string: replace host paths with container paths.
   *
   * Handles three path formats the LLM commonly emits on Windows:
   *   - Windows backslash:  E:\Projects\duya\src  → /workspace/src
   *   - Windows forward:    E:/Projects/duya/src  → /workspace/src
   *   - Git Bash POSIX:     /e/Projects/duya/src  → /workspace/src
   *
   * Each variant is matched as a complete path (prefix + optional sub-path)
   * with a negative lookahead for path characters to avoid partial matches
   * (e.g. "duya" matching inside "duya-backup"). Backslashes in the matched
   * suffix are normalized to forward slashes for the container.
   */
  rewriteCommandToContainer(command: string): string {
    if (!command || !this.hostCwd) return command;

    let result = command;

    const variants: { path: string; sep: string }[] = [
      { path: this.hostBackslash, sep: '\\\\' },
      { path: this.hostForward, sep: '/' },
    ];
    if (this.hostPosix) {
      variants.push({ path: this.hostPosix, sep: '/' });
    }

    for (const { path: variant, sep } of variants) {
      if (!variant) continue;
      const escaped = escapeRegex(variant);
      // Match variant + optional path continuation using the same separator.
      // Negative lookahead prevents matching a path prefix inside a longer
      // directory name (e.g. "duya" inside "duya-backup").
      const regex = new RegExp(
        `${escaped}(?:${sep}[^\\s"'<>|; &|$]*)*(?![a-zA-Z0-9_.-])`,
        'gi',
      );
      result = result.replace(regex, (match) => {
        const suffix = match.slice(variant.length);
        return this.containerRoot + suffix.replace(/\\/g, '/');
      });
    }

    return result;
  }

  /**
   * Rewrite output: replace container paths with host paths.
   *
   * /workspace/src/foo.ts → E:/Projects/duya/src/foo.ts
   *
   * Uses forward slashes in the replacement because they are valid on
   * both Windows and Unix and are more readable in error messages.
   */
  rewriteOutputToHost(output: string): string {
    if (!output || !this.hostCwd) return output;

    const escaped = escapeRegex(this.containerRoot);
    // Match containerRoot followed by / or a non-path character or end.
    // This prevents replacing "/workspace" inside "/workspace-foo".
    const regex = new RegExp(`${escaped}(?=/|[^a-zA-Z0-9_-]|$)`, 'g');
    return output.replace(regex, this.hostForward);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
