/** Durable App identity/state; live execution authority is rebound at launch. */
export type PluginAppInstanceStatus = 'active' | 'disabled' | 'revoked';
export type PluginAppInstanceStateValue =
  | string | number | boolean | null
  | PluginAppInstanceStateValue[]
  | { [key: string]: PluginAppInstanceStateValue };
export type PluginAppInstanceState = { [key: string]: PluginAppInstanceStateValue };

export interface PluginAppInstanceRecord {
  readonly instanceId: string;
  readonly pluginId: string;
  readonly appId: string;
  readonly stateSchemaVersion: number;
  readonly state: PluginAppInstanceState;
  readonly revision: number;
  readonly status: PluginAppInstanceStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type PluginAppInstanceWriteRejection =
  | 'not_found' | 'stale_revision' | 'schema_mismatch' | 'inactive';
export type PluginAppInstanceWriteResult =
  | { readonly ok: true; readonly instance: PluginAppInstanceRecord }
  | { readonly ok: false; readonly reason: PluginAppInstanceWriteRejection; readonly instance: PluginAppInstanceRecord | null };
export type PluginAppInstanceStatusRejection =
  | 'not_found' | 'stale_revision' | 'invalid_transition';
export type PluginAppInstanceStatusResult =
  | { readonly ok: true; readonly instance: PluginAppInstanceRecord }
  | { readonly ok: false; readonly reason: PluginAppInstanceStatusRejection; readonly instance: PluginAppInstanceRecord | null };

export interface HostPluginAppInstanceCreateInput {
  readonly pluginId: string;
  readonly appId: string;
  readonly stateSchemaVersion: number;
  readonly state?: PluginAppInstanceState;
}
export interface HostPluginAppInstanceWriteInput {
  readonly expectedRevision: number;
  readonly expectedSchemaVersion: number;
  readonly state: PluginAppInstanceState;
}
export interface HostPluginAppInstanceStatusInput {
  readonly expectedRevision: number;
  readonly status: PluginAppInstanceStatus;
}

/** Trusted local clients only. An App iframe receives neither this API nor its token. */
export interface HostPluginAppInstanceApiV1 {
  createPluginAppInstance(input: HostPluginAppInstanceCreateInput): Promise<PluginAppInstanceRecord>;
  getPluginAppInstance(instanceId: string): Promise<PluginAppInstanceRecord | null>;
  listPluginAppInstances(pluginId: string, appId?: string): Promise<readonly PluginAppInstanceRecord[]>;
  writePluginAppInstanceState(instanceId: string, input: HostPluginAppInstanceWriteInput): Promise<PluginAppInstanceWriteResult>;
  setPluginAppInstanceStatus(instanceId: string, input: HostPluginAppInstanceStatusInput): Promise<PluginAppInstanceStatusResult>;
}
