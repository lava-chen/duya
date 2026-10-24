/**
 * Feature/view executors: goal / deep-research / diff / loop / memory / mcp /
 * add-dir / image / btw.
 *
 * Design notes shared by every executor here:
 *
 * - Executors are plain functions. Anything reactive is read through a store's
 *   `getState()` (`useConversationStore`, `useBtwStore`) — never a React hook —
 *   and navigation into a page is done by setting the conversation store's
 *   view/tab, the same switch the sidebar buttons perform.
 * - `openPanel(id)` only fires a best-effort intent event
 *   (`duya:open-<panel>-panel`). The automation / memory / mcp pages have no
 *   listener for it yet, so each of those commands ALSO drives the store, the
 *   same way `auth.ts` pairs its panel event with `setSettingsTab` /
 *   `setCurrentView`. The page therefore opens today and stays correct once the
 *   panel event grows its own listener.
 * - `toggleMode` is a toggle, not a setter: re-running `/deep-research` (or
 *   `/goal <objective>`) while that mode is already on turns it OFF. A
 *   read-only `getActiveModes()` on the bridge would make both idempotent;
 *   until then the semantics are the same as tapping the mode chip.
 */

import type { CommandExecutorFn } from './registry';
import type { CommandContext, CommandResult } from '../types';
import { useConversationStore } from '@/stores/conversation-store';
import { useBtwStore } from '@/stores/btw-store';
import { askSideQuestion } from '@/lib/agent-sse-client';

/**
 * The whole `/cmd a b` line as typed.
 *
 * `parseCommand` splits the input: `ctx.raw` is the command token alone
 * (`/goal`), the arguments land in `ctx.args`. Forwarding `ctx.raw` verbatim
 * would silently drop an objective or a subcommand, so anything that hands the
 * line back to the agent goes through here.
 */
function fullLine(ctx: CommandContext): string {
  return ctx.args.length ? `${ctx.raw} ${ctx.args.join(' ')}` : ctx.raw;
}

/** Uniform guard for the paths that need the live composer. */
function bridgeMissing(name: string): CommandResult {
  return { type: 'error', message: `/${name}: app bridge unavailable` };
}

/**
 * Verbs the goal tracker answers itself.
 *
 * `packages/host/src/worker-modes/goal/goal-commands.ts` claims
 * status/pause/resume/clear/help BEFORE the model runs (wired through the run
 * engine's command port), so forwarding these verbatim mutates the tracker
 * deterministically — no LLM turn, no hallucinated tool call. The tracker lives
 * in the agent process; the renderer has no goal status IPC, so "forward and
 * let the agent handle it" is the only path that actually pauses/resumes the
 * goal rather than pretending to.
 */
const GOAL_CONTROL_VERBS = new Set(['status', 'pause', 'resume', 'clear', 'help']);

export const VIEW_EXECUTORS: Record<string, CommandExecutorFn> = {
  /**
   * `/goal <objective>` → goal mode on, then the objective goes to the agent
   * (which calls `goal_start` and begins driving rounds).
   *
   * `/goal status|pause|resume|clear` → forwarded untouched so the agent's
   * command port answers them. Goal mode is deliberately NOT toggled here: a
   * status query must not flip the composer's mode chip.
   *
   * Bare `/goal` → forwarded as well; the agent replies with its usage text.
   *
   * The first token decides, exactly as it does agent-side: `/goal status page
   * redesign` is read as the control verb, not as an objective starting with
   * "status".
   */
  goal: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('goal');
    const sub = (ctx.args[0] ?? '').toLowerCase();
    if (!sub || GOAL_CONTROL_VERBS.has(sub)) {
      return { type: 'forward', prompt: fullLine(ctx) };
    }
    app.toggleMode('goal');
    return { type: 'forward', prompt: fullLine(ctx) };
  },

  /**
   * Plan mode is a session-level mode modifier — the same one the composer's
   * "Plan Mode" chip toggles (`useSlashCommands.ts` → `modeValue: 'plan-task'`).
   * Switching it on is what makes the agent plan before it edits.
   *
   * `toggleMode` is a toggle, so re-running `/plan` turns the mode back off.
   * That matches tapping the chip twice, which is what the user sees.
   *
   * The mode is mutually exclusive with `research` (`MODE_EXCLUSIVE_WITH` in
   * `@/types/mode-id`), so turning plan mode on drops research mode.
   */
  plan: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('plan');
    app.toggleMode('plan-task');
    return { type: 'dismiss' };
  },

  /**
   * Research mode is a session-level mode modifier (plan 423) — switching it on
   * is what makes the agent use `research_start` / `research_report`. The query
   * itself is forwarded as plain text: `/deep-research` is a desktop command
   * name, and the agent has no `/deep-research` verb to receive.
   *
   * With no query the mode is still switched on and the composer keeps the
   * user's draft waiting — the agent only sees a prompt once one is typed.
   */
  'deep-research': (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('deep-research');
    app.toggleMode('research');
    const query = ctx.args.join(' ').trim();
    if (!query) {
      return { type: 'text', content: '已开启深度研究模式，输入研究问题后发送即可。' };
    }
    return { type: 'forward', prompt: query };
  },

  /** Alias entry — see the note on `permissions` in auth.ts. */
  research: (ctx) => VIEW_EXECUTORS['deep-research'](ctx),

  /**
   * The Code Review panel reads its git data from the session's working
   * directory (`openTurnReviewInSidePanel` returns false without one), so a
   * session with no project attached is reported instead of opening nothing.
   */
  diff: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('diff');
    const { sessionId, workingDirectory } = app.getSessionSnapshot();
    if (!sessionId || !workingDirectory) {
      return {
        type: 'error',
        message: '当前会话没有关联项目目录，代码审查需要工作目录。请先用 /add-dir 添加或切换项目。',
      };
    }
    app.openPanel('code-review');
    return { type: 'dismiss' };
  },

  /**
   * Bare `/loop` opens the automation page (cron runs + templates), which is
   * where a recurring task is configured today.
   *
   * With arguments this executor explains the shape instead of guessing: the
   * cron editor owns schedule/prompt parsing (it validates its own fields and
   * posts to `automation:cron:create`), so a slash-created cron would duplicate
   * that validation instead of reusing it. Building `/loop <interval> <prompt>`
   * on top of the editor is the follow-up.
   */
  loop: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('loop');
    const tail = ctx.args.join(' ').trim();
    if (!tail) {
      app.openPanel('automation');
      useConversationStore.getState().setCurrentView('automation');
      return { type: 'dismiss' };
    }
    return {
      type: 'text',
      content: [
        '定时循环需要在「自动化」页面创建（当前 /loop 暂不直接建 cron）。',
        '',
        '用法：/loop <间隔> <提示词>',
        '示例：/loop 30m 检查 CI 是否变红并汇报',
        '',
        '已为你打开自动化页面，点击新建定时任务即可配置同样的内容。',
      ].join('\n'),
    };
  },

  /** Memory lives in 设置 → 记忆 (settings tab `memory`). */
  memory: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('memory');
    app.openPanel('memory');
    const store = useConversationStore.getState();
    store.setSettingsTab('memory');
    store.setCurrentView('settings');
    app.toast('已打开记忆设置', 'info');
    return { type: 'dismiss' };
  },

  /** MCP servers are managed on the 扩展 (extensions) page. */
  mcp: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('mcp');
    app.openPanel('mcp');
    useConversationStore.getState().setCurrentView('extensions');
    app.toast('已打开扩展设置（MCP 服务）', 'info');
    return { type: 'dismiss' };
  },

  /**
   * Add a workspace directory: the native folder picker when no path is given,
   * otherwise the typed path is registered directly.
   *
   * `addProjectFolder` is the store action the New Chat / Welcome "use existing
   * folder" buttons call — it persists through `addRecentFolderIPC` (main-side
   * `registerLocalDirectory`) and refreshes the sidebar's project list, so the
   * new directory is usable by the very next message.
   */
  'add-dir': async (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('add-dir');

    const typed = ctx.args.join(' ').trim();
    let target = typed;

    if (!target) {
      const dialog = window.electronAPI?.dialog;
      if (!dialog?.openFolder) {
        return {
          type: 'text',
          content: [
            '当前环境没有目录选择对话框，可以直接把路径跟在命令后面：',
            '',
            '/add-dir E:\\Projects\\duya',
          ].join('\n'),
        };
      }
      const result = await dialog.openFolder({ title: '选择要添加的工作区目录' });
      if (result.canceled || !result.filePaths[0]) return { type: 'dismiss' };
      target = result.filePaths[0];
    }

    const project = await useConversationStore.getState().addProjectFolder(target);
    if (!project) {
      return { type: 'error', message: `/add-dir: 无法注册目录 ${target}` };
    }
    app.toast(`已添加工作区：${project.projectName}`, 'success');
    return {
      type: 'text',
      content: [
        `已添加工作区目录：${project.workingDirectory}`,
        '',
        `项目名：${project.projectName}`,
        '可在左上角项目切换器里选择它，并在设置会话工作目录时使用。',
      ].join('\n'),
    };
  },

  /**
   * Image generation is an agent-side capability: the `image_generate` tool
   * (config `[image_generation]`, provider openai/fal) is exposed to the model
   * through `tool_search`, and the only direct driver is the agent CLI's
   * `duya image` subcommand. There is no renderer-facing image IPC, so the
   * prompt is forwarded with an instruction that names the tool.
   */
  image: (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('image');
    const prompt = ctx.args.join(' ').trim();
    if (!prompt) {
      return {
        type: 'text',
        content: [
          '用法：/image <提示词>',
          '',
          '示例：/image 一只坐在窗台上的橘猫，水彩风格',
          '',
          '提示：需要先在 config.toml 的 [image_generation] 段启用并配置好 provider 与 API Key。',
        ].join('\n'),
      };
    }
    return { type: 'forward', prompt: `请使用 image_generate 工具生成图片。提示词：${prompt}` };
  },

  /**
   * Side question: a one-shot, no-tool LLM call against the current session that
   * never touches the durable transcript (agent server `/btw`), which is why it
   * does not interrupt or queue behind the running turn.
   *
   * The question is recorded in the btw store first so the popover's 中途聊天
   * sub-view shows the same entry once the user opens it, then the answer is
   * returned through the command dialog (that sub-view is React-local state in
   * SlashCommandPopover and cannot be opened from an executor).
   *
   * Without a question the composer asks for one rather than forwarding an
   * empty side call.
   */
  btw: async (ctx) => {
    const app = ctx.app;
    if (!app) return bridgeMissing('btw');

    const { sessionId } = app.getSessionSnapshot();
    if (!sessionId) {
      return { type: 'error', message: '当前没有会话，旁问需要一个已打开的会话。' };
    }

    let question = ctx.args.join(' ').trim();
    if (!question) {
      question =
        (await app.promptInput({
          title: '旁侧问答',
          placeholder: '输入不打断当前对话的问题',
        }))?.trim() ?? '';
      if (!question) return { type: 'dismiss' };
    }

    const btw = useBtwStore.getState();
    const entryId = btw.addQuestion(sessionId, question);
    try {
      const result = await askSideQuestion(sessionId, question);
      btw.setAnswer(sessionId, entryId, result.answer);
      return { type: 'text', content: result.answer };
    } catch (error) {
      const message = error instanceof Error ? error.message : '旁侧问答失败，请重试。';
      btw.setError(sessionId, entryId, message);
      return { type: 'error', message };
    }
  },
};
