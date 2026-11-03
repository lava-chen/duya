/** Desktop transport adapter for the shared Host plugin implementation. */
import { getDesktopPluginServices } from '../shared-plugin-services';
export type * from '@duya/host/plugins/marketplace/manager';
export { DEFAULT_OFFICIAL_SOURCES } from '@duya/host/plugins/marketplace/manager';
export { DEFAULT_OFFICIAL_MARKETPLACE } from '@duya/host/plugins/marketplace/manager';
export { DEFAULT_OFFICIAL_SOURCE } from '@duya/host/plugins/marketplace/manager';
export const listMarketplaces = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['listMarketplaces']>) => getDesktopPluginServices().marketplaces.listMarketplaces(...args);
export const addMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['addMarketplace']>) => getDesktopPluginServices().marketplaces.addMarketplace(...args);
export const removeMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['removeMarketplace']>) => getDesktopPluginServices().marketplaces.removeMarketplace(...args);
export const setMarketplaceHidden = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['setMarketplaceHidden']>) => getDesktopPluginServices().marketplaces.setMarketplaceHidden(...args);
export const refreshMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['refreshMarketplace']>) => getDesktopPluginServices().marketplaces.refreshMarketplace(...args);
export const syncAllMarketplaces = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['syncAllMarketplaces']>) => getDesktopPluginServices().marketplaces.syncAllMarketplaces(...args);
export const ensureOfficialMarketplace = (...args: Parameters<ReturnType<typeof getDesktopPluginServices>['marketplaces']['ensureOfficialMarketplace']>) => getDesktopPluginServices().marketplaces.ensureOfficialMarketplace(...args);
