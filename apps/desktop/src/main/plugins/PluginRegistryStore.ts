import { app } from 'electron';
import { PluginRegistryStore as SharedPluginRegistryStore } from '@duya/host/plugins/PluginRegistryStore';
import { resolvePluginPackageRoot } from '@duya/host/plugins/service';
import { getConfigStore } from '../config/store-instance';
export class PluginRegistryStore extends SharedPluginRegistryStore {
  constructor() { super(resolvePluginPackageRoot(getConfigStore().getConfigDir(), app.getPath('userData')), { getByPath: key => getConfigStore().getByPath(key), set: (key, value) => getConfigStore().set(key, value) }); }
}
