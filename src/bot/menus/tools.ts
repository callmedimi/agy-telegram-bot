import os from 'node:os';
import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { stripAnsiAndSpinners } from '../../agy/cli-commands.js';
import type { AgyMcpServer, AgySkill } from '../../agy/types.js';
import { type BotDeps, getUserId, makeCallbackData, safeReplyOrEdit } from '../context.js';
import { escapeHtml, truncate } from '../formatters.js';

const SKILLS_PER_PAGE = 8;
const activeSkillSearchByUser = new Map<number, string>();

/**
 * Clears the stored skill search filter for a user.
 */
export function clearActiveSkillSearch(userId: number): void {
  activeSkillSearchByUser.delete(userId);
}

function formatUptime(totalSeconds: number): string {
  const secs = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(' ');
}

function formatMemoryMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return `${(mb / 1024).toFixed(2)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

function isMcpEnabled(server: AgyMcpServer): boolean {
  const s = server.status.toLowerCase();
  return !s.includes('disable') && !s.includes('off') && !s.includes('inactive');
}

/**
 * Renders the MCP, Skills, Plugins, Agents, and Status tools hub.
 */
export async function renderToolsMenu(
  ctx: Context,
  _deps: BotDeps,
  edit = false,
): Promise<void> {
  const lines = [
    '🔌 <b>MCP &amp; Tools Hub</b>',
    '',
    'Manage MCP servers, browse installed skills, inspect plugins, switch agents, or check system status.',
  ];

  const keyboard = new InlineKeyboard()
    .text('🔌 MCP Servers', 'tools:mcp')
    .text('🧩 Skills', 'tools:skills:0')
    .row()
    .text('📦 Plugins', 'tools:plugins')
    .text('🤖 Agents', 'tools:agents')
    .row()
    .text('📊 System Status', 'tools:status')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders the MCP server list with enable/disable toggles, add, and remove actions.
 */
export async function renderMcpMenu(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  let servers: AgyMcpServer[];
  try {
    servers = await deps.cli.listMcpServers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const keyboard = new InlineKeyboard()
      .text('🔄 Retry', 'tools:mcp')
      .text('⬅️ Back', 'menu:tools')
      .row()
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `🔌 <b>MCP Servers</b>\n\n❌ Failed to list MCP servers: <code>${escapeHtml(truncate(msg, 300))}</code>`,
      keyboard,
      edit,
    );
    return;
  }

  const lines = [`🔌 <b>MCP Servers</b> <i>(${servers.length})</i>`, ''];
  const keyboard = new InlineKeyboard();

  if (servers.length === 0) {
    lines.push('<i>No MCP servers configured.</i>');
  } else {
    for (const srv of servers.slice(0, 25)) {
      const enabled = isMcpEnabled(srv);
      const icon = enabled ? '✅' : '⛔';
      lines.push(
        `${icon} <b>${escapeHtml(srv.name)}</b> <i>(${escapeHtml(srv.type)} · ${escapeHtml(srv.status)})</i>\n    <code>${escapeHtml(truncate(srv.target, 55))}</code>`,
      );
      keyboard
        .text(
          `${icon} ${truncate(srv.name, 22)}`,
          makeCallbackData('mcp:toggle:', srv.name, enabled ? '0' : '1'),
        )
        .text('🗑 Remove', makeCallbackData('mcp:del:', srv.name))
        .row();
    }
    if (servers.length > 25) {
      lines.push('', `<i>Showing 25 of ${servers.length} servers.</i>`);
    }
  }

  keyboard
    .text('➕ Add MCP', 'mcp:add')
    .text('🔄 Refresh', 'tools:mcp')
    .row()
    .text('⬅️ Back', 'menu:tools')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders the paginated skills browser (8 per page) with optional search filtering.
 */
export async function renderSkillsMenu(
  ctx: Context,
  deps: BotDeps,
  opts: { page?: number; query?: string; edit?: boolean } = {},
): Promise<void> {
  const userId = getUserId(ctx);
  if (opts.query !== undefined) {
    const cleaned = opts.query.trim();
    if (cleaned) {
      activeSkillSearchByUser.set(userId, cleaned);
    } else {
      activeSkillSearchByUser.delete(userId);
    }
  }
  const allSkills = deps.store.listSkills();
  const query = opts.query !== undefined ? opts.query.trim() : (activeSkillSearchByUser.get(userId) ?? '');
  const filtered: Array<{ skill: AgySkill; globalIndex: number }> = [];

  if (query) {
    const needle = query.toLowerCase();
    for (let i = 0; i < allSkills.length; i++) {
      const s = allSkills[i];
      if (
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle)
      ) {
        filtered.push({ skill: s, globalIndex: i });
      }
    }
  } else {
    for (let i = 0; i < allSkills.length; i++) {
      filtered.push({ skill: allSkills[i], globalIndex: i });
    }
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / SKILLS_PER_PAGE));
  const page = Math.max(0, Math.min(opts.page ?? 0, totalPages - 1));
  const slice = filtered.slice(page * SKILLS_PER_PAGE, (page + 1) * SKILLS_PER_PAGE);

  const headerFilter = query ? ` · filter: "${escapeHtml(truncate(query, 24))}"` : '';
  const lines = [
    `🧩 <b>Skills</b> <i>(${filtered.length} found${headerFilter})</i>`,
    '',
  ];

  if (slice.length === 0) {
    lines.push('<i>No matching skills found.</i>');
  } else {
    for (const item of slice) {
      const desc = item.skill.description
        ? ` — <i>${escapeHtml(truncate(item.skill.description, 70))}</i>`
        : '';
      lines.push(`• <b>${escapeHtml(item.skill.name)}</b>${desc}`);
    }
  }

  if (totalPages > 1) {
    lines.push('', `<i>Page ${page + 1} of ${totalPages}</i>`);
  }

  const keyboard = new InlineKeyboard();
  for (let i = 0; i < slice.length; i++) {
    const item = slice[i];
    keyboard.text(
      `🧩 ${truncate(item.skill.name, 22)}`,
      `skill:view:${item.globalIndex}`,
    );
    if ((i + 1) % 2 === 0 || i === slice.length - 1) {
      keyboard.row();
    }
  }

  if (totalPages > 1) {
    if (page > 0) {
      keyboard.text('⬅️ Prev', `tools:skills:${page - 1}`);
    }
    keyboard.text(`${page + 1}/${totalPages}`, 'noop');
    if (page < totalPages - 1) {
      keyboard.text('Next ➡️', `tools:skills:${page + 1}`);
    }
    keyboard.row();
  }

  keyboard.text('🔍 Search Skills', 'skill:search');
  if (query) {
    keyboard.text('✖️ Clear Filter', 'tools:skills:clear');
  }
  keyboard
    .row()
    .text('⬅️ Back', 'menu:tools')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, opts.edit ?? false);
}

/**
 * Renders details and invoke action for a single skill by its index in `listSkills()`.
 */
export async function renderSkillDetail(
  ctx: Context,
  deps: BotDeps,
  skillIndex: number,
  edit = false,
): Promise<void> {
  const skills = deps.store.listSkills();
  const skill = skills[skillIndex];

  if (!skill) {
    const keyboard = new InlineKeyboard()
      .text('⬅️ Back to Skills', 'tools:skills:0')
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(ctx, '⚠️ <b>Skill not found.</b>', keyboard, edit);
    return;
  }

  const lines = [
    `🧩 <b>${escapeHtml(skill.name)}</b>`,
    '',
    skill.description
      ? escapeHtml(truncate(skill.description, 1000))
      : '<i>No description provided.</i>',
    '',
    `📄 <b>Path:</b> <code>${escapeHtml(skill.path)}</code>`,
  ];

  const keyboard = new InlineKeyboard()
    .text('▶️ Use Skill', makeCallbackData('skill:use:', String(skillIndex)))
    .row()
    .text('⬅️ Back to Skills', 'tools:skills:0')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders installed AGY plugins output.
 */
export async function renderPluginsMenu(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  let body: string;
  try {
    const raw = await deps.cli.listPlugins();
    const cleaned = stripAnsiAndSpinners(raw).trim();
    body = cleaned
      ? `<pre>${escapeHtml(truncate(cleaned, 3200))}</pre>`
      : '<i>No plugins installed.</i>';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    body = `❌ Failed to list plugins: <code>${escapeHtml(truncate(msg, 300))}</code>`;
  }

  const keyboard = new InlineKeyboard()
    .text('🔄 Refresh', 'tools:plugins')
    .text('⬅️ Back', 'menu:tools')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, `📦 <b>Plugins</b>\n\n${body}`, keyboard, edit);
}

/**
 * Renders available AGY agents with one-tap selection.
 */
export async function renderAgentsMenu(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);

  let agents: string[];
  try {
    agents = await deps.cli.listAgents();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const keyboard = new InlineKeyboard()
      .text('🔄 Retry', 'tools:agents')
      .text('⬅️ Back', 'menu:tools')
      .row()
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `🤖 <b>Agents</b>\n\n❌ Failed to list agents: <code>${escapeHtml(truncate(msg, 300))}</code>`,
      keyboard,
      edit,
    );
    return;
  }

  const lines = [
    `🤖 <b>Agents</b> <i>(${agents.length})</i>`,
    `<b>Current:</b> <code>${escapeHtml(session.agent ?? 'default (none)')}</code>`,
    '',
  ];

  if (agents.length === 0) {
    lines.push('<i>No custom agents configured.</i>');
  } else {
    for (const agent of agents.slice(0, 30)) {
      const mark = session.agent === agent ? '✅ ' : '• ';
      lines.push(`${mark}<code>${escapeHtml(agent)}</code>`);
    }
  }

  const keyboard = new InlineKeyboard()
    .text(session.agent === null ? '✅ Default (none)' : 'Default (none)', 'agent:set:none')
    .row();

  const capped = agents.slice(0, 40);
  for (let i = 0; i < capped.length; i++) {
    const name = capped[i];
    const isCurrent = session.agent === name;
    keyboard.text(
      `${isCurrent ? '✅ ' : ''}${truncate(name, 26)}`,
      makeCallbackData('agent:set:', name),
    );
    if ((i + 1) % 2 === 0 || i === capped.length - 1) {
      keyboard.row();
    }
  }

  keyboard
    .text('🔄 Refresh', 'tools:agents')
    .text('⚙️ Settings', 'menu:settings')
    .row()
    .text('⬅️ Back', 'menu:tools')
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders runtime health, CLI version, OS resources, active runs, and database stats.
 */
export async function renderStatusView(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  let agyVersion = 'unavailable';
  try {
    const v = await deps.cli.getVersion();
    if (v) {
      agyVersion = v;
    }
  } catch {
    agyVersion = 'unavailable';
  }

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const usedPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;

  const activeRuns = deps.runner.listActiveRuns();
  const dbStats = deps.db.getStats();
  const totalProjects = deps.store.listProjects().length;
  const totalSkills = deps.store.listSkills().length;

  const lines = [
    '📊 <b>System Status</b>',
    '',
    `🛸 <b>AGY CLI:</b> <code>${escapeHtml(truncate(agyVersion, 48))}</code>`,
    `🟢 <b>Node.js:</b> <code>${escapeHtml(process.version)}</code>`,
    `⏱ <b>OS Uptime:</b> <code>${escapeHtml(formatUptime(os.uptime()))}</code>`,
    `💾 <b>RAM:</b> <code>${escapeHtml(formatMemoryMb(usedMem))} / ${escapeHtml(formatMemoryMb(totalMem))}</code> (${usedPct}%)`,
    `🏃 <b>Active Runs:</b> <b>${activeRuns.length}</b>`,
    '',
    '🗄 <b>Database &amp; Store</b>',
    `  • 📁 Projects: <b>${totalProjects}</b> (📌 ${dbStats.pinnedProjects} pinned)`,
    `  • 🧩 Skills: <b>${totalSkills}</b>`,
    `  • 🗂 Categories: <b>${dbStats.categories}</b>`,
    `  • 💬 Pinned Chats: <b>${dbStats.pinnedChats}</b>`,
    `  • 📌 Topic Bindings: <b>${dbStats.topicBindings}</b>`,
    `  • 👥 Users: <b>${dbStats.users}</b>`,
  ];

  if (activeRuns.length > 0) {
    lines.push('', '<b>Running Tasks:</b>');
    for (const run of activeRuns.slice(0, 5)) {
      const elapsedSec = Math.round((Date.now() - run.startedAt) / 1000);
      lines.push(
        `  • <code>${escapeHtml(run.runId.slice(0, 8))}</code> (${elapsedSec}s): ${escapeHtml(truncate(run.options.prompt, 40))}`,
      );
    }
  }

  const keyboard = new InlineKeyboard();
  if (activeRuns.length > 0) {
    keyboard.text(`🛑 Stop All (${activeRuns.length})`, 'run:stop_all').row();
  }
  keyboard
    .text('🔄 Refresh', 'tools:status')
    .text('⬅️ Back', 'menu:tools')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}
