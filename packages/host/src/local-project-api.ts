/** Local-only project path resolution for services that own workspace context. */
export interface HostLocalProjectResolutionInput {
  readonly workingDirectory: string;
  readonly agentProfileId?: string | null;
  readonly cwd?: string;
  readonly workspaceOverridesPath?: string;
}

export interface HostLocalProjectResolution {
  readonly projectId: string;
  readonly canonicalRoot: string;
  readonly resolutionSource: 'override' | 'working_directory' | 'cwd';
  readonly aliasKind: 'workspace_override' | 'working_directory' | 'cwd';
  readonly absoluteNormalizedPath: string;
}

export interface HostLocalProjectApiV1 {
  resolveProjectPath(input: HostLocalProjectResolutionInput): Promise<HostLocalProjectResolution>;
}

export function createHostLocalProjectApi(options: {
  readonly resolveProjectPath: (
    input: HostLocalProjectResolutionInput,
  ) => HostLocalProjectResolution | Promise<HostLocalProjectResolution>;
}): HostLocalProjectApiV1 {
  return {
    async resolveProjectPath(input) {
      return await options.resolveProjectPath(input);
    },
  };
}
