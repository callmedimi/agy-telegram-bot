import type { Bot, Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import type { AgyEffort, AgyPermissionMode } from '../../agy/types.js';
import { VALID_EFFORTS, VALID_MODES } from '../../config.js';
import {
  type BotDeps,
  getUserId,
  resolveCallbackPart,
  safeReplyOrEdit,
} from '../context.js';
import { escapeHtml, truncate } from '../formatters.js';
import {
  renderChatCategoryPicker,
  renderChatDetail,
  renderChatsMenu,
  sendArtifactFile,
  sendArtifactsList,
  sendSearchResults,
  sendTranscriptView,
} from './chats.js';
import { renderDashboard } from './dashboard.js';
import {
  renderCategoriesMenu,
  renderProjectCategoryPicker,
  renderProjectDetail,
  renderProjectsMenu,
} from './projects.js';
import { renderModelsMenu, renderSettingsMenu } from './settings.js';
import {
  clearActiveSkillSearch,
  renderAgentsMenu,
  renderMcpMenu,
  renderPluginsMenu,
  renderSkillDetail,
  renderSkillsMenu,
  renderStatusView,
  renderToolsMenu,
} from './tools.js';

export {
  renderAgentsMenu,
  renderCategoriesMenu,
  renderChatDetail,
  renderChatsMenu,
  renderDashboard,
  renderMcpMenu,
  renderModelsMenu,
  renderPluginsMenu,
  renderProjectDetail,
  renderProjectsMenu,
  renderSettingsMenu,
  renderSkillDetail,
  renderSkillsMenu,
  renderStatusView,
  renderToolsMenu,
  sendArtifactFile,
  sendArtifactsList,
  sendSearchResults,
  sendTranscriptView,
};

async function safeAnswerCallback(
  ctx: Context,
  text?: string,
  showAlert = false,
): Promise<void> {
  try {
    await ctx.answerCallbackQuery(
      text ? { text: truncate(text, 190), show_alert: showAlert } : undefined,
    );
  } catch {
    // Ignore expired or already-answered callback queries.
  }
}

async function promptForPendingInput(
  ctx: Context,
  deps: BotDeps,
  action: string,
  promptHtml: string,
  payload?: Record<string, string>,
): Promise<void> {
  const userId = getUserId(ctx);
  deps.db.setPendingInput(userId, {
    action,
    ...(payload ? { payload } : {}),
    createdAt: Date.now(),
  });

  const keyboard = new InlineKeyboard().text('❌ Cancel', 'input:cancel');
  await safeReplyOrEdit(ctx, promptHtml, keyboard, false);
}

function sanitizeFilename(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 48) || 'transcript';
}

/**
 * Registers all inline menu, pagination, settings, tools, and run-control callback handlers.
 */
export function registerMenuCallbacks(bot: Bot, deps: BotDeps): void {
  const handle = (
    pattern: string | RegExp,
    fn: (
      ctx: Context,
      data: string,
      answer: (text?: string, showAlert?: boolean) => Promise<void>,
    ) => Promise<void>,
  ): void => {
    bot.callbackQuery(pattern, async (ctx) => {
      let answered = false;
      const answer = async (text?: string, showAlert = false): Promise<void> => {
        if (answered) return;
        answered = true;
        await safeAnswerCallback(ctx, text, showAlert);
      };

      try {
        const data = ctx.callbackQuery.data ?? '';
        await fn(ctx, data, answer);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await answer(`❌ ${msg}`, true);
      } finally {
        if (!answered) {
          await safeAnswerCallback(ctx);
        }
      }
    });
  };

  // ── Navigation & Dashboard ──────────────────────────────────────────────────

  handle('noop', async (_ctx, _data, answer) => {
    await answer();
  });

  handle('menu:home', async (ctx) => {
    await renderDashboard(ctx, deps, true);
  });

  handle('menu:categories', async (ctx) => {
    await renderCategoriesMenu(ctx, deps, true);
  });

  handle('menu:settings', async (ctx) => {
    await renderSettingsMenu(ctx, deps, true);
  });

  handle('menu:tools', async (ctx) => {
    await renderToolsMenu(ctx, deps, true);
  });

  handle(/^menu:projects:(\d+)$/, async (ctx, data) => {
    const page = Number.parseInt(data.split(':')[2] ?? '0', 10) || 0;
    await renderProjectsMenu(ctx, deps, { page, edit: true });
  });

  handle(/^menu:proj_cat:([^:]+):(\d+)$/, async (ctx, data) => {
    const parts = data.split(':');
    const catFilter = parts[2] ?? 'all';
    const page = Number.parseInt(parts[3] ?? '0', 10) || 0;
    await renderProjectsMenu(ctx, deps, { catFilter, page, edit: true });
  });

  handle(/^menu:chats:(proj|all|pinned):(\d+)$/, async (ctx, data) => {
    const parts = data.split(':');
    const scope = (parts[2] as 'proj' | 'all' | 'pinned') || 'proj';
    const page = Number.parseInt(parts[3] ?? '0', 10) || 0;
    await renderChatsMenu(ctx, deps, { scope, page, edit: true });
  });

  // ── Pending Input Cancel ────────────────────────────────────────────────────

  handle('input:cancel', async (ctx, _data, answer) => {
    const userId = getUserId(ctx);
    deps.db.clearPendingInput(userId);
    await answer('❌ Cancelled');
    await safeReplyOrEdit(
      ctx,
      '❌ <i>Input cancelled.</i>',
      new InlineKeyboard().text('🏠 Home', 'menu:home'),
      true,
    );
  });

  // ── Projects & Categories ───────────────────────────────────────────────────

  handle('proj:new', async (ctx) => {
    await promptForPendingInput(
      ctx,
      deps,
      'proj:new',
      '➕ <b>New Project</b>\n\nReply with the project name, or <code>Name | /path/to/workspace</code>:',
    );
  });

  handle(/^proj:view:(.+)$/, async (ctx, data) => {
    const projectId = resolveCallbackPart(data.slice('proj:view:'.length));
    await renderProjectDetail(ctx, deps, projectId, true);
  });

  handle(/^proj:select:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const projectId = resolveCallbackPart(data.slice('proj:select:'.length));
    const project = deps.store.getProject(projectId);
    if (!project) {
      await answer('⚠️ Project not found', true);
      return;
    }

    const session = deps.db.getSession(userId);
    const activeConv = session.activeConversationId
      ? deps.store.getConversation(session.activeConversationId)
      : null;
    const keepConv = activeConv !== null && activeConv.projectId === project.id;

    deps.db.updateSession(userId, {
      activeProjectId: project.id,
      ...(keepConv ? {} : { activeConversationId: null }),
    });

    await answer(`✅ Active project: ${project.name}`);
    await renderProjectDetail(ctx, deps, project.id, true);
  });

  handle(/^proj:pin:(.+)$/, async (ctx, data, answer) => {
    const projectId = resolveCallbackPart(data.slice('proj:pin:'.length));
    const updated = deps.db.toggleProjectPin(projectId);
    await answer(updated.pinned ? '📌 Project pinned' : '📍 Project unpinned');
    await renderProjectDetail(ctx, deps, projectId, true);
  });

  handle(/^proj:cat:(.+)$/, async (ctx, data) => {
    const projectId = resolveCallbackPart(data.slice('proj:cat:'.length));
    await renderProjectCategoryPicker(ctx, deps, projectId, true);
  });

  handle(/^proj:setcat:(.+):([^:]+)$/, async (ctx, data, answer) => {
    const match = data.match(/^proj:setcat:(.+):([^:]+)$/);
    const projectId = resolveCallbackPart(match?.[1] ?? '');
    const catRaw = match?.[2] ?? 'none';
    const categoryId = catRaw === 'none' ? null : Number.parseInt(catRaw, 10);
    deps.db.setProjectCategory(
      projectId,
      categoryId !== null && Number.isFinite(categoryId) ? categoryId : null,
    );
    await answer('🗂 Category updated');
    await renderProjectDetail(ctx, deps, projectId, true);
  });

  handle(/^proj:adddir:(.+)$/, async (ctx, data) => {
    const projectId = resolveCallbackPart(data.slice('proj:adddir:'.length));
    const project = deps.store.getProject(projectId);
    const name = project?.name ?? projectId;
    await promptForPendingInput(
      ctx,
      deps,
      'proj:adddir',
      `📁 <b>Add Workspace Directory</b>\nProject: <code>${escapeHtml(truncate(name, 40))}</code>\n\nReply with the absolute directory path:`,
      { projectId },
    );
  });

  handle(/^proj:bindtopic:(.+)$/, async (ctx, data, answer) => {
    const projectId = resolveCallbackPart(data.slice('proj:bindtopic:'.length));
    const chatId = ctx.chat?.id;
    const threadId = ctx.msg?.message_thread_id;

    if (chatId === undefined || threadId === undefined) {
      await answer(
        'ℹ️ Open this menu inside a Telegram Forum Topic to bind it to this project.',
        true,
      );
      return;
    }

    const project = deps.store.getProject(projectId);
    deps.db.upsertTopicBinding({
      chatId,
      threadId,
      projectId,
      label: project?.name ?? projectId,
    });

    await answer(`📌 Bound topic #${threadId} to ${project?.name ?? projectId}`);
    await renderProjectDetail(ctx, deps, projectId, true);
  });

  handle('cat:new', async (ctx) => {
    await promptForPendingInput(
      ctx,
      deps,
      'cat:new',
      '🗂 <b>New Category</b>\n\nReply with a category name (optionally prefixed with an emoji, e.g. <code>🚀 Launch</code>):',
    );
  });

  handle(/^cat:del:(\d+)$/, async (ctx, data, answer) => {
    const catId = Number.parseInt(data.slice('cat:del:'.length), 10);
    const deleted = Number.isFinite(catId) ? deps.db.deleteCategory(catId) : false;
    await answer(deleted ? '🗑 Category deleted' : '⚠️ Category not found');
    await renderCategoriesMenu(ctx, deps, true);
  });

  // ── Chats, Artifacts, Transcripts, Search ───────────────────────────────────

  handle('chat:new', async (ctx, _data, answer) => {
    const userId = getUserId(ctx);
    deps.db.updateSession(userId, { activeConversationId: null });
    await answer('🆕 Ready for a new conversation');
    await renderDashboard(ctx, deps, true);
  });

  handle('chat:search', async (ctx) => {
    await promptForPendingInput(
      ctx,
      deps,
      'chat:search',
      '🔍 <b>Search Conversations</b>\n\nReply with keywords to search chat titles and previews:',
    );
  });

  handle(/^chat:view:(.+)$/, async (ctx, data) => {
    const convId = resolveCallbackPart(data.slice('chat:view:'.length));
    await renderChatDetail(ctx, deps, convId, true);
  });

  handle(/^chat:resume:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const convId = resolveCallbackPart(data.slice('chat:resume:'.length));
    const conv = deps.store.getConversation(convId);

    const patch: { activeConversationId: string; activeProjectId?: string } = {
      activeConversationId: convId,
    };
    if (conv?.projectId && deps.store.getProject(conv.projectId)) {
      patch.activeProjectId = conv.projectId;
    }

    deps.db.updateSession(userId, patch);
    await answer('▶️ Conversation resumed');
    await renderDashboard(ctx, deps, true);
  });

  handle(/^chat:pin:(.+)$/, async (ctx, data, answer) => {
    const convId = resolveCallbackPart(data.slice('chat:pin:'.length));
    const updated = deps.db.toggleChatPin(convId);
    await answer(updated.pinned ? '📌 Chat pinned' : '📍 Chat unpinned');
    await renderChatDetail(ctx, deps, convId, true);
  });

  handle(/^chat:rename:(.+)$/, async (ctx, data) => {
    const convId = resolveCallbackPart(data.slice('chat:rename:'.length));
    await promptForPendingInput(
      ctx,
      deps,
      'chat:rename',
      `✏️ <b>Rename Conversation</b>\nID: <code>${escapeHtml(convId)}</code>\n\nReply with the new custom title:`,
      { conversationId: convId },
    );
  });

  handle(/^chat:cat:(.+)$/, async (ctx, data) => {
    const convId = resolveCallbackPart(data.slice('chat:cat:'.length));
    await renderChatCategoryPicker(ctx, deps, convId, true);
  });

  handle(/^chat:setcat:(.+):([^:]+)$/, async (ctx, data, answer) => {
    const match = data.match(/^chat:setcat:(.+):([^:]+)$/);
    const convId = resolveCallbackPart(match?.[1] ?? '');
    const catRaw = match?.[2] ?? 'none';
    const categoryId = catRaw === 'none' ? null : Number.parseInt(catRaw, 10);
    deps.db.setChatCategory(
      convId,
      categoryId !== null && Number.isFinite(categoryId) ? categoryId : null,
    );
    await answer('🗂 Category updated');
    await renderChatDetail(ctx, deps, convId, true);
  });

  handle(/^chat:artifacts:(.+)$/, async (ctx, data) => {
    const convId = resolveCallbackPart(data.slice('chat:artifacts:'.length));
    await sendArtifactsList(ctx, deps, convId, true);
  });

  handle(/^chat:art_dl:(.+):(\d+)$/, async (ctx, data, answer) => {
    const match = data.match(/^chat:art_dl:(.+):(\d+)$/);
    const convId = resolveCallbackPart(match?.[1] ?? '');
    const idx = Number.parseInt(match?.[2] ?? '0', 10);
    await answer('📤 Sending artifact...');
    await sendArtifactFile(ctx, deps, convId, idx);
  });

  handle(/^chat:transcript:(.+)$/, async (ctx, data, answer) => {
    const convId = resolveCallbackPart(data.slice('chat:transcript:'.length));
    await answer();
    await sendTranscriptView(ctx, deps, convId);
  });

  handle(/^chat:export:(.+)$/, async (ctx, data, answer) => {
    const convId = resolveCallbackPart(data.slice('chat:export:'.length));
    const md = deps.store.exportTranscriptMarkdown(convId);
    const conv = deps.store.getConversation(convId);
    const meta = deps.db.getChatMeta(convId);
    const baseName = sanitizeFilename(
      meta?.customTitle || conv?.title || convId.slice(0, 16),
    );
    const threadId = ctx.msg?.message_thread_id;

    await answer('⬇️ Exporting Markdown...');
    await ctx.replyWithDocument(
      new InputFile(Buffer.from(md, 'utf8'), `${baseName}.md`),
      {
        caption: `📄 Transcript export for ${convId}`,
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      },
    );
  });

  handle(/^chat:archive:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const convId = resolveCallbackPart(data.slice('chat:archive:'.length));
    const updated = deps.db.toggleChatArchive(convId);
    const session = deps.db.getSession(userId);
    if (updated.archived && session.activeConversationId === convId) {
      deps.db.updateSession(userId, { activeConversationId: null });
    }
    await answer(updated.archived ? '🗄 Conversation archived' : '📤 Conversation unarchived');
    await renderChatsMenu(ctx, deps, { scope: 'proj', page: 0, edit: true });
  });

  // ── Settings & Models ───────────────────────────────────────────────────────

  handle('set:models:all', async (ctx) => {
    await renderModelsMenu(ctx, deps, 'all', true);
  });

  handle('set:models:refresh', async (ctx, _data, answer) => {
    await answer('🔄 Refreshing models...');
    await renderModelsMenu(ctx, deps, 'refresh', true);
  });

  handle(/^set:models:fam:(.+)$/, async (ctx, data) => {
    const family = resolveCallbackPart(data.slice('set:models:fam:'.length));
    await renderModelsMenu(ctx, deps, family, true);
  });

  handle(/^set:model:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const modelId = resolveCallbackPart(data.slice('set:model:'.length));
    deps.db.updateSession(userId, { model: modelId });
    await answer(`🧠 Model set to ${modelId}`);
    await renderSettingsMenu(ctx, deps, true);
  });

  handle(/^set:effort:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const effort = data.slice('set:effort:'.length) as AgyEffort;
    if (!VALID_EFFORTS.includes(effort)) {
      await answer('⚠️ Invalid effort level', true);
      return;
    }
    deps.db.updateSession(userId, { effort });
    await answer(`⚡ Effort: ${effort}`);
    await renderSettingsMenu(ctx, deps, true);
  });

  handle(/^set:mode:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const mode = data.slice('set:mode:'.length) as AgyPermissionMode;
    if (!VALID_MODES.includes(mode)) {
      await answer('⚠️ Invalid mode', true);
      return;
    }
    deps.db.updateSession(userId, { mode });
    await answer(`🛡 Mode: ${mode}`);
    await renderSettingsMenu(ctx, deps, true);
  });

  handle(/^set:toggle:(sandbox|skip|tools|usage|art|lang)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const session = deps.db.getSession(userId);
    const field = data.slice('set:toggle:'.length);

    switch (field) {
      case 'sandbox':
        deps.db.updateSession(userId, { sandbox: !session.sandbox });
        await answer(`📦 Sandbox: ${!session.sandbox ? 'ON' : 'OFF'}`);
        break;
      case 'skip':
        deps.db.updateSession(userId, { skipPermissions: !session.skipPermissions });
        await answer(`⚠️ Skip Perms: ${!session.skipPermissions ? 'ON' : 'OFF'}`);
        break;
      case 'tools':
        deps.db.updateSession(userId, { showTools: !session.showTools });
        await answer(`🔧 Show Tools: ${!session.showTools ? 'ON' : 'OFF'}`);
        break;
      case 'usage':
        deps.db.updateSession(userId, { showUsage: !session.showUsage });
        await answer(`📊 Show Usage: ${!session.showUsage ? 'ON' : 'OFF'}`);
        break;
      case 'art':
        deps.db.updateSession(userId, { autoSendArtifacts: !session.autoSendArtifacts });
        await answer(`📎 Auto Artifacts: ${!session.autoSendArtifacts ? 'ON' : 'OFF'}`);
        break;
      case 'lang': {
        const nextLang = session.lang === 'en' ? 'fa' : 'en';
        deps.db.updateSession(userId, { lang: nextLang });
        await answer(`🌐 Language: ${nextLang.toUpperCase()}`);
        break;
      }
    }

    await renderSettingsMenu(ctx, deps, true);
  });

  // ── Tools: MCP, Skills, Plugins, Agents, Status ─────────────────────────────

  handle('tools:mcp', async (ctx) => {
    await renderMcpMenu(ctx, deps, true);
  });

  handle('mcp:add', async (ctx) => {
    await promptForPendingInput(
      ctx,
      deps,
      'mcp:add',
      '➕ <b>Add MCP Server</b>\n\nReply with <code>name target [args...]</code>:\n• Example (stdio): <code>fs npx -y @modelcontextprotocol/server-filesystem /tmp</code>\n• Example (http): <code>docs https://example.com/mcp</code>',
    );
  });

  handle(/^mcp:toggle:(.+):(0|1)$/, async (ctx, data, answer) => {
    const match = data.match(/^mcp:toggle:(.+):(0|1)$/);
    const name = resolveCallbackPart(match?.[1] ?? '');
    const enable = match?.[2] === '1';
    await deps.cli.toggleMcpServer(name, enable);
    await answer(`${enable ? '✅ Enabled' : '⛔ Disabled'} ${name}`);
    await renderMcpMenu(ctx, deps, true);
  });

  handle(/^mcp:del:(.+)$/, async (ctx, data, answer) => {
    const name = resolveCallbackPart(data.slice('mcp:del:'.length));
    await deps.cli.removeMcpServer(name);
    await answer(`🗑 Removed ${name}`);
    await renderMcpMenu(ctx, deps, true);
  });

  handle('tools:skills:clear', async (ctx, _data, answer) => {
    const userId = getUserId(ctx);
    clearActiveSkillSearch(userId);
    await answer('Filter cleared');
    await renderSkillsMenu(ctx, deps, { page: 0, query: '', edit: true });
  });

  handle(/^tools:skills:(\d+)$/, async (ctx, data) => {
    const page = Number.parseInt(data.slice('tools:skills:'.length), 10) || 0;
    await renderSkillsMenu(ctx, deps, { page, edit: true });
  });

  handle('skill:search', async (ctx) => {
    await promptForPendingInput(
      ctx,
      deps,
      'skill:search',
      '🔍 <b>Search Skills</b>\n\nReply with a skill name or description keyword:',
    );
  });

  handle(/^skill:view:(\d+)$/, async (ctx, data) => {
    const idx = Number.parseInt(data.slice('skill:view:'.length), 10);
    await renderSkillDetail(ctx, deps, idx, true);
  });

  handle(/^skill:use:(.+)$/, async (ctx, data, answer) => {
    const rawTarget = resolveCallbackPart(data.slice('skill:use:'.length));
    const skills = deps.store.listSkills();
    const skill = /^\d+$/.test(rawTarget)
      ? skills[Number.parseInt(rawTarget, 10)]
      : skills.find((s) => s.name === rawTarget);

    if (!skill) {
      await answer('⚠️ Skill not found', true);
      return;
    }

    await answer(`🧩 Skill: ${skill.name}`);
    const keyboard = new InlineKeyboard()
      .text('⬅️ Back to Skills', 'tools:skills:0')
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `🧩 <b>Ready to use skill:</b> <code>${escapeHtml(skill.name)}</code>\n\nSend a message mentioning this skill (for example:\n<code>Use the ${escapeHtml(skill.name)} skill to ...</code>\nor <code>/${escapeHtml(skill.name)} ...</code>).`,
      keyboard,
      false,
    );
  });

  handle('tools:plugins', async (ctx) => {
    await renderPluginsMenu(ctx, deps, true);
  });

  handle('tools:agents', async (ctx) => {
    await renderAgentsMenu(ctx, deps, true);
  });

  handle(/^agent:set:(.+)$/, async (ctx, data, answer) => {
    const userId = getUserId(ctx);
    const raw = resolveCallbackPart(data.slice('agent:set:'.length));
    const agent = raw === 'none' ? null : raw;
    deps.db.updateSession(userId, { agent });
    await answer(agent ? `🤖 Agent: ${agent}` : '🤖 Agent reset to default');
    await renderSettingsMenu(ctx, deps, true);
  });

  handle('tools:status', async (ctx) => {
    await renderStatusView(ctx, deps, true);
  });

  // ── Run Controls ────────────────────────────────────────────────────────────

  handle(/^run:stop:(.+)$/, async (ctx, data, answer) => {
    const runId = data.slice('run:stop:'.length);
    const aborted = deps.runner.abortRun(runId);
    await answer(aborted ? '🛑 Stop signal sent' : '⚠️ Run already finished');
  });

  handle('run:stop_all', async (ctx, _data, answer) => {
    const count = deps.runner.abortAll();
    await answer(count > 0 ? `🛑 Stopped ${count} active run(s)` : 'No active runs');
    const msgText = ctx.callbackQuery?.message?.text ?? '';
    if (msgText.includes('System Status')) {
      await renderStatusView(ctx, deps, true);
    }
  });
}
