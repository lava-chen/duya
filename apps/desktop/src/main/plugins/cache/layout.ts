/** Desktop transport adapter for the shared Host plugin implementation. */
import { getDesktopPluginServices } from '../shared-plugin-services';
export type * from '@duya/host/plugins/cache/layout';
export const getPluginCacheRoot = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getPluginCacheRoot']>) => getDesktopPluginServices().layout.getPluginCacheRoot(...args);
export const getPluginInstalledRoot = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getPluginInstalledRoot']>) => getDesktopPluginServices().layout.getPluginInstalledRoot(...args);
export const getPluginMarketplaceCacheDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getPluginMarketplaceCacheDir']>) => getDesktopPluginServices().layout.getPluginMarketplaceCacheDir(...args);
export const getPluginVersionCacheDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getPluginVersionCacheDir']>) => getDesktopPluginServices().layout.getPluginVersionCacheDir(...args);
export const ensurePluginCacheDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['ensurePluginCacheDir']>) => getDesktopPluginServices().layout.ensurePluginCacheDir(...args);
export const listCachedVersions = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['listCachedVersions']>) => getDesktopPluginServices().layout.listCachedVersions(...args);
export const getPluginInstalledSymlinkPath = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getPluginInstalledSymlinkPath']>) => getDesktopPluginServices().layout.getPluginInstalledSymlinkPath(...args);
export const createInstalledSymlink = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['createInstalledSymlink']>) => getDesktopPluginServices().layout.createInstalledSymlink(...args);
export const removeInstalledSymlink = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['removeInstalledSymlink']>) => getDesktopPluginServices().layout.removeInstalledSymlink(...args);
export const resolveInstalledSymlink = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['resolveInstalledSymlink']>) => getDesktopPluginServices().layout.resolveInstalledSymlink(...args);
export const isSymlinkValid = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['isSymlinkValid']>) => getDesktopPluginServices().layout.isSymlinkValid(...args);
export const cleanupOldVersions = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['cleanupOldVersions']>) => getDesktopPluginServices().layout.cleanupOldVersions(...args);
export const getCacheStats = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['getCacheStats']>) => getDesktopPluginServices().layout.getCacheStats(...args);

export const assertManagedPath = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['assertManagedPath']>) => getDesktopPluginServices().layout.assertManagedPath(...args);

export const resolvePluginDataPath = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['layout']['resolvePluginDataPath']>) => getDesktopPluginServices().layout.resolvePluginDataPath(...args);
