/** Translate session model placeholders into a status people can act on. */
export interface TuiModelStatus {
  readonly provider: string;
  readonly model: string;
  readonly statusText: string;
}

/** Describe the active selection without exposing the storage placeholder `env`. */
export function describeTuiModelStatus(
  providerId: string,
  sessionModel: string,
  requestedModel?: string,
): TuiModelStatus {
  if (providerId === 'env') {
    return {
      provider: '未选择模型',
      model: '输入 /provider',
      statusText: '未选择模型 · /provider',
    };
  }

  const model = sessionModel || requestedModel;
  if (!model) {
    return {
      provider: providerId,
      model: '请选择模型',
      statusText: `${providerId} · /model 选择`,
    };
  }

  return {
    provider: providerId,
    model,
    statusText: `${providerId} · ${model}`,
  };
}
