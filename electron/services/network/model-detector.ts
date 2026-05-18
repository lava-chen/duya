interface OllamaModel {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaModelsResult {
  success: boolean;
  models?: Array<{ id: string; name: string; size?: number; modified_at?: string }>;
  error?: string;
}

export async function fetchOllamaModels(baseUrl: string): Promise<OllamaModelsResult> {
  try {
    let apiUrl = baseUrl || 'http://localhost:11434';
    apiUrl = apiUrl.replace(/\/$/, '');
    apiUrl = apiUrl.replace(/\/v1$/, '');

    const response = await fetch(`${apiUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `HTTP ${response.status}: ${await response.text()}`,
      };
    }

    const data = await response.json() as { models: OllamaModel[] };

    return {
      success: true,
      models: data.models.map((m) => ({
        id: m.name,
        name: m.name,
        size: m.size,
        modified_at: m.modified_at,
      })),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

export type { OllamaModelsResult };
