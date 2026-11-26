import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';
import type { AgyMcpServer, AgyModel } from './types.js';

const execFileAsync = promisify(execFile);

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const CLI_EXEC_TIMEOUT_MS = 30_000;

// Matches ANSI CSI/OSC escape sequences and braille spinner frames.
const ANSI_PATTERN = /\x1B(?:\[[0-9;?]*[A-Za-z]|\][^\x07]*(?:\x07|\x1B\\))/g;
const SPINNER_CHARS_PATTERN = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;

/**
 * Strip ANSI escape sequences and braille spinner glyphs from CLI output.
 */
export function stripAnsiAndSpinners(output: string): string {
  return output.replace(ANSI_PATTERN, '').replace(SPINNER_CHARS_PATTERN, '');
}

/**
 * Derive a display family name from a model ID and human label.
 */
export function deriveModelFamily(id: string, label: string): string {
  const normalizedId = id.toLowerCase();
  const normalizedLabel = label.toLowerCase();

  if (normalizedId.startsWith('gemini-4-neon') || normalizedLabel.startsWith('gemini 4 neon')) {
    return 'Gemini 4 Neon';
  }
  if (
    normalizedId.startsWith('gemini-4-carbon') ||
    normalizedLabel.startsWith('gemini 4 carbon')
  ) {
    return 'Gemini 4 Carbon';
  }
  if (normalizedId.startsWith('gemini-4-argon') || normalizedLabel.startsWith('gemini 4 argon')) {
    return 'Gemini 4 Argon';
  }
  if (
    normalizedId.startsWith('gemini-4-hydrogen') ||
    normalizedLabel.startsWith('gemini 4 hydrogen')
  ) {
    return 'Gemini 4 Hydrogen';
  }
  if (
    normalizedId.startsWith('gemini-3.8-flash') ||
    normalizedLabel.startsWith('gemini 3.8 flash')
  ) {
    return 'Gemini 3.8 Flash';
  }
  if (normalizedId.includes('orchestrator') || normalizedLabel.startsWith('orchestrator')) {
    return 'Orchestrator';
  }
  if (normalizedId.startsWith('claude-opus') || normalizedLabel.startsWith('claude opus')) {
    return 'Claude Opus';
  }
  if (normalizedId.startsWith('claude-sonnet') || normalizedLabel.startsWith('claude sonnet')) {
    return 'Claude Sonnet';
  }
  if (normalizedId.startsWith('claude-haiku') || normalizedLabel.startsWith('claude haiku')) {
    return 'Claude Haiku';
  }

  return 'Other';
}

/**
 * Parse `agy models` stdout into structured `AgyModel` entries.
 */
export function parseModelsOutput(output: string): AgyModel[] {
  const cleaned = stripAnsiAndSpinners(output);
  const models: AgyModel[] = [];
  const seen = new Set<string>();

  for (const rawLine of cleaned.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^fetching available models/i.test(line) || /^name\s+/i.test(line)) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9._:/-]+)(?:\t+|\s{2,})(.+)$/);
    if (!match) {
      continue;
    }

    const id = match[1].trim();
    const label = match[2].trim();
    if (!id || !label || seen.has(id)) {
      continue;
    }

    seen.add(id);
    models.push({
      id,
      label,
      family: deriveModelFamily(id, label),
    });
  }

  return models;
}

/**
 * Parse `agy agents` stdout into a list of agent names.
 */
export function parseAgentsOutput(output: string): string[] {
  const cleaned = stripAnsiAndSpinners(output);
  const agents: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of cleaned.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (
      !line ||
      /^no agents/i.test(line) ||
      /^name(?:\s|$)/i.test(line) ||
      /^[-─=]+$/.test(line)
    ) {
      continue;
    }

    // Handle bulleted lists or columnar output (first token is the agent name).
    const stripped = line.replace(/^[-*•]\s+/, '').trim();
    const firstToken = stripped.split(/\s{2,}|\t/)[0]?.trim() ?? '';
    if (firstToken && !seen.has(firstToken)) {
      seen.add(firstToken);
      agents.push(firstToken);
    }
  }

  return agents;
}

/**
 * Parse `agy mcp list` tabular stdout into `AgyMcpServer` entries.
 */
export function parseMcpListOutput(output: string): AgyMcpServer[] {
  const cleaned = stripAnsiAndSpinners(output);
  const servers: AgyMcpServer[] = [];

  for (const rawLine of cleaned.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (
      !line ||
      /^NAME\s+TYPE\s+STATUS/i.test(line) ||
      /^no mcp servers/i.test(line) ||
      /^[-─=]+$/.test(line)
    ) {
      continue;
    }

    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) {
      continue;
    }

    servers.push({
      name: match[1].trim(),
      type: match[2].trim(),
      status: match[3].trim(),
      target: match[4].trim(),
    });
  }

  return servers;
}

/**
 * Executes non-streaming `agy` CLI management commands safely via `execFile`.
 */
export class AgyCliCommands {
  private readonly config: AppConfig;
  private cachedModels: AgyModel[] | null = null;
  private modelsCachedAt = 0;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private async execAgy(args: string[]): Promise<string> {
    const { stdout, stderr } = await execFileAsync(this.config.agyBin, args, {
      timeout: CLI_EXEC_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    const out = stdout.trim();
    const err = stderr.trim();
    if (out && err) {
      return `${out}\n${err}`;
    }
    return out || err;
  }

  async getVersion(): Promise<string> {
    const output = await this.execAgy(['--version']);
    return stripAnsiAndSpinners(output).trim();
  }

  async listModels(forceRefresh = false): Promise<AgyModel[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.cachedModels !== null &&
      now - this.modelsCachedAt < MODEL_CACHE_TTL_MS
    ) {
      return this.cachedModels;
    }

    const output = await this.execAgy(['models']);
    const parsed = parseModelsOutput(output);
    this.cachedModels = parsed;
    this.modelsCachedAt = now;
    return parsed;
  }

  async listAgents(): Promise<string[]> {
    const output = await this.execAgy(['agents']);
    return parseAgentsOutput(output);
  }

  async listMcpServers(): Promise<AgyMcpServer[]> {
    const output = await this.execAgy(['mcp', 'list']);
    return parseMcpListOutput(output);
  }

  async toggleMcpServer(name: string, enable: boolean): Promise<string> {
    const subcommand = enable ? 'enable' : 'disable';
    return this.execAgy(['mcp', subcommand, name]);
  }

  async addMcpServer(args: {
    name: string;
    type?: 'stdio' | 'http';
    target: string;
    extraArgs?: string[];
  }): Promise<string> {
    const cliArgs = ['mcp', 'add'];
    if (args.type) {
      cliArgs.push('--type', args.type);
    }
    cliArgs.push(args.name, args.target);
    if (args.extraArgs && args.extraArgs.length > 0) {
      cliArgs.push(...args.extraArgs);
    }
    return this.execAgy(cliArgs);
  }

  async removeMcpServer(name: string): Promise<string> {
    return this.execAgy(['mcp', 'remove', name]);
  }

  async listPlugins(): Promise<string> {
    return this.execAgy(['plugin', 'list']);
  }

  async managePlugin(
    action: 'install' | 'uninstall' | 'enable' | 'disable',
    target: string,
  ): Promise<string> {
    return this.execAgy(['plugin', action, target]);
  }
}
