import fs from 'node:fs';
import type { Context } from 'grammy';
import { InlineKeyboard, InputFile } from 'grammy';
import type { AgyConversation } from '../../agy/types.js';
import { type BotDeps, getUserId, makeCallbackData, safeReplyOrEdit } from '../context.js';
import {
  chunkTelegramHtml,
  escapeHtml,
  formatRelativeTime,
  markdownToTelegramHtml,
  truncate,
} from '../formatters.js';

const CHATS_PER_PAGE = 6;
const PHOTO_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getConversationDisplayTitle(
  conv: AgyConversation,
  customTitle?: string | null,
): string {
  return (
    customTitle?.trim() ||
    conv.title?.trim() ||
    conv.preview?.trim() ||
    conv.conversationId
  );
}

/**
 * Renders the paginated conversation browser with Project / All / Pinned scope tabs.
 */
export async function renderChatsMenu(
  ctx: Context,
  deps: BotDeps,
  opts: { scope?: 'proj' | 'all' | 'pinned'; page?: number; edit?: boolean } = {},
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const scope: 'proj' | 'all' | 'pinned' = opts.scope ?? 'proj';

  const chatMetas = new Map(
    deps.db.listAllChatMeta().map((m) => [m.conversationId, m]),
  );

  let rawConversations: AgyConversation[];
  if (scope === 'proj') {
    rawConversations = session.activeProjectId
      ? deps.store.listConversations({ projectId: session.activeProjectId, limit: 200 })
      : [];
  } else if (scope === 'pinned') {
    rawConversations = deps.store.listConversations({ limit: 500 });
  } else {
    rawConversations = deps.store.listConversations({ limit: 200 });
  }

  const filtered = rawConversations
    .filter((conv) => {
      const meta = chatMetas.get(conv.conversationId);
      if (meta?.archived) {
        return false;
      }
      if (scope === 'pinned') {
        return meta?.pinned === true;
      }
      return true;
    })
    .sort((a, b) => {
      const aPinned = chatMetas.get(a.conversationId)?.pinned ?? false;
      const bPinned = chatMetas.get(b.conversationId)?.pinned ?? false;
      if (aPinned !== bPinned) {
        return aPinned ? -1 : 1;
      }
      return b.lastModifiedTime.localeCompare(a.lastModifiedTime);
    });

  const totalPages = Math.max(1, Math.ceil(filtered.length / CHATS_PER_PAGE));
  const page = Math.max(0, Math.min(opts.page ?? 0, totalPages - 1));
  const slice = filtered.slice(page * CHATS_PER_PAGE, (page + 1) * CHATS_PER_PAGE);

  const activeProjName = session.activeProjectId
    ? deps.store.getProject(session.activeProjectId)?.name ?? session.activeProjectId
    : null;
  const scopeLabel =
    scope === 'proj'
      ? activeProjName
        ? `Project: ${activeProjName}`
        : 'Project (none selected)'
      : scope === 'pinned'
        ? 'Pinned'
        : 'All Chats';

  const lines: string[] = [
    `💬 <b>Chats</b> <i>(${escapeHtml(truncate(scopeLabel, 36))} · ${filtered.length})</i>`,
    '',
  ];

  if (scope === 'proj' && !session.activeProjectId) {
    lines.push('<i>No active project selected. Pick a project or switch to 🌐 All.</i>');
  } else if (slice.length === 0) {
    lines.push('<i>No conversations found in this view.</i>');
  } else {
    for (const conv of slice) {
      const meta = chatMetas.get(conv.conversationId);
      const isActive = session.activeConversationId === conv.conversationId;
      const isPinned = meta?.pinned ?? false;
      const prefix = [isActive ? '✅' : '', isPinned ? '📌' : ''].filter(Boolean).join(' ');
      const title = getConversationDisplayTitle(conv, meta?.customTitle);
      const relTime = formatRelativeTime(conv.lastModifiedTime);
      lines.push(
        `${prefix ? `${prefix} ` : ''}<b>${escapeHtml(truncate(title, 44))}</b>\n    <i>${conv.stepCount} steps · ${escapeHtml(relTime)}</i>`,
      );
    }
  }

  if (totalPages > 1) {
    lines.push('', `<i>Page ${page + 1} of ${totalPages}</i>`);
  }

  const keyboard = new InlineKeyboard()
    .text(scope === 'proj' ? '• 📁 Project' : '📁 Project', 'menu:chats:proj:0')
    .text(scope === 'all' ? '• 🌐 All' : '🌐 All', 'menu:chats:all:0')
    .text(scope === 'pinned' ? '• 📌 Pinned' : '📌 Pinned', 'menu:chats:pinned:0')
    .row();

  for (const conv of slice) {
    const meta = chatMetas.get(conv.conversationId);
    const isActive = session.activeConversationId === conv.conversationId;
    const isPinned = meta?.pinned ?? false;
    const title = getConversationDisplayTitle(conv, meta?.customTitle);
    const relTime = formatRelativeTime(conv.lastModifiedTime);
    const btnPrefix = [isActive ? '✅' : '', isPinned ? '📌' : '💬'].filter(Boolean).join(' ');
    keyboard
      .text(
        `${btnPrefix} ${truncate(title, 24)} (${relTime})`,
        makeCallbackData('chat:view:', conv.conversationId),
      )
      .row();
  }

  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text('⬅️ Prev', `menu:chats:${scope}:${page - 1}`);
    }
    keyboard.text(`${page + 1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) {
      keyboard.text('Next ➡️', `menu:chats:${scope}:${page + 1}`);
    }
    keyboard.row();
  }

  keyboard
    .text('🆕 New Chat', 'chat:new')
    .text('🔍 Search', 'chat:search')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, opts.edit ?? false);
}

/**
 * Renders the detail view and actions for a specific conversation.
 */
export async function renderChatDetail(
  ctx: Context,
  deps: BotDeps,
  conversationId: string,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const conv = deps.store.getConversation(conversationId);
  const meta = deps.db.getChatMeta(conversationId);

  if (!conv && !meta) {
    const keyboard = new InlineKeyboard()
      .text('⬅️ Back to Chats', 'menu:chats:proj:0')
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `⚠️ <b>Conversation not found:</b> <code>${escapeHtml(conversationId)}</code>`,
      keyboard,
      edit,
    );
    return;
  }

  const title = conv
    ? getConversationDisplayTitle(conv, meta?.customTitle)
    : meta?.customTitle || conversationId;
  const project = conv?.projectId ? deps.store.getProject(conv.projectId) : null;
  const projectDisplay = project?.name || conv?.projectId || 'None';
  const category = meta?.categoryId ? deps.db.getCategory(meta.categoryId) : null;
  const isActive = session.activeConversationId === conversationId;
  const isPinned = meta?.pinned ?? false;
  const tagsDisplay =
    meta && meta.tags.length > 0
      ? meta.tags.map((t) => `<code>#${escapeHtml(t)}</code>`).join(' ')
      : '<i>None</i>';

  const lines = [
    `💬 <b>${escapeHtml(truncate(title, 80))}</b>${isActive ? ' ✅ <i>(Active)</i>' : ''}`,
    '',
    `🆔 <b>ID:</b> <code>${escapeHtml(conversationId)}</code>`,
    `📁 <b>Project:</b> ${escapeHtml(projectDisplay)}`,
    `📊 <b>Steps:</b> ${conv?.stepCount ?? 0}`,
    `🕒 <b>Last Modified:</b> ${conv?.lastModifiedTime ? escapeHtml(formatRelativeTime(conv.lastModifiedTime)) : '<i>Unknown</i>'}`,
    `🗂 <b>Category:</b> ${category ? `${escapeHtml(category.emoji)} ${escapeHtml(category.name)}` : '<i>None</i>'}`,
    `🏷 <b>Tags:</b> ${tagsDisplay}`,
  ];

  if (conv?.preview && conv.preview.trim() && conv.preview.trim() !== title) {
    lines.push('', `<i>${escapeHtml(truncate(conv.preview.trim(), 220))}</i>`);
  }

  const keyboard = new InlineKeyboard()
    .text('▶️ Resume Chat', makeCallbackData('chat:resume:', conversationId))
    .text(isPinned ? '📍 Unpin' : '📌 Pin', makeCallbackData('chat:pin:', conversationId))
    .row()
    .text('✏️ Rename', makeCallbackData('chat:rename:', conversationId))
    .text('🗂 Category', makeCallbackData('chat:cat:', conversationId))
    .row()
    .text('📎 Artifacts', makeCallbackData('chat:artifacts:', conversationId))
    .text('📜 Transcript', makeCallbackData('chat:transcript:', conversationId))
    .row()
    .text('⬇️ Export .md', makeCallbackData('chat:export:', conversationId))
    .text(
      meta?.archived ? '📤 Unarchive' : '🗄 Archive',
      makeCallbackData('chat:archive:', conversationId),
    )
    .row()
    .text('⬅️ Back', 'menu:chats:proj:0')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders category selection buttons for a conversation.
 */
export async function renderChatCategoryPicker(
  ctx: Context,
  deps: BotDeps,
  conversationId: string,
  edit = false,
): Promise<void> {
  const conv = deps.store.getConversation(conversationId);
  const meta = deps.db.getChatMeta(conversationId);
  const categories = deps.db.listCategories();
  const title = conv
    ? getConversationDisplayTitle(conv, meta?.customTitle)
    : meta?.customTitle || conversationId;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const isCurrent = meta?.categoryId === cat.id;
    keyboard.text(
      `${isCurrent ? '✅ ' : ''}${cat.emoji} ${cat.name}`,
      makeCallbackData('chat:setcat:', conversationId, String(cat.id)),
    );
    if ((i + 1) % 2 === 0 || i === categories.length - 1) {
      keyboard.row();
    }
  }

  keyboard
    .text('🚫 Clear Category', makeCallbackData('chat:setcat:', conversationId, 'none'))
    .row()
    .text('⬅️ Back', makeCallbackData('chat:view:', conversationId));

  await safeReplyOrEdit(
    ctx,
    `🗂 <b>Select Category for</b> <code>${escapeHtml(truncate(title, 40))}</code>`,
    keyboard,
    edit,
  );
}

/**
 * Lists artifacts in `~/.gemini/antigravity-cli/brain/<id>/` with download buttons.
 */
export async function sendArtifactsList(
  ctx: Context,
  deps: BotDeps,
  conversationId?: string,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const targetId = conversationId || session.activeConversationId;

  if (!targetId) {
    const keyboard = new InlineKeyboard()
      .text('💬 Browse Chats', 'menu:chats:all:0')
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      '📎 <b>Artifacts</b>\n\n<i>No active conversation selected.</i>',
      keyboard,
      edit,
    );
    return;
  }

  const artifacts = deps.store.listArtifacts(targetId);
  const lines = [
    `📎 <b>Artifacts</b> <i>(${artifacts.length})</i>`,
    `🆔 <code>${escapeHtml(targetId)}</code>`,
    '',
  ];

  const keyboard = new InlineKeyboard();
  if (artifacts.length === 0) {
    lines.push('<i>No artifacts found for this conversation.</i>');
  } else {
    const shown = artifacts.slice(0, 20);
    for (let i = 0; i < shown.length; i++) {
      const art = shown[i];
      const icon = PHOTO_EXTENSIONS.has(art.ext.toLowerCase()) ? '🖼' : '📄';
      lines.push(
        `${i + 1}. ${icon} <code>${escapeHtml(art.relativePath)}</code> <i>(${escapeHtml(formatBytes(art.sizeBytes))})</i>`,
      );
      keyboard
        .text(
          `${icon} ${truncate(art.name, 26)} (${formatBytes(art.sizeBytes)})`,
          makeCallbackData('chat:art_dl:', targetId, String(i)),
        )
        .row();
    }
    if (artifacts.length > shown.length) {
      lines.push('', `<i>Showing ${shown.length} of ${artifacts.length} artifacts.</i>`);
    }
  }

  keyboard
    .text('⬅️ Chat Detail', makeCallbackData('chat:view:', targetId))
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Sends a specific artifact file as a Telegram photo (for images) or document.
 */
export async function sendArtifactFile(
  ctx: Context,
  deps: BotDeps,
  conversationId: string,
  index: number,
): Promise<void> {
  const artifacts = deps.store.listArtifacts(conversationId);
  const artifact = artifacts[index];
  if (!artifact || !fs.existsSync(artifact.absolutePath)) {
    await ctx.reply('⚠️ Artifact file not found.', { parse_mode: 'HTML' });
    return;
  }

  const threadId = ctx.msg?.message_thread_id;
  const threadOpt = threadId !== undefined ? { message_thread_id: threadId } : {};
  const inputFile = new InputFile(artifact.absolutePath, artifact.name);
  const caption = artifact.relativePath;

  const isPhoto =
    PHOTO_EXTENSIONS.has(artifact.ext.toLowerCase()) &&
    artifact.sizeBytes <= MAX_TELEGRAM_PHOTO_BYTES;

  if (isPhoto) {
    try {
      await ctx.replyWithPhoto(inputFile, { caption, ...threadOpt });
      return;
    } catch {
      // Fallback to document if Telegram rejects image dimensions/format.
    }
  }

  await ctx.replyWithDocument(new InputFile(artifact.absolutePath, artifact.name), {
    caption,
    ...threadOpt,
  });
}

/**
 * Sends the last ~10 user/agent transcript turns formatted cleanly in Telegram HTML.
 */
export async function sendTranscriptView(
  ctx: Context,
  deps: BotDeps,
  conversationId?: string,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const targetId = conversationId || session.activeConversationId;

  if (!targetId) {
    await ctx.reply('📜 <b>Transcript</b>\n\n<i>No active conversation selected.</i>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const rawEntries = deps.store.getTranscript(targetId, 60);
  const turnEntries = rawEntries.filter((entry) => {
    if (!entry.content.trim()) {
      return false;
    }
    const combined = `${entry.source} ${entry.type}`.toLowerCase();
    return (
      combined.includes('user') ||
      combined.includes('agent') ||
      combined.includes('assistant') ||
      combined.includes('model') ||
      combined.includes('planner') ||
      combined.includes('response')
    );
  });

  const selected = (turnEntries.length > 0 ? turnEntries : rawEntries.filter((e) => e.content.trim()))
    .slice(-10);

  const conv = deps.store.getConversation(targetId);
  const meta = deps.db.getChatMeta(targetId);
  const title = conv
    ? getConversationDisplayTitle(conv, meta?.customTitle)
    : meta?.customTitle || targetId;

  const keyboard = new InlineKeyboard()
    .text('⬇️ Export .md', makeCallbackData('chat:export:', targetId))
    .text('⬅️ Chat Detail', makeCallbackData('chat:view:', targetId))
    .row()
    .text('🏠 Home', 'menu:home');

  if (selected.length === 0) {
    await safeReplyOrEdit(
      ctx,
      `📜 <b>Transcript:</b> ${escapeHtml(truncate(title, 50))}\n\n<i>No transcript entries found.</i>`,
      keyboard,
      false,
    );
    return;
  }

  const blocks: string[] = [
    `📜 <b>Transcript:</b> ${escapeHtml(truncate(title, 60))}\n<i>Last ${selected.length} turns</i>`,
  ];

  for (const entry of selected) {
    const labelLower = `${entry.source} ${entry.type}`.toLowerCase();
    const isUser = labelLower.includes('user');
    const header = isUser ? '👤 <b>User</b>' : '🤖 <b>Agent</b>';
    const bodyHtml = markdownToTelegramHtml(truncate(entry.content.trim(), 700));
    blocks.push(`${header}\n${bodyHtml}`);
  }

  const fullHtml = blocks.join('\n\n');
  const chunks = chunkTelegramHtml(fullHtml, 3900);
  const threadId = ctx.msg?.message_thread_id;

  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    await ctx.reply(chunks[i], {
      parse_mode: 'HTML',
      ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
      ...(isLast ? { reply_markup: keyboard } : {}),
    });
  }
}

/**
 * Searches conversations via `deps.store.searchConversations` and displays clickable results.
 */
export async function sendSearchResults(
  ctx: Context,
  deps: BotDeps,
  query: string,
): Promise<void> {
  const results = deps.store.searchConversations(query, 10);
  const chatMetas = new Map(
    deps.db.listAllChatMeta().map((m) => [m.conversationId, m]),
  );

  const lines: string[] = [
    `🔍 <b>Search Results for</b> <code>${escapeHtml(truncate(query, 60))}</code>`,
    '',
  ];

  const keyboard = new InlineKeyboard();
  if (results.length === 0) {
    lines.push('<i>No matching conversations found.</i>');
  } else {
    for (let i = 0; i < results.length; i++) {
      const conv = results[i];
      const meta = chatMetas.get(conv.conversationId);
      const title = getConversationDisplayTitle(conv, meta?.customTitle);
      const relTime = formatRelativeTime(conv.lastModifiedTime);
      lines.push(
        `${i + 1}. <b>${escapeHtml(truncate(title, 48))}</b> <i>(${conv.stepCount} steps · ${escapeHtml(relTime)})</i>`,
      );
      keyboard
        .text(`💬 ${truncate(title, 24)}`, makeCallbackData('chat:view:', conv.conversationId))
        .text('▶️ Resume', makeCallbackData('chat:resume:', conv.conversationId))
        .row();
    }
  }

  keyboard
    .text('🔍 Search Again', 'chat:search')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, false);
}
