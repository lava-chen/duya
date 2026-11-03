/** Desktop transport adapter for the shared Host plugin implementation. */
import { getDesktopPluginServices } from './shared-plugin-services';
export type * from '@duya/host/plugins/catalog';
export const readConfigMarketplaces = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['readConfigMarketplaces']>) => getDesktopPluginServices().catalog.readConfigMarketplaces(...args);
export const invalidatePluginCatalogCache = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['invalidatePluginCatalogCache']>) => getDesktopPluginServices().catalog.invalidatePluginCatalogCache(...args);
export const resolveIconUrl = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['resolveIconUrl']>) => getDesktopPluginServices().catalog.resolveIconUrl(...args);
export const getBuiltinCatalogEntries = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getBuiltinCatalogEntries']>) => getDesktopPluginServices().catalog.getBuiltinCatalogEntries(...args);
export const getPluginCatalog = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getPluginCatalog']>) => getDesktopPluginServices().catalog.getPluginCatalog(...args);
export const getPluginCatalogEntry = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getPluginCatalogEntry']>) => getDesktopPluginServices().catalog.getPluginCatalogEntry(...args);
export const getMarketplaceStatuses = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getMarketplaceStatuses']>) => getDesktopPluginServices().catalog.getMarketplaceStatuses(...args);
export const getLocalPluginPaths = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getLocalPluginPaths']>) => getDesktopPluginServices().catalog.getLocalPluginPaths(...args);
export const getBundledSkillsDir = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['getBundledSkillsDir']>) => getDesktopPluginServices().catalog.getBundledSkillsDir(...args);
export const syncBuiltinPlugins = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['catalog']['syncBuiltinPlugins']>) => getDesktopPluginServices().catalog.syncBuiltinPlugins(...args);
