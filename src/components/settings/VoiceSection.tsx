"use client";

import { useCallback, useEffect, useState } from "react";
import {
  MicrophoneIcon,
  SpinnerGapIcon,
  CheckCircleIcon,
  XCircleIcon,
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

// Renderer-side mirror of the `envDoctor` / `getModelStatus` IPC shapes.
interface EnvDoctorReport {
  platform: string;
  binaryFound: boolean;
  binaryPath?: string;
  installSteps: string[];
  summary: string;
}

interface ModelStatus {
  model: string;
  ready: boolean;
  sizeMb: number;
  path?: string;
}

export function VoiceSection() {
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(false);
  const [cfg, setCfg] = useState<VoiceConfigDTO | null>(null);
  const [env, setEnv] = useState<EnvDoctorReport | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelStatus | null>(null);
  const [models, setModels] = useState<ModelStatus[]>([]);

  const load = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api) {
      setSupported(false);
      setLoading(false);
      return;
    }
    setSupported(true);
    try {
      const [config, envReport, model, list] = await Promise.all([
        api.getConfig(),
        api.envDoctor(),
        api.getModelStatus(),
        api.getModelList(),
      ]);
      setCfg(config);
      setEnv(envReport);
      setModelStatus(model);
      setModels(list);
    } catch (err) {
      console.error("Failed to load voice config:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Writes map camelCase DTO fields to snake_case config.toml dotted paths.
  // The ConfigStore's setByPath creates intermediate objects, so each leaf
  // can be written independently and is persisted + broadcast immediately.
  const writeConfig = useCallback((patch: Partial<VoiceConfigDTO>) => {
    const port = window.electronAPI?.getConfigPort?.();
    if (!port) return;
    if (patch.enabled !== undefined) port.setConfig("voice.enabled", patch.enabled);
    if (patch.engine !== undefined) port.setConfig("voice.stt.engine", patch.engine);
    if (patch.endSilenceMs !== undefined)
      port.setConfig("voice.stt.end_silence_ms", patch.endSilenceMs);
    if (patch.noSpeechTimeoutMs !== undefined)
      port.setConfig("voice.stt.no_speech_timeout_ms", patch.noSpeechTimeoutMs);
    if (patch.language !== undefined)
      port.setConfig("voice.stt.language", patch.language);
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

  const handleModelChange = useCallback((value: string) => {
    const port = window.electronAPI?.getConfigPort?.();
    if (!port) return;
    port.setConfig("voice.stt.local.model", value);
    setCfg((prev) => (prev ? { ...prev, model: value } : prev));
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

  const handleRunEnvDoctor = useCallback(async () => {
    const api = window.electronAPI?.voice;
    if (!api) return;
    const report = await api.envDoctor();
    setEnv(report);
  }, []);

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

  return (
    <div className="settings-section">
      <SettingsSection
        title="语音输入"
        description="配置本地语音转文字（STT）输入。"
        icon={<MicrophoneIcon size={18} />}
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
            description="选择语音识别引擎。"
            value={cfg?.engine ?? "local"}
            onValueChange={handleEngineChange}
            options={[
              { value: "local", label: "本地 Whisper" },
              { value: "cloud", label: "云端（OpenAI 兼容）" },
            ]}
          />
          {cfg?.engine === "local" ? (
            <SettingsSelectRow
              label="模型"
              description="选择本地 Whisper 模型（小/中模型需下载到 ~/.duya/voice/models/，见下方环境检测）。"
              value={cfg?.model ?? "ggml-base.bin"}
              onValueChange={handleModelChange}
              options={models.map((m) => ({
                value: m.model,
                label: `${m.model} · ${m.sizeMb}MB${m.ready ? "（就绪）" : "（未下载）"}`,
              }))}
            />
          ) : (
            <SettingsRow label="云端模型" description={`${cfg?.model ?? "whisper-1"} · 使用配置的 provider`}>
              {modelReady ? (
                <span className="inline-flex items-center gap-1 text-sm text-green-500">
                  <CheckCircleIcon size={16} /> 就绪
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                  <XCircleIcon size={16} /> 未配置
                </span>
              )}
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="识别参数"
        description="调整语音识别与静音检测参数。"
      >
        <SettingsCard>
          <SettingsInput
            label="静音结束时间（毫秒）"
            description="检测到静音多少毫秒后结束录制。"
            type="text"
            value={String(cfg?.endSilenceMs ?? 800)}
            onChange={handleEndSilence}
          />
          <SettingsInput
            label="无语音超时（毫秒）"
            description="未检测到语音多少毫秒后自动取消。"
            type="text"
            value={String(cfg?.noSpeechTimeoutMs ?? 3000)}
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
        description="检查语音识别二进制是否可用。"
      >
        <SettingsCard>
          <SettingsRow
            label="运行环境"
            description={env?.summary ?? "未检测"}
            action={
              <Button variant="ghost" size="sm" onClick={handleRunEnvDoctor}>
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
          {!env?.binaryFound && env?.binaryPath && (
            <div className="py-3.5">
              <div className="text-sm font-medium text-foreground">预期路径</div>
              <div className="mt-0.5 font-mono text-xs text-muted-foreground break-all">
                {env.binaryPath}
              </div>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}