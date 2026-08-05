export type AuthType = 'api_key' | 'auth_token' | 'oauth' | 'device_code' | 'env_only';

export interface AuthInfoLink {
  label?: string;
  url: string;
}

export interface DeviceCodeInfo {
  verificationUri: string;
  userCode: string;
  expiresIn?: number;
}

/** UI implements these callbacks; the auth layer drives them. */
export interface AuthInteraction {
  onAuth?: (url: string, providerId: string) => void;
  onDeviceCode?: (info: DeviceCodeInfo) => void;
  onPrompt?: (message: string, placeholder?: string) => Promise<string>;
  onInfo?: (message: string, links?: readonly AuthInfoLink[]) => void;
}

export interface Credential {
  providerId: string;
  type: AuthType;
  apiKey?: string;
  token?: string;
  env?: Record<string, string>;
  expiresAt?: number;
}

export interface CredentialStore {
  get(providerId: string): Promise<Credential | undefined>;
  set(credential: Credential): Promise<void>;
  delete(providerId: string): Promise<void>;
  list(): Promise<Credential[]>;
}