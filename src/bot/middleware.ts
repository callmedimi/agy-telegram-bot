import type { BotError, Context, ErrorHandler, MiddlewareFn } from 'grammy';
import { GrammyError, HttpError } from 'grammy';

/**
 * Restricts bot access to `allowedUserIds`.
 * If `allowedUserIds` is empty, all users are permitted.
 * Unauthorized users receive a short denial notice in private chats and are silently ignored in groups.
 */
export function createAuthMiddleware(allowedUserIds: number[]): MiddlewareFn<Context> {
  const allowedSet = new Set(allowedUserIds);

  return async (ctx, next) => {
    if (allowedSet.size === 0) {
      await next();
      return;
    }

    const userId = ctx.from?.id;
    if (userId !== undefined && allowedSet.has(userId)) {
      await next();
      return;
    }

    if (ctx.chat?.type === 'private') {
      const idDisplay = userId !== undefined ? String(userId) : 'unknown';
      try {
        await ctx.reply(`⛔ Access denied. Your Telegram ID: <code>${idDisplay}</code>`, {
          parse_mode: 'HTML',
        });
      } catch {
        // Ignore Telegram delivery errors when notifying denied users.
      }
    }
  };
}

/**
 * Creates a grammY error handler that logs update context and error details without crashing the process.
 */
export function createErrorHandler(): ErrorHandler<Context> {
  return (err: BotError<Context>) => {
    const ctx = err.ctx;
    const updateId = ctx?.update?.update_id ?? 'unknown';
    const userId = ctx?.from?.id ?? 'unknown';
    const chatId = ctx?.chat?.id ?? 'unknown';
    const cause = err.error;

    if (cause instanceof GrammyError) {
      console.error(
        `[bot:error] update=${updateId} user=${userId} chat=${chatId} GrammyError(${cause.error_code}): ${cause.description}`,
      );
      return;
    }

    if (cause instanceof HttpError) {
      console.error(
        `[bot:error] update=${updateId} user=${userId} chat=${chatId} HttpError: ${cause.message}`,
      );
      return;
    }

    const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
    console.error(
      `[bot:error] update=${updateId} user=${userId} chat=${chatId} Error: ${message}`,
    );
  };
}
