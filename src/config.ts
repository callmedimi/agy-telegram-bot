import dotenv from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import type { AgyEffort, AgyPermissionMode } from './agy/types.js';

export const VALID_EFFORTS: readonly AgyEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export const VALID_MODES: readonly AgyPermissionMode[] = [
  'auto',
  'accept-edits',
  'plan',
] as const;

export type BotLang = 'en' | 'fa' | (string & {});

export interface AppConfig {
  botToken: string;
  allowedUserIds: number[];
  agyBin: string;
  geminiDir: string;
  appDataDir: string;
  dataDir: string;
  defaultModel?: string;
  defaultEffort: AgyEffort;
  defaultMode: AgyPermissionMode;
  streamEditIntervalMs: number;
  maxTurnTimeoutMs: number;
  botLang: BotLang;
}

export interface LoadConfigOptions {
  /** Skip requiring BOT_TOKEN (useful for unit tests and CLI inspection). */
  allowMissingToken?: boolean;
  /** Override environment source instead of process.env. */
  env?: Record<string, string | undefined>;
  /** Skip loading .env from disk. */
  skipDotenv?: boolean;
  /** Custom path to .env file. */
  dotenvPath?: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function expandHome(inputPath: string): string {
  if (inputPath === '~') {
    return os.homedir();
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(os.homedir(), inputPath.slice(2));
  }
  return inputPath;
}

function parsePositiveInt(
  raw: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

function parseAllowedUserIds(raw: string | undefined): number[] {
  if (!raw || raw.trim() === '') {
    return [];
  }
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') {
      continue;
    }
    if (!/^\d+$/.test(trimmed)) {
      throw new ConfigError(
        `ALLOWED_USER_IDS contains invalid Telegram user ID: "${trimmed}"`,
      );
    }
    const id = Number.parseInt(trimmed, 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigError(
        `ALLOWED_USER_IDS contains out-of-range user ID: "${trimmed}"`,
      );
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  defaultValue: T,
  name: string,
): T {
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase() as T;
  if (!allowed.includes(normalized)) {
    throw new ConfigError(
      `${name} must be one of [${allowed.join(', ')}], got "${raw}"`,
    );
  }
  return normalized;
}

/**
 * Load and validate bot configuration from environment variables (and `.env` if present).
 */
export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (!options.skipDotenv) {
    dotenv.config({
      path: options.dotenvPath,
      quiet: true,
    });
  }

  const env = options.env ?? process.env;

  const botToken = (env.BOT_TOKEN ?? '').trim();
  if (!botToken && !options.allowMissingToken) {
    throw new ConfigError(
      'BOT_TOKEN is required. Set it in .env or environment variables.',
    );
  }

  const allowedUserIds = parseAllowedUserIds(env.ALLOWED_USER_IDS);
  const agyBin = (env.AGY_BIN ?? '').trim() || 'agy';

  const rawGeminiDir = (env.GEMINI_DIR ?? '').trim();
  const geminiDir = rawGeminiDir
    ? path.resolve(expandHome(rawGeminiDir))
    : path.join(os.homedir(), '.gemini');

  const rawAppDataDir = (env.APP_DATA_DIR ?? '').trim();
  const appDataDir = rawAppDataDir
    ? path.resolve(expandHome(rawAppDataDir))
    : path.join(geminiDir, 'antigravity-cli');

  const rawDataDir = (env.DATA_DIR ?? '').trim();
  const dataDir = rawDataDir
    ? path.resolve(expandHome(rawDataDir))
    : path.resolve(process.cwd(), 'data');

  const rawModel = (env.DEFAULT_MODEL ?? '').trim();
  const defaultModel = rawModel !== '' ? rawModel : undefined;

  const defaultEffort = parseEnum(
    env.DEFAULT_EFFORT,
    VALID_EFFORTS,
    'medium',
    'DEFAULT_EFFORT',
  );

  const defaultMode = parseEnum(
    env.DEFAULT_MODE,
    VALID_MODES,
    'auto',
    'DEFAULT_MODE',
  );

  const streamEditIntervalMs = parsePositiveInt(
    env.STREAM_EDIT_INTERVAL_MS,
    1200,
    'STREAM_EDIT_INTERVAL_MS',
  );

  const maxTurnTimeoutMs = parsePositiveInt(
    env.MAX_TURN_TIMEOUT_MS,
    600_000,
    'MAX_TURN_TIMEOUT_MS',
  );

  const rawLang = (env.BOT_LANG ?? '').trim().toLowerCase();
  const botLang: BotLang = rawLang || 'en';

  return {
    botToken,
    allowedUserIds,
    agyBin,
    geminiDir,
    appDataDir,
    dataDir,
    defaultModel,
    defaultEffort,
    defaultMode,
    streamEditIntervalMs,
    maxTurnTimeoutMs,
    botLang,
  };
}
