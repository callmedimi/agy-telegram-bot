#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');

const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const VALID_MODES = ['auto', 'accept-edits', 'plan'];
const VALID_LANGS = ['en', 'fa'];

function checkNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (!Number.isFinite(major) || major < 22) {
    console.error(
      `❌ Node.js >= 22 is required (detected v${process.versions.node}). Please upgrade Node.js first.`,
    );
    process.exit(1);
  }
}

function parseExistingEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) {
    return values;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) {
      continue;
    }
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key) {
      values[key] = val;
    }
  }
  return values;
}

function detectAgyBinary() {
  try {
    const found = execFileSync('which', ['agy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found && fs.existsSync(found)) {
      return found;
    }
  } catch {
    // Fallback to common locations below.
  }

  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'agy'),
    '/usr/local/bin/agy',
    '/usr/bin/agy',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function getAgyVersion(binPath) {
  try {
    return execFileSync(binPath, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function maskToken(token) {
  if (!token) return '';
  if (token.length <= 10) return '***';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function formatEnvValue(val) {
  if (val === '') return '';
  if (/[\s#"']/.test(val)) {
    return JSON.stringify(val);
  }
  return val;
}

function validateUserIds(raw) {
  if (!raw.trim()) {
    return { ok: true, normalized: '' };
  }
  const ids = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^\d+$/.test(trimmed) || Number.parseInt(trimmed, 10) <= 0) {
      return { ok: false, error: `Invalid Telegram user ID: "${trimmed}" (must be a positive integer)` };
    }
    if (!ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  }
  return { ok: true, normalized: ids.join(',') };
}

async function promptWithDefault(rl, label, defaultValue, displayDefault = defaultValue) {
  const suffix = displayDefault ? ` [${displayDefault}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer !== '' ? answer : defaultValue;
}

async function promptChoice(rl, label, choices, defaultValue) {
  while (true) {
    const raw = await promptWithDefault(rl, `${label} (${choices.join('/')})`, defaultValue);
    const normalized = raw.toLowerCase();
    if (choices.includes(normalized)) {
      return normalized;
    }
    console.log(`⚠️  Please enter one of: ${choices.join(', ')}`);
  }
}

async function main() {
  checkNodeVersion();

  console.log('==============================================');
  console.log('  Antigravity Telegram Bot — Setup Wizard');
  console.log('==============================================');
  console.log(`Node.js : v${process.versions.node}`);

  const existing = parseExistingEnv(ENV_PATH);
  if (Object.keys(existing).length > 0) {
    console.log(`Existing .env found at ${ENV_PATH} (press Enter to keep current values).`);
  }

  const detectedAgy = detectAgyBinary();
  if (detectedAgy) {
    const ver = getAgyVersion(detectedAgy);
    console.log(`agy CLI : ${detectedAgy}${ver ? ` (v${ver})` : ''}`);
  } else {
    console.log('⚠️  agy CLI was not auto-detected in PATH or ~/.local/bin/agy.');
  }
  console.log('');

  const rl = readline.createInterface({ input, output });

  try {
    let botToken = '';
    while (!botToken) {
      const existingToken = existing.BOT_TOKEN ?? '';
      const raw = await promptWithDefault(
        rl,
        'Telegram BOT_TOKEN (from @BotFather)',
        existingToken,
        existingToken ? maskToken(existingToken) : '',
      );
      if (!raw) {
        console.log('⚠️  BOT_TOKEN is required.');
        continue;
      }
      botToken = raw;
    }

    let allowedUserIds = '';
    while (true) {
      const defaultIds = existing.ALLOWED_USER_IDS ?? '';
      const raw = await promptWithDefault(
        rl,
        'ALLOWED_USER_IDS (comma-separated Telegram user IDs; blank = unrestricted)',
        defaultIds,
      );
      const res = validateUserIds(raw);
      if (!res.ok) {
        console.log(`⚠️  ${res.error}`);
        continue;
      }
      allowedUserIds = res.normalized;
      if (!allowedUserIds) {
        console.log('ℹ️  No ALLOWED_USER_IDS set — anyone who messages the bot will be allowed.');
      }
      break;
    }

    const defaultAgyBin = existing.AGY_BIN || detectedAgy || 'agy';
    const agyBin = await promptWithDefault(rl, 'AGY_BIN path or binary name', defaultAgyBin);

    const defaultModel = await promptWithDefault(
      rl,
      'DEFAULT_MODEL',
      existing.DEFAULT_MODEL || 'gemini-4-neon-medium',
    );

    const defaultEffort = await promptChoice(
      rl,
      'DEFAULT_EFFORT',
      VALID_EFFORTS,
      VALID_EFFORTS.includes((existing.DEFAULT_EFFORT ?? '').toLowerCase())
        ? existing.DEFAULT_EFFORT.toLowerCase()
        : 'medium',
    );

    const defaultMode = await promptChoice(
      rl,
      'DEFAULT_MODE',
      VALID_MODES,
      VALID_MODES.includes((existing.DEFAULT_MODE ?? '').toLowerCase())
        ? existing.DEFAULT_MODE.toLowerCase()
        : 'auto',
    );

    const botLang = await promptChoice(
      rl,
      'BOT_LANG',
      VALID_LANGS,
      VALID_LANGS.includes((existing.BOT_LANG ?? '').toLowerCase())
        ? existing.BOT_LANG.toLowerCase()
        : 'en',
    );

    const finalConfig = {
      BOT_TOKEN: botToken,
      ALLOWED_USER_IDS: allowedUserIds,
      AGY_BIN: agyBin,
      GEMINI_DIR: existing.GEMINI_DIR || '~/.gemini',
      APP_DATA_DIR: existing.APP_DATA_DIR || '~/.gemini/antigravity-cli',
      DATA_DIR: existing.DATA_DIR || './data',
      DEFAULT_MODEL: defaultModel,
      DEFAULT_EFFORT: defaultEffort,
      DEFAULT_MODE: defaultMode,
      STREAM_EDIT_INTERVAL_MS: existing.STREAM_EDIT_INTERVAL_MS || '1200',
      MAX_TURN_TIMEOUT_MS: existing.MAX_TURN_TIMEOUT_MS || '600000',
      BOT_LANG: botLang,
    };

    const lines = [
      '# Generated by scripts/setup.mjs',
      `BOT_TOKEN=${formatEnvValue(finalConfig.BOT_TOKEN)}`,
      `ALLOWED_USER_IDS=${formatEnvValue(finalConfig.ALLOWED_USER_IDS)}`,
      `AGY_BIN=${formatEnvValue(finalConfig.AGY_BIN)}`,
      `GEMINI_DIR=${formatEnvValue(finalConfig.GEMINI_DIR)}`,
      `APP_DATA_DIR=${formatEnvValue(finalConfig.APP_DATA_DIR)}`,
      `DATA_DIR=${formatEnvValue(finalConfig.DATA_DIR)}`,
      `DEFAULT_MODEL=${formatEnvValue(finalConfig.DEFAULT_MODEL)}`,
      `DEFAULT_EFFORT=${formatEnvValue(finalConfig.DEFAULT_EFFORT)}`,
      `DEFAULT_MODE=${formatEnvValue(finalConfig.DEFAULT_MODE)}`,
      `STREAM_EDIT_INTERVAL_MS=${formatEnvValue(finalConfig.STREAM_EDIT_INTERVAL_MS)}`,
      `MAX_TURN_TIMEOUT_MS=${formatEnvValue(finalConfig.MAX_TURN_TIMEOUT_MS)}`,
      `BOT_LANG=${formatEnvValue(finalConfig.BOT_LANG)}`,
      '',
    ];

    fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
    fs.chmodSync(ENV_PATH, 0o600);

    console.log('');
    console.log(`✅ Saved configuration to ${ENV_PATH} (permissions: 0600)`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Build (if not already built): npm run build');
    console.log('  2. Start the bot              : npm start');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error('❌ Setup failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
