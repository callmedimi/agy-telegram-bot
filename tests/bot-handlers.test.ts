import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from 'grammy';
import { Bot } from 'grammy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyCliCommands } from '../src/agy/cli-commands.js';
import type { AgyRunner } from '../src/agy/runner.js';
import { AgyStore } from '../src/agy/store.js';
import type { AgyResultEvent, AgyRunOptions } from '../src/agy/types.js';
import type { BotDeps } from '../src/bot/context.js';
import type { AppConfig } from '../src/config.js';
import { BotDb } from '../src/db/bot-db.js';

const mockMenus = vi.hoisted(() => ({
  registerMenuCallbacks: vi.fn(),
  renderDashboard: vi.fn(async () => {}),
  renderForumPanel: vi.fn(async () => {}),
  renderProjectsMenu: vi.fn(async () => {}),
  renderCategoriesMenu: vi.fn(async () => {}),
  renderChatsMenu: vi.fn(async () => {}),
  renderSettingsMenu: vi.fn(async () => {}),
  renderModelsMenu: vi.fn(async () => {}),
  renderToolsMenu: vi.fn(async () => {}),
  renderMcpMenu: vi.fn(async () => {}),
  renderSkillsMenu: vi.fn(async () => {}),
  renderPluginsMenu: vi.fn(async () => {}),
  renderStatusView: vi.fn(async () => {}),
  sendArtifactsList: vi.fn(async () => {}),
  sendTranscriptView: vi.fn(async () => {}),
  sendSearchResults: vi.fn(async () => {}),
  syncProjectsToForumTopics: vi.fn(async () => {}),
}));

vi.mock('../src/bot/menus/index.js', () => mockMenus);

import { BOT_COMMANDS, registerCommands } from '../src/bot/commands.js';
import {
  executePrompt,
  handlePendingInput,
  registerMessageHandlers,
} from '../src/bot/handlers/messages.js';
import { createBotApp } from '../src/index.js';

class MockRunHandle extends EventEmitter {
  readonly runId = 'run-test-1';
  conversationId?: string;
}

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

function createMockContext(overrides: {
  userId?: number;
  chatId?: number;
  threadId?: number;
  text?: string;
  match?: string;
} = {}): {
  ctx: Context;
  replies: Array<{ text: string; options?: Record<string, unknown> }>;
  photos: Array<{ file: unknown; options?: Record<string, unknown> }>;
  docs: Array<{ file: unknown; options?: Record<string, unknown> }>;
  edits: Array<{ text: string; options?: Record<string, unknown> }>;
  answeredCallbacks: Array<unknown>;
} {
  const replies: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const photos: Array<{ file: unknown; options?: Record<string, unknown> }> = [];
  const docs: Array<{ file: unknown; options?: Record<string, unknown> }> = [];
  const edits: Array<{ text: string; options?: Record<string, unknown> }> = [];
  const answeredCallbacks: Array<unknown> = [];

  const chatId = overrides.chatId ?? 999;
  const userId = overrides.userId ?? 101;
  let nextMsgId = 10;

  const ctx = {
    from: { id: userId, is_bot: false, first_name: 'Tester' },
    chat: { id: chatId, type: 'supergroup' },
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: 'supergroup' },
      text: overrides.text,
      ...(overrides.threadId !== undefined ? { message_thread_id: overrides.threadId } : {}),
    },
    msg: {
      message_id: 1,
      ...(overrides.threadId !== undefined ? { message_thread_id: overrides.threadId } : {}),
    },
    match: overrides.match ?? '',
    reply: vi.fn(async (text: string, options?: Record<string, unknown>) => {
      replies.push({ text, options });
      return {
        message_id: nextMsgId++,
        chat: { id: chatId },
      };
    }),
    replyWithPhoto: vi.fn(async (file: unknown, options?: Record<string, unknown>) => {
      photos.push({ file, options });
      return { message_id: nextMsgId++, chat: { id: chatId } };
    }),
    replyWithDocument: vi.fn(async (file: unknown, options?: Record<string, unknown>) => {
      docs.push({ file, options });
      return { message_id: nextMsgId++, chat: { id: chatId } };
    }),
    answerCallbackQuery: vi.fn(async (arg?: unknown) => {
      answeredCallbacks.push(arg);
      return true;
    }),
    api: {
      editMessageText: vi.fn(
        async (_chatId: number, _messageId: number, text: string, options?: Record<string, unknown>) => {
          edits.push({ text, options });
          return true;
        },
      ),
      sendMessage: vi.fn(async () => ({ message_id: nextMsgId++, chat: { id: chatId } })),
    },
  } as unknown as Context;

  return { ctx, replies, photos, docs, edits, answeredCallbacks };
}

describe('bot handlers, commands, and app wiring', () => {
  let tmpDir: string;
  let config: AppConfig;
  let db: BotDb;
  let store: AgyStore;
  let runCalls: AgyRunOptions[];
  let activeHandles: MockRunHandle[];
  let abortAllCount: number;
  let addMcpCalls: Array<unknown>;
  let deps: BotDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-bot-handlers-'));
    config = makeTempConfig(tmpDir);
    db = new BotDb(':memory:', {
      model: config.defaultModel ?? '',
      effort: config.defaultEffort,
      mode: config.defaultMode,
      lang: 'en',
    });
    store = new AgyStore(config);
    runCalls = [];
    activeHandles = [];
    abortAllCount = 0;
    addMcpCalls = [];

    const runner = {
      run: vi.fn((opts: AgyRunOptions) => {
        runCalls.push(opts);
        const handle = new MockRunHandle();
        activeHandles.push(handle);
        return handle;
      }),
      abortAll: vi.fn(() => abortAllCount),
    } as unknown as AgyRunner;

    const cli = {
      addMcpServer: vi.fn(async (args: unknown) => {
        addMcpCalls.push(args);
        return 'Server added';
      }),
    } as unknown as AgyCliCommands;

    deps = {
      config,
      db,
      store,
      runner,
      cli,
      lastPrompts: new Map(),
    };
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handles all pendingInput actions and expires stale pendingInput', async () => {
    const { ctx, replies } = createMockContext();

    // No pending input
    expect(await handlePendingInput(ctx, deps, 'hello')).toBe(false);

    // Expired pending input (> 10 minutes)
    db.setPendingInput(101, {
      action: 'cat:new',
      createdAt: Date.now() - 11 * 60 * 1000,
    });
    expect(await handlePendingInput(ctx, deps, 'Stale')).toBe(false);
    expect(db.getSession(101).pendingInput).toBeNull();

    // cat:new with emoji
    db.setPendingInput(101, { action: 'cat:new', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, '🚀 Startup Ideas')).toBe(true);
    const cats = db.listCategories();
    expect(cats.some((c) => c.emoji === '🚀' && c.name === 'Startup Ideas')).toBe(true);
    expect(mockMenus.renderCategoriesMenu).toHaveBeenCalledWith(ctx, deps, false);

    // proj:new with path
    const projPath = path.join(tmpDir, 'my-repo');
    fs.mkdirSync(projPath, { recursive: true });
    db.setPendingInput(101, { action: 'proj:new', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, `MyApp | ${projPath}`)).toBe(true);
    const createdProj = store.getProject('MyApp');
    expect(createdProj).not.toBeNull();
    expect(createdProj?.paths).toEqual([projPath]);
    expect(db.getSession(101).activeProjectId).toBe(createdProj?.id);
    expect(mockMenus.renderProjectsMenu).toHaveBeenCalledWith(ctx, deps, { edit: false });

    // proj:adddir
    const extraPath = path.join(tmpDir, 'extra-repo');
    fs.mkdirSync(extraPath, { recursive: true });
    db.setPendingInput(101, {
      action: 'proj:adddir',
      payload: { projectId: createdProj!.id },
      createdAt: Date.now(),
    });
    expect(await handlePendingInput(ctx, deps, extraPath)).toBe(true);
    expect(store.getProject(createdProj!.id)?.paths).toEqual([projPath, extraPath]);

    // chat:rename
    db.setPendingInput(101, {
      action: 'chat:rename',
      payload: { conversationId: 'conv-123' },
      createdAt: Date.now(),
    });
    expect(await handlePendingInput(ctx, deps, 'Sprint Review')).toBe(true);
    expect(db.getChatMeta('conv-123')?.customTitle).toBe('Sprint Review');
    expect(mockMenus.renderChatsMenu).toHaveBeenCalledWith(ctx, deps, { edit: false });

    // chat:search
    db.setPendingInput(101, { action: 'chat:search', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, 'sqlite')).toBe(true);
    expect(mockMenus.sendSearchResults).toHaveBeenCalledWith(ctx, deps, 'sqlite');

    // skill:search
    db.setPendingInput(101, { action: 'skill:search', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, 'vitest')).toBe(true);
    expect(mockMenus.renderSkillsMenu).toHaveBeenCalledWith(ctx, deps, {
      query: 'vitest',
      page: 0,
      edit: false,
    });

    // skill:use
    db.setPendingInput(101, {
      action: 'skill:use',
      payload: { skillName: 'tdd' },
      createdAt: Date.now(),
    });
    const skillUsePromise = handlePendingInput(ctx, deps, 'Write tests for auth');
    await vi.waitFor(() => {
      expect(runCalls.some((r) => r.prompt.includes('tdd') && r.prompt.includes('Write tests for auth'))).toBe(true);
    });
    activeHandles[activeHandles.length - 1].emit('result', {
      conversation_id: 'conv-skill',
      status: 'success',
      response: 'Done!',
    });
    expect(await skillUsePromise).toBe(true);

    // mcp:add (http and stdio)
    db.setPendingInput(101, { action: 'mcp:add', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, 'docs https://example.com/mcp')).toBe(true);
    db.setPendingInput(101, { action: 'mcp:add', createdAt: Date.now() });
    expect(await handlePendingInput(ctx, deps, 'fs npx -y @mcp/server-fs /tmp')).toBe(true);
    expect(addMcpCalls).toEqual([
      { name: 'docs', type: 'http', target: 'https://example.com/mcp' },
      { name: 'fs', type: 'stdio', target: 'npx', extraArgs: ['-y', '@mcp/server-fs', '/tmp'] },
    ]);
    expect(replies.some((r) => r.text.includes('Added MCP server'))).toBe(true);
  });

  it('executePrompt respects Forum Topic bindings, updates state, and auto-sends up to 3 new artifacts', async () => {
    const repoDir = path.join(tmpDir, 'topic-repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const project = store.createProject('TopicProj', repoDir);

    // Pre-existing artifact that should NOT be re-sent
    const convId = 'conv-topic-1';
    const brainDir = path.join(config.appDataDir, 'brain', convId);
    fs.mkdirSync(brainDir, { recursive: true });
    const oldFile = path.join(brainDir, 'old.txt');
    fs.writeFileSync(oldFile, 'old content');
    const pastTime = new Date(Date.now() - 60_000);
    fs.utimesSync(oldFile, pastTime, pastTime);

    db.upsertTopicBinding({
      chatId: -1001,
      threadId: 77,
      projectId: project.id,
      conversationId: convId,
      label: project.name,
    });

    const { ctx, photos, docs } = createMockContext({
      chatId: -1001,
      threadId: 77,
    });

    const runPromise = executePrompt(ctx, deps, 'Generate report and diagram');
    await vi.waitFor(() => {
      expect(activeHandles).toHaveLength(1);
    });

    expect(runCalls[0]).toMatchObject({
      prompt: 'Generate report and diagram',
      conversationId: convId,
      cwd: repoDir,
      model: 'gemini-2.5-pro',
      effort: 'medium',
      mode: 'auto',
    });
    expect(deps.lastPrompts.get(101)).toBe('Generate report and diagram');

    // Create 4 new artifacts during the turn (1 image, 3 docs) -> max 3 sent
    fs.writeFileSync(path.join(brainDir, 'chart.png'), 'PNGDATA');
    fs.writeFileSync(path.join(brainDir, 'report1.md'), '# 1');
    fs.writeFileSync(path.join(brainDir, 'report2.md'), '# 2');
    fs.writeFileSync(path.join(brainDir, 'report3.md'), '# 3');

    const result: AgyResultEvent['result'] = {
      conversation_id: convId,
      status: 'success',
      response: 'Done!',
    };
    activeHandles[0].emit('result', result);
    await runPromise;

    expect(db.getSession(101).activeConversationId).toBe(convId);
    expect(db.getTopicBinding(-1001, 77)?.conversationId).toBe(convId);
    expect(photos.length + docs.length).toBe(3);
  });

  it('registers all 22 BOT_COMMANDS and handles /new, /mode, /effort, /plan, /forum, /topic, /stop', async () => {
    expect(BOT_COMMANDS).toHaveLength(22);

    const bot = new Bot('123456:TEST_TOKEN');
    bot.botInfo = {
      id: 1,
      is_bot: true,
      first_name: 'AgyBot',
      username: 'agy_test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };

    // Spy on command registration via real grammY handleUpdate with mocked fetch
    registerCommands(bot, deps);
    registerMessageHandlers(bot, deps);

    const projectDir = path.join(tmpDir, 'cmd-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const project = store.createProject('CmdProj', projectDir);

    const apiCalls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    bot.api.config.use(async (_prev, method, payload) => {
      apiCalls.push({ method, payload: payload as Record<string, unknown> });
      return {
        ok: true,
        result: {
          message_id: apiCalls.length + 100,
          date: 0,
          chat: { id: 101, type: 'private' },
        },
      } as never;
    });

    // /mode plan
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: 101, type: 'private' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/mode plan',
        entities: [{ offset: 0, length: 5, type: 'bot_command' }],
      },
    });
    expect(db.getSession(101).mode).toBe('plan');

    // /effort xhigh
    await bot.handleUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: 101, type: 'private' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/effort xhigh',
        entities: [{ offset: 0, length: 7, type: 'bot_command' }],
      },
    });
    expect(db.getSession(101).effort).toBe('xhigh');

    // /topic bind CmdProj
    await bot.handleUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        date: 0,
        chat: { id: -500, type: 'supergroup' },
        message_thread_id: 42,
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/topic bind CmdProj',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });
    expect(db.getTopicBinding(-500, 42)?.projectId).toBe(project.id);

    // /forum
    await bot.handleUpdate({
      update_id: 31,
      message: {
        message_id: 31,
        date: 0,
        chat: { id: -500, type: 'supergroup' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/forum',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });
    expect(mockMenus.renderForumPanel).toHaveBeenCalledTimes(1);

    // /topic sync
    await bot.handleUpdate({
      update_id: 32,
      message: {
        message_id: 32,
        date: 0,
        chat: { id: -500, type: 'supergroup' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/topic sync',
        entities: [{ offset: 0, length: 6, type: 'bot_command' }],
      },
    });
    expect(mockMenus.syncProjectsToForumTopics).toHaveBeenCalledTimes(1);

    // /stop
    abortAllCount = 2;
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 4,
        date: 0,
        chat: { id: 101, type: 'private' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/stop',
        entities: [{ offset: 0, length: 5, type: 'bot_command' }],
      },
    });
    expect(
      apiCalls.some(
        (c) => c.method === 'sendMessage' && String(c.payload.text).includes('Stopped 2 active runs'),
      ),
    ).toBe(true);

    // Unknown slash command (/compact) forwarded to agy
    const compactPromise = bot.handleUpdate({
      update_id: 5,
      message: {
        message_id: 5,
        date: 0,
        chat: { id: 101, type: 'private' },
        from: { id: 101, is_bot: false, first_name: 'U' },
        text: '/compact',
        entities: [{ offset: 0, length: 8, type: 'bot_command' }],
      },
    });
    await vi.waitFor(() => {
      expect(runCalls.some((r) => r.prompt === '/compact')).toBe(true);
    });
    activeHandles[0].emit('result', {
      conversation_id: 'conv-compact',
      status: 'success',
      response: 'Compacted!',
    });
    await compactPromise;

    // run:retry callback query re-runs last prompt
    deps.lastPrompts.set(101, 'Retry me please');
    const retryPromise = bot.handleUpdate({
      update_id: 6,
      callback_query: {
        id: 'cb-retry-1',
        from: { id: 101, is_bot: false, first_name: 'U' },
        chat_instance: 'ci-1',
        data: 'run:retry',
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 101, type: 'private' },
        },
      },
    });
    await vi.waitFor(() => {
      expect(runCalls.some((r) => r.prompt === 'Retry me please')).toBe(true);
    });
    activeHandles[activeHandles.length - 1].emit('result', {
      conversation_id: 'conv-retry',
      status: 'success',
      response: 'Retried!',
    });
    await retryPromise;
  });

  it('createBotApp builds bot and deps without starting polling', () => {
    const app = createBotApp(config);
    try {
      expect(app.bot).toBeInstanceOf(Bot);
      expect(app.deps.config).toBe(config);
      expect(app.dbPath).toBe(path.join(config.dataDir, 'bot.db'));
      expect(mockMenus.registerMenuCallbacks).toHaveBeenCalledWith(app.bot, app.deps);
    } finally {
      app.deps.db.close();
    }
  });
});
