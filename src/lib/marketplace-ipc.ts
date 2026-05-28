export interface MarketplaceEntry {
  key: string;
  name: string;
  url: string;
  description?: string;
  autoUpdate: boolean;
  trusted?: boolean;
}

export function getMarketplaceAPI() {
  const api = window.electronAPI;
  if (!api) {
    return null;
  }

  return {
    list: async (): Promise<{ success: boolean; data: MarketplaceEntry[]; error?: string }> => {
      return api.marketplace.list();
    },
    add: async (payload: {
      key: string;
      entry: { name: string; url: string; description?: string; autoUpdate: boolean; trusted?: boolean };
    }): Promise<{ success: boolean; data?: MarketplaceEntry; error?: string }> => {
      return api.marketplace.add(payload);
    },
    update: async (payload: {
      key: string;
      entry: { name?: string; url?: string; description?: string; autoUpdate?: boolean; trusted?: boolean };
    }): Promise<{ success: boolean; data?: MarketplaceEntry; error?: string }> => {
      return api.marketplace.update(payload);
    },
    remove: async (payload: { key: string }): Promise<{ success: boolean; data?: { removed: boolean }; error?: string }> => {
      return api.marketplace.remove(payload);
    },
    reset: async (): Promise<{ success: boolean; data: MarketplaceEntry[]; error?: string }> => {
      return api.marketplace.reset();
    },
    checkName: async (name: string): Promise<{ success: boolean; data?: { name: string; blocked: boolean }; error?: string }> => {
      return api.marketplace.checkName(name);
    },
  };
}