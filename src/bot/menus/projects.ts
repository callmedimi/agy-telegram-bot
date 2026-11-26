import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { type BotDeps, getUserId, makeCallbackData, safeReplyOrEdit } from '../context.js';
import { escapeHtml, truncate } from '../formatters.js';

const PROJECTS_PER_PAGE = 6;
const DEFAULT_CATEGORY_NAMES = new Set(['Work', 'Personal', 'DevOps', 'Research']);

function buildChatCountByProject(deps: BotDeps): Map<string, number> {
  const counts = new Map<string, number>();
  const conversations = deps.store.listConversations({ limit: 500 });
  for (const conv of conversations) {
    if (!conv.projectId) {
      continue;
    }
    counts.set(conv.projectId, (counts.get(conv.projectId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Renders the paginated projects browser with category filter tabs and pin/active indicators.
 */
export async function renderProjectsMenu(
  ctx: Context,
  deps: BotDeps,
  opts: { catFilter?: string; page?: number; edit?: boolean } = {},
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const categories = deps.db.listCategories();
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const metas = new Map(deps.db.listAllProjectMeta().map((m) => [m.projectId, m]));
  const chatCounts = buildChatCountByProject(deps);

  const rawFilter = opts.catFilter?.trim() || 'all';
  const catFilter =
    rawFilter === 'all' || rawFilter === 'none' || catMap.has(Number(rawFilter))
      ? rawFilter
      : 'all';

  const allProjects = deps.store.listProjects();
  const enriched = allProjects
    .map((proj) => {
      const meta = metas.get(proj.id);
      const category = meta?.categoryId ? catMap.get(meta.categoryId) ?? null : null;
      const displayName = meta?.alias?.trim() || proj.name;
      return {
        project: proj,
        meta,
        category,
        displayName,
        pinned: meta?.pinned ?? false,
        chatCount: chatCounts.get(proj.id) ?? 0,
      };
    })
    .filter((item) => {
      if (catFilter === 'all') {
        return true;
      }
      if (catFilter === 'none') {
        return item.category === null;
      }
      return item.category?.id === Number(catFilter);
    })
    .sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return a.displayName.localeCompare(b.displayName);
    });

  const totalPages = Math.max(1, Math.ceil(enriched.length / PROJECTS_PER_PAGE));
  const page = Math.max(0, Math.min(opts.page ?? 0, totalPages - 1));
  const slice = enriched.slice(
    page * PROJECTS_PER_PAGE,
    (page + 1) * PROJECTS_PER_PAGE,
  );

  const filterLabel =
    catFilter === 'all'
      ? 'All'
      : catFilter === 'none'
        ? 'Uncategorized'
        : `${catMap.get(Number(catFilter))?.emoji ?? ''} ${catMap.get(Number(catFilter))?.name ?? ''}`.trim();

  const lines: string[] = [
    `📁 <b>Projects</b> <i>(${escapeHtml(filterLabel)} · ${enriched.length})</i>`,
    '',
  ];

  if (slice.length === 0) {
    lines.push('<i>No projects match this filter.</i>');
  } else {
    for (const item of slice) {
      const isActive = session.activeProjectId === item.project.id;
      const badges = [
        isActive ? '✅' : '',
        item.pinned ? '📌' : '',
        item.category ? item.category.emoji : '',
      ]
        .filter(Boolean)
        .join(' ');
      const prefix = badges ? `${badges} ` : '';
      const pathHint =
        item.project.paths.length > 0
          ? ` — <code>${escapeHtml(truncate(item.project.paths[0], 34))}</code>`
          : '';
      lines.push(
        `${prefix}<b>${escapeHtml(truncate(item.displayName, 36))}</b> (${item.chatCount} chats)${pathHint}`,
      );
    }
  }

  if (totalPages > 1) {
    lines.push('', `<i>Page ${page + 1} of ${totalPages}</i>`);
  }

  const keyboard = new InlineKeyboard();

  // Category filter tabs (max 3 per row)
  const filterTabs: Array<{ label: string; filter: string }> = [
    { label: catFilter === 'all' ? '• All' : 'All', filter: 'all' },
    ...categories.map((cat) => ({
      label:
        catFilter === String(cat.id)
          ? `• ${cat.emoji} ${truncate(cat.name, 12)}`
          : `${cat.emoji} ${truncate(cat.name, 12)}`,
      filter: String(cat.id),
    })),
    {
      label: catFilter === 'none' ? '• Uncategorized' : 'Uncategorized',
      filter: 'none',
    },
  ];

  for (let i = 0; i < filterTabs.length; i++) {
    const tab = filterTabs[i];
    keyboard.text(tab.label, `menu:proj_cat:${tab.filter}:0`);
    if ((i + 1) % 3 === 0 || i === filterTabs.length - 1) {
      keyboard.row();
    }
  }

  // Project buttons (1 per row for readability)
  for (const item of slice) {
    const isActive = session.activeProjectId === item.project.id;
    const labelParts = [
      isActive ? '✅' : '',
      item.pinned ? '📌' : '',
      item.category ? item.category.emoji : '📁',
      truncate(item.displayName, 26),
      `(${item.chatCount})`,
    ].filter(Boolean);
    keyboard.text(labelParts.join(' '), makeCallbackData('proj:view:', item.project.id)).row();
  }

  // Pagination row
  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text('⬅️ Prev', `menu:proj_cat:${catFilter}:${page - 1}`);
    }
    keyboard.text(`${page + 1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) {
      keyboard.text('Next ➡️', `menu:proj_cat:${catFilter}:${page + 1}`);
    }
    keyboard.row();
  }

  keyboard
    .text('➕ New Project', 'proj:new')
    .text('🗂 Manage Categories', 'menu:categories')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, opts.edit ?? false);
}

/**
 * Renders the detail view and management actions for a single project.
 */
export async function renderProjectDetail(
  ctx: Context,
  deps: BotDeps,
  projectId: string,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const project = deps.store.getProject(projectId);

  if (!project) {
    const keyboard = new InlineKeyboard()
      .text('⬅️ Back to Projects', 'menu:projects:0')
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `⚠️ <b>Project not found:</b> <code>${escapeHtml(projectId)}</code>`,
      keyboard,
      edit,
    );
    return;
  }

  const meta = deps.db.getProjectMeta(project.id);
  const category = meta?.categoryId ? deps.db.getCategory(meta.categoryId) : null;
  const isActive = session.activeProjectId === project.id;
  const isPinned = meta?.pinned ?? false;
  const displayName = meta?.alias?.trim() || project.name;
  const recentChats = deps.store.listConversations({ projectId: project.id, limit: 500 });

  const lines = [
    `📁 <b>${escapeHtml(displayName)}</b>${isActive ? ' ✅ <i>(Active)</i>' : ''}`,
    '',
    `🆔 <b>ID:</b> <code>${escapeHtml(project.id)}</code>`,
    `🗂 <b>Category:</b> ${category ? `${escapeHtml(category.emoji)} ${escapeHtml(category.name)}` : '<i>Uncategorized</i>'}`,
    `📌 <b>Pinned:</b> ${isPinned ? 'Yes' : 'No'}`,
    `💬 <b>Chats:</b> ${recentChats.length}`,
  ];

  if (project.paths.length > 0) {
    lines.push('📂 <b>Workspace Paths:</b>');
    for (const p of project.paths.slice(0, 6)) {
      lines.push(`  • <code>${escapeHtml(p)}</code>`);
    }
    if (project.paths.length > 6) {
      lines.push(`  <i>…and ${project.paths.length - 6} more</i>`);
    }
  } else {
    lines.push('📂 <b>Workspace Paths:</b> <i>None configured</i>');
  }

  const keyboard = new InlineKeyboard()
    .text(
      isActive ? '✅ Active Project' : '✅ Select Active',
      makeCallbackData('proj:select:', project.id),
    )
    .text('💬 Chats', 'menu:chats:proj:0')
    .row()
    .text(isPinned ? '📍 Unpin' : '📌 Pin', makeCallbackData('proj:pin:', project.id))
    .text('🗂 Set Category', makeCallbackData('proj:cat:', project.id))
    .row()
    .text('📁 Add Dir', makeCallbackData('proj:adddir:', project.id))
    .text('📌 Bind Forum Topic', makeCallbackData('proj:bindtopic:', project.id))
    .row()
    .text('⬅️ Back', 'menu:projects:0')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders the category selector for assigning a category to a project.
 */
export async function renderProjectCategoryPicker(
  ctx: Context,
  deps: BotDeps,
  projectId: string,
  edit = false,
): Promise<void> {
  const project = deps.store.getProject(projectId);
  const meta = deps.db.getProjectMeta(projectId);
  const categories = deps.db.listCategories();
  const title = meta?.alias?.trim() || project?.name || projectId;

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i];
    const isCurrent = meta?.categoryId === cat.id;
    keyboard.text(
      `${isCurrent ? '✅ ' : ''}${cat.emoji} ${cat.name}`,
      makeCallbackData('proj:setcat:', projectId, String(cat.id)),
    );
    if ((i + 1) % 2 === 0 || i === categories.length - 1) {
      keyboard.row();
    }
  }

  keyboard
    .text('🚫 Clear Category', makeCallbackData('proj:setcat:', projectId, 'none'))
    .row()
    .text('⬅️ Back', makeCallbackData('proj:view:', projectId));

  await safeReplyOrEdit(
    ctx,
    `🗂 <b>Select Category for</b> <code>${escapeHtml(truncate(title, 40))}</code>`,
    keyboard,
    edit,
  );
}

/**
 * Renders the category management screen with per-category project counts.
 */
export async function renderCategoriesMenu(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  const categories = deps.db.listCategories();
  const projects = deps.store.listProjects();
  const metas = new Map(deps.db.listAllProjectMeta().map((m) => [m.projectId, m]));

  const counts = new Map<number, number>();
  let uncategorizedCount = 0;
  for (const proj of projects) {
    const catId = metas.get(proj.id)?.categoryId ?? null;
    if (catId !== null) {
      counts.set(catId, (counts.get(catId) ?? 0) + 1);
    } else {
      uncategorizedCount += 1;
    }
  }

  const lines = [
    '🗂 <b>Project Categories</b>',
    '',
  ];

  for (const cat of categories) {
    const count = counts.get(cat.id) ?? 0;
    const customTag = DEFAULT_CATEGORY_NAMES.has(cat.name) ? '' : ' <i>(custom)</i>';
    lines.push(`${escapeHtml(cat.emoji)} <b>${escapeHtml(cat.name)}</b> — ${count} projects${customTag}`);
  }
  lines.push(`📂 <b>Uncategorized</b> — ${uncategorizedCount} projects`);

  const keyboard = new InlineKeyboard();
  for (const cat of categories) {
    const count = counts.get(cat.id) ?? 0;
    keyboard.text(
      `${cat.emoji} ${truncate(cat.name, 20)} (${count})`,
      `menu:proj_cat:${cat.id}:0`,
    );
    if (!DEFAULT_CATEGORY_NAMES.has(cat.name)) {
      keyboard.text('🗑', `cat:del:${cat.id}`);
    }
    keyboard.row();
  }

  keyboard
    .text('➕ New Category', 'cat:new')
    .text('📁 All Projects', 'menu:projects:0')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}
