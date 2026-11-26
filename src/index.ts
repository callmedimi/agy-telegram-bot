import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bot } from 'grammy';
import { AgyCliCommands } from './agy/cli-commands.js';
import { AgyRunner } from './agy/runner.js';
import { AgyStore } from './agy/store.js';
import { BOT_COMMANDS, registerCommands } from './bot/commands.js';
import type { BotDeps } from './bot/context.js';
import { registerMessageHandlers } from './bot/handlers/messages.js';
import { registerMenuCallbacks } from './bot/menus/index.js';
import { createAuthMiddleware, createErrorHandler } from './bot/middleware.js';
import { type AppConfig, loadConfig } from './config.js';
import { BotDb } from './db/bot-db.js';

export interface BotApp {
  bot: Bot;
  deps: BotDeps;
  dbPath: string;
}

/**
 * Instantiates all services, database connections, middleware, commands, menus,
 * and message handlers without calling `bot.start()`.
 */
export function createBotApp(config: AppConfig): BotApp {
  const dbPath = path.join(config.dataDir, 'bot.db');
  const db = new BotDb(dbPath, {
    model: config.defaultModel ?? '',
    effort: config.defaultEffort,
    mode: config.defaultMode,
    lang: config.botLang === 'fa' ? 'fa' : 'en',
  });
  const store = new AgyStore(config);
  const runner = new AgyRunner(config);
  const cli = new AgyCliCommands(config);
  const lastPrompts = new Map<number, string>();

  const deps: BotDeps = {
    config,
    db,
    store,
    runner,
    cli,
    lastPrompts,
  };

  const bot = new Bot(config.botToken);
  bot.use(createAuthMiddleware(config.allowedUserIds));
  bot.catch(createErrorHandler());

  registerCommands(bot, deps);
  registerMenuCallbacks(bot, deps);
  registerMessageHandlers(bot, deps);

  return { bot, deps, dbPath };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { bot, deps, dbPath } = createBotApp(config);

  try {
    await bot.api.setMyCommands([...BOT_COMMANDS]);
  } catch (err) {
    console.warn('[startup] Failed to register Telegram bot commands:', err);
  }

  const allowedDisplay =
    config.allowedUserIds.length > 0 ? config.allowedUserIds.join(', ') : 'ALL (unrestricted)';

  console.log('========================================');
  console.log('  Antigravity Telegram Bot');
  console.log(`  Allowed users : ${allowedDisplay}`);
  console.log(`  agy binary    : ${config.agyBin}`);
  console.log(`  Bot database  : ${dbPath}`);
  console.log('========================================');

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`\n[shutdown] Received ${signal}, stopping...`);

    try {
      const aborted = deps.runner.abortAll();
      if (aborted > 0) {
        console.log(`[shutdown] Aborted ${aborted} active agy run(s).`);
      }
    } catch (err) {
      console.warn('[shutdown] Error aborting active runs:', err);
    }

    try {
      await bot.stop();
    } catch (err) {
      console.warn('[shutdown] Error stopping bot polling:', err);
    }

    try {
      deps.db.close();
    } catch (err) {
      console.warn('[shutdown] Error closing database:', err);
    }

    process.exit(0);
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await bot.start({
    onStart: (botInfo) => {
      console.log(`[startup] Bot @${botInfo.username} is listening.`);
    },
  });
}

function isDirectExecution(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) {
    return false;
  }
  try {
    const entryPath = fs.realpathSync(entryArg);
    const selfPath = fs.realpathSync(fileURLToPath(import.meta.url));
    return entryPath === selfPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[fatal] Bot failed to start:', err);
    process.exit(1);
  });
}
