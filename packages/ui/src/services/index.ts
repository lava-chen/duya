export type { UiServices, UiStartRunInput, UiPlatformCapabilities, UiRunRecord, UiRunSession } from './ui-services.js';
export { clearUiServices, configureUiServices, getUiServices, peekUiServices } from './registry.js';
export { createUiServices, type CreateUiServicesOptions } from './ui-services-factory.js';
export { UiServicesProvider, useUiServices } from '../hooks/useUiServices.js';

/**
 * The Host bridge, re-exported.
 *
 * A surface that fills the `UiServices` port needs the bridge's TYPE, and
 * sometimes its factory. Re-exporting them here keeps the dependency in one
 * place: a surface depends on `@duya/ui`, and `@duya/ui` is the one that
 * depends on the client-side transport. A surface reaching past this to
 * `@duya/client-core` would be a surface with two doors onto the same layer.
 */
export {
  createHostHttpBridge,
  HostApiError,
  type HostApiBridge,
  type HostFetchLike,
  type HostFetchResponse,
  type HostHttpBridgeOptions,
} from '@duya/client-core';
