import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import type { AgyModel } from '../../agy/types.js';
import { VALID_EFFORTS, VALID_MODES } from '../../config.js';
import { type BotDeps, getUserId, makeCallbackData, safeReplyOrEdit } from '../context.js';
import { escapeHtml, truncate } from '../formatters.js';

function boolBadge(val: boolean): string {
  return val ? '🟢 ON' : '⚪️ OFF';
}

/**
 * Renders the user session settings menu with effort, mode, pickers, and toggles.
 */
export async function renderSettingsMenu(
  ctx: Context,
  deps: BotDeps,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);

  const lines = [
    '⚙️ <b>Settings</b>',
    '',
    `🧠 <b>Model:</b> <code>${escapeHtml(session.model)}</code>`,
    `⚡ <b>Effort:</b> <code>${escapeHtml(session.effort)}</code>`,
    `🛡 <b>Mode:</b> <code>${escapeHtml(session.mode)}</code>`,
    `🤖 <b>Agent:</b> <code>${escapeHtml(session.agent ?? 'default')}</code>`,
    '',
    `📦 <b>Sandbox:</b> ${boolBadge(session.sandbox)}`,
    `⚠️ <b>Skip Permissions:</b> ${boolBadge(session.skipPermissions)}`,
    `🔧 <b>Show Tools:</b> ${boolBadge(session.showTools)}`,
    `📊 <b>Show Usage:</b> ${boolBadge(session.showUsage)}`,
    `📎 <b>Auto-send Artifacts:</b> ${boolBadge(session.autoSendArtifacts)}`,
    `🌐 <b>Language:</b> <code>${session.lang === 'fa' ? 'FA (فارسی)' : 'EN (English)'}</code>`,
  ];

  const keyboard = new InlineKeyboard();

  // Effort selector row
  for (const effort of VALID_EFFORTS) {
    const active = session.effort === effort;
    keyboard.text(active ? `✅ ${effort}` : effort, `set:effort:${effort}`);
  }
  keyboard.row();

  // Mode selector row
  for (const mode of VALID_MODES) {
    const active = session.mode === mode;
    keyboard.text(active ? `✅ ${mode}` : mode, `set:mode:${mode}`);
  }
  keyboard.row();

  // Model & Agent pickers
  keyboard
    .text('🧠 Choose Model', 'set:models:all')
    .text('🤖 Choose Agent', 'tools:agents')
    .row();

  // Toggle buttons (2 per row)
  keyboard
    .text(`📦 Sandbox: ${session.sandbox ? 'ON' : 'OFF'}`, 'set:toggle:sandbox')
    .text(`⚠️ Skip Perms: ${session.skipPermissions ? 'ON' : 'OFF'}`, 'set:toggle:skip')
    .row()
    .text(`🔧 Tools: ${session.showTools ? 'ON' : 'OFF'}`, 'set:toggle:tools')
    .text(`📊 Usage: ${session.showUsage ? 'ON' : 'OFF'}`, 'set:toggle:usage')
    .row()
    .text(`📎 Artifacts: ${session.autoSendArtifacts ? 'ON' : 'OFF'}`, 'set:toggle:art')
    .text(`🌐 Lang: ${session.lang.toUpperCase()}`, 'set:toggle:lang')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}

/**
 * Renders the model picker grouped by model family, with refresh support.
 */
export async function renderModelsMenu(
  ctx: Context,
  deps: BotDeps,
  family?: string,
  edit = false,
): Promise<void> {
  const userId = getUserId(ctx);
  const session = deps.db.getSession(userId);
  const forceRefresh = family === 'refresh';
  const activeFamily = !family || family === 'all' || family === 'refresh' ? 'all' : family;

  let models: AgyModel[];
  try {
    models = await deps.cli.listModels(forceRefresh);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const keyboard = new InlineKeyboard()
      .text('🔄 Retry', 'set:models:refresh')
      .text('⚙️ Settings', 'menu:settings')
      .row()
      .text('🏠 Home', 'menu:home');
    await safeReplyOrEdit(
      ctx,
      `🧠 <b>Models</b>\n\n❌ Failed to load models: <code>${escapeHtml(truncate(msg, 300))}</code>`,
      keyboard,
      edit,
    );
    return;
  }

  const byFamily = new Map<string, AgyModel[]>();
  for (const model of models) {
    const list = byFamily.get(model.family) ?? [];
    list.push(model);
    byFamily.set(model.family, list);
  }

  const families = Array.from(byFamily.keys());
  const selectedFamily =
    activeFamily !== 'all' && byFamily.has(activeFamily) ? activeFamily : 'all';

  const displayedModels =
    selectedFamily === 'all' ? models : (byFamily.get(selectedFamily) ?? []);

  const lines = [
    `🧠 <b>Models</b> <i>(${displayedModels.length} shown · ${models.length} total)</i>`,
    `<b>Current:</b> <code>${escapeHtml(session.model)}</code>`,
    '',
  ];

  if (displayedModels.length === 0) {
    lines.push('<i>No models available.</i>');
  } else {
    const shownFamilies = selectedFamily === 'all' ? families : [selectedFamily];
    for (const fam of shownFamilies) {
      const group = byFamily.get(fam) ?? [];
      lines.push(`<b>${escapeHtml(fam)}</b> (${group.length})`);
    }
  }

  const keyboard = new InlineKeyboard();

  // Family tabs (2 per row)
  if (families.length > 1) {
    const tabs: Array<{ label: string; cb: string }> = [
      { label: selectedFamily === 'all' ? '• All' : 'All', cb: 'set:models:all' },
      ...families.map((fam) => ({
        label: selectedFamily === fam ? `• ${truncate(fam, 18)}` : truncate(fam, 18),
        cb: makeCallbackData('set:models:fam:', fam),
      })),
    ];

    for (let i = 0; i < tabs.length; i++) {
      keyboard.text(tabs[i].label, tabs[i].cb);
      if ((i + 1) % 2 === 0 || i === tabs.length - 1) {
        keyboard.row();
      }
    }
  }

  // Model buttons (cap at 50 buttons to stay well within Telegram's 100-button limit)
  const cappedModels = displayedModels.slice(0, 50);
  for (let i = 0; i < cappedModels.length; i++) {
    const m = cappedModels[i];
    const isCurrent = m.id === session.model;
    const label = `${isCurrent ? '✅ ' : ''}${truncate(m.label || m.id, 28)}`;
    keyboard.text(label, makeCallbackData('set:model:', m.id));
    if ((i + 1) % 2 === 0 || i === cappedModels.length - 1) {
      keyboard.row();
    }
  }

  if (displayedModels.length > cappedModels.length) {
    lines.push('', `<i>Showing first ${cappedModels.length} models. Filter by family to see more.</i>`);
  }

  keyboard
    .text('🔄 Refresh', 'set:models:refresh')
    .text('⚙️ Settings', 'menu:settings')
    .row()
    .text('🏠 Home', 'menu:home');

  await safeReplyOrEdit(ctx, lines.join('\n'), keyboard, edit);
}
