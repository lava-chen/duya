import { createContext, useContext, type ReactNode } from 'react';
import type { UiServices } from '@/services/ui-services';

const UiServicesContext = createContext<UiServices | null>(null);

export function UiServicesProvider({
  services,
  children,
}: {
  readonly services: UiServices;
  readonly children: ReactNode;
}) {
  return <UiServicesContext.Provider value={services}>{children}</UiServicesContext.Provider>;
}

export function useUiServices(): UiServices {
  const services = useContext(UiServicesContext);
  if (services === null) throw new Error('useUiServices must be used within UiServicesProvider');
  return services;
}
