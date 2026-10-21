/**
 * cli/handlers/voice-env-report.ts — pure voice doctor report builder.
 *
 * Kept free of Electron / ConfigStore imports so it can be unit tested
 * directly. The HTTP handler wires live config + provider store into
 * `buildVoiceEnvBody`.
 *
 * `ok` reflects true end-to-end readiness for the configured engine:
 *   - voice disabled            → false (start() would reject with voice_disabled)
 *   - engine = cloud            → resolved provider has base_url + api key
 *   - engine = local (default)  → whisper binary found AND model file usable
 */
import {
  collectEnvReport,
  resolveVoiceConfig,
  runtimeBinDir,
  type ResolvedVoiceConfig,
} from '@duya/voice';
import {
  cloudEndpointReady,
  resolveCloudEndpoint,
  type CloudEndpointSource,
} from '../../services/voice/cloud-endpoint';

export interface VoiceCloudStatus {
  provider: string;
  size: string;
  /** Effective base_url after the fallback chain (explicit → default → first). */
  baseUrl: string;
  ready: boolean;
}

export interface VoiceEnvBody {
  ok: boolean;
  platform: string;
  enabled: boolean;
  engine: 'local' | 'cloud';
  binaryFound: boolean;
  binaryPath?: string;
  binarySource?: 'config' | 'managed' | 'path' | 'candidate';
  runtimeInstallable: boolean;
  model: string;
  modelReady: boolean;
  modelSizeMb: number;
  cloud: VoiceCloudStatus;
  installSteps: string[];
  summary: string;
}

export interface BuildVoiceEnvBodyOptions {
  rawConfig: unknown;
  userDataRoot: string;
  /** Provider store subset for cloud endpoint resolution. */
  cloudSource: CloudEndpointSource;
  /** Configured local model file usability (exists + sane size). */
  modelReady: boolean;
  modelSizeMb: number;
}

/** Compute the full doctor body, including the real readiness flag. */
export function buildVoiceEnvBody(opts: BuildVoiceEnvBodyOptions): VoiceEnvBody {
  const cfg: ResolvedVoiceConfig = resolveVoiceConfig(opts.rawConfig as Parameters<typeof resolveVoiceConfig>[0]);

  const env = collectEnvReport({
    // Honor the explicit binary_path override so a working custom install is
    // not misreported as MISSING.
    explicitPath: cfg.binaryPath || undefined,
    managedBinDir: runtimeBinDir(opts.userDataRoot),
    runtimeBaseUrl: cfg.runtimeUrlBase,
  });

  const endpoint = resolveCloudEndpoint(cfg, opts.cloudSource);
  const cloud: VoiceCloudStatus = {
    provider: cfg.cloud.provider,
    size: cfg.cloud.size,
    baseUrl: endpoint.baseUrl,
    ready: cloudEndpointReady(endpoint),
  };

  const modelReady = opts.modelReady;
  let ok: boolean;
  if (!cfg.enabled) {
    ok = false;
  } else if (cfg.engine === 'cloud') {
    ok = cloud.ready;
  } else {
    ok = env.binaryFound && modelReady;
  }

  return {
    ok,
    platform: env.platform,
    enabled: cfg.enabled,
    engine: cfg.engine,
    binaryFound: env.binaryFound,
    binaryPath: env.binaryPath,
    binarySource: env.binarySource,
    runtimeInstallable: env.runtimeInstallable,
    model: cfg.model,
    modelReady,
    modelSizeMb: opts.modelSizeMb,
    cloud,
    installSteps: env.installSteps,
    summary: summarize(cfg, env.summary, cloud),
  };
}

function summarize(
  cfg: ResolvedVoiceConfig,
  envSummary: string,
  cloud: VoiceCloudStatus,
): string {
  if (!cfg.enabled) {
    return `语音功能未启用（[voice] enabled=false）。${envSummary}`;
  }
  if (cfg.engine === 'cloud') {
    return cloud.ready
      ? `云端转写就绪（provider base_url + api key 已配置，model: ${cloud.size}）。本地 whisper 环境不影响此模式。`
      : `云端引擎缺少可用 provider（base_url / API Key 缺失）。${envSummary}`;
  }
  return envSummary;
}
