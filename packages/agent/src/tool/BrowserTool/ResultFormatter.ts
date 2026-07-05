/**
 * ResultFormatter - Formats browser tool action results as structured markdown.
 *
 * Transforms raw JSON action results into LLM-friendly structured output,
 * similar to Codex's browser tool output format.
 *
 * Design principles:
 * - Section headers (###) for scannability
 * - Bullet lists for key-value metadata
 * - Keep SnapshotEngine's compact HTML-like snapshot format as-is
 * - Concise one-liners for simple interaction confirmations
 */

// ─── Public API ────────────────────────────────────────────────────────────

export function formatResult(operation: string, result: Record<string, unknown>): string {
  switch (operation) {
    case 'navigate':
    case 'go_back':
      return formatPageWithSnapshot(result);
    case 'snapshot':
      return formatSnapshotResult(result);
    case 'click':
      return formatClickResult(result);
    case 'type':
      return formatTypeResult(result);
    case 'scroll':
      return formatScrollResult(result);
    case 'hover':
      return formatHoverResult(result);
    case 'press_key':
      return formatPressKeyResult(result);
    case 'wait':
      return formatWaitResult(result);
    case 'select':
      return formatSelectResult(result);
    case 'evaluate':
      return formatEvaluateResult(result);
    case 'iframe_evaluate':
      return formatIframeEvaluateResult(result);
    case 'screenshot':
      return formatScreenshotResult(result);
    case 'tabs_list':
      return formatTabsListResult(result);
    case 'tabs_new':
      return formatTabsNewResult(result);
    case 'tabs_close':
      return formatTabsCloseResult(result);
    case 'tabs_select':
      return formatTabsSelectResult(result);
    case 'file_upload':
      return formatFileUploadResult(result);
    case 'network_start':
      return formatNetworkStartResult(result);
    case 'network_read':
      return formatNetworkReadResult(result);
    case 'cookies':
      return formatCookiesResult(result);
    case 'parallel_fetch':
      return formatParallelFetchResult(result);
    case 'close_window':
      return formatCloseWindowResult(result);
    default:
      return formatGenericResult(operation, result);
  }
}

// ─── Page / Navigation Formatters ──────────────────────────────────────────

function formatPageWithSnapshot(result: Record<string, unknown>): string {
  const url = String(result.url || 'unknown');
  const title = String(result.title || '');
  const mode = String(result.mode || '');
  const platformType = result.platformType ? String(result.platformType) : undefined;

  const lines: string[] = [];

  lines.push('### Page');
  lines.push(`- URL: ${url}`);
  if (title) lines.push(`- Title: ${title}`);
  if (platformType) lines.push(`- Platform: ${platformType}`);

  const snapshot = extractSnapshot(result, 'compactSnapshot');
  const interactiveElements = extractInteractiveElements(result);
  const summary = snapshot ? buildSnapshotSummary(snapshot, title, platformType) : null;
  const visibleText = snapshot ? extractVisibleText(snapshot) : [];

  if (summary) {
    lines.push('');
    lines.push('### Summary');
    lines.push(summary);
  }

  if (visibleText.length > 0) {
    lines.push('');
    lines.push('### Visible Text');
    for (const t of visibleText) {
      lines.push(`- ${t}`);
    }
  }

  if (snapshot) {
    lines.push('');
    lines.push('### Snapshot');
    lines.push(snapshot);
  } else if (result.snapshotNote) {
    lines.push('');
    lines.push(`> ${result.snapshotNote}`);
  }

  if (interactiveElements) {
    lines.push('');
    lines.push(interactiveElements);
  }

  return lines.join('\n');
}

function formatSnapshotResult(result: Record<string, unknown>): string {
  const lines: string[] = [];

  const snapshot = extractSnapshot(result, 'snapshot');
  const interactiveElements = extractInteractiveElements(result);

  if (snapshot) {
    lines.push('### Snapshot');
    lines.push(snapshot);
  }

  if (interactiveElements) {
    lines.push('');
    lines.push(interactiveElements);
  }

  if (result.truncated) {
    lines.push('');
    lines.push('> Snapshot was truncated due to size limits.');
  }

  return lines.join('\n') || '(empty page)';
}

// ─── Interaction Formatters ────────────────────────────────────────────────

function formatClickResult(result: Record<string, unknown>): string {
  const ref = String(result.clicked || 'unknown');
  const url = result.url ? String(result.url) : '';
  return url ? `Clicked [ref=${ref}] → ${url}` : `Clicked [ref=${ref}]`;
}

function formatTypeResult(result: Record<string, unknown>): string {
  const text = String(result.typed || '');
  const ref = String(result.into || 'unknown');
  const submitted = result.submitted ? ' + Enter' : '';
  return `Typed "${text}" into [ref=${ref}]${submitted}`;
}

function formatScrollResult(result: Record<string, unknown>): string {
  const direction = String(result.direction || 'down');
  const amount = String(result.amount || '300');
  return `Scrolled ${direction} ${amount}px`;
}

function formatHoverResult(result: Record<string, unknown>): string {
  const ref = String(result.hovered || 'unknown');
  return `Hovered [ref=${ref}]`;
}

function formatPressKeyResult(result: Record<string, unknown>): string {
  const key = String(result.key || 'unknown');
  return `Pressed key: ${key}`;
}

function formatWaitResult(result: Record<string, unknown>): string {
  if (result.waitedMs !== undefined) {
    return `Waited ${result.waitedMs}ms`;
  }
  if (result.elementFound) {
    return `Element found: ${result.elementFound}`;
  }
  if (result.pageLoaded) {
    return 'Page loaded';
  }
  return 'Wait completed';
}

function formatSelectResult(result: Record<string, unknown>): string {
  if (result.selected && typeof result.selected === 'object') {
    const sel = result.selected as Record<string, unknown>;
    return `Selected "${sel.value}" on [ref=${sel.ref}]`;
  }
  return 'Selection completed';
}

// ─── Script / Evaluate Formatters ──────────────────────────────────────────

function formatEvaluateResult(result: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('### Evaluate Result');

  const evalResult = result.result;
  if (evalResult === undefined || evalResult === null) {
    lines.push('(no return value)');
  } else if (typeof evalResult === 'string') {
    lines.push(evalResult.length > 3000
      ? evalResult.slice(0, 3000) + '\n\n> Truncated to 3000 chars.'
      : evalResult);
  } else {
    const json = JSON.stringify(evalResult, null, 2);
    lines.push(json.length > 3000
      ? json.slice(0, 3000) + '\n\n> Truncated to 3000 chars.'
      : json);
  }

  return lines.join('\n');
}

function formatIframeEvaluateResult(result: Record<string, unknown>): string {
  const frameIndex = String(result.frameIndex || '?');
  const lines: string[] = [];
  lines.push(`### Iframe[${frameIndex}] Evaluate Result`);

  const evalResult = result.result;
  if (evalResult === undefined || evalResult === null) {
    lines.push('(no return value)');
  } else if (typeof evalResult === 'string') {
    lines.push(evalResult.length > 3000
      ? evalResult.slice(0, 3000) + '\n\n> Truncated to 3000 chars.'
      : evalResult);
  } else {
    const json = JSON.stringify(evalResult, null, 2);
    lines.push(json.length > 3000
      ? json.slice(0, 3000) + '\n\n> Truncated to 3000 chars.'
      : json);
  }

  return lines.join('\n');
}

// ─── Screenshot Formatter ──────────────────────────────────────────────────

function formatScreenshotResult(result: Record<string, unknown>): string {
  const fullPage = result.fullPage ? ' (full page)' : '';
  const selector = result.selector ? ` [${result.selector}]` : '';
  const filePath = typeof result.filePath === 'string' ? result.filePath : null;

  if (filePath) {
    return [
      `Screenshot captured${fullPage}${selector}`,
      `filePath: ${filePath}`,
      'Pass this filePath to vision_analyze to inspect the image visually.',
    ].join('\n');
  }

  if (result.screenshot) {
    return `Screenshot captured${fullPage}${selector} (inline data URL — prefer filePath if available)`;
  }

  if (result.error) {
    return `Screenshot failed: ${String(result.error)}`;
  }

  return 'Screenshot: (no data)';
}

// ─── Tab Management Formatters ─────────────────────────────────────────────

function formatTabsListResult(result: Record<string, unknown>): string {
  const tabs = result.tabs;
  if (!Array.isArray(tabs) || tabs.length === 0) {
    return 'No tabs open';
  }

  const lines: string[] = ['### Tabs'];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i] as Record<string, unknown>;
    const active = tab.active ? ' [active]' : '';
    const title = String(tab.title || '').slice(0, 60);
    const url = String(tab.url || '').slice(0, 80);
    lines.push(`- ${i}: ${title || url}${active}`);
  }
  return lines.join('\n');
}

function formatTabsNewResult(result: Record<string, unknown>): string {
  if (result.newTabId) {
    return `New tab opened: ${result.newTabId}`;
  }
  return 'New tab opened';
}

function formatTabsCloseResult(result: Record<string, unknown>): string {
  const closed = result.closed ? ` ${result.closed}` : '';
  return `Tab closed${closed}`;
}

function formatTabsSelectResult(result: Record<string, unknown>): string {
  const selected = result.selected ? ` ${result.selected}` : '';
  return `Switched to tab${selected}`;
}

// ─── Other Formatters ──────────────────────────────────────────────────────

function formatFileUploadResult(result: Record<string, unknown>): string {
  const files = result.uploaded;
  const selector = String(result.selector || '');
  if (Array.isArray(files)) {
    return `Uploaded ${files.length} file(s) to ${selector}: ${files.join(', ')}`;
  }
  return 'File upload completed';
}

function formatNetworkStartResult(result: Record<string, unknown>): string {
  if (result.started) {
    const pattern = result.pattern ? ` (pattern: ${result.pattern})` : '';
    return `Network capture started${pattern}`;
  }
  return 'Network capture not supported in this mode';
}

function formatNetworkReadResult(result: Record<string, unknown>): string {
  const entries = result.requests;
  if (!Array.isArray(entries) || entries.length === 0) {
    return 'No network entries captured';
  }

  const lines: string[] = [`### Network (${entries.length} entries)`];
  for (const entry of entries.slice(0, 20)) {
    if (typeof entry === 'object' && entry !== null) {
      const e = entry as Record<string, unknown>;
      const method = String(e.method || 'GET');
      const url = String(e.url || '').slice(0, 100);
      const status = e.status !== undefined ? String(e.status) : '';
      lines.push(`- ${method} ${url} → ${status}`);
    }
  }
  if (entries.length > 20) {
    lines.push(`- ...${entries.length - 20} more entries`);
  }
  return lines.join('\n');
}

function formatCookiesResult(result: Record<string, unknown>): string {
  const cookies = result.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return 'No cookies found';
  }

  const lines: string[] = [`### Cookies (${cookies.length})`];
  for (const cookie of cookies.slice(0, 20)) {
    if (typeof cookie === 'object' && cookie !== null) {
      const c = cookie as Record<string, unknown>;
      const name = String(c.name || '');
      const domain = String(c.domain || '');
      lines.push(`- ${name} (${domain})`);
    }
  }
  return lines.join('\n');
}

function formatParallelFetchResult(result: Record<string, unknown>): string {
  const results = result.results;
  const total = result.total as number | undefined;
  const successful = result.successful as number | undefined;
  const mode = result.mode as string | undefined;
  const poolStats = result.poolStats as Record<string, unknown> | undefined;

  const lines: string[] = [];

  lines.push('### Parallel Fetch Results');

  if (mode) {
    lines.push(`Mode: \`${mode}\``);
  }

  if (total !== undefined) {
    const successCount = successful ?? 0;
    const failedCount = total - successCount;
    lines.push(`Total: ${total} | Success: ${successCount} | Failed: ${failedCount}`);
  }

  if (poolStats) {
    const tabs = poolStats.totalTabs as number | undefined;
    const active = poolStats.activeTabs as number | undefined;
    if (tabs !== undefined && active !== undefined) {
      lines.push(`Pool: ${active}/${tabs} tabs active`);
    }
  }

  if (Array.isArray(results)) {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (typeof r !== 'object' || r === null) continue;

      const item = r as Record<string, unknown>;
      const url = String(item.url || '');
      const title = String(item.title || '');
      const error = item.error ? String(item.error) : '';
      const duration = item.durationMs ? `${item.durationMs}ms` : '';
      const index = typeof item.id === 'string' ? item.id : `${i + 1}`;
      const platformType = item.platformType ? String(item.platformType) : undefined;

      if (error) {
        lines.push('');
        lines.push(`#### [${index}] ${url}`);
        lines.push(`| Status | ${duration ? 'Duration | ' : ''}Error |`);
        lines.push(`|--------|${duration ? '----------|' : ''}-------|`);
        const durCol = duration ? ` ${duration} |` : '';
        lines.push(`| :red_circle: FAILED |${durCol} ${error.slice(0, 200)} |`);
        continue;
      }

      lines.push('');
      lines.push(`#### [${index}] ${url}`);

      const metadataParts: string[] = [];
      if (title) metadataParts.push(`**Title**: ${title.slice(0, 120)}`);
      if (duration) metadataParts.push(`**Duration**: ${duration}`);
      if (platformType) metadataParts.push(`**Platform**: ${platformType}`);
      if (metadataParts.length > 0) {
        lines.push(metadataParts.join(' | '));
      }

      const snapshotStr = formatPerItemSnapshot(item, title, platformType);
      if (snapshotStr) {
        lines.push('');
        lines.push(snapshotStr);
      }

      const interactiveStr = extractInteractiveElements(item);
      if (interactiveStr) {
        lines.push('');
        lines.push(interactiveStr);
      }
    }
  }

  return lines.join('\n');
}

function formatPerItemSnapshot(
  item: Record<string, unknown>,
  title: string,
  platformType: string | undefined,
): string {
  const rawSnapshot: string | null =
    (typeof item.compactSnapshot === 'string' ? item.compactSnapshot :
     typeof item.snapshot === 'string' ? item.snapshot :
     typeof item.content === 'string' ? item.content :
     null);

  const snapshot = extractSnapshot({ compactSnapshot: rawSnapshot }, 'compactSnapshot');
  const summary = snapshot ? buildSnapshotSummary(snapshot, title, platformType) : null;
  const visibleText = snapshot ? extractVisibleText(snapshot) : [];

  const parts: string[] = [];

  if (summary) {
    parts.push('### Summary');
    parts.push(summary);
  }

  if (visibleText.length > 0) {
    parts.push('');
    parts.push('### Visible Text');
    for (const t of visibleText) {
      parts.push(`- ${t}`);
    }
  }

  if (snapshot) {
    parts.push('');
    parts.push('### Snapshot');
    parts.push(snapshot);
  }

  return parts.join('\n');
}

function formatCloseWindowResult(_result: Record<string, unknown>): string {
  return 'Browser window closed';
}

function formatGenericResult(operation: string, result: Record<string, unknown>): string {
  if (result.error) {
    return `### ${operation}\nError: ${result.error}`;
  }

  const keys = Object.keys(result).filter(k =>
    k !== 'mode' && k !== 'operation' && result[k] !== undefined && result[k] !== null
  );

  if (keys.length === 0) {
    return `${operation}: completed`;
  }

  const lines: string[] = [`### ${operation}`];
  for (const key of keys) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 500) {
      lines.push(`- ${key}: ${value.slice(0, 500)}...`);
    } else if (typeof value === 'object') {
      lines.push(`- ${key}: ${JSON.stringify(value).slice(0, 200)}`);
    } else {
      lines.push(`- ${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractSnapshot(result: Record<string, unknown>, key: string): string | null {
  const raw = result[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  let content = raw.trim();

  if (content.length > 100000) {
    content = content.slice(0, 100000) + '\n\n> Snapshot truncated (100k char limit).';
  }

  return content;
}

function extractInteractiveElements(result: Record<string, unknown>): string | null {
  const elements = result.interactiveElements;
  if (!Array.isArray(elements) || elements.length === 0) return null;

  const count = elements.length;
  const lines: string[] = [`### Actions (${count})`];

  for (const el of elements.slice(0, 30)) {
    if (typeof el === 'object' && el !== null) {
      const e = el as Record<string, unknown>;
      const ref = e.ref !== undefined ? `[${e.ref}]` : '[-]';
      const tag = String(e.tag || '?');
      const role = typeof e.type === 'string' && e.type.trim() ? e.type.trim() : '';
      const textRaw = typeof e.text === 'string' ? e.text.trim() : '';
      const aria = typeof e.ariaLabel === 'string' ? e.ariaLabel.trim() : '';
      const label = textRaw || aria;
      const labelPart = label ? ` "${label.slice(0, 80)}"` : '';
      const rolePart = role ? ` (${role})` : '';
      lines.push(`- ${ref} ${tag}${rolePart}${labelPart}`);
    }
  }

  if (elements.length > 30) {
    lines.push(`- ...${elements.length - 30} more elements`);
  }

  return lines.join('\n');
}

function buildSnapshotSummary(snapshot: string, title: string, platformType?: string): string | null {
  const lines = snapshot.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;

  const refCount = lines.filter(l => l.includes('[ref=')).length;
  const hasForm = lines.some(l => l.includes('form'));
  const hasListLike = lines.some(l => l.includes('list') || l.includes('grid'));
  const hasSearch = lines.some(l => /search|搜索/i.test(l));

  const parts: string[] = [];
  if (title) parts.push(`页面标题为 "${title}"。`);
  if (platformType) parts.push(`页面类型：${platformType}。`);
  if (hasSearch) parts.push('页面包含搜索相关区域。');
  if (hasForm) parts.push('页面包含可填写表单。');
  if (hasListLike) parts.push('页面主体可能为列表或网格内容。');
  if (refCount > 0) parts.push(`当前可交互元素约 ${refCount} 个。`);

  if (parts.length === 0) return `页面已加载，捕获到 ${lines.length} 行结构化快照。`;
  return parts.join(' ');
}

function extractVisibleText(snapshot: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = snapshot.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const quoted = trimmed.match(/"([^"]{2,120})"/g) || [];
    for (const q of quoted) {
      const text = q.slice(1, -1).replace(/\s+/g, ' ').trim();
      if (isUsefulVisibleText(text) && !seen.has(text)) {
        seen.add(text);
        out.push(text);
        if (out.length >= 8) return out;
      }
    }
  }

  return out;
}

function isUsefulVisibleText(text: string): boolean {
  if (!text || text.length < 2) return false;
  if (/^[\W_]+$/.test(text)) return false;
  if (/^(html|body|div|span|svg|path|g|li|ul|ol|section|article)$/i.test(text)) return false;
  return true;
}
