import { getPluginAPI } from './plugin-ipc';

export async function isLiteraturePluginEnabled(): Promise<boolean> {
  const pluginApi = getPluginAPI();
  if (!pluginApi) {
    return false;
  }

  const result = await pluginApi.registry.list();
  if (!result.success) {
    return false;
  }

  return result.data.some((plugin) => plugin.id === 'com.duya.literature' && plugin.enabled);
}
