import type { UiServices } from './ui-services.js';

let configuredServices: UiServices | null = null;

/** Install the surface-specific adapter before mounting the shared renderer. */
export function configureUiServices(services: UiServices): void {
  configuredServices = services;
}

/** Clear only the adapter that was installed by the caller. */
export function clearUiServices(services: UiServices): void {
  if (configuredServices === services) configuredServices = null;
}

/** Access for existing non-React stores and IPC wrappers. */
export function getUiServices(): UiServices {
  if (configuredServices === null) {
    throw new Error('UI services have not been configured for this renderer');
  }
  return configuredServices;
}
