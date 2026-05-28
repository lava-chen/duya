import type {
  PluginError,
  PluginErrorSeverity,
} from './plugin-error-types';

export function getPluginErrorMessage(err: PluginError): string {
  switch (err.type) {
    case 'git-auth-failed':
      return `Authentication failed for plugin "${err.plugin}". ${err.reason}\n` +
             `Run 'git config --global credential.helper' to check your Git credentials.`;
    case 'git-timeout':
      return `Git clone timed out for "${err.plugin}" after ${err.duration}ms.\n` +
             `Check your network connection or increase the timeout setting.`;
    case 'git-clone-failed':
      return `Failed to clone "${err.plugin}". ${err.message}`;
    case 'network-error':
      return `Network error ${err.statusCode ? `(${err.statusCode})` : ''} when accessing ${err.url}.\n` +
             `${err.retryable ? 'This error is retryable.' : 'Check the URL and try again.'}`;
    case 'npm-install-failed':
      return `Failed to install npm package "${err.package}" for plugin "${err.plugin}". ${err.message}`;
    case 'download-failed':
      return `Failed to download "${err.plugin}" from ${err.url}. ${err.reason}`;
    case 'extract-failed':
      return `Failed to extract archive "${err.archive}" for plugin "${err.plugin}". ${err.reason}`;
    case 'path-not-found':
      return `Path not found: ${err.path}${err.plugin ? ` (plugin: ${err.plugin})` : ''}`;
    case 'path-traversal-detected':
      return `Path traversal detected for plugin "${err.plugin}". ` +
             `Path "${err.path}" resolved outside the plugin directory to "${err.resolvedPath}".`;
    case 'manifest-parse-error':
      return `Failed to parse plugin manifest for "${err.plugin}".\n` +
             `Path: ${err.path}\n` +
             (err.zodError ? `Validation: ${err.zodError}` : `Raw content: ${err.raw.substring(0, 200)}`);
    case 'manifest-validation-error':
      return `Plugin manifest validation failed for "${err.plugin}".\n` +
             `Path: ${err.path}\n` +
             `Errors:\n${err.errors.map((e) => `  - ${e}`).join('\n')}`;
    case 'manifest-not-found':
      return `Plugin manifest not found${err.plugin ? ` for "${err.plugin}"` : ''}. ` +
             `Searched in: ${err.searchedPaths.join(', ')}`;
    case 'invalid-manifest-format':
      return `Invalid manifest format for plugin "${err.plugin}" at "${err.path}". ` +
             `Expected format: ${err.expectedFormat}`;
    case 'hook-load-failed':
      return `Failed to load hook "${err.path}" for plugin "${err.plugin}". ${err.reason}`;
    case 'command-load-failed':
      return `Failed to load command "${err.command}" for plugin "${err.plugin}". ${err.reason}`;
    case 'skill-load-failed':
      return `Failed to load skill "${err.skill}" for plugin "${err.plugin}". ${err.reason}`;
    case 'agent-load-failed':
      return `Failed to load agent "${err.agent}" for plugin "${err.plugin}". ${err.reason}`;
    case 'capability-registration-failed':
      return `Failed to register capability "${err.capability}" for plugin "${err.plugin}". ${err.reason}`;
    case 'marketplace-not-found':
      return `Marketplace "${err.marketplace}" not found.` +
             (err.searchedPaths?.length ? ` Searched in: ${err.searchedPaths.join(', ')}` : '');
    case 'marketplace-load-failed':
      return `Failed to load marketplace "${err.marketplace}" from ${err.url}. ${err.reason}`;
    case 'marketplace-blocked-by-policy':
      return `Marketplace "${err.marketplace}" is blocked by ${err.policy} policy.`;
    case 'marketplace-impersonation-detected':
      return `Marketplace impersonation detected for "${err.marketplace}". ${err.reason}`;
    case 'plugin-not-found':
      return `Plugin "${err.plugin}" not found in marketplace "${err.marketplace}".`;
    case 'plugin-catalog-fetch-failed':
      return `Failed to fetch plugin catalog from "${err.marketplace}" at ${err.url}. ${err.reason}`;
    case 'dependency-unsatisfied':
      return `Plugin "${err.plugin}" has unsatisfied dependencies:\n` +
             err.missing.map((d) => `  - ${d.id} @ ${d.version}`).join('\n');
    case 'version-constraint-failed':
      return `Version constraint failed for "${err.plugin}". ` +
             `Installed: ${err.current}, Required: ${err.required}`;
    case 'duya-version-incompatible':
      return `Plugin "${err.plugin}" requires DUYA ${err.required} but current version is ${err.current}.`;
    case 'engine-not-supported':
      return `Plugin "${err.plugin}" requires ${err.engine} ${err.required} but current version is ${err.current}.`;
    case 'generic-error':
      return err.plugin
        ? `Plugin error (${err.plugin}): ${err.message}`
        : `Plugin error: ${err.message}`;
    default:
      return `Unknown plugin error: ${(err as PluginError).type}`;
  }
}

export function getPluginErrorSeverity(err: PluginError): PluginErrorSeverity {
  switch (err.type) {
    case 'git-auth-failed':
    case 'marketplace-blocked-by-policy':
    case 'path-traversal-detected':
    case 'marketplace-impersonation-detected':
      return 'critical';

    case 'network-error':
      return err.retryable ? 'warning' : 'critical';
    case 'git-timeout':
    case 'download-failed':
      return 'warning';

    case 'manifest-parse-error':
    case 'manifest-validation-error':
    case 'invalid-manifest-format':
      return 'warning';

    case 'dependency-unsatisfied':
    case 'version-constraint-failed':
    case 'duya-version-incompatible':
    case 'engine-not-supported':
      return 'warning';

    case 'manifest-not-found':
    case 'setup-required' as string:
      return 'info';

    default:
      return 'critical';
  }
}

export function isRetryable(err: PluginError): boolean {
  switch (err.type) {
    case 'network-error':
      return err.retryable;
    case 'git-timeout':
    case 'download-failed':
    case 'plugin-catalog-fetch-failed':
      return true;
    default:
      return false;
  }
}

export function getSuggestedAction(err: PluginError): string | undefined {
  switch (err.type) {
    case 'git-auth-failed':
      return 'Check your Git credentials with "git config --global credential.helper"';
    case 'git-timeout':
      return 'Check your network connection or increase the timeout setting';
    case 'git-clone-failed':
      return 'Verify the Git repository URL and your network connection';
    case 'network-error':
      if (err.statusCode === 401 || err.statusCode === 403) {
        return 'Check your authentication credentials';
      }
      if (err.statusCode === 404) {
        return 'Verify the URL is correct and the resource exists';
      }
      return err.retryable ? 'Retry the operation' : 'Check the URL and try again';
    case 'npm-install-failed':
      return 'Verify the npm package name and your registry configuration';
    case 'download-failed':
      return 'Check the download URL and your network connection';
    case 'extract-failed':
      return 'Verify the archive is not corrupted and try downloading again';
    case 'path-not-found':
      return 'Verify the path exists and is accessible';
    case 'path-traversal-detected':
      return 'The plugin attempted to access files outside its directory. This plugin may be malicious.';
    case 'manifest-parse-error':
      return 'Check the plugin.json file for syntax errors';
    case 'manifest-validation-error':
      return 'Fix the validation errors in the plugin manifest';
    case 'manifest-not-found':
      return 'Ensure the plugin contains a plugin.json file';
    case 'marketplace-blocked-by-policy':
      return 'Contact your administrator to update the enterprise policy';
    case 'plugin-not-found':
      return 'Verify the plugin ID or check a different marketplace';
    case 'dependency-unsatisfied':
      return 'Install the missing dependencies';
    case 'duya-version-incompatible':
      return 'Update DUYA to the required version or use an older plugin version';
    case 'engine-not-supported':
      return 'Update the required engine to the minimum version';
    default:
      return undefined;
  }
}