import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../config.js';
import type {
  AgyArtifact,
  AgyConversation,
  AgyProject,
  AgySkill,
} from './types.js';

export interface AgyTranscriptEntry {
  stepIndex: number;
  type: string;
  source: string;
  content: string;
  createdAt?: string;
}

interface ConversationSummaryRow {
  conversation_id: string;
  title: string;
  preview: string;
  step_count: number;
  last_modified_time: string;
  workspace_uris: string;
  status: string;
  project_id: string;
  agent_name: string;
  last_user_input_time: string;
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..')
  );
}

function stripFileUriPrefix(uri: string): string {
  if (uri.startsWith('file://')) {
    return uri.slice('file://'.length);
  }
  return uri;
}

function toFileUri(folderPath: string): string {
  if (folderPath.startsWith('file://')) {
    return folderPath;
  }
  const resolved = path.resolve(folderPath);
  return `file://${resolved}`;
}

function extractProjectPaths(raw: Record<string, unknown>): string[] {
  const projectResources = raw.projectResources;
  if (!projectResources || typeof projectResources !== 'object') {
    return [];
  }
  const resources = (projectResources as Record<string, unknown>).resources;
  if (!Array.isArray(resources)) {
    return [];
  }

  const paths: string[] = [];
  const seen = new Set<string>();

  for (const item of resources) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const resource = item as Record<string, unknown>;
    let uri: string | undefined;

    if (typeof resource.folderUri === 'string' && resource.folderUri.trim() !== '') {
      uri = resource.folderUri.trim();
    } else if (resource.gitFolder && typeof resource.gitFolder === 'object') {
      const gitFolder = resource.gitFolder as Record<string, unknown>;
      if (typeof gitFolder.folderUri === 'string' && gitFolder.folderUri.trim() !== '') {
        uri = gitFolder.folderUri.trim();
      }
    }

    if (uri) {
      const cleaned = stripFileUriPrefix(uri);
      if (!seen.has(cleaned)) {
        seen.add(cleaned);
        paths.push(cleaned);
      }
    }
  }

  return paths;
}

function mapProject(raw: Record<string, unknown>, fallbackId: string): AgyProject {
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id : fallbackId;
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : id;
  return {
    id,
    name,
    paths: extractProjectPaths(raw),
    isWorkspaceOnly:
      typeof raw.isWorkspaceOnly === 'boolean' ? raw.isWorkspaceOnly : undefined,
    raw,
  };
}

function parseWorkspaceUris(raw: string): string[] {
  if (!raw || raw.trim() === '') {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Fallback below.
  }
  return [];
}

function mapConversationRow(row: ConversationSummaryRow): AgyConversation {
  return {
    conversationId: String(row.conversation_id ?? ''),
    title: String(row.title ?? ''),
    preview: String(row.preview ?? ''),
    stepCount: Number(row.step_count ?? 0),
    lastModifiedTime: String(row.last_modified_time ?? ''),
    workspaceUris: parseWorkspaceUris(String(row.workspace_uris ?? '')),
    status: String(row.status ?? ''),
    projectId: String(row.project_id ?? ''),
    agentName: String(row.agent_name ?? ''),
    lastUserInputTime: String(row.last_user_input_time ?? ''),
  };
}

function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) {
    return {};
  }
  const block = match[1];
  const result: { name?: string; description?: string } = {};
  const lines = block.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kvMatch = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (!kvMatch) {
      continue;
    }
    const key = kvMatch[1];
    let val = kvMatch[2].trim();

    if (key !== 'name' && key !== 'description') {
      continue;
    }

    if (val === '|' || val === '>') {
      const multiline: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^[ \t]+\S/.test(lines[j])) {
        multiline.push(lines[j].trim());
        j += 1;
      }
      i = j - 1;
      val = multiline.join(val === '>' ? ' ' : '\n').trim();
    } else if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }

    if (key === 'name') {
      result.name = val;
    } else if (key === 'description') {
      result.description = val;
    }
  }

  return result;
}

function sanitizeFts5Query(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/"/g, '').trim())
    .filter((token) => token.length > 0);
  return tokens.map((token) => `"${token}"`).join(' ');
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Reads local Antigravity CLI state: projects, conversations (SQLite),
 * artifacts, transcripts, and installed skills.
 */
export class AgyStore {
  private readonly config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  private get projectsDir(): string {
    return path.join(this.config.geminiDir, 'config', 'projects');
  }

  private get skillsDir(): string {
    return path.join(this.config.geminiDir, 'config', 'skills');
  }

  private get dbPath(): string {
    return path.join(this.config.appDataDir, 'conversation_summaries.db');
  }

  private withSummariesDb<T>(fallback: T, fn: (db: DatabaseSync) => T): T {
    if (!fs.existsSync(this.dbPath)) {
      return fallback;
    }
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      return fn(db);
    } catch {
      return fallback;
    } finally {
      try {
        db?.close();
      } catch {
        // Ignore close errors.
      }
    }
  }

  listProjects(): AgyProject[] {
    if (!fs.existsSync(this.projectsDir)) {
      return [];
    }

    let entries: string[];
    try {
      entries = fs.readdirSync(this.projectsDir);
    } catch {
      return [];
    }

    const projects: AgyProject[] = [];
    for (const file of entries) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(this.projectsDir, file);
      try {
        const rawText = fs.readFileSync(fullPath, 'utf8');
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        const fallbackId = path.basename(file, '.json');
        projects.push(mapProject(parsed as Record<string, unknown>, fallbackId));
      } catch {
        // Skip unreadable or malformed project files.
      }
    }

    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  }

  getProject(idOrName: string): AgyProject | null {
    const needle = idOrName.trim();
    if (!needle) {
      return null;
    }
    const projects = this.listProjects();
    const byId = projects.find((p) => p.id === needle);
    if (byId) {
      return byId;
    }
    const byExactName = projects.find((p) => p.name === needle);
    if (byExactName) {
      return byExactName;
    }
    const lower = needle.toLowerCase();
    return projects.find((p) => p.name.toLowerCase() === lower) ?? null;
  }

  createProject(name: string, folderPath?: string): AgyProject {
    const id = randomUUID();
    fs.mkdirSync(this.projectsDir, { recursive: true });

    const resources: Array<{ folderUri: string }> = [];
    if (folderPath && folderPath.trim() !== '') {
      resources.push({ folderUri: toFileUri(folderPath.trim()) });
    }

    const payload: Record<string, unknown> = {
      id,
      name: name.trim() || id,
      projectResources: {
        resources,
      },
      permissionGrants: {
        v2Migrated: true,
      },
      settings: {},
      isWorkspaceOnly: false,
    };

    const filePath = path.join(this.projectsDir, `${id}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return mapProject(payload, id);
  }

  addDirToProject(projectId: string, folderPath: string): AgyProject | null {
    if (!fs.existsSync(this.projectsDir)) {
      return null;
    }

    let targetFile: string | null = null;
    let rawObj: Record<string, unknown> | null = null;

    let files: string[];
    try {
      files = fs.readdirSync(this.projectsDir);
    } catch {
      return null;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) {
        continue;
      }
      const fullPath = path.join(this.projectsDir, file);
      try {
        const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          continue;
        }
        const record = parsed as Record<string, unknown>;
        const fileId =
          typeof record.id === 'string' && record.id.trim() !== ''
            ? record.id
            : path.basename(file, '.json');
        if (fileId === projectId || path.basename(file, '.json') === projectId) {
          targetFile = fullPath;
          rawObj = record;
          break;
        }
      } catch {
        // Ignore invalid files.
      }
    }

    if (!targetFile || !rawObj) {
      return null;
    }

    const uri = toFileUri(folderPath.trim());
    const cleanTarget = stripFileUriPrefix(uri);

    const projectResources =
      rawObj.projectResources && typeof rawObj.projectResources === 'object'
        ? (rawObj.projectResources as Record<string, unknown>)
        : {};
    const resources = Array.isArray(projectResources.resources)
      ? [...projectResources.resources]
      : [];

    const existingPaths = extractProjectPaths(rawObj);
    if (!existingPaths.includes(cleanTarget)) {
      resources.push({ folderUri: uri });
    }

    rawObj.projectResources = {
      ...projectResources,
      resources,
    };

    fs.writeFileSync(targetFile, `${JSON.stringify(rawObj, null, 2)}\n`, 'utf8');
    return mapProject(rawObj, projectId);
  }

  listConversations(opts?: {
    projectId?: string;
    limit?: number;
    offset?: number;
  }): AgyConversation[] {
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 500));
    const offset = Math.max(0, opts?.offset ?? 0);

    return this.withSummariesDb<AgyConversation[]>([], (db) => {
      if (opts?.projectId) {
        const stmt = db.prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  workspace_uris, status, project_id, agent_name, last_user_input_time
           FROM conversation_summaries
           WHERE project_id = ?
           ORDER BY last_modified_time DESC
           LIMIT ? OFFSET ?`,
        );
        const rows = stmt.all(
          opts.projectId,
          limit,
          offset,
        ) as unknown as ConversationSummaryRow[];
        return rows.map(mapConversationRow);
      }

      const stmt = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, status, project_id, agent_name, last_user_input_time
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT ? OFFSET ?`,
      );
      const rows = stmt.all(limit, offset) as unknown as ConversationSummaryRow[];
      return rows.map(mapConversationRow);
    });
  }

  getConversation(conversationId: string): AgyConversation | null {
    if (!conversationId.trim()) {
      return null;
    }
    return this.withSummariesDb<AgyConversation | null>(null, (db) => {
      const stmt = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, status, project_id, agent_name, last_user_input_time
         FROM conversation_summaries
         WHERE conversation_id = ?
         LIMIT 1`,
      );
      const row = stmt.get(conversationId) as ConversationSummaryRow | undefined;
      return row ? mapConversationRow(row) : null;
    });
  }

  searchConversations(query: string, limit = 20): AgyConversation[] {
    const trimmed = query.trim();
    const safeLimit = Math.max(1, Math.min(limit, 200));
    if (!trimmed) {
      return this.listConversations({ limit: safeLimit });
    }

    return this.withSummariesDb<AgyConversation[]>([], (db) => {
      const ftsQuery = sanitizeFts5Query(trimmed);
      if (ftsQuery) {
        try {
          const ftsStmt = db.prepare(
            `SELECT cs.conversation_id, cs.title, cs.preview, cs.step_count, cs.last_modified_time,
                    cs.workspace_uris, cs.status, cs.project_id, cs.agent_name, cs.last_user_input_time
             FROM conversation_summaries cs
             INNER JOIN (
               SELECT conversation_id, MIN(rank) AS best_rank
               FROM conversations_fts
               WHERE conversations_fts MATCH ?
               GROUP BY conversation_id
             ) f ON cs.conversation_id = f.conversation_id
             ORDER BY f.best_rank ASC, cs.last_modified_time DESC
             LIMIT ?`,
          );
          const rows = ftsStmt.all(
            ftsQuery,
            safeLimit,
          ) as unknown as ConversationSummaryRow[];
          return rows.map(mapConversationRow);
        } catch {
          // Fall back to LIKE search below if FTS table is missing or query fails.
        }
      }

      const pattern = `%${escapeLikePattern(trimmed)}%`;
      const likeStmt = db.prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, status, project_id, agent_name, last_user_input_time
         FROM conversation_summaries
         WHERE title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\'
         ORDER BY last_modified_time DESC
         LIMIT ?`,
      );
      const rows = likeStmt.all(
        pattern,
        pattern,
        safeLimit,
      ) as unknown as ConversationSummaryRow[];
      return rows.map(mapConversationRow);
    });
  }

  listArtifacts(conversationId: string): AgyArtifact[] {
    if (!isSafePathSegment(conversationId)) {
      return [];
    }
    const brainDir = path.join(this.config.appDataDir, 'brain', conversationId);
    if (!fs.existsSync(brainDir)) {
      return [];
    }

    const artifacts: AgyArtifact[] = [];

    const walk = (currentDir: string): void => {
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of dirEntries) {
        if (entry.name === '.system_generated' || entry.name.startsWith('.')) {
          continue;
        }
        const absolutePath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walk(absolutePath);
        } else if (entry.isFile()) {
          try {
            const stat = fs.statSync(absolutePath);
            artifacts.push({
              name: entry.name,
              relativePath: path.relative(brainDir, absolutePath),
              absolutePath,
              sizeBytes: stat.size,
              mtimeMs: stat.mtimeMs,
              ext: path.extname(entry.name),
            });
          } catch {
            // Skip inaccessible file.
          }
        }
      }
    };

    walk(brainDir);
    artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return artifacts;
  }

  getTranscript(
    conversationId: string,
    maxEntries?: number,
  ): AgyTranscriptEntry[] {
    if (!isSafePathSegment(conversationId)) {
      return [];
    }
    const transcriptPath = path.join(
      this.config.appDataDir,
      'brain',
      conversationId,
      '.system_generated',
      'logs',
      'transcript.jsonl',
    );
    if (!fs.existsSync(transcriptPath)) {
      return [];
    }

    let raw: string;
    try {
      raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
      return [];
    }

    const entries: AgyTranscriptEntry[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object') {
          continue;
        }
        const createdAt =
          typeof parsed.created_at === 'string'
            ? parsed.created_at
            : typeof parsed.createdAt === 'string'
              ? parsed.createdAt
              : undefined;
        const content =
          typeof parsed.content === 'string'
            ? parsed.content
            : parsed.content === undefined
              ? ''
              : JSON.stringify(parsed.content);
        entries.push({
          stepIndex: Number(parsed.step_index ?? parsed.stepIndex ?? 0),
          type: String(parsed.type ?? ''),
          source: String(parsed.source ?? ''),
          content,
          ...(createdAt ? { createdAt } : {}),
        });
      } catch {
        // Skip malformed JSONL line.
      }
    }

    if (maxEntries !== undefined && maxEntries > 0 && entries.length > maxEntries) {
      return entries.slice(-maxEntries);
    }
    return entries;
  }

  exportTranscriptMarkdown(conversationId: string): string {
    const conv = this.getConversation(conversationId);
    const entries = this.getTranscript(conversationId);

    const title = conv?.title?.trim() || `Conversation ${conversationId}`;
    const lines: string[] = [`# ${title}`, '', `- **Conversation ID:** \`${conversationId}\``];

    if (conv?.lastModifiedTime) {
      lines.push(`- **Last Modified:** ${conv.lastModifiedTime}`);
    }
    if (conv?.projectId) {
      lines.push(`- **Project ID:** \`${conv.projectId}\``);
    }
    lines.push('');

    if (entries.length === 0) {
      lines.push('_No transcript entries found._');
      return `${lines.join('\n')}\n`;
    }

    for (const entry of entries) {
      const timeSuffix = entry.createdAt ? ` (${entry.createdAt})` : '';
      const label = [entry.source, entry.type].filter(Boolean).join(' / ') || 'UNKNOWN';
      lines.push(`## Step ${entry.stepIndex} — ${label}${timeSuffix}`);
      lines.push('');
      lines.push(entry.content);
      lines.push('');
    }

    return `${lines.join('\n')}\n`;
  }

  listSkills(): AgySkill[] {
    if (!fs.existsSync(this.skillsDir)) {
      return [];
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const skills: AgySkill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const skillFile = path.join(this.skillsDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) {
        continue;
      }
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        const meta = parseSkillFrontmatter(content);
        skills.push({
          name: meta.name?.trim() || entry.name,
          description: meta.description?.trim() || '',
          path: skillFile,
        });
      } catch {
        // Skip unreadable skill files.
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  }

  searchSkills(query: string): AgySkill[] {
    const needle = query.trim().toLowerCase();
    const all = this.listSkills();
    if (!needle) {
      return all;
    }
    return all.filter(
      (skill) =>
        skill.name.toLowerCase().includes(needle) ||
        skill.description.toLowerCase().includes(needle),
    );
  }
}
