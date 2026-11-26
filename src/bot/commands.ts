import type { Bot, Context } from 'grammy';
import type { BotCommand } from 'grammy/types';
import type { AgyEffort, AgyPermissionMode } from '../agy/types.js';
import { VALID_EFFORTS, VALID_MODES } from '../config.js';
import type { BotDeps } from './context.js';
import { escapeHtml } from './formatters.js';
import { executePrompt } from './handlers/messages.js';
import {
  renderCategoriesMenu,
  renderChatsMenu,
  renderDashboard,
  renderMcpMenu,
  renderModelsMenu,
  renderPluginsMenu,
  renderProjectsMenu,
  renderSettingsMenu,
  renderSkillsMenu,
  renderStatusView,
  sendArtifactsList,
  sendSearchResults,
  sendTranscriptView,
} from './menus/index.js';

export const BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'Show welcome dashboard' },
  { command: 'menu', description: 'Open main control menu' },
  { command: 'projects', description: 'Browse & switch projects' },
  { command: 'categories', description: 'Manage project & chat categories' },
  { command: 'chats', description: 'Browse & resume conversations' },
  { command: 'new', description: 'Start a new chat' },
  { command: 'search', description: 'Search conversations' },
  { command: 'models', description: 'Select AI model' },
  { command: 'mode', description: 'Set permission mode' },
  { command: 'effort', description: 'Set reasoning effort' },
  { command: 'settings', description: 'Open bot settings' },
  { command: 'mcp', description: 'Manage MCP servers' },
  { command: 'skills', description: 'Browse installed skills' },
  { command: 'plugins', description: 'Manage plugins' },
  { command: 'artifacts', description: 'List conversation artifacts' },
  { command: 'transcript', description: 'Export conversation transcript' },
  { command: 'topic', description: 'Manage Forum Topic bindings' },
  { command: 'plan', description: 'Run a prompt in plan mode' },
  { command: 'status', description: 'Show session & CLI status' },
  { command: 'stop', description: 'Stop all active agy runs' },
  { command: 'help', description: 'Show command guide' },
];

function resolveConversationId(ctx: Context, deps: BotDeps, userId: number): string | null {
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  if (chatId !== undefined && threadId !== undefined) {
    const binding = deps.db.getTopicBinding(chatId, threadId);
    if (binding) {
      return binding.conversationId;
    }
  }
  return deps.db.getSession(userId).activeConversationId;
}

function buildHelpHtml(): string {
  return [
    '🤖 <b>Antigravity Telegram Bot — Commands</b>',
    '',
    '<b>Navigation &amp; Workspace</b>',
    '/start, /menu — Open control dashboard',
    '/projects — Browse &amp; switch projects',
    '/categories — Organize categories',
    '/chats — Browse &amp; resume chats',
    '/new [prompt] — Start a new chat (optionally run prompt)',
    '/search [query] — Search conversation history',
    '/topic [bind &lt;project&gt; | unbind | list] — Bind Forum Topics',
    '',
    '<b>Model &amp; Execution</b>',
    '/models — Choose AI model',
    '/mode [auto|accept-edits|plan] — Set permission mode',
    '/effort [low|medium|high|xhigh|max] — Set reasoning effort',
    '/plan &lt;prompt&gt; — Run one prompt in plan mode',
    '/settings — Toggle tools, usage, sandbox &amp; artifacts',
    '/stop — Abort all running turns',
    '',
    '<b>Tools &amp; Outputs</b>',
    '/mcp — Manage MCP servers',
    '/skills [query] — Browse installed skills',
    '/plugins — Manage plugins',
    '/artifacts — List &amp; download turn artifacts',
    '/transcript — Export conversation transcript',
    '/status — Show current session &amp; CLI status',
    '',
    '💡 <i>Any plain text, photo, document, voice note, or unknown /slash-command is forwarded directly to agy.</i>',
  ].join('\n');
}

async function handleTopicCommand(ctx: Context, deps: BotDeps): Promise<void> {
  const rawArg = typeof ctx.match === 'string' ? ctx.match.trim() : '';
  const chatId = ctx.chat?.id;
  const threadId = ctx.message?.message_thread_id;
  const threadExtra = threadId !== undefined ? { message_thread_id: threadId } : {};

  if (rawArg === 'list' || (!rawArg && threadId === undefined)) {
    const bindings = deps.db.listTopicBindings(chatId);
    if (bindings.length === 0) {
      await ctx.reply('ℹ️ No Forum Topic bindings configured.', threadExtra);
      return;
    }
    const lines = ['📌 <b>Forum Topic Bindings</b>', ''];
    for (const b of bindings) {
      const proj = b.projectId ? deps.store.getProject(b.projectId) : null;
      const projLabel = proj?.name ?? b.projectId ?? 'none';
      const convLabel = b.conversationId ? `<code>${escapeHtml(b.conversationId.slice(0, 8))}</code>` : 'none';
      lines.push(
        `• Topic <code>#${b.threadId}</code> → <b>${escapeHtml(projLabel)}</b> (chat: ${convLabel})`,
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...threadExtra });
    return;
  }

  if (!rawArg && chatId !== undefined && threadId !== undefined) {
    const current = deps.db.getTopicBinding(chatId, threadId);
    if (!current) {
      await ctx.reply(
        [
          `ℹ️ Topic <code>#${threadId}</code> is not bound.`,
          'Usage: <code>/topic bind &lt;project&gt;</code>, <code>/topic unbind</code>, or <code>/topic list</code>',
        ].join('\n'),
        { parse_mode: 'HTML', ...threadExtra },
      );
      return;
    }
    const proj = current.projectId ? deps.store.getProject(current.projectId) : null;
    await ctx.reply(
      [
        `📌 <b>Topic #${threadId} Binding</b>`,
        `Project: <b>${escapeHtml(proj?.name ?? current.projectId ?? 'none')}</b>`,
        `Conversation: <code>${escapeHtml(current.conversationId ?? 'none')}</code>`,
      ].join('\n'),
      { parse_mode: 'HTML', ...threadExtra },
    );
    return;
  }

  if (rawArg.toLowerCase() === 'unbind') {
    if (chatId === undefined || threadId === undefined) {
      await ctx.reply('❌ Run <code>/topic unbind</code> inside a Telegram Forum Topic.', {
        parse_mode: 'HTML',
      });
      return;
    }
    const deleted = deps.db.deleteTopicBinding(chatId, threadId);
    await ctx.reply(
      deleted ? `✅ Unbound topic <code>#${threadId}</code>.` : 'ℹ️ This topic was not bound.',
      { parse_mode: 'HTML', ...threadExtra },
    );
    return;
  }

  if (rawArg.toLowerCase().startsWith('bind')) {
    if (chatId === undefined || threadId === undefined) {
      await ctx.reply('❌ Run <code>/topic bind &lt;project&gt;</code> inside a Telegram Forum Topic.', {
        parse_mode: 'HTML',
      });
      return;
    }
    const target = rawArg.slice('bind'.length).trim();
    if (!target) {
      await ctx.reply('❌ Usage: <code>/topic bind &lt;projectIdOrName&gt;</code>', {
        parse_mode: 'HTML',
        ...threadExtra,
      });
      return;
    }
    const project = deps.store.getProject(target);
    if (!project) {
      await ctx.reply(`❌ Project not found: <code>${escapeHtml(target)}</code>`, {
        parse_mode: 'HTML',
        ...threadExtra,
      });
      return;
    }
    deps.db.upsertTopicBinding({
      chatId,
      threadId,
      projectId: project.id,
      label: project.name,
    });
    await ctx.reply(
      `📌 Bound topic <code>#${threadId}</code> to <b>${escapeHtml(project.name)}</b> (<code>${escapeHtml(project.id)}</code>).`,
      { parse_mode: 'HTML', ...threadExtra },
    );
    return;
  }

  await ctx.reply(
    'ℹ️ Usage: <code>/topic bind &lt;project&gt;</code> | <code>/topic unbind</code> | <code>/topic list</code>',
    { parse_mode: 'HTML', ...threadExtra },
  );
}

/**
 * Registers all bot slash commands with grammY.
 */
export function registerCommands(bot: Bot, deps: BotDeps): void {
  bot.command('start', async (ctx) => {
    await renderDashboard(ctx, deps, false);
  });

  bot.command('menu', async (ctx) => {
    await renderDashboard(ctx, deps, false);
  });

  bot.command('projects', async (ctx) => {
    await renderProjectsMenu(ctx, deps, { edit: false });
  });

  bot.command('categories', async (ctx) => {
    await renderCategoriesMenu(ctx, deps, false);
  });

  bot.command('chats', async (ctx) => {
    await renderChatsMenu(ctx, deps, { edit: false });
  });

  bot.command('new', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }

    deps.db.updateSession(userId, { activeConversationId: null });

    const chatId = ctx.chat?.id;
    const threadId = ctx.message?.message_thread_id;
    if (chatId !== undefined && threadId !== undefined) {
      const binding = deps.db.getTopicBinding(chatId, threadId);
      if (binding) {
        deps.db.upsertTopicBinding({
          chatId,
          threadId,
          conversationId: null,
        });
      }
    }

    const threadExtra = threadId !== undefined ? { message_thread_id: threadId } : {};
    await ctx.reply('🆕 Started a new chat', threadExtra);

    const prompt = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (prompt) {
      await executePrompt(ctx, deps, prompt, { conversationId: null });
    }
  });

  bot.command('search', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    const query = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (query) {
      await sendSearchResults(ctx, deps, query);
      return;
    }
    deps.db.setPendingInput(userId, {
      action: 'chat:search',
      createdAt: Date.now(),
    });
    await ctx.reply('🔍 Send a search query to find conversations:');
  });

  bot.command('models', async (ctx) => {
    await renderModelsMenu(ctx, deps, undefined, false);
  });

  bot.command('mode', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    const arg = typeof ctx.match === 'string' ? ctx.match.trim().toLowerCase() : '';
    if (!arg) {
      await renderSettingsMenu(ctx, deps, false);
      return;
    }
    if ((VALID_MODES as readonly string[]).includes(arg)) {
      deps.db.updateSession(userId, { mode: arg as AgyPermissionMode });
      await ctx.reply(`✅ Permission mode set to <code>${escapeHtml(arg)}</code>.`, {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply(
      `❌ Invalid mode. Valid options: <code>${VALID_MODES.join('</code>, <code>')}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('effort', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    const arg = typeof ctx.match === 'string' ? ctx.match.trim().toLowerCase() : '';
    if (!arg) {
      await renderSettingsMenu(ctx, deps, false);
      return;
    }
    if ((VALID_EFFORTS as readonly string[]).includes(arg)) {
      deps.db.updateSession(userId, { effort: arg as AgyEffort });
      await ctx.reply(`✅ Reasoning effort set to <code>${escapeHtml(arg)}</code>.`, {
        parse_mode: 'HTML',
      });
      return;
    }
    await ctx.reply(
      `❌ Invalid effort. Valid options: <code>${VALID_EFFORTS.join('</code>, <code>')}</code>`,
      { parse_mode: 'HTML' },
    );
  });

  bot.command('settings', async (ctx) => {
    await renderSettingsMenu(ctx, deps, false);
  });

  bot.command('mcp', async (ctx) => {
    await renderMcpMenu(ctx, deps, false);
  });

  bot.command('skills', async (ctx) => {
    const query = typeof ctx.match === 'string' ? ctx.match.trim() || undefined : undefined;
    await renderSkillsMenu(ctx, deps, { query, page: 0, edit: false });
  });

  bot.command('plugins', async (ctx) => {
    await renderPluginsMenu(ctx, deps, false);
  });

  bot.command('artifacts', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    const conversationId = resolveConversationId(ctx, deps, userId);
    await sendArtifactsList(ctx, deps, conversationId ?? undefined, false);
  });

  bot.command('transcript', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      return;
    }
    const conversationId = resolveConversationId(ctx, deps, userId);
    await sendTranscriptView(ctx, deps, conversationId ?? undefined);
  });

  bot.command('topic', async (ctx) => {
    await handleTopicCommand(ctx, deps);
  });

  bot.command('plan', async (ctx) => {
    const prompt = typeof ctx.match === 'string' ? ctx.match.trim() : '';
    if (!prompt) {
      await ctx.reply('ℹ️ Usage: <code>/plan &lt;prompt&gt;</code>', {
        parse_mode: 'HTML',
      });
      return;
    }
    await executePrompt(ctx, deps, prompt, { modeOverride: 'plan' });
  });

  bot.command('status', async (ctx) => {
    await renderStatusView(ctx, deps, false);
  });

  bot.command('stop', async (ctx) => {
    const stopped = deps.runner.abortAll();
    const msg =
      stopped > 0
        ? `🛑 Stopped ${stopped} active run${stopped === 1 ? '' : 's'}.`
        : 'ℹ️ No active runs to stop.';
    await ctx.reply(msg);
  });

  bot.command('help', async (ctx) => {
    await ctx.reply(buildHelpHtml(), { parse_mode: 'HTML' });
  });
}
