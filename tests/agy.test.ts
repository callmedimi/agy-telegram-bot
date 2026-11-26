import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgyCliCommands,
  deriveModelFamily,
  parseAgentsOutput,
  parseMcpListOutput,
  parseModelsOutput,
  stripAnsiAndSpinners,
} from '../src/agy/cli-commands.js';
import { AgyRunner, buildAgyArgs, parseStreamLine } from '../src/agy/runner.js';
import { AgyStore } from '../src/agy/store.js';
import type { AppConfig } from '../src/config.js';

function createTempConfig(rootDir: string, agyBin = 'agy'): AppConfig {
  const geminiDir = path.join(rootDir, '.gemini');
  const appDataDir = path.join(geminiDir, 'antigravity-cli');
  const dataDir = path.join(rootDir, 'data');
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    botToken: 'test-token',
    allowedUserIds: [12345],
    agyBin,
    geminiDir,
    appDataDir,
    dataDir,
    defaultModel: 'gemini-4-neon-medium',
    defaultEffort: 'medium',
    defaultMode: 'auto',
    streamEditIntervalMs: 1200,
    maxTurnTimeoutMs: 30_000,
    botLang: 'en',
  };
}

describe('parseStreamLine & buildAgyArgs', () => {
  it('parses init events', () => {
    const line = JSON.stringify({
      event: 'init',
      conversation_id: 'conv-123',
      init: {
        model: 'gemini-4-neon-high',
        cwd: '/work',
        tools: ['view_file', 'run_command'],
        permission_mode: 'auto',
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed).toEqual({
      event: 'init',
      conversation_id: 'conv-123',
      init: {
        model: 'gemini-4-neon-high',
        cwd: '/work',
        tools: ['view_file', 'run_command'],
        permission_mode: 'auto',
      },
    });
  });

  it('parses step_update events', () => {
    const line = JSON.stringify({
      event: 'step_update',
      step_update: {
        conversation_id: 'conv-123',
        step_index: 2,
        state: 'RUNNING',
        step_type: 'agent_response',
        text_delta: 'Hello ',
        thinking_delta: 'Let me think',
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.event).toBe('step_update');
    if (parsed?.event === 'step_update') {
      expect(parsed.step_update.text_delta).toBe('Hello ');
      expect(parsed.step_update.thinking_delta).toBe('Let me think');
      expect(parsed.step_update.step_index).toBe(2);
    }
  });

  it('parses result events', () => {
    const line = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: 'conv-123',
        status: 'success',
        response: 'Done!',
        duration_seconds: 1.5,
        num_turns: 1,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          thinking_tokens: 10,
          cache_read_tokens: 20,
          total_tokens: 180,
        },
      },
    });
    const parsed = parseStreamLine(line);
    expect(parsed?.event).toBe('result');
    if (parsed?.event === 'result') {
      expect(parsed.result.status).toBe('success');
      expect(parsed.result.response).toBe('Done!');
      expect(parsed.result.usage?.total_tokens).toBe(180);
    }
  });

  it('returns null for blank lines, invalid JSON, or malformed events', () => {
    expect(parseStreamLine('')).toBeNull();
    expect(parseStreamLine('   \n')).toBeNull();
    expect(parseStreamLine('{not valid json')).toBeNull();
    expect(parseStreamLine('{"event":"unknown"}')).toBeNull();
    expect(parseStreamLine('{"event":"init"}')).toBeNull();
    expect(parseStreamLine('{"event":"step_update"}')).toBeNull();
    expect(parseStreamLine('{"event":"result"}')).toBeNull();
  });

  it('builds CLI args with conversationId taking precedence over project', () => {
    const argsWithConv = buildAgyArgs({
      prompt: 'hi',
      conversationId: 'conv-1',
      project: 'proj-1',
      model: 'claude-opus-5-5-high',
      effort: 'high',
      mode: 'plan',
      agent: 'reviewer',
      sandbox: true,
      skipPermissions: true,
      addDirs: ['/tmp/a', '/tmp/b'],
    });
    expect(argsWithConv).toEqual([
      '-p',
      'hi',
      '--output-format',
      'stream-json',
      '--conversation',
      'conv-1',
      '--model',
      'claude-opus-5-5-high',
      '--effort',
      'high',
      '--mode',
      'plan',
      '--agent',
      'reviewer',
      '--sandbox',
      '--dangerously-skip-permissions',
      '--add-dir',
      '/tmp/a',
      '--add-dir',
      '/tmp/b',
    ]);

    const argsWithProj = buildAgyArgs({
      prompt: 'hello',
      project: 'proj-1',
    });
    expect(argsWithProj).toEqual([
      '-p',
      'hello',
      '--output-format',
      'stream-json',
      '--project',
      'proj-1',
    ]);
  });
});

describe('AgyRunner', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-runner-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('streams NDJSON events, tracks active runs, and resolves done', async () => {
    const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ event: 'init', conversation_id: 'c-42', init: { model: 'm1', cwd: process.cwd(), tools: [], permission_mode: 'auto' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c-42', step_index: 1, state: 'RUNNING', step_type: 'agent_response', thinking_delta: 'hmm' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c-42', step_index: 2, state: 'RUNNING', step_type: 'run_command', tool_name: 'run_command' } }));
console.log(JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c-42', step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'Final answer' } }));
console.error('warning on stderr');
console.log(JSON.stringify({ event: 'result', result: { conversation_id: 'c-42', status: 'success', response: 'Final answer' } }));
`;
    fs.writeFileSync(fakeBin, script, { mode: 0o755 });

    const runner = new AgyRunner(createTempConfig(tmpDir, fakeBin));
    const handle = runner.run({ prompt: 'test', cwd: tmpDir });

    expect(runner.getRun(handle.runId)).toBe(handle);
    expect(runner.listActiveRuns()).toHaveLength(1);

    const events: string[] = [];
    const textDeltas: string[] = [];
    const thinkingDeltas: string[] = [];
    const tools: Array<{ name: string; state: string; stepIndex: number }> = [];
    const stderrs: string[] = [];

    handle.on('init', (ev) => {
      events.push(`init:${ev.conversation_id}`);
    });
    handle.on('thinking_delta', (d) => thinkingDeltas.push(d));
    handle.on('text_delta', (d) => textDeltas.push(d));
    handle.on('tool_use', (t) => tools.push(t));
    handle.on('stderr', (s) => stderrs.push(s));

    const result = await handle.done;
    expect(result.status).toBe('success');
    expect(result.response).toBe('Final answer');
    expect(handle.conversationId).toBe('c-42');
    expect(events).toEqual(['init:c-42']);
    expect(thinkingDeltas).toEqual(['hmm']);
    expect(textDeltas).toEqual(['Final answer']);
    expect(tools).toEqual([{ name: 'run_command', state: 'RUNNING', stepIndex: 2 }]);
    expect(stderrs.join('')).toContain('warning on stderr');
    expect(runner.listActiveRuns()).toHaveLength(0);
    expect(runner.getRun(handle.runId)).toBeUndefined();
  });

  it('aborts an active run and emits aborted', async () => {
    const fakeBin = path.join(tmpDir, 'slow-agy.mjs');
    const script = `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;
    fs.writeFileSync(fakeBin, script, { mode: 0o755 });

    const runner = new AgyRunner(createTempConfig(tmpDir, fakeBin));
    const handle = runner.run({ prompt: 'hang', cwd: tmpDir, timeoutMs: 0 });

    let abortedEventFired = false;
    handle.on('aborted', () => {
      abortedEventFired = true;
    });

    expect(runner.abortRun(handle.runId)).toBe(true);
    await expect(handle.done).rejects.toThrow(/aborted/i);
    expect(abortedEventFired).toBe(true);
    expect(runner.listActiveRuns()).toHaveLength(0);
  });

  it('enforces timeoutMs', async () => {
    const fakeBin = path.join(tmpDir, 'timeout-agy.mjs');
    const script = `#!/usr/bin/env node
setInterval(() => {}, 1000);
`;
    fs.writeFileSync(fakeBin, script, { mode: 0o755 });

    const runner = new AgyRunner(createTempConfig(tmpDir, fakeBin));
    const handle = runner.run({ prompt: 'timeout', cwd: tmpDir, timeoutMs: 80 });

    const errors: Error[] = [];
    handle.on('error', (err) => errors.push(err));

    await expect(handle.done).rejects.toThrow(/timed out/i);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/timed out/i);
  });
});

describe('AgyStore', () => {
  let tmpDir: string;
  let config: AppConfig;
  let store: AgyStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-store-test-'));
    config = createTempConfig(tmpDir);
    store = new AgyStore(config);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty arrays/null gracefully when directories and DB are missing', () => {
    expect(store.listProjects()).toEqual([]);
    expect(store.getProject('nonexistent')).toBeNull();
    expect(store.listConversations()).toEqual([]);
    expect(store.getConversation('missing')).toBeNull();
    expect(store.searchConversations('anything')).toEqual([]);
    expect(store.listArtifacts('missing')).toEqual([]);
    expect(store.getTranscript('missing')).toEqual([]);
    expect(store.listSkills()).toEqual([]);
    expect(store.searchSkills('foo')).toEqual([]);
  });

  it('manages projects CRUD and extracts folderUri + gitFolder.folderUri', () => {
    const created = store.createProject('Alpha Project', '/tmp/alpha');
    expect(created.name).toBe('Alpha Project');
    expect(created.paths).toEqual(['/tmp/alpha']);

    // Write an existing gitFolder-style project JSON
    const projectsDir = path.join(config.geminiDir, 'config', 'projects');
    const gitProjId = randomUUID();
    fs.writeFileSync(
      path.join(projectsDir, `${gitProjId}.json`),
      JSON.stringify({
        id: gitProjId,
        name: 'Beta Repo',
        projectResources: {
          resources: [
            {
              gitFolder: {
                folderUri: 'file:///opt/beta',
                defaultBranch: 'main',
              },
            },
          ],
        },
        settings: {},
        isWorkspaceOnly: false,
      }),
    );

    const all = store.listProjects();
    expect(all.map((p) => p.name)).toEqual(['Alpha Project', 'Beta Repo']);
    expect(all[1].paths).toEqual(['/opt/beta']);

    expect(store.getProject(created.id)?.name).toBe('Alpha Project');
    expect(store.getProject('beta repo')?.id).toBe(gitProjId);

    const updated = store.addDirToProject(created.id, '/tmp/alpha-extra');
    expect(updated?.paths).toEqual(['/tmp/alpha', '/tmp/alpha-extra']);

    // Deduplicates existing directory
    const deduped = store.addDirToProject(created.id, '/tmp/alpha');
    expect(deduped?.paths).toEqual(['/tmp/alpha', '/tmp/alpha-extra']);

    expect(store.addDirToProject('does-not-exist', '/tmp/x')).toBeNull();
  });

  it('parses skills YAML frontmatter and supports search', () => {
    const skillsRoot = path.join(config.geminiDir, 'config', 'skills');
    fs.mkdirSync(path.join(skillsRoot, 'zeta-skill'), { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, 'alpha-skill'), { recursive: true });
    fs.mkdirSync(path.join(skillsRoot, 'empty-dir'), { recursive: true });

    fs.writeFileSync(
      path.join(skillsRoot, 'zeta-skill', 'SKILL.md'),
      `---
name: zeta-tool
description: "Helps with Zod schemas and validation"
---
# Zeta Tool
`,
    );
    fs.writeFileSync(
      path.join(skillsRoot, 'alpha-skill', 'SKILL.md'),
      `---
name: 'alpha-helper'
description: >
  Assists with Telegram bots
  and streaming replies
---
Body here
`,
    );

    const skills = store.listSkills();
    expect(skills).toHaveLength(2);
    expect(skills[0].name).toBe('alpha-helper');
    expect(skills[0].description).toBe('Assists with Telegram bots and streaming replies');
    expect(skills[1].name).toBe('zeta-tool');
    expect(skills[1].description).toBe('Helps with Zod schemas and validation');

    expect(store.searchSkills('telegram').map((s) => s.name)).toEqual(['alpha-helper']);
    expect(store.searchSkills('ZOD').map((s) => s.name)).toEqual(['zeta-tool']);
  });

  it('lists artifacts excluding .system_generated and hidden files, sorted by mtime desc', () => {
    const convId = 'conv-artifacts-1';
    const brainDir = path.join(config.appDataDir, 'brain', convId);
    fs.mkdirSync(path.join(brainDir, '.system_generated', 'logs'), { recursive: true });
    fs.mkdirSync(path.join(brainDir, 'nested'), { recursive: true });

    const oldFile = path.join(brainDir, 'report.md');
    const newFile = path.join(brainDir, 'nested', 'chart.png');
    const hiddenFile = path.join(brainDir, '.secret');
    const sysFile = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');

    fs.writeFileSync(oldFile, '# Report\n');
    fs.utimesSync(oldFile, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));

    fs.writeFileSync(newFile, 'pngbytes');
    fs.utimesSync(newFile, new Date('2026-02-01T00:00:00Z'), new Date('2026-02-01T00:00:00Z'));

    fs.writeFileSync(hiddenFile, 'hidden');
    fs.writeFileSync(sysFile, '{}');

    const artifacts = store.listArtifacts(convId);
    expect(artifacts.map((a) => a.relativePath)).toEqual([
      path.join('nested', 'chart.png'),
      'report.md',
    ]);
    expect(artifacts[0].ext).toBe('.png');
    expect(artifacts[1].ext).toBe('.md');
  });

  it('parses transcript.jsonl and exports Markdown', () => {
    const convId = 'conv-transcript-1';
    const logsDir = path.join(config.appDataDir, 'brain', convId, '.system_generated', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.writeFileSync(
      path.join(logsDir, 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER',
          type: 'USER_INPUT',
          created_at: '2026-11-26T10:00:00Z',
          content: 'Build a bot',
        }),
        'not valid json',
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'AGENT_RESPONSE',
          created_at: '2026-11-26T10:00:05Z',
          content: 'Sure thing!',
        }),
      ].join('\n'),
    );

    const all = store.getTranscript(convId);
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual({
      stepIndex: 0,
      source: 'USER',
      type: 'USER_INPUT',
      createdAt: '2026-11-26T10:00:00Z',
      content: 'Build a bot',
    });

    const capped = store.getTranscript(convId, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0].stepIndex).toBe(1);

    const md = store.exportTranscriptMarkdown(convId);
    expect(md).toContain('# Conversation conv-transcript-1');
    expect(md).toContain('## Step 0 — USER / USER_INPUT');
    expect(md).toContain('Build a bot');
    expect(md).toContain('Sure thing!');
  });

  it('queries SQLite conversation_summaries and FTS5 searchConversations', () => {
    const dbPath = path.join(config.appDataDir, 'conversation_summaries.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time TEXT NOT NULL,
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        last_user_input_time TEXT NOT NULL DEFAULT ''
      );
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED,
        chunk_index UNINDEXED,
        title,
        user_body,
        agent_body
      );
    `);

    const insertConv = db.prepare(`
      INSERT INTO conversation_summaries
      (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, status, project_id, agent_name, last_user_input_time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertConv.run(
      'c1',
      'Telegram Bot Setup',
      'Configured grammY middleware',
      12,
      '2026-11-25T10:00:00Z',
      '["file:///opt/bot"]',
      'idle',
      'proj-a',
      'coder',
      '2026-11-25T09:59:00Z',
    );
    insertConv.run(
      'c2',
      'Database Migration',
      'Added node:sqlite schema',
      8,
      '2026-11-26T12:00:00Z',
      '["file:///opt/db"]',
      'idle',
      'proj-b',
      '',
      '2026-11-26T11:55:00Z',
    );

    const insertFts = db.prepare(`
      INSERT INTO conversations_fts (conversation_id, chunk_index, title, user_body, agent_body)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertFts.run('c1', 0, 'Telegram Bot Setup', 'setup grammy', 'done');
    insertFts.run('c2', 0, 'Database Migration', 'sqlite migration', 'completed');
    db.close();

    const recent = store.listConversations();
    expect(recent.map((c) => c.conversationId)).toEqual(['c2', 'c1']);
    expect(recent[1].workspaceUris).toEqual(['file:///opt/bot']);

    const byProj = store.listConversations({ projectId: 'proj-a' });
    expect(byProj.map((c) => c.conversationId)).toEqual(['c1']);

    const one = store.getConversation('c2');
    expect(one?.title).toBe('Database Migration');
    expect(one?.stepCount).toBe(8);

    // FTS5 search including punctuation that would break unsanitized FTS queries
    const ftsHits = store.searchConversations('grammy');
    expect(ftsHits.map((c) => c.conversationId)).toEqual(['c1']);

    const safePunctuation = store.searchConversations('sqlite-migration "unbalanced');
    expect(Array.isArray(safePunctuation)).toBe(true);

    // Verify LIKE fallback when FTS table is absent
    const dbFallback = new DatabaseSync(dbPath);
    dbFallback.exec('DROP TABLE conversations_fts');
    dbFallback.close();

    const fallbackHits = store.searchConversations('node:sqlite');
    expect(fallbackHits.map((c) => c.conversationId)).toEqual(['c2']);
  });
});

describe('AgyCliCommands parsers', () => {
  it('strips ANSI sequences and braille spinners', () => {
    const raw = '\x1B[?25l\r⠋ Fetching available models...\r\x1B[32mgemini-4-neon-high\x1B[0m  Gemini 4 Neon (High)';
    const cleaned = stripAnsiAndSpinners(raw);
    expect(cleaned).not.toContain('⠋');
    expect(cleaned).not.toContain('\x1B');
    expect(cleaned).toContain('gemini-4-neon-high  Gemini 4 Neon (High)');
  });

  it('derives expected model families', () => {
    expect(deriveModelFamily('gemini-4-neon-high', 'Gemini 4 Neon (High)')).toBe('Gemini 4 Neon');
    expect(deriveModelFamily('gemini-4-carbon-medium', 'Gemini 4 Carbon (Medium)')).toBe(
      'Gemini 4 Carbon',
    );
    expect(deriveModelFamily('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)')).toBe(
      'Gemini 3.8 Flash',
    );
    expect(deriveModelFamily('claude-opus-5-5-high', 'Claude Opus 5.5 (High)')).toBe('Claude Opus');
    expect(deriveModelFamily('claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)')).toBe(
      'Claude Sonnet',
    );
    expect(deriveModelFamily('gemini-pro-orchestrator', 'Orchestrator (Carbon)')).toBe(
      'Orchestrator',
    );
    expect(deriveModelFamily('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)')).toBe('Other');
  });

  it('parses agy models output with tabs, spinners, and ANSI escapes', () => {
    const raw = [
      '\r⠋ Fetching available models...\r⠙ Fetching available models...\rgemini-4-neon-high             Gemini 4 Neon (High)',
      'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
      'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
      'claude-opus-5-5-high           Claude Opus 5.5 (High)',
      'claude-sonnet-5-5-medium       Claude Sonnet 5.5 (Medium)',
      'gpt-oss-120b-medium            GPT-OSS 120B (Medium)',
    ].join('\n');

    const models = parseModelsOutput(raw);
    expect(models).toEqual([
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', family: 'Gemini 4 Neon' },
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', family: 'Gemini 4 Carbon' },
      {
        id: 'gemini-pro-orchestrator-neon',
        label: 'Orchestrator (Neon)',
        family: 'Orchestrator',
      },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High)', family: 'Claude Opus' },
      {
        id: 'claude-sonnet-5-5-medium',
        label: 'Claude Sonnet 5.5 (Medium)',
        family: 'Claude Sonnet',
      },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)', family: 'Other' },
    ]);
  });

  it('parses agy mcp list tabular output', () => {
    const raw = [
      'NAME       TYPE   STATUS    COMMAND/URL',
      'gscServer  stdio  enabled   /opt/venv/bin/python /opt/gsc_server.py --port 8080',
      'remoteApi  http   disabled  https://example.com/mcp',
    ].join('\n');

    expect(parseMcpListOutput(raw)).toEqual([
      {
        name: 'gscServer',
        type: 'stdio',
        status: 'enabled',
        target: '/opt/venv/bin/python /opt/gsc_server.py --port 8080',
      },
      {
        name: 'remoteApi',
        type: 'http',
        status: 'disabled',
        target: 'https://example.com/mcp',
      },
    ]);

    expect(parseMcpListOutput('No MCP servers configured.\n')).toEqual([]);
  });

  it('parses agy agents output', () => {
    expect(parseAgentsOutput('')).toEqual([]);
    expect(parseAgentsOutput('No agents found.\n')).toEqual([]);
    expect(parseAgentsOutput('NAME\nreviewer  Code reviewer\nplanner   Architect\n')).toEqual([
      'reviewer',
      'planner',
    ]);
  });

  it('caches listModels for 5 minutes unless forceRefresh is true', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-cli-cache-'));
    try {
      const counterFile = path.join(tmpDir, 'calls.txt');
      const fakeBin = path.join(tmpDir, 'fake-agy.mjs');
      fs.writeFileSync(
        fakeBin,
        `#!/usr/bin/env node
import fs from 'node:fs';
const countFile = ${JSON.stringify(counterFile)};
const prev = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(prev + 1));
if (process.argv[2] === 'models') {
  console.log('gemini-4-neon-high             Gemini 4 Neon (High)');
} else if (process.argv[2] === '--version') {
  console.log('1.5.18');
} else {
  console.log(process.argv.slice(2).join(' '));
}
`,
        { mode: 0o755 },
      );

      const cli = new AgyCliCommands(createTempConfig(tmpDir, fakeBin));
      const first = await cli.listModels();
      const second = await cli.listModels();
      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(fs.readFileSync(counterFile, 'utf8')).toBe('1');

      await cli.listModels(true);
      expect(fs.readFileSync(counterFile, 'utf8')).toBe('2');

      const addOut = await cli.addMcpServer({
        name: 'fs',
        type: 'stdio',
        target: 'npx',
        extraArgs: ['-y', '@mcp/fs'],
      });
      expect(addOut).toBe('mcp add --type stdio fs npx -y @mcp/fs');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
