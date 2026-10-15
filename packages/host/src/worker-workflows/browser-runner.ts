/**
 * browser-runner.ts — dwf `wf.browser` 节点执行器（plan 564）。
 *
 * 与 gui-runner（桌面 UIA/SOM 元素）平行的浏览器插件节点：把一段**确定性**
 * 步骤序列经 BrowserBackendPort 打到真实浏览器。生产后端 = daemon → 扩展 CDP
 * 动作（process/browser-backend.ts）；测试注入 canned backend。
 *
 * 与 gui 节点的关键差异：
 *   - 元素定位是 **CSS selector**（或扩展快照的 `@ref`），不是 `som:<n>`；
 *   - 扩展未安装/未连通时按 on_stuck 走——这是「连通时才可用」的节点；
 *   - 无 capture/verify 阶梯：扩展动作自带读回（navigate 等 load、click 先
 *     scrollIntoView），v1 不做 454 verdict 阶梯。
 */

import type { ArtifactStore } from './gui-artifacts.js';

export type BrowserStep =
  | { do: 'navigate'; url: string; optional?: boolean }
  | { do: 'click'; selector: string; optional?: boolean }
  | { do: 'click_text'; text: string; exact?: boolean; optional?: boolean }
  | { do: 'type'; selector: string; text: string; optional?: boolean }
  | { do: 'set_value'; selector: string; value: string; optional?: boolean }
  | { do: 'key'; key: string; optional?: boolean }
  | { do: 'scroll'; direction?: 'up' | 'down' | 'left' | 'right'; amount?: number; optional?: boolean }
  | { do: 'wait'; ms?: number; selector?: string; text?: string; timeoutMs?: number; optional?: boolean }
  | { do: 'screenshot'; name?: string; fullPage?: boolean; optional?: boolean };

export interface BrowserNodeSpec {
  /** 起点导航（等价隐式首步 navigate，不占 max_actions）。起点确定性第一死因防线。 */
  start_url?: string;
  steps: BrowserStep[];
  /** 步骤数护栏（默认 64）。超出 = 配置错误，loud fail 而非静默截断。 */
  max_actions?: number;
  /** 失败阶梯。默认 'fail'；'agent' 兜底与 gui 同构——声明了但未接线，按 fail 报错。 */
  on_stuck?: 'agent' | 'fail' | 'skip';
  /** 调用结束回收会话标签页（默认 true）。跨 wf.browser 调用接力同一页面时置 false。 */
  close_tab?: boolean;
}

/** 单步结果。navigate 附带 {url,title}；screenshot 附带 {base64}。 */
export interface BrowserStepResult {
  ok: boolean;
  error?: string;
  data?: Record<string, unknown>;
}

export interface BrowserBackendPort {
  /**
   * 连通性检查：daemon 不可达 / 扩展未握手时 throw，message 面向用户
   * （指明要装/连 DUYA Browser Bridge 扩展）。
   */
  connect(): Promise<void>;
  run(step: BrowserStep): Promise<BrowserStepResult>;
  /** 回收会话标签页（daemon `close_session`）。close_tab !== false 时调用。 */
  close(): Promise<void>;
}

export interface BrowserNodeOutcome {
  status: 'succeeded' | 'failed' | 'skipped';
  output?: {
    url?: string;
    title?: string;
    /** 实际执行的步骤数（skip 的步骤不计）。 */
    steps: number;
    /** 截图 artifact 引用（ArtifactStore.put 的返回值）。 */
    screenshots?: string[];
  };
  error?: string;
  errorClass?: string;
}

const DEFAULT_MAX_ACTIONS = 64;

/** 面向 inputSummary 的单步一行摘要。 */
export function describeBrowserStep(step: BrowserStep): string {
  switch (step.do) {
    case 'navigate':
      return `navigate ${step.url}`;
    case 'click':
      return `click ${step.selector}`;
    case 'click_text':
      return `click_text ${step.text}`;
    case 'type':
      return `type ${step.selector}`;
    case 'set_value':
      return `set_value ${step.selector}`;
    case 'key':
      return `key ${step.key}`;
    case 'scroll':
      return `scroll ${step.direction ?? 'down'}`;
    case 'wait':
      return step.selector ? `wait ${step.selector}` : step.text ? `wait text:${step.text}` : 'wait';
    case 'screenshot':
      return `screenshot${step.name ? ` ${step.name}` : ''}`;
  }
}

function classifyBrowserError(error: string | undefined): string {
  if (!error) return 'unknown';
  if (error.includes('browser bridge unavailable')) return 'tool_missing';
  if (error.includes('not found') || error.includes('not attached') || error.includes('No active tab')) {
    return 'element_not_found';
  }
  return 'tool_error';
}

/**
 * 顺序执行一个 browser 节点。失败按 on_stuck 走：'skip' 跳过该步继续，
 * 否则 failed（'agent' 档位显式声明未接线）。步骤级 `optional: true` 优先于
 * 节点级 on_stuck：标记为可选的步骤失败即跳过（弹窗可能不出现、装饰性点击
 * 可以缺席），不拖垮节点。close_tab !== false 时在 finally 里回收会话标签页
 * ——清理失败不影响节点结果。
 */
export async function runBrowserNode(opts: {
  browser: BrowserNodeSpec;
  backend: BrowserBackendPort;
  /** 截图字节落盘处。缺席 → 截图结果只带 {saved:false}，不内联 base64。 */
  artifacts?: ArtifactStore;
  /**
   * on_stuck:'agent' 升级问询（plan 565 Phase D）：把卡住的上下文投给锚定
   * 会话，答复含 retry/重试 → 当步重跑一次；其余答复视为跳过。缺席 →
   * 'agent' 档维持原状（fail，错误信息注明未接线）。
   */
  ask?: (question: string) => Promise<string | null>;
  runId: string;
}): Promise<BrowserNodeOutcome> {
  const { browser, backend } = opts;
  try {
    return await runBrowserSteps(opts);
  } finally {
    if (browser.close_tab !== false) {
      try {
        await backend.close();
      } catch {
        // 回收失败不影响节点结果——标签页留给用户手动关即可。
      }
    }
  }
}

async function runBrowserSteps(opts: {
  browser: BrowserNodeSpec;
  backend: BrowserBackendPort;
  artifacts?: ArtifactStore;
  ask?: (question: string) => Promise<string | null>;
  runId: string;
}): Promise<BrowserNodeOutcome> {
  const { browser, backend } = opts;
  const onStuck = browser.on_stuck ?? 'fail';
  const maxActions = browser.max_actions ?? DEFAULT_MAX_ACTIONS;
  // Phase D escalation verdict: answer mentions retry → re-run once; anything
  // else (skip / silence / dismiss) lands on the skip side of the ladder.
  const escalate = async (question: string): Promise<'retry' | 'skip'> => {
    if (!opts.ask) return 'skip';
    const answer = await opts.ask(question);
    return answer && /retry|重试/i.test(answer) ? 'retry' : 'skip';
  };
  const fail = (error: string, errorClass: string, steps: number): BrowserNodeOutcome => ({
    status: 'failed',
    error,
    errorClass,
    output: { steps },
  });

  // 护栏：声明步数超上限是脚本配置错误，不是运行时事故。
  if (browser.steps.length > maxActions) {
    return fail(
      `browser node declares ${browser.steps.length} steps but max_actions is ${maxActions}`,
      'config',
      0,
    );
  }

  try {
    await backend.connect();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (onStuck === 'skip') return { status: 'skipped', output: { steps: 0 } };
    if (onStuck === 'agent' && opts.ask) {
      if ((await escalate(`Browser connect failed: ${message}. Retry the connection?`)) === 'retry') {
        try {
          await backend.connect();
        } catch (retryErr) {
          const retryMessage = retryErr instanceof Error ? retryErr.message : String(retryErr);
          return fail(`browser connect failed after ask-retry: ${retryMessage}`, 'tool_missing', 0);
        }
      } else {
        return { status: 'skipped', output: { steps: 0 } };
      }
    } else {
      return fail(
        onStuck === 'agent'
          ? `${message} (on_stuck:'agent' has no ask port — treated as 'fail')`
          : message,
        'tool_missing',
        0,
      );
    }
  }

  let url: string | undefined;
  let title: string | undefined;
  const screenshots: string[] = [];
  let done = 0;

  // start_url = 起点确定性（重跑第一死因，skill 转换守则第 2 条的浏览器版）。
  if (browser.start_url) {
    const nav = await backend.run({ do: 'navigate', url: browser.start_url });
    if (!nav.ok) {
      if (onStuck !== 'skip') {
        return fail(`start_url navigation failed: ${nav.error ?? 'unknown error'}`, 'tool_error', 0);
      }
    } else {
      url = typeof nav.data?.url === 'string' ? nav.data.url : undefined;
      title = typeof nav.data?.title === 'string' ? nav.data.title : undefined;
    }
  }

  for (const step of browser.steps) {
    let res: BrowserStepResult = await backend.run(step);
    // on_stuck:'agent' escalation (plan 565 Phase D): one ask + one retry.
    let askedSkip = false;
    if (!res.ok && !step.optional && onStuck === 'agent' && opts.ask) {
      const verdict = await escalate(
        `Browser step ${done + 1} (${describeBrowserStep(step)}) failed: ${res.error ?? 'unknown error'}. Retry this step?`,
      );
      if (verdict === 'retry') {
        res = await backend.run(step);
      } else {
        askedSkip = true;
      }
    }

    // 截图：字节进 artifact store，journal 只留引用（gui capture 同纪律）。
    if (res.ok && step.do === 'screenshot') {
      const base64 = typeof res.data?.base64 === 'string' ? res.data.base64 : undefined;
      if (base64 && opts.artifacts) {
        const name = step.name ?? `browser-shot-${screenshots.length + 1}`;
        const ref = await opts.artifacts.put(opts.runId, name, Buffer.from(base64, 'base64'), '.png');
        screenshots.push(ref);
        res = { ok: true, data: { ref } };
      } else {
        res = { ok: true, data: { saved: false } };
      }
    }

    if (step.do === 'navigate') {
      url = typeof res.data?.url === 'string' ? res.data.url : url;
      title = typeof res.data?.title === 'string' ? res.data.title : title;
    }

    if (!res.ok) {
      // optional 步骤：失败即视为缺席（引导弹窗没弹、色块没渲染），继续走。
      if (step.optional) continue;
      if (onStuck === 'skip' || askedSkip) continue;
      const note =
        onStuck === 'agent' ? " (on_stuck:'agent' has no ask port — treated as 'fail')" : '';
      return fail(
        `browser step ${done + 1} (${describeBrowserStep(step)}) failed: ${res.error ?? 'unknown error'}${note}`,
        classifyBrowserError(res.error),
        done,
      );
    }
    done += 1;
  }

  return {
    status: 'succeeded',
    output: {
      ...(url !== undefined ? { url } : {}),
      ...(title !== undefined ? { title } : {}),
      steps: done,
      ...(screenshots.length > 0 ? { screenshots } : {}),
    },
  };
}
