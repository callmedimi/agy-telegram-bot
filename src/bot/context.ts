import type { Context, InlineKeyboard } from 'grammy';
import { GrammyError } from 'grammy';
import type { AgyCliCommands } from '../agy/cli-commands.js';
import type { AgyRunner } from '../agy/runner.js';
import type { AgyStore } from '../agy/store.js';
import type { AppConfig } from '../config.js';
import type { BotDb } from '../db/bot-db.js';

export interface BotDeps {
  config: AppConfig;
  db: BotDb;
  store: AgyStore;
  runner: AgyRunner;
  cli: AgyCliCommands;
  lastPrompts: Map<number, string>;
}

const MAX_CALLBACK_BYTES = 64;
const MAX_MESSAGE_BYTES = 4096;
const SHORT_TOKEN_PREFIX = '~';
const MAX_TOKEN_CACHE = 5000;

const tokenToValue = new Map<string, string>();
const valueToToken = new Map<string, string>();
let tokenCounter = 0;

function isMessageNotModifiedError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    return (
      err.error_code === 400 &&
      err.description.toLowerCase().includes('message is not modified')
    );
  }
  if (err && typeof err === 'object') {
    const record = err as { error_code?: unknown; description?: unknown; message?: unknown };
    const desc =
      typeof record.description === 'string'
        ? record.description
        : typeof record.message === 'string'
          ? record.message
          : '';
    return record.error_code === 400 && desc.toLowerCase().includes('message is not modified');
  }
  return false;
}

/**
 * Extracts the acting Telegram user ID from a Context, falling back to chat ID.
 */
export function getUserId(ctx: Context): number {
  return ctx.from?.id ?? ctx.chat?.id ?? 0;
}

function getOrCreateToken(value: string): string {
  const existing = valueToToken.get(value);
  if (existing) {
    return existing;
  }

  tokenCounter = (tokenCounter + 1) % 1_000_000_000;
  const token = `${SHORT_TOKEN_PREFIX}${tokenCounter.toString(36)}`;

  if (tokenToValue.size >= MAX_TOKEN_CACHE) {
    const oldestKey = tokenToValue.keys().next().value;
    if (oldestKey !== undefined) {
      const oldestVal = tokenToValue.get(oldestKey);
      tokenToValue.delete(oldestKey);
      if (oldestVal !== undefined) {
        valueToToken.delete(oldestVal);
      }
    }
  }

  tokenToValue.set(token, value);
  valueToToken.set(value, token);
  return token;
}

/**
 * Builds a callback_data string guaranteed to be <= 64 UTF-8 bytes.
 * Uses `prefix + parts.join(':')` verbatim when it fits, otherwise substitutes short tokens.
 */
export function makeCallbackData(prefix: string, ...parts: string[]): string {
  const joined = parts.join(':');
  const full = `${prefix}${joined}`;
  if (Buffer.byteLength(full, 'utf8') <= MAX_CALLBACK_BYTES) {
    return full;
  }

  const shortenedParts = parts.map((part) => {
    if (Buffer.byteLength(part, 'utf8') <= 12) {
      return part;
    }
    return getOrCreateToken(part);
  });

  const candidate = `${prefix}${shortenedParts.join(':')}`;
  if (Buffer.byteLength(candidate, 'utf8') <= MAX_CALLBACK_BYTES) {
    return candidate;
  }

  const wholeToken = getOrCreateToken(joined);
  const compact = `${prefix}${wholeToken}`;
  if (Buffer.byteLength(compact, 'utf8') <= MAX_CALLBACK_BYTES) {
    return compact;
  }

  return Buffer.from(compact, 'utf8').subarray(0, MAX_CALLBACK_BYTES).toString('utf8');
}

/**
 * Resolves a callback_data segment that may have been compacted by `makeCallbackData`.
 */
export function resolveCallbackPart(part: string): string {
  if (part.startsWith(SHORT_TOKEN_PREFIX)) {
    return tokenToValue.get(part) ?? part;
  }
  return part;
}

/**
 * Edits the current callback message when `edit` is true, falling back to `ctx.reply`
 * if editing fails (ignoring "message is not modified"). Always uses `parse_mode: 'HTML'`.
 */
export async function safeReplyOrEdit(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
  edit = false,
): Promise<void> {
  const safeText = text.length > MAX_MESSAGE_BYTES ? `${text.slice(0, MAX_MESSAGE_BYTES - 1)}…` : text;
  const options = {
    parse_mode: 'HTML' as const,
    ...(keyboard ? { reply_markup: keyboard } : {}),
  };

  if (edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(safeText, options);
      return;
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        return;
      }
      // Fall through to ctx.reply when the message cannot be edited.
    }
  }

  const threadId = ctx.msg?.message_thread_id;
  await ctx.reply(safeText, {
    ...options,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  });
}
