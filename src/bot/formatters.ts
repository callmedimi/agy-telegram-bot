import type { AgyUsage } from '../agy/types.js';

const TRACKED_TAGS = new Set(['pre', 'code', 'b', 'i', 's', 'u', 'a', 'blockquote']);

interface OpenTag {
  name: string;
  openTag: string;
}

/**
 * Escapes text for safe inclusion in Telegram HTML messages.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

/**
 * Converts Markdown output (code blocks, inline code, headings, bold, italic, links)
 * into Telegram-safe HTML.
 */
export function markdownToTelegramHtml(md: string): string {
  if (!md) {
    return '';
  }

  let normalized = md.replace(/\r\n/g, '\n').replace(/\u0000/g, '');

  const codeBlocks: string[] = [];
  const inlineCodes: string[] = [];

  // 1. Extract fenced code blocks first so inner markdown is never interpreted.
  normalized = normalized.replace(
    /(^|\n)```([^\n`]*)\n([\s\S]*?)```[ \t]*(?=\n|$)/g,
    (_match, prefix: string, rawLang: string, rawCode: string) => {
      const lang = rawLang.trim().replace(/[^a-zA-Z0-9_+-]/g, '');
      const code = rawCode.replace(/\n$/, '');
      const html = lang
        ? `<pre><code class="language-${escapeHtmlAttr(lang)}">${escapeHtml(code)}</code></pre>`
        : `<pre><code>${escapeHtml(code)}</code></pre>`;
      const token = `\u0000CB_${codeBlocks.length}\u0000`;
      codeBlocks.push(html);
      return `${prefix}${token}`;
    },
  );

  // 2. Extract double-backtick inline code, then single-backtick inline code.
  normalized = normalized.replace(/``([^`\n]+(?:`[^`\n]+)*)``/g, (_match, code: string) => {
    const token = `\u0000IC_${inlineCodes.length}\u0000`;
    inlineCodes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return token;
  });

  normalized = normalized.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const token = `\u0000IC_${inlineCodes.length}\u0000`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return token;
  });

  // 3. Escape all remaining non-markup HTML.
  let html = escapeHtml(normalized);

  // 4. Headings (# ... -> <b>...</b>)
  html = html.replace(/^#{1,6}[ \t]+(.+)$/gm, '<b>$1</b>');

  // 5. Links [text](url)
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+|tg:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_match, label: string, url: string) =>
      `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`,
  );

  // 6. Bold **...**
  html = html.replace(
    /\*\*(?!\s)((?:[^*\n]|\*(?!\*))+?)(?<!\s)\*\*/g,
    '<b>$1</b>',
  );

  // 7. Italic *...* (avoid breaking arithmetic like 2*3*4 or bullet lists `* item`)
  html = html.replace(
    /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g,
    '<i>$1</i>',
  );

  // 8. Strikethrough ~~...~~
  html = html.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '<s>$1</s>');

  // 9. Restore inline code, then fenced code blocks.
  html = html.replace(/\u0000IC_(\d+)\u0000/g, (_m, idx: string) => inlineCodes[Number(idx)] ?? '');
  html = html.replace(/\u0000CB_(\d+)\u0000/g, (_m, idx: string) => codeBlocks[Number(idx)] ?? '');

  return html;
}

function closingTagsFor(stack: readonly OpenTag[]): string {
  let out = '';
  for (let i = stack.length - 1; i >= 0; i--) {
    out += `</${stack[i].name}>`;
  }
  return out;
}

function openingTagsFor(stack: readonly OpenTag[]): string {
  return stack.map((t) => t.openTag).join('');
}

function applyTagToken(stack: OpenTag[], token: string): void {
  const closeMatch = /^<\/([a-zA-Z0-9]+)>$/.exec(token);
  if (closeMatch) {
    const tagName = closeMatch[1].toLowerCase();
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].name === tagName) {
        stack.splice(i, 1);
        break;
      }
    }
    return;
  }

  const openMatch = /^<([a-zA-Z0-9]+)(?:\s+[^>]*)?>$/.exec(token);
  if (openMatch && !token.endsWith('/>')) {
    const tagName = openMatch[1].toLowerCase();
    if (TRACKED_TAGS.has(tagName)) {
      stack.push({ name: tagName, openTag: token });
    }
  }
}

interface SplitCandidate {
  index: number;
  stack: OpenTag[];
}

/**
 * Splits long Telegram HTML into chunks <= `maxLen`, splitting on paragraph/line/word
 * boundaries where possible and properly closing/reopening tags (such as `<pre><code>`)
 * across chunk boundaries.
 */
export function chunkTelegramHtml(html: string, maxLen = 3900): string[] {
  if (html.length <= maxLen) {
    return [html];
  }

  const chunks: string[] = [];
  let pos = 0;
  let activeStack: OpenTag[] = [];

  while (pos < html.length) {
    const reopenPrefix = openingTagsFor(activeStack);
    const workingStack: OpenTag[] = activeStack.map((t) => ({ ...t }));

    let bestPara: SplitCandidate | null = null;
    let bestLine: SplitCandidate | null = null;
    let bestSpace: SplitCandidate | null = null;
    let bestAny: SplitCandidate | null = null;

    let cursor = pos;
    let reachedEnd = false;

    while (cursor <= html.length) {
      const closingLen = closingTagsFor(workingStack).length;
      const totalLen = reopenPrefix.length + (cursor - pos) + closingLen;

      if (totalLen > maxLen) {
        break;
      }

      if (cursor > pos) {
        const snapshot = workingStack.map((t) => ({ ...t }));
        const inPre = workingStack.some((t) => t.name === 'pre');
        bestAny = { index: cursor, stack: snapshot };

        const prevChar = html[cursor - 1];
        if (!inPre && cursor - pos >= 2 && html[cursor - 2] === '\n' && prevChar === '\n') {
          bestPara = { index: cursor, stack: snapshot };
        } else if (prevChar === '\n') {
          bestLine = { index: cursor, stack: snapshot };
        } else if (!inPre && prevChar === ' ') {
          bestSpace = { index: cursor, stack: snapshot };
        }
      }

      if (cursor === html.length) {
        reachedEnd = true;
        break;
      }

      const ch = html[cursor];
      if (ch === '<') {
        const closeAngle = html.indexOf('>', cursor + 1);
        if (closeAngle !== -1) {
          const tagToken = html.slice(cursor, closeAngle + 1);
          const nextCursor = closeAngle + 1;
          const nextStack = workingStack.map((t) => ({ ...t }));
          applyTagToken(nextStack, tagToken);
          const nextTotal =
            reopenPrefix.length + (nextCursor - pos) + closingTagsFor(nextStack).length;
          if (nextTotal > maxLen && cursor > pos) {
            break;
          }
          applyTagToken(workingStack, tagToken);
          cursor = nextCursor;
          continue;
        }
      } else if (ch === '&') {
        const entityMatch = /^&[a-zA-Z0-9#]{1,10};/.exec(html.slice(cursor, cursor + 12));
        if (entityMatch) {
          const nextCursor = cursor + entityMatch[0].length;
          const nextTotal =
            reopenPrefix.length + (nextCursor - pos) + closingTagsFor(workingStack).length;
          if (nextTotal > maxLen && cursor > pos) {
            break;
          }
          cursor = nextCursor;
          continue;
        }
      }

      cursor += 1;
    }

    if (reachedEnd) {
      chunks.push(reopenPrefix + html.slice(pos));
      break;
    }

    const minParaDist = Math.floor(maxLen * 0.3);
    const minLineDist = Math.floor(maxLen * 0.2);

    let chosen: SplitCandidate | null = null;
    if (bestPara && bestPara.index - pos >= minParaDist) {
      chosen = bestPara;
    } else if (bestLine && bestLine.index - pos >= minLineDist) {
      chosen = bestLine;
    } else if (bestSpace && bestSpace.index - pos >= minLineDist) {
      chosen = bestSpace;
    } else {
      chosen = bestPara ?? bestLine ?? bestSpace ?? bestAny;
    }

    if (!chosen || chosen.index <= pos) {
      // Fallback guard against pathological tiny maxLen values.
      const fallbackEnd = Math.min(html.length, pos + Math.max(1, maxLen - reopenPrefix.length));
      chunks.push(reopenPrefix + html.slice(pos, fallbackEnd) + closingTagsFor(activeStack));
      pos = fallbackEnd;
      continue;
    }

    const bodySlice = html.slice(pos, chosen.index);
    const closingSuffix = closingTagsFor(chosen.stack);
    chunks.push(reopenPrefix + bodySlice + closingSuffix);
    activeStack = chosen.stack;
    pos = chosen.index;
  }

  return chunks;
}

function formatCompactTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return String(count);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Formats an optional HTML usage/duration/model footer for completed AGY turns.
 */
export function formatUsageFooter(
  usage?: AgyUsage,
  durationSeconds?: number,
  model?: string,
): string {
  const parts: string[] = [];

  if (model) {
    parts.push(`🤖 ${escapeHtml(model)}`);
  }

  if (durationSeconds !== undefined && Number.isFinite(durationSeconds)) {
    parts.push(`⏱ ${formatDuration(durationSeconds)}`);
  }

  if (usage) {
    const tokenParts: string[] = [];
    if (usage.input_tokens > 0) {
      tokenParts.push(`${formatCompactTokens(usage.input_tokens)} in`);
    }
    if (usage.output_tokens > 0) {
      tokenParts.push(`${formatCompactTokens(usage.output_tokens)} out`);
    }
    if (usage.thinking_tokens > 0) {
      tokenParts.push(`${formatCompactTokens(usage.thinking_tokens)} think`);
    }
    if (usage.cache_read_tokens > 0) {
      tokenParts.push(`${formatCompactTokens(usage.cache_read_tokens)} cached`);
    }
    if (tokenParts.length > 0) {
      parts.push(`📊 ${tokenParts.join(' / ')}`);
    } else if (usage.total_tokens > 0) {
      parts.push(`📊 ${formatCompactTokens(usage.total_tokens)} tokens`);
    }
  }

  if (parts.length === 0) {
    return '';
  }

  return `<i>${parts.join(' · ')}</i>`;
}

/**
 * Formats an ISO timestamp or date string into a human-friendly relative time string.
 */
export function formatRelativeTime(isoOrDate: string): string {
  const parsedMs = Date.parse(isoOrDate);
  if (Number.isNaN(parsedMs)) {
    return isoOrDate || 'unknown';
  }

  const diffSeconds = Math.floor((Date.now() - parsedMs) / 1000);
  if (diffSeconds < 0) {
    return 'just now';
  }
  if (diffSeconds < 60) {
    return 'just now';
  }
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) {
    return `${diffDays}d ago`;
  }
  return new Date(parsedMs).toISOString().slice(0, 10);
}

/**
 * Truncates text to at most `maxLen` characters, appending an ellipsis if shortened.
 */
export function truncate(text: string, maxLen: number): string {
  if (maxLen <= 0) {
    return '';
  }
  if (text.length <= maxLen) {
    return text;
  }
  if (maxLen === 1) {
    return '…';
  }
  return `${text.slice(0, maxLen - 1)}…`;
}
