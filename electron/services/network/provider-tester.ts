import { fetchOllamaModels } from './model-detector';

export interface TestProviderBody {
  provider_type?: string;
  base_url?: string;
  api_key?: string;
  model?: string;
  auth_style?: 'api_key' | 'auth_token' | 'env_only';
}

export interface ConnectionTestResult {
  success: boolean;
  message?: string;
  error?: {
    code: string;
    message: string;
    suggestion?: string;
  };
}

function classifyError(error: unknown, baseUrl?: string): ConnectionTestResult['error'] {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('fetch failed')) {
    return {
      code: 'CONNECTION_FAILED',
      message: '无法连接到服务器',
      suggestion: '请检查 Base URL 是否正确，以及网络连接是否正常',
    };
  }

  if (message.includes('401') || message.includes('Unauthorized')) {
    return {
      code: 'AUTH_FAILED',
      message: '认证失败',
      suggestion: '请检查 API Key 是否正确',
    };
  }

  if (message.includes('403') || message.includes('Forbidden')) {
    return {
      code: 'ACCESS_DENIED',
      message: '访问被拒绝',
      suggestion: '您的 API Key 可能没有权限访问此资源',
    };
  }

  if (message.includes('429') || message.includes('Rate limit')) {
    return {
      code: 'RATE_LIMITED',
      message: '请求过于频繁',
      suggestion: '请稍后再试',
    };
  }

  if (message.includes('404') || message.includes('Not Found')) {
    return {
      code: 'ENDPOINT_NOT_FOUND',
      message: 'API 端点未找到 (404)',
      suggestion: `请检查 Base URL 是否正确。当前 URL: ${baseUrl || '未设置'}`,
    };
  }

  if (message.includes('timeout') || message.includes('aborted')) {
    return {
      code: 'TIMEOUT',
      message: '连接超时',
      suggestion: '服务器响应时间过长，请检查网络或稍后重试',
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: message.slice(0, 200),
    suggestion: '请检查配置是否正确',
  };
}

export async function testProviderConnection(body: TestProviderBody): Promise<ConnectionTestResult> {
  const { provider_type, base_url, api_key, model, auth_style } = body;

  if (!api_key && auth_style !== 'env_only') {
    return {
      success: false,
      error: {
        code: 'NO_CREDENTIALS',
        message: 'API Key is required',
        suggestion: 'Please enter your API Key',
      },
    };
  }

  if (provider_type === 'bedrock' || provider_type === 'vertex' || auth_style === 'env_only') {
    return {
      success: false,
      error: {
        code: 'SKIPPED',
        message: '此类提供商无法直接测试连接',
        suggestion: '请保存配置后发送消息来验证连接',
      },
    };
  }

  const isOllama = provider_type === 'ollama' ||
    (base_url && (
      base_url.includes('localhost:11434') ||
      base_url.includes('127.0.0.1:11434') ||
      base_url.includes('ollama')
    ));

  if (isOllama) {
    const result = await fetchOllamaModels(base_url || 'http://localhost:11434');
    if (result.success) {
      const modelCount = result.models?.length || 0;
      return {
        success: true,
        message: `连接成功，找到 ${modelCount} 个本地模型`,
      };
    } else {
      return {
        success: false,
        error: classifyError(result.error || '连接失败', base_url),
      };
    }
  }

  const isOpenAICompatible = provider_type === 'openai' ||
    provider_type === 'openai-compatible' ||
    (base_url && (
      base_url.includes('openrouter') ||
      base_url.includes('openai') ||
      base_url.includes('api.deepseek') ||
      base_url.includes('api.moonshot') ||
      base_url.includes('api.groq') ||
      base_url.includes('api.together') ||
      base_url.includes('api.perplexity')
    ));

  let apiUrl = base_url || 'https://api.anthropic.com';
  apiUrl = apiUrl.replace(/\/+$/, '');

  if (isOpenAICompatible) {
    if (!apiUrl.endsWith('/v1/chat/completions')) {
      if (!apiUrl.endsWith('/v1')) {
        apiUrl += '/v1';
      }
      apiUrl += '/chat/completions';
    }
  } else {
    if (!apiUrl.endsWith('/v1/messages')) {
      if (!apiUrl.endsWith('/v1')) {
        apiUrl += '/v1';
      }
      apiUrl += '/messages';
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (isOpenAICompatible) {
    headers['Authorization'] = `Bearer ${api_key}`;
  } else {
    headers['anthropic-version'] = '2023-06-01';
    if (auth_style === 'auth_token') {
      headers['Authorization'] = `Bearer ${api_key}`;
    } else {
      headers['x-api-key'] = api_key!;
    }
  }

  if (!model) {
    return {
      success: false,
      error: {
        code: 'NO_MODEL',
        message: 'Model is required',
        suggestion: 'Select or enter a model name before testing',
      },
    };
  }
  const testModel = model;

  const requestBody = JSON.stringify({
    model: testModel,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (response.ok) {
      return {
        success: true,
        message: '连接成功',
      };
    }

    let errorBody = '';
    try {
      errorBody = await response.text();
    } catch { /* ignore */ }

    const error = classifyError(
      new Error(`HTTP ${response.status}: ${errorBody.slice(0, 500)}`),
      base_url
    );

    return { success: false, error };
  } catch (err) {
    clearTimeout(timeoutId);
    const error = classifyError(err, base_url);
    return { success: false, error };
  }
}
