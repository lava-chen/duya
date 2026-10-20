"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MicrophoneIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
  DownloadSimpleIcon,
  ArrowsClockwiseIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsSelectRow,
  SettingsInput,
} from "@/components/settings/ui";
import type { VoiceConfigDTO } from "@/lib/voice/types";
import {
  listAudioInputDevices,
  subscribeDeviceChange,
  type VoiceInputDevice,
} from "@/lib/voice/voice-devices";

// Renderer-side mirror of the `envDoctor` / `runtimeStatus` / `getModelStatus`
// IPC shapes.
interface EnvDoctorReport {
  platform: string;
  binaryFound: boolean;
  binaryPath?: string;
  binarySource?: "config" | "managed" | "path" | "candidate";
  runtimeInstallable: boolean;
  runtimeBaseUrl: string;
  installSteps: string[];
  summary: string;
}

interface RuntimeStatus {
  ready: boolean;
  path?: string;
  installable: boolean;
  message?: string;
}

interface ModelStatus {
  model: string;
  ready: boolean;
  sizeMb: number;
  path?: string;
}

interface ProviderOption {
  id: string;
  name: string;
  baseUrl: string;
}

interface DownloadProgress {
  target: "runtime" | "model";
  phase: "downloading" | "extracting" | "locating" | "done";
  model?: string;
  receivedBytes?: number;
  totalBytes?: number;
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

function progressLabel(p: DownloadProgress): string {
  const size = p.totalBytes
    ? `${formatBytes(p.receivedBytes)} / ${formatBytes(p.totalBytes)}`
    : formatBytes(p.receivedBytes);
  switch (p.phase) {
    case "downloading":
      return `下载中${size ? ` · ${size}` : ""}`;
    case "extracting":
      return "解压中…";
    case "locating":
      return "定位可执行文件…";
    case "done":
      return "完成";
  }
}

const CLOUD_MODEL_PRESETS = [
  { value: "whisper-1", label: "whisper-1（经典）" },
  { value: "gpt-4o-mini-transcribe", label: "gpt-4o-mini-transcribe" },
  { value: "gpt-4o-transcribe", label: "gpt-4o-transcribe" },
];

export function VoiceSection() {
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(false);
  const [cfg, setCfg] = useState<VoiceConfigDTO | null>(null);
  const [env, setEnv] = useState<EnvDoctorReport | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [models, setModels] = useState<ModelStatus[]>([]);
  const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [installing, setInstalling] = useState(false);
  const [downloadingModel, setDownloadingModel] = useState(false);
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudTestResult, setCloudTestResult] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    try {
      setDevices(await listAudioInputDevices());
    } catch {
      setDevices([]);
    }
  }, []);

  const load = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api) {
      setSupported(false);
      setLoading(false);
      return;
    }
    setSupported(true);
    try {
      const [config, envReport, runtimeStatus, model, list] = await Promise.all([
        api.getConfig(),
        api.envDoctor(),
        api.runtimeStatus(),
        api.getModelStatus(),
        api.getModelList(),
      ]);
      setCfg(config);
      setEnv(envReport);
      setRuntime(runtimeStatus);
      setModelStatus(model);
      setModels(list);
    } catch (err) {
      console.error("Failed to load voice config:", err);
    } finally {
      setLoading(false);
    }
    void loadDevices();
  }, [loadDevices]);

  useEffect(() => {
    void load();
  }, [load]);

  // Provider list for the cloud track (id + name + baseUrl only).
  useEffect(() => {
    (async () => {
      try {
        const raw = (await window.electronAPI?.provider?.list?.()) as ProviderOption[] | undefined;
        if (Array.isArray(raw)) {
          setProviders(raw.map((p) => ({ id: p.id, name: p.name || p.id, baseUrl: p.baseUrl || "" })));
        }
      } catch {
        /* provider list unavailable — cloud select falls back to auto */
      }
    })();
  }, []);

  // Live download progress (runtime + model).
  useEffect(() => {
    const api = window.electronAPI?.voice;
    if (!api?.onDownloadProgress) return;
    return api.onDownloadProgress((d) => setProgress(d));
  }, []);

  // Refresh the device list on plug/unplug.
  useEffect(() => subscribeDeviceChange(() => void loadDevices()), [loadDevices]);

  // Writes map camelCase DTO fields to snake_case config.toml dotted paths.
  // The ConfigStore's setByPath creates intermediate objects, so each leaf
  // can be written independently and is persisted + broadcast immediately.
  const writeConfig = useCallback((patch: Partial<VoiceConfigDTO>) => {
    const port = window.electronAPI?.getConfigPort?.();
    if (!port) return;
    if (patch.enabled !== undefined) port.setConfig("voice.enabled", patch.enabled);
    if (patch.inputDevice !== undefined) port.setConfig("voice.input_device", patch.inputDevice);
    if (patch.engine !== undefined) port.setConfig("voice.stt.engine", patch.engine);
    if (patch.endSilenceMs !== undefined)
      port.setConfig("voice.stt.end_silence_ms", patch.endSilenceMs);
    if (patch.noSpeechTimeoutMs !== undefined)
      port.setConfig("voice.stt.no_speech_timeout_ms", patch.noSpeechTimeoutMs);
    if (patch.language !== undefined)
      port.setConfig("voice.stt.language", patch.language);
    if (patch.cloudProvider !== undefined)
      port.setConfig("voice.stt.cloud.provider", patch.cloudProvider);
    if (patch.cloudModel !== undefined)
      port.setConfig("voice.stt.cloud.size", patch.cloudModel);
    setCfg((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handleToggleEnabled = useCallback(
    (checked: boolean) => writeConfig({ enabled: checked }),
    [writeConfig],
  );

  const handleEngineChange = useCallback(
    (value: string) => writeConfig({ engine: value as "local" | "cloud" }),
    [writeConfig],
  );

  const handleDeviceChange = useCallback(
    (value: string) => writeConfig({ inputDevice: value === "__default__" ? "" : value }),
    [writeConfig],
  );

  const handleModelChange = useCallback((value: string) => {
    const port = window.electronAPI?.getConfigPort?.();
    if (!port) return;
    port.setConfig("voice.stt.local.model", value);
    setCfg((prev) => (prev ? { ...prev, model: value } : prev));
    const status = window.electronAPI?.voice?.getModelStatus?.();
    void status.then((s) => s && setModelStatus(s));
  }, []);

  const handleEndSilence = useCallback(
    (value: string) => {
      const ms = Number(value);
      if (!Number.isNaN(ms)) writeConfig({ endSilenceMs: ms });
    },
    [writeConfig],
  );

  const handleNoSpeechTimeout = useCallback(
    (value: string) => {
      const ms = Number(value);
      if (!Number.isNaN(ms)) writeConfig({ noSpeechTimeoutMs: ms });
    },
    [writeConfig],
  );

  const handleLanguage = useCallback(
    (value: string) => writeConfig({ language: value }),
    [writeConfig],
  );

  const handleCloudProvider = useCallback(
    (value: string) => writeConfig({ cloudProvider: value === "__auto__" ? "" : value }),
    [writeConfig],
  );

  const handleCloudModel = useCallback(
    (value: string) => writeConfig({ cloudModel: value.trim() }),
    [writeConfig],
  );

  const handleRunEnvDoctor = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api) return;
    const [report, runtimeStatus] = await Promise.all([api.envDoctor(), api.runtimeStatus()]);
    setEnv(report);
    setRuntime(runtimeStatus);
  }, []);

  const handleInstallRuntime = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api || installing) return;
    setInstalling(true);
    setProgress({ target: "runtime", phase: "downloading", receivedBytes: 0, totalBytes: 0 });
    try {
      const result = await api.runtimeDownload();
      if (!result.ok) setProgress(null);
      const runtimeStatus = await api.runtimeStatus();
      setRuntime(runtimeStatus);
      const report = await api.envDoctor();
      setEnv(report);
    } finally {
      setInstalling(false);
    }
  }, [installing]);

  const handleDownloadModel = useCallback(
    async (model?: string) => {
      const api = window.electronAPI?.voice;
      if (!api || downloadingModel) return;
      setDownloadingModel(true);
      setProgress({
        target: "model",
        phase: "downloading",
        model: model ?? cfg?.model,
        receivedBytes: 0,
        totalBytes: 0,
      });
      try {
        const result = await api.modelDownload(model);
        if (!result.ok) setProgress(null);
        const [list, status] = await Promise.all([api.getModelList(), api.getModelStatus()]);
        setModels(list);
        setModelStatus(status);
      } finally {
        setDownloadingModel(false);
      }
    },
    [cfg?.model, downloadingModel],
  );

  const handleCloudTest = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api || cloudTesting) return;
    setCloudTesting(true);
    setCloudTestResult(null);
    try {
      const result = await api.cloudTest();
      setCloudTestResult(
        result.ok
          ? `连接成功 · ${result.latencyMs}ms`
          : `连接失败：${result.message ?? "未知错误"}`,
      );
    } finally {
      setCloudTesting(false);
    }
  }, [cloudTesting]);

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-12">
        <SpinnerGapIcon size={18} className="animate-spin" />
        <span className="text-sm text-muted-foreground">加载中…</span>
      </div>
    );
  }

  if (!supported) {
    return (
      <SettingsSection
        title="语音输入"
        description="语音输入（STT）仅在 DUYA 桌面应用中可用。"
      >
        <SettingsCard>
          <SettingsRow label="不支持语音输入">
            <span className="text-sm text-muted-foreground">
              当前环境未提供语音 API，请使用桌面应用。
            </span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    );
  }

  const modelReady = modelStatus?.ready ?? cfg?.modelReady ?? false;
  const runtimeReady = runtime?.ready ?? env?.binaryFound ?? false;
  const selectedModelStatus = models.find((m) => m.model === cfg?.model);
  const progressPct =
    progress && progress.totalBytes && progress.receivedBytes
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null;

  const deviceOptions = [
    { value: "__default__", label: "系统默认设备" },
    ...devices
      .filter((d) => !d.isDefault)
      .map((d) => ({ value: d.deviceId, label: d.label })),
  ];

  const providerOptions = [
    { value: "__auto__", label: "自动（默认 / 第一个 provider）" },
    ...providers.map((p) => ({ value: p.id, label: p.name })),
  ];

  const cloudModelValue = cfg?.cloudModel || "whisper-1";
  const cloudModelOptions = CLOUD_MODEL_PRESETS.some((o) => o.value === cloudModelValue)
    ? CLOUD_MODEL_PRESETS
    : [{ value: cloudModelValue, label: cloudModelValue }, ...CLOUD_MODEL_PRESETS];

  return (
    <div className="settings-section">
      <SettingsSection
        title="语音输入"
        description="配置语音转文字（STT）输入：本地 Whisper 或云端 OpenAI 兼容接口。"
      >
        <SettingsCard>
          <SettingsToggle
            label="启用语音输入"
            description="允许使用麦克风进行语音输入。"
            checked={!!cfg?.enabled}
            onCheckedChange={handleToggleEnabled}
          />
          <SettingsSelectRow
            label="STT 引擎"
            description="本地 Whisper（隐私、离线）或云端 OpenAI 兼容接口。"
            value={cfg?.engine ?? "local"}
            onValueChange={handleEngineChange}
            options={[
              { value: "local", label: "本地 Whisper" },
              { value: "cloud", label: "云端（OpenAI 兼容）" },
            ]}
          />
          <SettingsSelectRow
            label="输入设备"
            description="选择麦克风输入源；设备名需要授权后才会显示。"
            value={cfg?.inputDevice ? `device:${cfg.inputDevice}` : "__default__"}
            onValueChange={(v) => handleDeviceChange(v.startsWith("device:") ? v.slice(7) : v)}
            options={
              cfg?.inputDevice && !devices.some((d) => d.deviceId === cfg.inputDevice)
                ? [
                    ...deviceOptions,
                    { value: `device:${cfg.inputDevice}`, label: "已配置的设备（未检测到）" },
                  ]
                : deviceOptions
            }
          />
          <SettingsRow
            label="刷新设备"
            description="插入或拔出麦克风后刷新列表。"
            action={
              <Button variant="ghost" size="sm" onClick={() => void loadDevices()}>
                <ArrowsClockwiseIcon size={14} className="mr-1" />
                刷新
              </Button>
            }
          >
            <span className="text-sm text-muted-foreground">
              检测到 {devices.length} 个输入设备
            </span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      {cfg?.engine === "local" ? (
        <SettingsSection
          title="本地 Whisper"
          description="一键安装 whisper.cpp 运行时与模型，或使用系统已安装的二进制。"
        >
          <SettingsCard>
            <SettingsRow
              label="Whisper 运行时"
              description={
                runtimeReady
                  ? env?.binaryPath ?? runtime?.path ?? "已检测到 whisper.cpp"
                  : runtime?.message ?? env?.summary ?? "未检测到 whisper.cpp"
              }
            >
              {runtimeReady ? (
                <span className="inline-flex items-center gap-1 text-sm text-green-500">
                  <CheckCircleIcon size={16} /> 已就绪
                </span>
              ) : runtime?.installable ? (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={installing}
                  onClick={() => void handleInstallRuntime()}
                >
                  {installing ? (
                    <SpinnerGapIcon size={14} className="mr-1 animate-spin" />
                  ) : (
                    <DownloadSimpleIcon size={14} className="mr-1" />
                  )}
                  {installing ? "安装中…" : "一键安装"}
                </Button>
              ) : (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <XCircleIcon size={16} /> 需手动安装
                </span>
              )}
            </SettingsRow>
            <SettingsSelectRow
              label="模型"
              description="模型保存在 ~/.duya/voice/models/，未下载的可在下方一键下载。"
              value={cfg?.model ?? "ggml-base.bin"}
              onValueChange={handleModelChange}
              options={models.map((m) => ({
                value: m.model,
                label: `${m.model} · ${m.sizeMb}MB${m.ready ? "（就绪）" : "（未下载）"}`,
              }))}
            />
            <SettingsRow
              label="下载模型"
              description={
                selectedModelStatus
                  ? selectedModelStatus.ready
                    ? `${selectedModelStatus.model} 已就绪（${selectedModelStatus.sizeMb}MB）`
                    : `${selectedModelStatus.model} 未下载（约 ${selectedModelStatus.sizeMb}MB）`
                  : undefined
              }
              action={
                selectedModelStatus && !selectedModelStatus.ready ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={downloadingModel}
                    onClick={() => void handleDownloadModel(selectedModelStatus.model)}
                  >
                    {downloadingModel ? (
                      <SpinnerGapIcon size={14} className="mr-1 animate-spin" />
                    ) : (
                      <DownloadSimpleIcon size={14} className="mr-1" />
                    )}
                    {downloadingModel ? "下载中…" : "下载"}
                  </Button>
                ) : undefined
              }
            >
              {selectedModelStatus?.ready ? (
                <span className="inline-flex items-center gap-1 text-sm text-green-500">
                  <CheckCircleIcon size={16} /> 就绪
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </SettingsRow>
            {progress && (installing || downloadingModel) && (
              <div className="py-2">
                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                  <span>
                    {progress.target === "runtime" ? "运行时" : `模型 ${progress.model ?? ""}`}
                    {" · "}
                    {progressLabel(progress)}
                  </span>
                  {progressPct !== null && <span>{progressPct}%</span>}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all"
                    style={{ width: `${progressPct ?? (progress.phase === "done" ? 100 : 8)}%` }}
                  />
                </div>
              </div>
            )}
          </SettingsCard>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="云端识别"
          description="复用已配置的 OpenAI 兼容 provider 调用 /audio/transcriptions。"
        >
          <SettingsCard>
            <SettingsSelectRow
              label="Provider"
              description="留空则自动使用默认 provider（或第一个已配置的 provider）。"
              value={cfg?.cloudProvider ? cfg.cloudProvider : "__auto__"}
              onValueChange={handleCloudProvider}
              options={providerOptions}
            />
            <SettingsSelectRow
              label="云端模型"
              description="transcriptions 模型名；也可在 config.toml 中自定义。"
              value={cloudModelValue}
              onValueChange={(v) => handleCloudModel(v)}
              options={cloudModelOptions}
            />
            <SettingsRow
              label="连接测试"
              description="用 0.2 秒静音音频实测转写端点。"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={cloudTesting}
                  onClick={() => void handleCloudTest()}
                >
                  {cloudTesting ? "测试中…" : "测试"}
                </Button>
              }
            >
              {cloudTestResult ? (
                <span
                  className={`text-sm ${
                    cloudTestResult.startsWith("连接成功") ? "text-green-500" : "text-destructive"
                  }`}
                >
                  {cloudTestResult}
                </span>
              ) : cfg?.modelReady ? (
                <span className="inline-flex items-center gap-1 text-sm text-green-500">
                  <CheckCircleIcon size={16} /> 就绪
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">未验证</span>
              )}
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection
        title="识别参数"
        description="调整语音识别与静音检测参数。"
      >
        <SettingsCard>
          <SettingsInput
            label="静音结束时间（毫秒）"
            description="检测到静音多少毫秒后结束录制。"
            type="text"
            value={String(cfg?.endSilenceMs ?? 900)}
            onChange={handleEndSilence}
          />
          <SettingsInput
            label="无语音超时（毫秒）"
            description="未检测到语音多少毫秒后自动取消。"
            type="text"
            value={String(cfg?.noSpeechTimeoutMs ?? 4000)}
            onChange={handleNoSpeechTimeout}
          />
          <SettingsInput
            label="语言"
            description="目标语言代码，例如 zh 或 en。留空表示自动。"
            type="text"
            value={cfg?.language ?? ""}
            onChange={handleLanguage}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="环境检测"
        description="检查 whisper.cpp 运行环境（含手动安装指引）。"
      >
        <SettingsCard>
          <SettingsRow
            label="运行环境"
            description={env?.summary ?? "未检测"}
            action={
              <Button variant="ghost" size="sm" onClick={() => void handleRunEnvDoctor()}>
                重新检测
              </Button>
            }
          >
            {env?.binaryFound ? (
              <span className="inline-flex items-center gap-1 text-sm text-green-500">
                <CheckCircleIcon size={16} /> 已就绪
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm text-destructive">
                <XCircleIcon size={16} /> 缺失
              </span>
            )}
          </SettingsRow>
          {env?.binaryFound && env.binaryPath && (
            <div className="py-3.5">
              <div className="text-sm font-medium text-foreground mb-2">二进制路径</div>
              <div className="font-mono text-xs text-muted-foreground break-all">
                {env.binaryPath}
                {env.binarySource ? ` （来源：${env.binarySource}）` : ""}
              </div>
            </div>
          )}
          {!env?.binaryFound && !!env?.installSteps?.length && (
            <div className="py-3.5">
              <div className="text-sm font-medium text-foreground mb-2">安装指引</div>
              <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                {env.installSteps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
