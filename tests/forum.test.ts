import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyCliCommands } from '../src/agy/cli-commands.js';
import type { AgyRunner } from '../src/agy/runner.js';
import { AgyStore } from '../src/agy/store.js';
import { type BotDeps, getThreadId, safeReplyOrEdit } from '../src/bot/context.js';
import { renderDashboard } from '../src/bot/menus/dashboard.js';
import {
  createNewChatTopic,
  createTopicForProject,
  renderForumBindingsList,
  renderForumPanel,
  renderForumProjectPicker,
  syncProjectsToForumTopics,
} from '../src/bot/menus/forum.js';
import type { AppConfig } from '../src/config.js';
import { BotDb } from '../src/db/bot-db.js';

function makeTempConfig(tmpDir: string): AppConfig {
  return {
    botToken: '123456:TEST_TOKEN',
    allowedUserIds: [101],
    agyBin: 'agy',
    geminiDir: path.join(tmpDir, 'gemini'),
    appDataDir: path.join(tmpDir, 'appData'),
    dataDir: path.join(tmpDir, 'data'),
    defaultModel: 'gemini-2.5-pro',
    defaultEffort: 'medium',
    defaultMode: 'auto',
    streamEditIntervalMs: 800,
    maxTurnTimeoutMs: 60_000,
    botLang: 'en',
  };
}

interface MockForumContextOptions {
  chatType?: 'private' | 'group' | 'supergroup';
  isForum?: boolean;
  chatId?: number;
  userId?: number;
  messageThreadId?: number;
  callbackThreadId?: number;
  canManageTopics?: boolean;
  getChatMemberError?: Error;
  createTopicError?: Error;
  editMessageError?: Error;
}

function createForumMockContext(opts: MockForumContextOptions = {}) {
  const chatId = opts.chatId ?? -100777;
  const userId = opts.userId ?? 101;
  const chatType = opts.chatType ?? 'supergroup';

  const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const edits: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const createdTopics: Array<{ chatId: number; name: string; threadId: number }> = [];
  const sentMessages: Array<{
    chatId: number;
    text: string;
    options?: Record<string, unknown>;
  }> = [];

  let nextThreadId = 500;

  const chat =
    chatType === 'supergroup'
      ? {
          id: chatId,
          type: 'supergroup' as const,
          title: 'Test Supergroup',
          ...(opts.isForum !== undefined ? { is_forum: opts.isForum } : {}),
        }
      : {
          id: chatId,
          type: chatType,
        };

  const ctx = {
    from: { id: userId, is_bot: false, first_name: 'Tester' },
    me: { id: 999999, is_bot: true, first_name: 'AgyBot', username: 'agy_test_bot' },
    chat,
    message:
      opts.callbackThreadId === undefined
        ? {
            message_id: 1,
            date: 0,
            chat,
            ...(opts.messageThreadId !== undefined
              ? { message_thread_id: opts.messageThreadId }
              : {}),
          }
        : undefined,
    callbackQuery:
      opts.callbackThreadId !== undefined
        ? {
            id: 'cb-1',
            from: { id: userId, is_bot: false, first_name: 'Tester' },
            chat_instance: 'ci-1',
            data: 'forum:panel',
            message: {
              message_id: 2,
              date: 0,
              chat,
              message_thread_id: opts.callbackThreadId,
            },
          }
        : undefined,
    reply: vi.fn(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return { message_id: 100, chat };
    }),
    editMessageText: vi.fn(async (text: string, options?: Record<string, unknown>) => {
      if (opts.editMessageError) {
        throw opts.editMessageError;
      }
      edits.push({ text, options });
      return true;
    }),
    api: {
      getChatMember: vi.fn(async () => {
        if (opts.getChatMemberError) {
          throw opts.getChatMemberError;
        }
        return {
          status: 'administrator',
          can_manage_topics: opts.canManageTopics ?? true,
        };
      }),
      createForumTopic: vi.fn(async (targetChatId: number, name: string) => {
        if (opts.createTopicError) {
          throw opts.createTopicError;
        }
        const threadId = nextThreadId++;
        createdTopics.push({ chatId: targetChatId, name, threadId });
        return {
          message_thread_id: threadId,
          name,
          icon_color: 0x6fb9f0,
        };
      }),
      sendMessage: vi.fn(
        async (targetChatId: number, text: string, options?: Record<string, unknown>) => {
          sentMessages.push({ chatId: targetChatId, text, options });
          return { message_id: 200, chat };
        },
      ),
    },
  } as unknown as Context;

  return { ctx, replies, edits, createdTopics, sentMessages };
}

describe('Forum Supergroup automation and thread safety', () => {
  let tmpDir: string;
  let config: AppConfig;
  let db: BotDb;
  let store: AgyStore;
  let deps: BotDeps;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-forum-test-'));
    config = makeTempConfig(tmpDir);
    db = new BotDb(':memory:', {
      model: config.defaultModel ?? '',
      effort: config.defaultEffort,
      mode: config.defaultMode,
      lang: 'en',
    });
    store = new AgyStore(config);
    deps = {
      config,
      db,
      store,
      runner: {
        listActiveRuns: () => [],
      } as unknown as AgyRunner,
      cli: {} as unknown as AgyCliCommands,
      lastPrompts: new Map(),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('getThreadId and safeReplyOrEdit preserve message_thread_id across message, callback, and edit fallback', async () => {
    const msgCtx = createForumMockContext({ messageThreadId: 77 });
    expect(getThreadId(msgCtx.ctx)).toBe(77);
    await safeReplyOrEdit(msgCtx.ctx, 'Hello topic');
    expect(msgCtx.replies[0]?.options?.message_thread_id).toBe(77);

    const cbFallbackCtx = createForumMockContext({
      callbackThreadId: 88,
      editMessageError: new Error('message can not be edited'),
    });
    expect(getThreadId(cbFallbackCtx.ctx)).toBe(88);
    await safeReplyOrEdit(cbFallbackCtx.ctx, 'Fallback inside topic', undefined, true);
    expect(cbFallbackCtx.replies[0]?.options?.message_thread_id).toBe(88);
  });

  it('renderForumPanel provides setup guidance when chat is not a forum supergroup', async () => {
    const nonForumSupergroup = createForumMockContext({
      chatType: 'supergroup',
      isForum: false,
    });
    await renderForumPanel(nonForumSupergroup.ctx, deps, false);
    expect(nonForumSupergroup.replies).toHaveLength(1);
    const text = nonForumSupergroup.replies[0].text;
    expect(text).toContain('Telegram Bot API cannot toggle Forum mode itself');
    expect(text).toContain('Group Settings');
    expect(text).toContain('Topics');
    expect(text).toContain('Manage Topics');
    expect(text).toContain('/forum');

    const privateChat = createForumMockContext({ chatType: 'private' });
    await renderForumPanel(privateChat.ctx, deps, false);
    expect(privateChat.replies).toHaveLength(1);
    expect(privateChat.replies[0].text).toContain('/forum');
  });

  it('renderForumPanel checks can_manage_topics, shows counts, and renders forum keyboard', async () => {
    const dirA = path.join(tmpDir, 'proj-a');
    fs.mkdirSync(dirA, { recursive: true });
    const projA = store.createProject('Alpha', dirA);
    store.createProject('Beta', dirA);
    db.upsertTopicBinding({
      chatId: -100777,
      threadId: 12,
      projectId: projA.id,
      conversationId: null,
      label: projA.name,
    });

    const { ctx, replies } = createForumMockContext({
      chatType: 'supergroup',
      isForum: true,
      canManageTopics: true,
    });

    await renderForumPanel(ctx, deps, false);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('Granted');
    expect(replies[0].text).toContain('1 topic(s) (1/2 projects bound)');

    const markup = replies[0].options?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data?: string }>>;
    };
    const callbacks = markup.inline_keyboard.flat().map((btn) => btn.callback_data);
    expect(callbacks).toEqual([
      'forum:sync',
      'forum:pick:0',
      'forum:newchat',
      'forum:list',
      'menu:home',
    ]);
  });

  it('syncProjectsToForumTopics creates topics only for unbound projects, skips already-bound ones, and saves bindings', async () => {
    const dir1 = path.join(tmpDir, 'repo-1');
    const dir2 = path.join(tmpDir, 'repo-2');
    const dir3 = path.join(tmpDir, 'repo-3');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.mkdirSync(dir3, { recursive: true });

    const boundProj = store.createProject('AlreadyBound', dir1);
    const devProj = store.createProject('BackendAPI', dir2);
    const plainProj = store.createProject('DocsSite', dir3);

    // Assign DevOps category (🛠️) to BackendAPI; DocsSite stays default (📁)
    const devOpsCat = db.listCategories().find((c) => c.name === 'DevOps');
    expect(devOpsCat).toBeDefined();
    db.setProjectCategory(devProj.id, devOpsCat!.id);

    // Pre-bind AlreadyBound in this chat
    db.upsertTopicBinding({
      chatId: -100777,
      threadId: 101,
      projectId: boundProj.id,
      conversationId: null,
      label: boundProj.name,
    });

    const upsertSpy = vi.spyOn(db, 'upsertTopicBinding');
    const { ctx, replies, createdTopics, sentMessages } = createForumMockContext({
      chatType: 'supergroup',
      isForum: true,
      chatId: -100777,
    });

    await syncProjectsToForumTopics(ctx, deps);

    expect(createdTopics).toHaveLength(2);
    expect(createdTopics.map((t) => t.name)).toEqual([
      '🛠️ BackendAPI',
      '📁 DocsSite',
    ]);

    expect(upsertSpy).toHaveBeenCalledTimes(2);
    expect(upsertSpy).toHaveBeenCalledWith({
      chatId: -100777,
      threadId: 500,
      projectId: devProj.id,
      conversationId: null,
      label: 'BackendAPI',
    });
    expect(upsertSpy).toHaveBeenCalledWith({
      chatId: -100777,
      threadId: 501,
      projectId: plainProj.id,
      conversationId: null,
      label: 'DocsSite',
    });

    // Welcome cards sent inside each created topic
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0].options?.message_thread_id).toBe(500);
    expect(sentMessages[0].text).toContain('BackendAPI');
    expect(sentMessages[0].text).toContain(dir2);
    expect(sentMessages[1].options?.message_thread_id).toBe(501);
    expect(sentMessages[1].text).toContain('DocsSite');
    expect(sentMessages[1].text).toContain(dir3);

    // Summary reply
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('Created:</b> 2');
    expect(replies[0].text).toContain('Already bound:</b> 1');
  });

  it('syncProjectsToForumTopics reports missing Manage Topics permission gracefully', async () => {
    const dir = path.join(tmpDir, 'perm-repo');
    fs.mkdirSync(dir, { recursive: true });
    store.createProject('PermProj', dir);

    const { ctx, replies } = createForumMockContext({
      chatType: 'supergroup',
      isForum: true,
      createTopicError: new Error('Bad Request: not enough rights to create a topic'),
    });

    await syncProjectsToForumTopics(ctx, deps);

    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain('Created:</b> 0');
    expect(replies[0].text).toContain('Missing Permission');
    expect(replies[0].text).toContain('Manage Topics');
  });

  it('supports createTopicForProject, createNewChatTopic, renderForumBindingsList, renderForumProjectPicker, and dashboard Forum button', async () => {
    const dir = path.join(tmpDir, 'single-repo');
    fs.mkdirSync(dir, { recursive: true });
    const proj = store.createProject('SingleProj', dir);
    db.updateSession(101, { activeProjectId: proj.id });

    const { ctx, createdTopics, sentMessages, replies } = createForumMockContext({
      chatType: 'supergroup',
      isForum: true,
      chatId: -100777,
    });

    await createTopicForProject(ctx, deps, proj.id);
    expect(createdTopics[0]?.name).toBe('📁 SingleProj');
    expect(db.getTopicBinding(-100777, 500)?.projectId).toBe(proj.id);
    expect(sentMessages[0]?.options?.message_thread_id).toBe(500);

    await createNewChatTopic(ctx, deps);
    expect(createdTopics[1]?.name).toBe('💬 SingleProj · New Chat');
    expect(db.getTopicBinding(-100777, 501)?.projectId).toBe(proj.id);

    await renderForumBindingsList(ctx, deps, false);
    expect(replies.some((r) => r.text.includes('Bound Forum Topics (2)'))).toBe(true);

    await renderForumProjectPicker(ctx, deps, 0, false);
    expect(replies.some((r) => r.text.includes('Create Topic for Project'))).toBe(true);

    // Dashboard shows Forum button in supergroup, omits it in private chat
    await renderDashboard(ctx, deps, false);
    const supergroupDash = replies[replies.length - 1];
    const supergroupCallbacks = (
      supergroupDash.options?.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
      }
    ).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(supergroupCallbacks).toContain('forum:panel');

    const privateDashCtx = createForumMockContext({ chatType: 'private' });
    await renderDashboard(privateDashCtx.ctx, deps, false);
    const privateCallbacks = (
      privateDashCtx.replies[0].options?.reply_markup as {
        inline_keyboard: Array<Array<{ callback_data?: string }>>;
      }
    ).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(privateCallbacks).not.toContain('forum:panel');
  });
});
