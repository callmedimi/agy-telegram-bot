import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Bot, Context } from 'grammy';
import { InputFile } from 'grammy';
import type { AgyPermissionMode, AgyResultEvent } from '../../agy/types.js';
import { type BotDeps, resolveCallbackPart } from '../context.js';
import { escapeHtml } from '../formatters.js';
import {
  renderCategoriesMenu,
  renderChatsMenu,
  renderProjectsMenu,
  renderSkillsMenu,
  sendArtifactsList,
  sendSearchResults,
  sendTranscriptView,
} from '../menus/index.js';
import { streamAgyResponse } from '../streamer.js';

const PENDING_INPUT_TTL_MS = 10 * 60 * 1000;
const MAX_AUTO_ARTIFACTS = 3;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface ExecutePromptOptions {
  conversationId?: string | null;
  projectId?: string | null;
  modeOverride?: AgyPermissionMode;
  threadId?: number;
}

function resolveThreadId(ctx: Context, explicitThreadId?: number): number | undefined {
  if (explicitThreadId !== undefined) {
    return explicitThreadId;
  }
  if (ctx.message?.message_thread_id !== undefined) {
    return ctx.message.message_thread_id;
  }
  const msg = ctx.msg;
  if (msg && 'message_thread_id' in msg && typeof msg.message_thread_id === 'number') {
    return msg.message_thread_id;
  }
  return undefined;
}

function expandHomePath(inputPath: string): string {
  const trimmed = inputPath.trim();
  if (trimmed === '~') {
    return os.homedir();
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function sanitizeFilename(filename: string, fallback: string): string {
  const base = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || fallback;
}

async function sendNewArtifacts(
  ctx: Context,
  deps: BotDeps,
  conversationId: string,
  beforeArtifacts: Map<string, number>,
  startedAt: number,
  priorConversationId: string | null,
  threadId?: number,
): Promise<void> {
  const artifacts = deps.store.listArtifacts(conversationId);
  const newArtifacts = artifacts.filter((artifact) => {
    if (artifact.sizeBytes <= 0) {
      return false;
    }
    const prevMtime = beforeArtifacts.get(artifact.absolutePath);
    if (prevMtime !== undefined) {
      return artifact.mtimeMs > prevMtime;
    }
    if (priorConversationId && conversationId === priorConversationId) {
      return true;
    }
    return artifact.mtimeMs >= startedAt - 50;
  });

  const toSend = newArtifacts.slice(0, MAX_AUTO_ARTIFACTS);
  const threadExtra = threadId !== undefined ? { message_thread_id: threadId } : {};

  for (const artifact of toSend) {
    try {
      const input = new InputFile(artifact.absolutePath);
      if (IMAGE_EXTENSIONS.has(artifact.ext.toLowerCase())) {
        await ctx.replyWithPhoto(input, {
          caption: artifact.relativePath,
          ...threadExtra,
        });
      } else {
        await ctx.replyWithDocument(input, {
          caption: artifact.relativePath,
          ...threadExtra,
        });
      }
    } catch (err) {
      console.warn(`[artifacts] Failed to auto-send ${artifact.absolutePath}:`, err);
    }
  }
}

/**
 * Executes a prompt against `agy` for the current user session (respecting Forum Topic bindings)
 * and streams the response back to Telegram.
 */
export async function executePrompt(
  ctx: Context,
  deps: BotDeps,
  prompt: string,
  opts?: ExecutePromptOptions,
): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) {
    return;
  }

  const session = deps.db.getSession(userId);
  const threadId = resolveThreadId(ctx, opts?.threadId);
  const chatId = ctx.chat?.id;
  const binding =
    chatId !== undefined && threadId !== undefined
      ? deps.db.getTopicBinding(chatId, threadId)
      : null;

  const projectId = opts?.projectId ?? binding?.projectId ?? session.activeProjectId;
  const project = projectId ? deps.store.getProject(projectId) : null;
  const firstPath = project?.paths[0];
  const cwd = firstPath && fs.existsSync(firstPath) ? firstPath : process.cwd();

  const conversationId =
    opts?.conversationId !== undefined
      ? opts.conversationId
      : binding
        ? binding.conversationId
        : session.activeConversationId;

  const beforeArtifacts = new Map<string, number>();
  if (conversationId) {
    for (const artifact of deps.store.listArtifacts(conversationId)) {
      beforeArtifacts.set(artifact.absolutePath, artifact.mtimeMs);
    }
  }

  const startedAt = Date.now();
  deps.lastPrompts.set(userId, prompt);

  const handle = deps.runner.run({
    prompt,
    conversationId: conversationId ?? undefined,
    project: !conversationId && project ? project.id : undefined,
    cwd,
    model: session.model || undefined,
    effort: session.effort,
    mode: opts?.modeOverride ?? session.mode,
    agent: session.agent ?? undefined,
    sandbox: session.sandbox,
    skipPermissions: session.skipPermissions,
  });

  await streamAgyResponse({
    ctx,
    handle,
    editIntervalMs: deps.config.streamEditIntervalMs,
    showTools: session.showTools,
    showUsage: session.showUsage,
    model: session.model || undefined,
    threadId,
    onComplete: async (result: AgyResultEvent['result']) => {
      if (result.conversation_id) {
        deps.db.updateSession(userId, {
          activeConversationId: result.conversation_id,
        });
        if (binding && chatId !== undefined && threadId !== undefined) {
          deps.db.upsertTopicBinding({
            chatId,
            threadId,
            conversationId: result.conversation_id,
          });
        }
      }

      if (session.autoSendArtifacts && result.conversation_id) {
        await sendNewArtifacts(
          ctx,
          deps,
          result.conversation_id,
          beforeArtifacts,
          startedAt,
          conversationId,
          threadId,
        );
      }
    },
  });
}

function parseCategoryInput(text: string): { emoji: string; name: string } {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && /\p{Extended_Pictographic}/u.test(parts[0])) {
    return {
      emoji: parts[0],
      name: parts.slice(1).join(' ').trim(),
    };
  }
  return {
    emoji: '📁',
    name: trimmed,
  };
}

function parseProjectInput(text: string): { name: string; folderPath?: string } {
  const trimmed = text.trim();
  const pipeIdx = trimmed.indexOf('|');
  if (pipeIdx === -1) {
    return { name: trimmed };
  }
  const name = trimmed.slice(0, pipeIdx).trim();
  const rawPath = trimmed.slice(pipeIdx + 1).trim();
  return {
    name,
    ...(rawPath ? { folderPath: expandHomePath(rawPath) } : {}),
  };
}

/**
 * Processes an active `pendingInput` prompt for the user if one exists and has not expired.
 * Returns `true` when input was consumed by a pending action, `false` otherwise.
 */
export async function handlePendingInput(
  ctx: Context,
  deps: BotDeps,
  text: string,
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined) {
    return false;
  }

  const session = deps.db.getSession(userId);
  const pending = session.pendingInput;
  if (!pending) {
    return false;
  }

  if (Date.now() - pending.createdAt > PENDING_INPUT_TTL_MS) {
    deps.db.clearPendingInput(userId);
    return false;
  }

  deps.db.clearPendingInput(userId);

  const trimmed = text.trim();
  const payload = pending.payload ?? {};

  switch (pending.action) {
    case 'cat:new': {
      const { emoji, name } = parseCategoryInput(trimmed);
      if (!name) {
        await ctx.reply('❌ Category name cannot be empty.');
        return true;
      }
      try {
        deps.db.createCategory(name, emoji);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Could not create category: <code>${escapeHtml(msg)}</code>`, {
          parse_mode: 'HTML',
        });
        return true;
      }
      await renderCategoriesMenu(ctx, deps, false);
      return true;
    }

    case 'proj:new': {
      const { name, folderPath } = parseProjectInput(trimmed);
      if (!name) {
        await ctx.reply('❌ Project name cannot be empty.');
        return true;
      }
      const project = deps.store.createProject(name, folderPath);
      deps.db.updateSession(userId, {
        activeProjectId: project.id,
        activeConversationId: null,
      });
      await renderProjectsMenu(ctx, deps, { edit: false });
      return true;
    }

    case 'proj:adddir': {
      const projectId = payload.projectId;
      if (!projectId || !trimmed) {
        await ctx.reply('❌ Missing project ID or directory path.');
        return true;
      }
      const resolvedPath = expandHomePath(trimmed);
      const updated = deps.store.addDirToProject(projectId, resolvedPath);
      if (!updated) {
        await ctx.reply('❌ Project not found.');
        return true;
      }
      await ctx.reply(
        `✅ Added <code>${escapeHtml(resolvedPath)}</code> to <b>${escapeHtml(updated.name)}</b>.`,
        { parse_mode: 'HTML' },
      );
      await renderProjectsMenu(ctx, deps, { edit: false });
      return true;
    }

    case 'chat:rename': {
      const conversationId = payload.conversationId;
      if (!conversationId || !trimmed) {
        await ctx.reply('❌ Missing conversation ID or title.');
        return true;
      }
      deps.db.setChatTitle(conversationId, trimmed);
      await ctx.reply(`✅ Renamed chat to <b>${escapeHtml(trimmed)}</b>.`, {
        parse_mode: 'HTML',
      });
      await renderChatsMenu(ctx, deps, { edit: false });
      return true;
    }

    case 'chat:search': {
      await sendSearchResults(ctx, deps, trimmed);
      return true;
    }

    case 'skill:search': {
      await renderSkillsMenu(ctx, deps, { query: trimmed, page: 0, edit: false });
      return true;
    }

    case 'skill:use': {
      const skillName = payload.skillName;
      if (!trimmed) {
        await ctx.reply('❌ Prompt cannot be empty.');
        return true;
      }
      const prompt = skillName
        ? `Use the "${skillName}" skill for this task:\n\n${trimmed}`
        : trimmed;
      await executePrompt(ctx, deps, prompt);
      return true;
    }

    case 'mcp:add': {
      const parts = trimmed.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        await ctx.reply('❌ Usage: <code>&lt;name&gt; &lt;command_or_url&gt; [args...]</code>', {
          parse_mode: 'HTML',
        });
        return true;
      }
      const [name, target, ...extraArgs] = parts;
      const type: 'http' | 'stdio' =
        target.startsWith('http://') || target.startsWith('https://') ? 'http' : 'stdio';
      try {
        const output = await deps.cli.addMcpServer({
          name,
          type,
          target,
          ...(extraArgs.length > 0 ? { extraArgs } : {}),
        });
        await ctx.reply(
          `✅ Added MCP server <code>${escapeHtml(name)}</code>:\n<pre>${escapeHtml(output || 'Done')}</pre>`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`❌ Failed to add MCP server: <code>${escapeHtml(msg)}</code>`, {
          parse_mode: 'HTML',
        });
      }
      return true;
    }

    default: {
      await ctx.reply('ℹ️ Pending input cleared.');
      return true;
    }
  }
}

async function downloadTelegramFile(
  ctx: Context,
  deps: BotDeps,
  userId: number,
  fileId: string,
  preferredFilename: string,
): Promise<string> {
  const fileInfo = await ctx.api.getFile(fileId);
  if (!fileInfo.file_path) {
    throw new Error('Telegram did not return a file path');
  }

  const downloadUrl = `https://api.telegram.org/file/bot${deps.config.botToken}/${fileInfo.file_path}`;
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Telegram file download failed with HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const uploadDir = path.join(deps.config.dataDir, 'uploads', String(userId));
  fs.mkdirSync(uploadDir, { recursive: true });

  const safeName = sanitizeFilename(
    preferredFilename || path.basename(fileInfo.file_path),
    'upload.bin',
  );
  const localPath = path.join(uploadDir, `${Date.now()}-${safeName}`);
  fs.writeFileSync(localPath, bytes);
  return localPath;
}

async function handleMediaMessage(
  ctx: Context,
  deps: BotDeps,
  mediaKind: 'photo' | 'document' | 'voice' | 'audio',
  fileId: string,
  filename: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (userId === undefined) {
    return;
  }

  let localPath: string;
  try {
    localPath = await downloadTelegramFile(ctx, deps, userId, fileId, filename);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ctx.reply(`❌ Failed to download ${mediaKind}: <code>${escapeHtml(msg)}</code>`, {
      parse_mode: 'HTML',
    });
    return;
  }

  const caption = ctx.message?.caption?.trim();
  const prompt = caption
    ? `[Attached ${mediaKind} saved at: ${localPath}]\n\n${caption}`
    : `Please inspect and process the attached ${mediaKind} saved at: ${localPath}`;

  await executePrompt(ctx, deps, prompt);
}

/**
 * Registers text, media, and retry/action callback handlers on the Telegram bot.
 */
export function registerMessageHandlers(bot: Bot, deps: BotDeps): void {
  const handleRetryCallback = async (ctx: Context, conversationIdOverride?: string): Promise<void> => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const lastPrompt = deps.lastPrompts.get(userId);
    if (!lastPrompt) {
      await ctx.answerCallbackQuery({ text: 'No previous prompt found to retry.' });
      return;
    }

    await ctx.answerCallbackQuery({ text: 'Retrying last prompt...' });
    await executePrompt(
      ctx,
      deps,
      lastPrompt,
      conversationIdOverride ? { conversationId: conversationIdOverride } : undefined,
    );
  };

  bot.callbackQuery('run:retry', async (ctx) => {
    await handleRetryCallback(ctx);
  });

  bot.callbackQuery(/^action:retry(?::(.+))?$/, async (ctx) => {
    const match = ctx.match;
    const convId =
      typeof match !== 'string' && match[1] ? resolveCallbackPart(match[1]) : undefined;
    await handleRetryCallback(ctx, convId);
  });

  bot.callbackQuery(/^action:artifacts(?::(.+))?$/, async (ctx) => {
    const match = ctx.match;
    const convId =
      typeof match !== 'string' && match[1] ? resolveCallbackPart(match[1]) : undefined;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore expired callback queries.
    }
    await sendArtifactsList(ctx, deps, convId, false);
  });

  bot.callbackQuery(/^action:transcript(?::(.+))?$/, async (ctx) => {
    const match = ctx.match;
    const convId =
      typeof match !== 'string' && match[1] ? resolveCallbackPart(match[1]) : undefined;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // Ignore expired callback queries.
    }
    await sendTranscriptView(ctx, deps, convId);
  });

  bot.callbackQuery('action:new', async (ctx) => {
    const userId = ctx.from?.id;
    if (userId !== undefined) {
      deps.db.updateSession(userId, { activeConversationId: null });
      const chatId = ctx.chat?.id;
      const threadId = resolveThreadId(ctx);
      if (chatId !== undefined && threadId !== undefined && deps.db.getTopicBinding(chatId, threadId)) {
        deps.db.upsertTopicBinding({ chatId, threadId, conversationId: null });
      }
    }
    await ctx.answerCallbackQuery({ text: 'Started a new chat' });
    const threadId = resolveThreadId(ctx);
    await ctx.reply(
      '🆕 Started a new chat',
      threadId !== undefined ? { message_thread_id: threadId } : undefined,
    );
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;

    // Forward unrecognized slash commands directly to Antigravity CLI (e.g. /compact, /karpathy-check).
    if (text.startsWith('/')) {
      await executePrompt(ctx, deps, text);
      return;
    }

    const consumed = await handlePendingInput(ctx, deps, text);
    if (consumed) {
      return;
    }

    await executePrompt(ctx, deps, text);
  });

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) {
      return;
    }
    await handleMediaMessage(ctx, deps, 'photo', largest.file_id, 'photo.jpg');
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    await handleMediaMessage(
      ctx,
      deps,
      'document',
      doc.file_id,
      doc.file_name ?? 'document.bin',
    );
  });

  bot.on('message:voice', async (ctx) => {
    const voice = ctx.message.voice;
    await handleMediaMessage(ctx, deps, 'voice', voice.file_id, 'voice.ogg');
  });

  bot.on('message:audio', async (ctx) => {
    const audio = ctx.message.audio;
    await handleMediaMessage(
      ctx,
      deps,
      'audio',
      audio.file_id,
      audio.file_name ?? 'audio.mp3',
    );
  });
}
