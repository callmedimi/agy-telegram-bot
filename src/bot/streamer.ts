import type { Context } from 'grammy';
import { GrammyError, InlineKeyboard } from 'grammy';
import type { AgyInitEvent, AgyResultEvent } from '../agy/types.js';
import { makeCallbackData } from './context.js';
import {
  chunkTelegramHtml,
  escapeHtml,
  formatUsageFooter,
  markdownToTelegramHtml,
  truncate,
} from './formatters.js';

export interface StreamableRunHandle {
  readonly runId: string;
  conversationId?: string;
  on(event: 'init', listener: (ev: AgyInitEvent) => void): this;
  on(event: 'text_delta', listener: (delta: string) => void): this;
  on(event: 'thinking_delta', listener: (delta: string) => void): this;
  on(
    event: 'tool_use',
    listener: (info: { name: string; state: string; stepIndex: number }) => void,
  ): this;
  on(event: 'result', listener: (res: AgyResultEvent['result']) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'aborted', listener: () => void): this;
}

export interface StreamAgyResponseParams {
  ctx: Context;
  handle: StreamableRunHandle;
  editIntervalMs: number;
  showTools: boolean;
  showUsage: boolean;
  model?: string;
  threadId?: number;
  onComplete?: (result: AgyResultEvent['result']) => Promise<void> | void;
}

interface ToolEntry {
  name: string;
  state: string;
  stepIndex: number;
}

const MAX_MESSAGE_LEN = 3900;
const MIN_EDIT_INTERVAL_MS = 800;

function extractTelegramError(err: unknown): { code?: number; description?: string; retryAfter?: number } {
  if (err instanceof GrammyError) {
    return {
      code: err.error_code,
      description: err.description,
      retryAfter: err.parameters?.retry_after,
    };
  }
  if (err && typeof err === 'object') {
    const obj = err as {
      error_code?: unknown;
      description?: unknown;
      message?: unknown;
      parameters?: { retry_after?: unknown };
    };
    return {
      code: typeof obj.error_code === 'number' ? obj.error_code : undefined,
      description:
        typeof obj.description === 'string'
          ? obj.description
          : typeof obj.message === 'string'
            ? obj.message
            : undefined,
      retryAfter:
        typeof obj.parameters?.retry_after === 'number'
          ? obj.parameters.retry_after
          : undefined,
    };
  }
  return {};
}

function isMessageNotModified(err: unknown): boolean {
  const { code, description } = extractTelegramError(err);
  return code === 400 && Boolean(description?.toLowerCase().includes('message is not modified'));
}

function buildStopKeyboard(runId: string): InlineKeyboard {
  return new InlineKeyboard().text('🛑 Stop', `run:stop:${runId}`);
}

function buildActionKeyboard(conversationId?: string): InlineKeyboard {
  const retryData = conversationId
    ? makeCallbackData('action:retry:', conversationId)
    : 'action:retry';
  const artifactsData = conversationId
    ? makeCallbackData('action:artifacts:', conversationId)
    : 'action:artifacts';
  const transcriptData = conversationId
    ? makeCallbackData('action:transcript:', conversationId)
    : 'action:transcript';
  return new InlineKeyboard()
    .text('🔄 Retry', retryData)
    .text('📎 Artifacts', artifactsData)
    .row()
    .text('📜 Transcript', transcriptData)
    .text('🆕 New Chat', 'action:new');
}

function toolStateIcon(state: string): string {
  const normalized = state.toLowerCase();
  if (normalized.includes('err') || normalized.includes('fail')) {
    return '❌';
  }
  if (
    normalized.includes('done') ||
    normalized.includes('complete') ||
    normalized.includes('success')
  ) {
    return '✅';
  }
  return '⏳';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Streams an AGY run's events into a Telegram message with throttled live edits,
 * then finalizes with formatted Markdown->HTML chunks and post-response action buttons.
 */
export async function streamAgyResponse(
  params: StreamAgyResponseParams,
): Promise<AgyResultEvent['result'] | null> {
  const { ctx, handle, showTools, showUsage, threadId, onComplete } = params;
  const intervalMs = Math.max(MIN_EDIT_INTERVAL_MS, params.editIntervalMs);
  const stopKeyboard = buildStopKeyboard(handle.runId);

  const initialMsg = await ctx.reply('⚡ <i>Connecting to AGY...</i>', {
    parse_mode: 'HTML',
    reply_markup: stopKeyboard,
    ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
  });

  const chatId = initialMsg.chat.id;
  const messageId = initialMsg.message_id;

  let textBuffer = '';
  let isThinking = false;
  let currentModel = params.model;
  let conversationId = handle.conversationId;
  const activeTools: ToolEntry[] = [];

  let settled = false;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let lastEditAt = 0;
  let retryUntil = 0;
  let lastRenderedHtml = '';
  let editChain: Promise<void> = Promise.resolve();

  const renderLiveHtml = (): string => {
    const headerParts = ['⚡ <b>AGY</b>'];
    if (currentModel) {
      headerParts.push(`<code>${escapeHtml(currentModel)}</code>`);
    }
    const statusLine = isThinking
      ? '🧠 <i>Thinking...</i>'
      : textBuffer.length > 0
        ? '✍️ <i>Streaming...</i>'
        : '⚡ <i>Working...</i>';

    const lines: string[] = [`${headerParts.join(' · ')} — ${statusLine}`];

    if (showTools && activeTools.length > 0) {
      const recent = activeTools.slice(-5);
      for (const tool of recent) {
        lines.push(
          `${toolStateIcon(tool.state)} <code>${escapeHtml(tool.name)}</code> <i>(${escapeHtml(tool.state)})</i>`,
        );
      }
    }

    const headerHtml = lines.join('\n');
    if (textBuffer.length === 0) {
      return headerHtml.slice(0, MAX_MESSAGE_LEN);
    }

    const separator = '\n\n';
    const budget = Math.max(200, MAX_MESSAGE_LEN - headerHtml.length - separator.length - 16);
    const tailRaw =
      textBuffer.length > budget ? `…${textBuffer.slice(-(budget - 1))}` : textBuffer;
    let escapedTail = escapeHtml(tailRaw);
    const maxTailLen = MAX_MESSAGE_LEN - headerHtml.length - separator.length;
    if (escapedTail.length > maxTailLen) {
      escapedTail = `…${escapedTail.slice(-(Math.max(1, maxTailLen - 1)))}`;
      // Ensure we don't slice inside an HTML entity at the beginning of the tail.
      const firstSemi = escapedTail.indexOf(';');
      const firstAmp = escapedTail.indexOf('&');
      if (firstSemi !== -1 && (firstAmp === -1 || firstSemi < firstAmp)) {
        escapedTail = `…${escapedTail.slice(firstSemi + 1)}`;
      }
    }

    return `${headerHtml}${separator}${escapedTail}`;
  };

  const performLiveEdit = async (): Promise<void> => {
    if (settled) {
      return;
    }
    const html = renderLiveHtml();
    if (html === lastRenderedHtml) {
      return;
    }

    try {
      await ctx.api.editMessageText(chatId, messageId, html, {
        parse_mode: 'HTML',
        reply_markup: stopKeyboard,
      });
      lastRenderedHtml = html;
      lastEditAt = Date.now();
    } catch (err) {
      if (isMessageNotModified(err)) {
        lastRenderedHtml = html;
        return;
      }
      const { code, retryAfter } = extractTelegramError(err);
      if (code === 429 && retryAfter !== undefined) {
        retryUntil = Date.now() + (retryAfter + 1) * 1000;
        scheduleLiveEdit();
        return;
      }
      console.warn('[streamer] Live edit failed:', err);
    }
  };

  const scheduleLiveEdit = (): void => {
    if (settled || editTimer !== null) {
      return;
    }
    const now = Date.now();
    const waitMs = Math.max(0, lastEditAt + intervalMs - now, retryUntil - now);
    editTimer = setTimeout(() => {
      editTimer = null;
      if (settled) {
        return;
      }
      editChain = editChain.then(() => performLiveEdit());
    }, waitMs);
  };

  const clearPendingTimer = (): void => {
    if (editTimer !== null) {
      clearTimeout(editTimer);
      editTimer = null;
    }
  };

  const editFinalWithRetry = async (
    html: string,
    replyMarkup?: InlineKeyboard | { inline_keyboard: [] },
  ): Promise<void> => {
    const attempt = async (): Promise<void> => {
      await ctx.api.editMessageText(chatId, messageId, html, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup ?? { inline_keyboard: [] },
      });
    };

    try {
      await attempt();
    } catch (err) {
      if (isMessageNotModified(err)) {
        return;
      }
      const { code, retryAfter } = extractTelegramError(err);
      if (code === 429 && retryAfter !== undefined && retryAfter <= 15) {
        await sleep((retryAfter + 1) * 1000);
        try {
          await attempt();
          return;
        } catch (retryErr) {
          if (!isMessageNotModified(retryErr)) {
            console.error('[streamer] Final edit retry failed:', retryErr);
          }
          return;
        }
      }
      console.error('[streamer] Final edit failed:', err);
    }
  };

  return new Promise<AgyResultEvent['result'] | null>((resolve) => {
    handle.on('init', (ev) => {
      if (settled) return;
      if (ev.conversation_id) {
        conversationId = ev.conversation_id;
      }
      if (ev.init?.model) {
        currentModel = ev.init.model;
      }
      scheduleLiveEdit();
    });

    handle.on('thinking_delta', () => {
      if (settled) return;
      isThinking = true;
      scheduleLiveEdit();
    });

    handle.on('text_delta', (delta) => {
      if (settled) return;
      isThinking = false;
      textBuffer += delta;
      scheduleLiveEdit();
    });

    handle.on('tool_use', (info) => {
      if (settled) return;
      const existing = activeTools.find(
        (t) => t.stepIndex === info.stepIndex && t.name === info.name,
      );
      if (existing) {
        existing.state = info.state;
      } else {
        activeTools.push({
          name: info.name,
          state: info.state,
          stepIndex: info.stepIndex,
        });
      }
      scheduleLiveEdit();
    });

    handle.on('result', (res) => {
      if (settled) return;
      settled = true;
      clearPendingTimer();

      if (res.conversation_id) {
        conversationId = res.conversation_id;
      }

      editChain = editChain
        .then(async () => {
          const rawBody =
            res.response && res.response.length > 0
              ? res.response
              : textBuffer.length > 0
                ? textBuffer
                : res.error
                  ? `Error: ${res.error}`
                  : '(No response)';

          let finalHtml = markdownToTelegramHtml(rawBody);
          if (showUsage) {
            const footer = formatUsageFooter(res.usage, res.duration_seconds, currentModel);
            if (footer) {
              finalHtml = finalHtml ? `${finalHtml}\n\n${footer}` : footer;
            }
          }

          const chunks = chunkTelegramHtml(finalHtml, MAX_MESSAGE_LEN);
          const actionKeyboard = buildActionKeyboard(conversationId);

          if (chunks.length === 1) {
            await editFinalWithRetry(chunks[0], actionKeyboard);
          } else {
            await editFinalWithRetry(chunks[0], { inline_keyboard: [] });
            for (let i = 1; i < chunks.length; i++) {
              const isLast = i === chunks.length - 1;
              try {
                await ctx.api.sendMessage(chatId, chunks[i], {
                  parse_mode: 'HTML',
                  ...(threadId !== undefined ? { message_thread_id: threadId } : {}),
                  ...(isLast ? { reply_markup: actionKeyboard } : {}),
                });
              } catch (sendErr) {
                console.error('[streamer] Follow-up chunk send failed:', sendErr);
              }
            }
          }

          if (onComplete) {
            await onComplete(res);
          }
        })
        .finally(() => {
          resolve(res);
        });
    });

    handle.on('aborted', () => {
      if (settled) return;
      settled = true;
      clearPendingTimer();

      editChain = editChain
        .then(async () => {
          const stoppedNotice = '⛔ <b>Stopped by user.</b>';
          let html = stoppedNotice;
          if (textBuffer.trim().length > 0) {
            const partial = markdownToTelegramHtml(truncate(textBuffer, 3200));
            html = `${partial}\n\n${stoppedNotice}`;
          }
          await editFinalWithRetry(html, { inline_keyboard: [] });
        })
        .finally(() => {
          resolve(null);
        });
    });

    handle.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearPendingTimer();

      editChain = editChain
        .then(async () => {
          const errorNotice = `❌ <b>Error:</b> <code>${escapeHtml(err.message)}</code>`;
          let html = errorNotice;
          if (textBuffer.trim().length > 0) {
            const partial = markdownToTelegramHtml(truncate(textBuffer, 3000));
            html = `${partial}\n\n${errorNotice}`;
          }
          await editFinalWithRetry(html, { inline_keyboard: [] });
        })
        .finally(() => {
          resolve(null);
        });
    });
  });
}
