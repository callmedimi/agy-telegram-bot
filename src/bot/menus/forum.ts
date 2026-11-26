import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import {
  type BotDeps,
  getUserId,
  makeCallbackData,
  safeReplyOrEdit,
} from '../context.js';
import { escapeHtml, truncate } from '../formatters.js';

const PROJECTS_PER_PAGE = 6;
const TOPIC_CREATE_DELAY_MS = 350;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isForumSupergroup(ctx: Context): boolean {
  return Boolean(
    ctx.chat?.type === 'supergroup' && 'is_forum' in ctx.chat && ctx.chat.is_forum,
  );
}

function buildNonForumInstructionsHtml(): string {
  return [
    '🏛 <b>Forum Supergroup Setup Required</b>',
    '',
    'Telegram Bot API cannot toggle Forum mode itself. Follow these steps in Telegram:',
    '',
    '1. Open <b>Group Settings</b> → <b>Edit</b> → turn <b>Topics</b> <b>ON</b>.',
    '2. Make the bot an <b>Admin</b> with <b>Manage Topics</b> permission.',
    '3. Run <code>/forum</code> again here!',
  ].join('\n');
}

function buildNonForumKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Check Again', 'forum:panel')
    .text('🏠 Dashboard', 'menu:home');
}

function getProjectCategoryEmoji(deps: BotDeps, projectId: string): string {
  const meta = deps.db.getProjectMeta(projectId);
  if (!meta?.categoryId) {
    return '📁';
  }
  const category = deps.db.getCategory(meta.categoryId);
  return category?.emoji || '📁';
}

function formatTopicCreationError(err: unknown): { message: string; isPermissionError: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  const isPermissionError =
    lower.includes('not enough rights') ||
    lower.includes('can_manage_topics') ||
    lower.includes('chat_admin_required') ||
    lower.includes('administrator') ||
    lower.includes('forbidden');
  return { message: raw, isPermissionError };
}

async function sendTopicWelcomeCard(
  ctx: Context,
  chatId: number,
  threadId: number,
  opts: { title: string; workspacePath?: string; hint: string },
): Promise<void> {
  const lines = [opts.title, ''];
  if (opts.workspacePath) {
    lines.push(`📂 <b>Workspace:</b> <code>${escapeHtml(opts.workspacePath)}</code>`, '');
  }
  lines.push(opts.hint);

  try {
    await ctx.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      message_thread_id: threadId,
    });
  } catch (err) {
    console.warn(`[forum] Failed to send welcome card to topic #${threadId}:`, err);
  }
}

async function checkCanManageTopics(
  ctx: Context,
  chatId: number,
): Promise<{ status: 'granted' | 'missing' | 'unknown' }> {
  if (ctx.me?.id === undefined) {
    return { status: 'unknown' };
  }
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.me.id);
    const granted =
      member.status === 'creator' ||
      (member.status === 'administrator' && member.can_manage_topics === true);
    return { status: granted ? 'granted' : 'missing' };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * Renders the Forum Supergroup automation control panel, or setup instructions
 * if invoked outside a Forum-enabled Supergroup.
 */
export async function renderForumPanel(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      edit,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const perm = await checkCanManageTopics(ctx, chatId);
  const permLine =
    perm.status === 'granted'
      ? '✅ <b>Manage Topics:</b> <code>Granted</code>'
      : perm.status === 'missing'
        ? '❌ <b>Manage Topics:</b> <code>Missing (enable in Admin permissions)</code>'
        : '⚠️ <b>Manage Topics:</b> <i>Unable to verify</i>';

  const projects = deps.store.listProjects();
  const bindings = deps.db.listTopicBindings(chatId);
  const boundProjectIds = new Set(
    bindings.map((b) => b.projectId).filter((id): id is string => id !== null),
  );
  const boundProjectsCount = projects.filter((p) => boundProjectIds.has(p.id)).length;

  const lines = [
    '🏛 <b>Forum Supergroup Automation</b>',
    '',
    permLine,
    `📌 <b>Bound Topics:</b> ${bindings.length} topic(s) (${boundProjectsCount}/${projects.length} projects bound)`,
    '',
    '<i>Each bound topic routes messages directly to its linked project &amp; conversation.</i>',
  ];

  const keyboard = new InlineKeyboard()
    .text('🔄 Sync All Projects → Topics', 'forum:sync')
    .row()
    .text('➕ Create Topic for Project', 'forum:pick:0')
    .row()
    .text('🆕 Create New Chat Topic', 'forum:newchat')
    .row()
    .text('📋 Bound Topics List', 'forum:list')
    .row()
    .text('🏠 Dashboard', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Creates Telegram Forum Topics for all unbound `agy` projects in the current supergroup,
 * saves bindings in SQLite, and posts a welcome card inside each created topic.
 */
export async function syncProjectsToForumTopics(
  ctx: Context,
  deps: BotDeps,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      false,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const projects = deps.store.listProjects();
  const existingBindings = deps.db.listTopicBindings(chatId);
  const boundProjectIds = new Set(
    existingBindings.map((b) => b.projectId).filter((id): id is string => id !== null),
  );

  const unboundProjects = projects.filter((proj) => !boundProjectIds.has(proj.id));
  const alreadyBoundCount = projects.length - unboundProjects.length;

  const createdNames: string[] = [];
  const errors: string[] = [];
  let missingPermission = false;

  for (let i = 0; i < unboundProjects.length; i++) {
    const proj = unboundProjects[i];
    if (i > 0) {
      await delay(TOPIC_CREATE_DELAY_MS);
    }

    const emoji = getProjectCategoryEmoji(deps, proj.id);
    const topicTitle = `${emoji} ${proj.name}`.slice(0, 128);

    try {
      const topic = await ctx.api.createForumTopic(chatId, topicTitle);
      deps.db.upsertTopicBinding({
        chatId,
        threadId: topic.message_thread_id,
        projectId: proj.id,
        conversationId: null,
        label: proj.name,
      });

      await sendTopicWelcomeCard(ctx, chatId, topic.message_thread_id, {
        title: `${emoji} <b>${escapeHtml(proj.name)}</b>`,
        workspacePath: proj.paths[0],
        hint: '💬 <i>Any message sent in this topic chats directly in this project.</i>',
      });

      createdNames.push(proj.name);
    } catch (err) {
      const parsed = formatTopicCreationError(err);
      errors.push(`${proj.name}: ${parsed.message}`);
      if (parsed.isPermissionError) {
        missingPermission = true;
        break;
      }
    }
  }

  const lines = ['🔄 <b>Forum Topic Sync Summary</b>', ''];

  if (projects.length === 0) {
    lines.push('ℹ️ No Antigravity projects found.');
  } else {
    lines.push(`✅ <b>Created:</b> ${createdNames.length}`);
    lines.push(`📌 <b>Already bound:</b> ${alreadyBoundCount}`);
  }

  if (createdNames.length > 0) {
    const preview = createdNames
      .slice(0, 15)
      .map((name) => `• ${escapeHtml(truncate(name, 48))}`);
    if (createdNames.length > 15) {
      preview.push(`• <i>…and ${createdNames.length - 15} more</i>`);
    }
    lines.push('', '<b>New Topics:</b>', ...preview);
  }

  if (errors.length > 0) {
    lines.push('', `❌ <b>Errors (${errors.length}):</b>`);
    for (const errMsg of errors.slice(0, 5)) {
      lines.push(`• <code>${escapeHtml(truncate(errMsg, 120))}</code>`);
    }
    if (missingPermission) {
      lines.push(
        '',
        '⚠️ <b>Missing Permission:</b> Grant the bot <b>Manage Topics</b> admin permission in Group Settings and run sync again.',
      );
    }
  }

  const keyboard = new InlineKeyboard()
    .text('📋 Bound Topics List', 'forum:list')
    .text('🏛 Forum Panel', 'forum:panel');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, false);
}

/**
 * Creates and binds a new Telegram Forum Topic for a specific `agy` project.
 */
export async function createTopicForProject(
  ctx: Context,
  deps: BotDeps,
  projectId: string,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      false,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const project = deps.store.getProject(projectId);
  if (!project) {
    await safeReplyOrEdit(
      ctx,
      `❌ Project not found: <code>${escapeHtml(projectId)}</code>`,
      new InlineKeyboard().text('⬅️ Back to Projects', 'forum:pick:0'),
      Boolean(ctx.callbackQuery),
    );
    return;
  }

  const emoji = getProjectCategoryEmoji(deps, project.id);
  const topicTitle = `${emoji} ${project.name}`.slice(0, 128);

  try {
    const topic = await ctx.api.createForumTopic(chatId, topicTitle);
    deps.db.upsertTopicBinding({
      chatId,
      threadId: topic.message_thread_id,
      projectId: project.id,
      conversationId: null,
      label: project.name,
    });

    await sendTopicWelcomeCard(ctx, chatId, topic.message_thread_id, {
      title: `${emoji} <b>${escapeHtml(project.name)}</b>`,
      workspacePath: project.paths[0],
      hint: '💬 <i>Any message sent in this topic chats directly in this project.</i>',
    });

    const keyboard = new InlineKeyboard()
      .text('➕ Create Another', 'forum:pick:0')
      .text('📋 Bound Topics', 'forum:list')
      .row()
      .text('🏛 Forum Panel', 'forum:panel');

    await safeReplyOrEdit(
      ctx,
      `✅ Created Forum Topic <b>${escapeHtml(topicTitle)}</b> (<code>#${topic.message_thread_id}</code>) and bound it to <b>${escapeHtml(project.name)}</b>.`,
      keyboard,
      Boolean(ctx.callbackQuery),
    );
  } catch (err) {
    const parsed = formatTopicCreationError(err);
    const hint = parsed.isPermissionError
      ? '\n\n⚠️ Ensure the bot is an Admin with <b>Manage Topics</b> permission.'
      : '';
    await safeReplyOrEdit(
      ctx,
      `❌ Failed to create topic for <b>${escapeHtml(project.name)}</b>: <code>${escapeHtml(parsed.message)}</code>${hint}`,
      new InlineKeyboard().text('⬅️ Back to Forum', 'forum:panel'),
      Boolean(ctx.callbackQuery),
    );
  }
}

/**
 * Creates a fresh Forum Topic for a new conversation (linked to the user's active project if any).
 */
export async function createNewChatTopic(
  ctx: Context,
  deps: BotDeps,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      false,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const project = session.activeProjectId
    ? deps.store.getProject(session.activeProjectId)
    : null;

  const topicTitle = (
    project ? `💬 ${project.name} · New Chat` : '💬 New Chat'
  ).slice(0, 128);

  try {
    const topic = await ctx.api.createForumTopic(chatId, topicTitle);
    deps.db.upsertTopicBinding({
      chatId,
      threadId: topic.message_thread_id,
      projectId: project?.id ?? null,
      conversationId: null,
      label: project ? `${project.name} (New Chat)` : 'New Chat',
    });

    await sendTopicWelcomeCard(ctx, chatId, topic.message_thread_id, {
      title: project
        ? `🆕 <b>New Chat — ${escapeHtml(project.name)}</b>`
        : '🆕 <b>New Chat Topic</b>',
      workspacePath: project?.paths[0],
      hint: '💬 <i>Send any message here to start a dedicated conversation in this topic.</i>',
    });

    const keyboard = new InlineKeyboard()
      .text('📋 Bound Topics List', 'forum:list')
      .text('🏛 Forum Panel', 'forum:panel');

    await safeReplyOrEdit(
      ctx,
      `🆕 Created new chat topic <b>${escapeHtml(topicTitle)}</b> (<code>#${topic.message_thread_id}</code>).`,
      keyboard,
      Boolean(ctx.callbackQuery),
    );
  } catch (err) {
    const parsed = formatTopicCreationError(err);
    const hint = parsed.isPermissionError
      ? '\n\n⚠️ Ensure the bot is an Admin with <b>Manage Topics</b> permission.'
      : '';
    await safeReplyOrEdit(
      ctx,
      `❌ Failed to create new chat topic: <code>${escapeHtml(parsed.message)}</code>${hint}`,
      new InlineKeyboard().text('⬅️ Back to Forum', 'forum:panel'),
      Boolean(ctx.callbackQuery),
    );
  }
}

/**
 * Lists all Forum Topic bindings configured for the current supergroup.
 */
export async function renderForumBindingsList(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      edit,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const bindings = deps.db.listTopicBindings(chatId);
  const lines = [`📋 <b>Bound Forum Topics (${bindings.length})</b>`, ''];

  if (bindings.length === 0) {
    lines.push('<i>No Forum Topics are bound in this supergroup yet.</i>');
  } else {
    for (const binding of bindings.slice(0, 30)) {
      const proj = binding.projectId ? deps.store.getProject(binding.projectId) : null;
      const label = proj?.name ?? binding.label ?? binding.projectId ?? 'Default workspace';
      const convBadge = binding.conversationId
        ? `<code>${escapeHtml(binding.conversationId.slice(0, 8))}</code>`
        : '<i>new chat</i>';
      lines.push(
        `• <code>#${binding.threadId}</code> → <b>${escapeHtml(truncate(label, 36))}</b> (${convBadge})`,
      );
    }
    if (bindings.length > 30) {
      lines.push('', `<i>…and ${bindings.length - 30} more binding(s).</i>`);
    }
  }

  const keyboard = new InlineKeyboard()
    .text('🔄 Sync All Projects', 'forum:sync')
    .text('➕ Create Topic', 'forum:pick:0')
    .row()
    .text('⬅️ Back to Forum', 'forum:panel')
    .text('🏠 Dashboard', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders a paginated project picker for creating a new Forum Topic bound to a project.
 */
export async function renderForumProjectPicker(
  ctx: Context,
  deps: BotDeps,
  page = 0,
  edit = false,
): Promise<void> {
  if (!isForumSupergroup(ctx) || !ctx.chat) {
    await safeReplyOrEdit(
      ctx,
      buildNonForumInstructionsHtml(),
      buildNonForumKeyboard(),
      edit,
    );
    return;
  }

  const chatId = ctx.chat.id;
  const projects = deps.store.listProjects().sort((a, b) => a.name.localeCompare(b.name));
  const bindings = deps.db.listTopicBindings(chatId);
  const boundProjectIds = new Set(
    bindings.map((b) => b.projectId).filter((id): id is string => id !== null),
  );

  const totalPages = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = projects.slice(
    safePage * PROJECTS_PER_PAGE,
    (safePage + 1) * PROJECTS_PER_PAGE,
  );

  const lines = [
    `➕ <b>Create Topic for Project</b> <i>(${projects.length} total)</i>`,
    '',
    slice.length === 0
      ? '<i>No Antigravity projects found.</i>'
      : 'Select a project to create &amp; bind a Forum Topic (📌 = already bound):',
  ];

  if (totalPages > 1) {
    lines.push('', `<i>Page ${safePage + 1} of ${totalPages}</i>`);
  }

  const keyboard = new InlineKeyboard();
  for (const proj of slice) {
    const emoji = getProjectCategoryEmoji(deps, proj.id);
    const boundMark = boundProjectIds.has(proj.id) ? '📌 ' : '';
    keyboard
      .text(
        `${boundMark}${emoji} ${truncate(proj.name, 30)}`,
        makeCallbackData('forum:create:', proj.id),
      )
      .row();
  }

  if (totalPages > 1) {
    if (safePage > 0) {
      keyboard.text('⬅️ Prev', `forum:pick:${safePage - 1}`);
    }
    keyboard.text(`${safePage + 1}/${totalPages}`, 'noop');
    if (safePage < totalPages - 1) {
      keyboard.text('Next ➡️', `forum:pick:${safePage + 1}`);
    }
    keyboard.row();
  }

  keyboard
    .text('⬅️ Back to Forum', 'forum:panel')
    .text('🏠 Dashboard', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}
