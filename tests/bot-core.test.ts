import { EventEmitter } from 'node:events';
import type { Context } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgyInitEvent, AgyResultEvent } from '../src/agy/types.js';
import {
  chunkTelegramHtml,
  escapeHtml,
  formatRelativeTime,
  formatUsageFooter,
  markdownToTelegramHtml,
  truncate,
} from '../src/bot/formatters.js';
import { createAuthMiddleware } from '../src/bot/middleware.js';
import { streamAgyResponse, type StreamableRunHandle } from '../src/bot/streamer.js';
import { BotDb } from '../src/db/bot-db.js';

const DEFAULT_DB_DEFAULTS = {
  model: 'gemini-2.5-pro',
  effort: 'medium' as const,
  mode: 'auto' as const,
  lang: 'en' as const,
};

describe('BotDb', () => {
  const dbs: BotDb[] = [];

  function createTestDb(): BotDb {
    const db = new BotDb(':memory:', DEFAULT_DB_DEFAULTS);
    dbs.push(db);
    return db;
  }

  afterEach(() => {
    while (dbs.length > 0) {
      dbs.pop()?.close();
    }
  });

  it('seeds default categories on initialization', () => {
    const db = createTestDb();
    const categories = db.listCategories();
    expect(categories).toHaveLength(4);
    expect(categories.map((c) => [c.name, c.emoji])).toEqual([
      ['Work', '💼'],
      ['Personal', '🏠'],
      ['DevOps', '🛠️'],
      ['Research', '🔬'],
    ]);
  });

  it('supports category CRUD and clears foreign keys on delete', () => {
    const db = createTestDb();
    const created = db.createCategory('ClientX', '🚀');
    expect(created.name).toBe('ClientX');
    expect(created.emoji).toBe('🚀');
    expect(db.getCategory(created.id)).toEqual(created);

    const renamed = db.renameCategory(created.id, 'ClientY', '⚡');
    expect(renamed?.name).toBe('ClientY');
    expect(renamed?.emoji).toBe('⚡');

    db.setProjectCategory('proj-1', created.id);
    db.setChatCategory('conv-1', created.id);
    expect(db.getProjectMeta('proj-1')?.categoryId).toBe(created.id);
    expect(db.getChatMeta('conv-1')?.categoryId).toBe(created.id);

    expect(db.deleteCategory(created.id)).toBe(true);
    expect(db.getCategory(created.id)).toBeNull();
    expect(db.getProjectMeta('proj-1')?.categoryId).toBeNull();
    expect(db.getChatMeta('conv-1')?.categoryId).toBeNull();
    expect(db.deleteCategory(created.id)).toBe(false);
  });

  it('supports project metadata CRUD, pinning, alias, and defaults patch', () => {
    const db = createTestDb();
    expect(db.getProjectMeta('proj-a')).toBeNull();

    const pinned = db.toggleProjectPin('proj-a');
    expect(pinned.pinned).toBe(true);

    db.setProjectAlias('proj-a', 'Alpha');
    db.setProjectDefaults('proj-a', {
      notes: 'Main repo',
      defaultModel: 'claude-sonnet',
      defaultEffort: 'high',
      defaultMode: 'accept-edits',
    });

    // Partial patch should preserve existing fields
    const updated = db.setProjectDefaults('proj-a', { notes: 'Updated repo' });
    expect(updated.alias).toBe('Alpha');
    expect(updated.pinned).toBe(true);
    expect(updated.notes).toBe('Updated repo');
    expect(updated.defaultModel).toBe('claude-sonnet');
    expect(updated.defaultEffort).toBe('high');
    expect(updated.defaultMode).toBe('accept-edits');

    const unpinned = db.toggleProjectPin('proj-a');
    expect(unpinned.pinned).toBe(false);
    expect(db.listAllProjectMeta()).toHaveLength(1);
  });

  it('supports chat metadata CRUD, pinning, archiving, and tags', () => {
    const db = createTestDb();
    db.setChatTitle('conv-1', 'Release Plan');
    db.toggleChatPin('conv-1');
    db.toggleChatArchive('conv-1');
    db.addChatTag('conv-1', 'urgent');
    db.addChatTag('conv-1', 'urgent'); // duplicate ignored
    db.addChatTag('conv-1', 'backend');

    let meta = db.getChatMeta('conv-1');
    expect(meta?.customTitle).toBe('Release Plan');
    expect(meta?.pinned).toBe(true);
    expect(meta?.archived).toBe(true);
    expect(meta?.tags).toEqual(['urgent', 'backend']);

    meta = db.removeChatTag('conv-1', 'urgent');
    expect(meta.tags).toEqual(['backend']);
    expect(db.listAllChatMeta()).toHaveLength(1);
  });

  it('supports topic bindings upsert, list, and delete', () => {
    const db = createTestDb();
    const binding = db.upsertTopicBinding({
      chatId: -100123,
      threadId: 42,
      projectId: 'proj-1',
      label: 'Backend Topic',
    });
    expect(binding.projectId).toBe('proj-1');
    expect(binding.conversationId).toBeNull();
    expect(binding.label).toBe('Backend Topic');

    const updated = db.upsertTopicBinding({
      chatId: -100123,
      threadId: 42,
      conversationId: 'conv-99',
    });
    expect(updated.projectId).toBe('proj-1');
    expect(updated.conversationId).toBe('conv-99');
    expect(updated.label).toBe('Backend Topic');

    expect(db.listTopicBindings(-100123)).toHaveLength(1);
    expect(db.listTopicBindings(-999)).toHaveLength(0);
    expect(db.deleteTopicBinding(-100123, 42)).toBe(true);
    expect(db.getTopicBinding(-100123, 42)).toBeNull();
  });

  it('auto-creates and updates user sessions, pending input, and stats', () => {
    const db = createTestDb();
    const session = db.getSession(1001);
    expect(session.userId).toBe(1001);
    expect(session.model).toBe('gemini-2.5-pro');
    expect(session.effort).toBe('medium');
    expect(session.mode).toBe('auto');
    expect(session.lang).toBe('en');
    expect(session.showTools).toBe(true);
    expect(session.showUsage).toBe(true);
    expect(session.autoSendArtifacts).toBe(true);
    expect(session.sandbox).toBe(false);
    expect(session.skipPermissions).toBe(false);
    expect(session.pendingInput).toBeNull();

    const updated = db.updateSession(1001, {
      activeProjectId: 'proj-1',
      activeConversationId: 'conv-1',
      effort: 'xhigh',
      sandbox: true,
      lang: 'fa',
    });
    expect(updated.activeProjectId).toBe('proj-1');
    expect(updated.effort).toBe('xhigh');
    expect(updated.sandbox).toBe(true);
    expect(updated.lang).toBe('fa');

    db.setPendingInput(1001, {
      action: 'rename_chat',
      payload: { conversationId: 'conv-1' },
      createdAt: 123456,
    });
    expect(db.getSession(1001).pendingInput?.action).toBe('rename_chat');

    db.clearPendingInput(1001);
    expect(db.getSession(1001).pendingInput).toBeNull();

    db.toggleProjectPin('proj-1');
    db.toggleChatPin('conv-1');
    db.upsertTopicBinding({ chatId: -100, threadId: 7, projectId: 'proj-1' });

    expect(db.getStats()).toEqual({
      categories: 4,
      pinnedProjects: 1,
      pinnedChats: 1,
      topicBindings: 1,
      users: 1,
    });
  });
});

describe('formatters', () => {
  it('escapes HTML entities', () => {
    expect(escapeHtml('<script>a & b</script>')).toBe(
      '&lt;script&gt;a &amp; b&lt;/script&gt;',
    );
  });

  it('converts markdown code blocks, inline code, bold, italic, headings, and links to Telegram HTML', () => {
    const md = [
      '# Title <One>',
      '',
      'Some **bold** and *italic* text with `x < y & z` and [Docs](https://example.com?a=1&b=2).',
      '',
      '```ts',
      'const a = 1 < 2 && "**not bold**";',
      '```',
    ].join('\n');

    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<b>Title &lt;One&gt;</b>');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>italic</i>');
    expect(html).toContain('<code>x &lt; y &amp; z</code>');
    expect(html).toContain('<a href="https://example.com?a=1&amp;b=2">Docs</a>');
    expect(html).toContain(
      '<pre><code class="language-ts">const a = 1 &lt; 2 &amp;&amp; "**not bold**";</code></pre>',
    );
  });

  it('chunks long plain/HTML text within maxLen on boundaries', () => {
    const para1 = 'Alpha '.repeat(40).trim();
    const para2 = 'Beta '.repeat(40).trim();
    const para3 = 'Gamma '.repeat(40).trim();
    const full = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = chunkTelegramHtml(full, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
    expect(chunks.join('')).toBe(full);
  });

  it('splits long <pre><code> blocks cleanly with balanced closing and reopening tags', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `const line_${i} = ${i};`).join('\n');
    const html = `<pre><code class="language-ts">${lines}</code></pre>`;

    const chunks = chunkTelegramHtml(html, 200);
    expect(chunks.length).toBeGreaterThan(2);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
      expect(chunk.startsWith('<pre><code class="language-ts">')).toBe(true);
      expect(chunk.endsWith('</code></pre>')).toBe(true);
    }

    const innerCombined = chunks
      .map((c) =>
        c
          .replace(/^<pre><code class="language-ts">/, '')
          .replace(/<\/code><\/pre>$/, ''),
      )
      .join('');
    expect(innerCombined).toBe(lines);
  });

  it('formats usage footer, relative time, and truncation', () => {
    const footer = formatUsageFooter(
      {
        input_tokens: 1500,
        output_tokens: 320,
        thinking_tokens: 0,
        cache_read_tokens: 500,
        total_tokens: 2320,
      },
      4.25,
      'gemini-2.5-pro',
    );
    expect(footer).toContain('gemini-2.5-pro');
    expect(footer).toContain('4.3s');
    expect(footer).toContain('1.5k in / 320 out / 500 cached');

    const twoMinutesAgo = new Date(Date.now() - 125_000).toISOString();
    expect(formatRelativeTime(twoMinutesAgo)).toBe('2m ago');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
  });
});

describe('createAuthMiddleware', () => {
  function makeMockCtx(opts: { userId?: number; chatType?: string }) {
    const reply = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      from: opts.userId !== undefined ? { id: opts.userId } : undefined,
      chat: opts.chatType !== undefined ? { id: 1, type: opts.chatType } : undefined,
      reply,
    } as unknown as Context;
    return { ctx, reply };
  }

  it('allows listed users and calls next', async () => {
    const mw = createAuthMiddleware([111, 222]);
    const { ctx, reply } = makeMockCtx({ userId: 222, chatType: 'private' });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it('blocks unlisted users in private chat with access denied message', async () => {
    const mw = createAuthMiddleware([111]);
    const { ctx, reply } = makeMockCtx({ userId: 99999, chatType: 'private' });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toContain('Access denied');
    expect(reply.mock.calls[0][0]).toContain('99999');
  });

  it('silently ignores unlisted users in group chats', async () => {
    const mw = createAuthMiddleware([111]);
    const { ctx, reply } = makeMockCtx({ userId: 99999, chatType: 'supergroup' });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(ctx, next);
    expect(next).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it('allows all users when allowedUserIds is empty', async () => {
    const mw = createAuthMiddleware([]);
    const { ctx } = makeMockCtx({ userId: 555, chatType: 'private' });
    const next = vi.fn().mockResolvedValue(undefined);

    await mw(ctx, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('streamAgyResponse', () => {
  class MockRunHandle extends EventEmitter implements StreamableRunHandle {
    readonly runId = 'run-123';
    conversationId?: string;
  }

  it('sends initial message and updates with formatted final result and action keyboard', async () => {
    const handle = new MockRunHandle();
    const editMessageText = vi.fn().mockResolvedValue(true);
    const sendMessage = vi.fn().mockResolvedValue({ chat: { id: 10 }, message_id: 2 });
    const reply = vi.fn().mockResolvedValue({ chat: { id: 10 }, message_id: 1 });
    const onComplete = vi.fn();

    const ctx = {
      reply,
      api: {
        editMessageText,
        sendMessage,
      },
    } as unknown as Context;

    const promise = streamAgyResponse({
      ctx,
      handle,
      editIntervalMs: 800,
      showTools: true,
      showUsage: true,
      model: 'gemini-2.5-pro',
      threadId: 77,
      onComplete,
    });

    // Wait microtask for initial reply
    await Promise.resolve();
    expect(reply).toHaveBeenCalledWith(
      '⚡ <i>Connecting to AGY...</i>',
      expect.objectContaining({
        parse_mode: 'HTML',
        message_thread_id: 77,
      }),
    );

    const initEv: AgyInitEvent = {
      event: 'init',
      conversation_id: 'conv-abc',
      init: {
        model: 'gemini-2.5-pro',
        cwd: '/tmp',
        tools: [],
        permission_mode: 'auto',
      },
    };
    handle.emit('init', initEv);
    handle.emit('text_delta', 'Hello **world**');

    const resultPayload: AgyResultEvent['result'] = {
      conversation_id: 'conv-abc',
      status: 'completed',
      response: 'Hello **world**',
      duration_seconds: 1.5,
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        thinking_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 120,
      },
    };
    handle.emit('result', resultPayload);

    const res = await promise;
    expect(res).toEqual(resultPayload);
    expect(onComplete).toHaveBeenCalledWith(resultPayload);
    expect(editMessageText).toHaveBeenCalled();
    const lastEditCall = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(lastEditCall[2]).toContain('Hello <b>world</b>');
    expect(lastEditCall[2]).toContain('100 in / 20 out');
  });

  it('handles aborted and error states cleanly', async () => {
    const handle = new MockRunHandle();
    const editMessageText = vi.fn().mockResolvedValue(true);
    const reply = vi.fn().mockResolvedValue({ chat: { id: 10 }, message_id: 1 });

    const ctx = {
      reply,
      api: { editMessageText, sendMessage: vi.fn() },
    } as unknown as Context;

    const promise = streamAgyResponse({
      ctx,
      handle,
      editIntervalMs: 800,
      showTools: false,
      showUsage: false,
    });

    await Promise.resolve();
    handle.emit('text_delta', 'Partial text');
    handle.emit('aborted');

    const res = await promise;
    expect(res).toBeNull();
    const lastEditCall = editMessageText.mock.calls[editMessageText.mock.calls.length - 1];
    expect(lastEditCall[2]).toContain('Partial text');
    expect(lastEditCall[2]).toContain('Stopped by user');
  });
});
