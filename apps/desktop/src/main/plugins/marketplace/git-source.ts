/** Desktop transport adapter for the shared Host plugin implementation. */
import { getDesktopPluginServices } from '../shared-plugin-services';
export type * from '@duya/host/plugins/marketplace/git-source';
export const getMarketplacesCacheRoot = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['getMarketplacesCacheRoot']>) => getDesktopPluginServices().git.getMarketplacesCacheRoot(...args);
export const getMarketplaceStagingRoot = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['getMarketplaceStagingRoot']>) => getDesktopPluginServices().git.getMarketplaceStagingRoot(...args);
export const getMarketplaceCloneDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['getMarketplaceCloneDir']>) => getDesktopPluginServices().git.getMarketplaceCloneDir(...args);
export const resolveSourceUrls = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['resolveSourceUrls']>) => getDesktopPluginServices().git.resolveSourceUrls(...args);
export const resolveConfiguredMarketplaceDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['resolveConfiguredMarketplaceDir']>) => getDesktopPluginServices().git.resolveConfiguredMarketplaceDir(...args);
export const cloneMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['cloneMarketplace']>) => getDesktopPluginServices().git.cloneMarketplace(...args);
export const updateMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['updateMarketplace']>) => getDesktopPluginServices().git.updateMarketplace(...args);
export const readHeadCommit = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['readHeadCommit']>) => getDesktopPluginServices().git.readHeadCommit(...args);
export const getPluginGitCacheRoot = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['getPluginGitCacheRoot']>) => getDesktopPluginServices().git.getPluginGitCacheRoot(...args);
export const clonePluginFromGit = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['clonePluginFromGit']>) => getDesktopPluginServices().git.clonePluginFromGit(...args);
export const removeCachedPluginClone = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['removeCachedPluginClone']>) => getDesktopPluginServices().git.removeCachedPluginClone(...args);
export const removeMarketplaceClone = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['git']['removeMarketplaceClone']>) => getDesktopPluginServices().git.removeMarketplaceClone(...args);
