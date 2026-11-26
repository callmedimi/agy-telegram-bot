import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { type BotDeps, getUserId, safeReplyOrEdit } from '../context.js';
import { escapeHtml, formatRelativeTime, truncate } from '../formatters.js';

/**
 * Renders the main Telegram control center dashboard showing active project,
 * conversation, model/settings, running tasks, and navigation buttons.
 */
export async function renderDashboard(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const activeRuns = deps.runner.listActiveRuns();

  let projectLine = '<i>None selected (default workspace)</i>';
  let workspaceLine = '';
  if (session.activeProjectId) {
    const project = deps.store.getProject(session.activeProjectId);
    const meta = deps.db.getProjectMeta(session.activeProjectId);
    const category = meta?.categoryId ? deps.db.getCategory(meta.categoryId) : null;
    const catBadge = category ? ` [${escapeHtml(category.emoji)} ${escapeHtml(category.name)}]` : '';
    const projectName = meta?.alias || project?.name || session.activeProjectId;
    projectLine = `<b>${escapeHtml(truncate(projectName, 40))}</b>${catBadge}`;
    if (project && project.paths.length > 0) {
      workspaceLine = `\n📂 <b>Workspace:</b> <code>${escapeHtml(truncate(project.paths[0], 60))}</code>`;
    }
  }

  let chatLine = '🆕 New conversation';
  if (session.activeConversationId) {
    const conv = deps.store.getConversation(session.activeConversationId);
    const chatMeta = deps.db.getChatMeta(session.activeConversationId);
    const rawTitle =
      chatMeta?.customTitle?.trim() ||
      conv?.title?.trim() ||
      conv?.preview?.trim() ||
      session.activeConversationId;
    const parts = [`<b>${escapeHtml(truncate(rawTitle, 44))}</b>`];
    if (conv) {
      const metaBits: string[] = [];
      if (conv.stepCount > 0) {
        metaBits.push(`${conv.stepCount} steps`);
      }
      if (conv.lastModifiedTime) {
        metaBits.push(formatRelativeTime(conv.lastModifiedTime));
      }
      if (metaBits.length > 0) {
        parts.push(`<i>(${escapeHtml(metaBits.join(' · '))})</i>`);
      }
    }
    chatLine = parts.join(' ');
  }

  const sandboxFlag = session.sandbox ? '🟢 on' : '⚪️ off';
  const skipFlag = session.skipPermissions ? '🟡 on' : '⚪️ off';
  const agentPart = session.agent ? ` · 🤖 <code>${escapeHtml(session.agent)}</code>` : '';
  const runsBadge =
    activeRuns.length > 0
      ? `<b>${activeRuns.length} running</b>`
      : '0 running';

  const lines = [
    '🛸 <b>Antigravity Control Center</b>',
    '',
    `📁 <b>Project:</b> ${projectLine}${workspaceLine}`,
    `💬 <b>Chat:</b> ${chatLine}`,
    `🧠 <b>Model:</b> <code>${escapeHtml(session.model)}</code>`,
    `⚡ <b>Effort:</b> <code>${escapeHtml(session.effort)}</code> · 🛡 <b>Mode:</b> <code>${escapeHtml(session.mode)}</code>${agentPart}`,
    `🚩 <b>Flags:</b> sandbox <code>${sandboxFlag}</code> · skip-perms <code>${skipFlag}</code>`,
    `🏃 <b>Tasks:</b> ${runsBadge}`,
    '',
    '<i>Send any message to prompt AGY, or use the menu below:</i>',
  ];

  const keyboard = new InlineKeyboard()
    .text('📁 Projects', 'menu:projects:0')
    .text('💬 Chats', 'menu:chats:proj:0')
    .row()
    .text('🗂 Categories', 'menu:categories')
    .text('🆕 New Chat', 'chat:new')
    .row()
    .text('🧠 Models', 'set:models:all')
    .text('⚙️ Settings', 'menu:settings')
    .row()
    .text('🔌 MCP & Tools', 'menu:tools')
    .text('🧩 Skills', 'tools:skills:0')
    .row()
    .text('🔍 Search', 'chat:search')
    .text('📊 Status', 'tools:status');

  if (ctx.chat?.type === 'supergroup') {
    keyboard.row().text('🏛 Forum', 'forum:panel');
  }

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}
