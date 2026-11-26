import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgyEffort, AgyPermissionMode } from '../agy/types.js';

export interface Category {
  id: number;
  name: string;
  emoji: string;
  sortOrder: number;
  createdAt: string;
}

export interface ProjectMeta {
  projectId: string;
  categoryId: number | null;
  pinned: boolean;
  alias: string | null;
  notes: string | null;
  defaultModel: string | null;
  defaultEffort: AgyEffort | null;
  defaultMode: AgyPermissionMode | null;
  updatedAt: string;
}

export interface ChatMeta {
  conversationId: string;
  categoryId: number | null;
  tags: string[];
  pinned: boolean;
  customTitle: string | null;
  archived: boolean;
  updatedAt: string;
}

export interface TopicBinding {
  chatId: number;
  threadId: number;
  projectId: string | null;
  conversationId: string | null;
  label: string | null;
  createdAt: string;
}

export interface PendingInput {
  action: string;
  payload?: Record<string, string>;
  createdAt: number;
}

export interface UserSession {
  userId: number;
  activeProjectId: string | null;
  activeConversationId: string | null;
  model: string;
  effort: AgyEffort;
  mode: AgyPermissionMode;
  agent: string | null;
  sandbox: boolean;
  skipPermissions: boolean;
  showTools: boolean;
  showUsage: boolean;
  autoSendArtifacts: boolean;
  lang: 'en' | 'fa';
  pendingInput: PendingInput | null;
  updatedAt: string;
}

export interface BotDbDefaults {
  model: string;
  effort: AgyEffort;
  mode: AgyPermissionMode;
  lang: 'en' | 'fa';
}

export interface ProjectDefaultsPatch {
  notes?: string | null;
  defaultModel?: string | null;
  defaultEffort?: AgyEffort | null;
  defaultMode?: AgyPermissionMode | null;
}

export interface TopicBindingInput {
  chatId: number;
  threadId: number;
  projectId?: string | null;
  conversationId?: string | null;
  label?: string | null;
}

export type UserSessionPatch = Partial<Omit<UserSession, 'userId' | 'updatedAt'>>;

export interface BotDbStats {
  categories: number;
  pinnedProjects: number;
  pinnedChats: number;
  topicBindings: number;
  users: number;
}

type RawRow = Record<string, unknown>;

const DEFAULT_CATEGORIES: ReadonlyArray<{ name: string; emoji: string; sortOrder: number }> = [
  { name: 'Work', emoji: '💼', sortOrder: 0 },
  { name: 'Personal', emoji: '🏠', sortOrder: 1 },
  { name: 'DevOps', emoji: '🛠️', sortOrder: 2 },
  { name: 'Research', emoji: '🔬', sortOrder: 3 },
];

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return Number(value) === 1;
}

function toNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parsePendingInput(raw: unknown): PendingInput | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      'action' in parsed &&
      typeof (parsed as { action: unknown }).action === 'string' &&
      'createdAt' in parsed &&
      typeof (parsed as { createdAt: unknown }).createdAt === 'number'
    ) {
      return parsed as PendingInput;
    }
    return null;
  } catch {
    return null;
  }
}

function mapCategory(row: RawRow): Category {
  return {
    id: Number(row.id),
    name: String(row.name),
    emoji: String(row.emoji),
    sortOrder: Number(row.sort_order),
    createdAt: String(row.created_at),
  };
}

function mapProjectMeta(row: RawRow): ProjectMeta {
  return {
    projectId: String(row.project_id),
    categoryId: toNullableNumber(row.category_id),
    pinned: toBool(row.pinned),
    alias: toNullableString(row.alias),
    notes: toNullableString(row.notes),
    defaultModel: toNullableString(row.default_model),
    defaultEffort: toNullableString(row.default_effort) as AgyEffort | null,
    defaultMode: toNullableString(row.default_mode) as AgyPermissionMode | null,
    updatedAt: String(row.updated_at),
  };
}

function mapChatMeta(row: RawRow): ChatMeta {
  return {
    conversationId: String(row.conversation_id),
    categoryId: toNullableNumber(row.category_id),
    tags: parseJsonArray(row.tags),
    pinned: toBool(row.pinned),
    customTitle: toNullableString(row.custom_title),
    archived: toBool(row.archived),
    updatedAt: String(row.updated_at),
  };
}

function mapTopicBinding(row: RawRow): TopicBinding {
  return {
    chatId: Number(row.chat_id),
    threadId: Number(row.thread_id),
    projectId: toNullableString(row.project_id),
    conversationId: toNullableString(row.conversation_id),
    label: toNullableString(row.label),
    createdAt: String(row.created_at),
  };
}

function mapUserSession(row: RawRow): UserSession {
  const rawLang = String(row.lang);
  const lang: 'en' | 'fa' = rawLang === 'fa' ? 'fa' : 'en';
  return {
    userId: Number(row.user_id),
    activeProjectId: toNullableString(row.active_project_id),
    activeConversationId: toNullableString(row.active_conversation_id),
    model: String(row.model),
    effort: String(row.effort) as AgyEffort,
    mode: String(row.mode) as AgyPermissionMode,
    agent: toNullableString(row.agent),
    sandbox: toBool(row.sandbox),
    skipPermissions: toBool(row.skip_permissions),
    showTools: toBool(row.show_tools),
    showUsage: toBool(row.show_usage),
    autoSendArtifacts: toBool(row.auto_send_artifacts),
    lang,
    pendingInput: parsePendingInput(row.pending_input),
    updatedAt: String(row.updated_at),
  };
}

/**
 * SQLite persistence layer for bot metadata, categories, topic bindings, and user sessions.
 * Uses Node 22 built-in `node:sqlite` (`DatabaseSync`).
 */
export class BotDb {
  private readonly db: DatabaseSync;
  private readonly defaults: BotDbDefaults;

  constructor(dbPath: string, defaults: BotDbDefaults) {
    this.defaults = { ...defaults };

    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }

    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.seedDefaultCategories();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        emoji TEXT NOT NULL DEFAULT '📁',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS project_meta (
        project_id TEXT PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        alias TEXT,
        notes TEXT,
        default_model TEXT,
        default_effort TEXT,
        default_mode TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_meta (
        conversation_id TEXT PRIMARY KEY,
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        pinned INTEGER NOT NULL DEFAULT 0,
        custom_title TEXT,
        archived INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS topic_bindings (
        chat_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        project_id TEXT,
        conversation_id TEXT,
        label TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (chat_id, thread_id)
      );

      CREATE TABLE IF NOT EXISTS user_sessions (
        user_id INTEGER PRIMARY KEY,
        active_project_id TEXT,
        active_conversation_id TEXT,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        mode TEXT NOT NULL,
        agent TEXT,
        sandbox INTEGER NOT NULL DEFAULT 0,
        skip_permissions INTEGER NOT NULL DEFAULT 0,
        show_tools INTEGER NOT NULL DEFAULT 1,
        show_usage INTEGER NOT NULL DEFAULT 1,
        auto_send_artifacts INTEGER NOT NULL DEFAULT 1,
        lang TEXT NOT NULL DEFAULT 'en',
        pending_input TEXT,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private seedDefaultCategories(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM categories').get() as RawRow;
    if (Number(row.count) > 0) {
      return;
    }

    const insert = this.db.prepare(
      'INSERT INTO categories (name, emoji, sort_order, created_at) VALUES (?, ?, ?, ?)',
    );
    const createdAt = nowIso();
    for (const cat of DEFAULT_CATEGORIES) {
      insert.run(cat.name, cat.emoji, cat.sortOrder, createdAt);
    }
  }

  // ── Categories ──────────────────────────────────────────────────────────────

  listCategories(): Category[] {
    const rows = this.db
      .prepare('SELECT * FROM categories ORDER BY sort_order ASC, id ASC')
      .all() as RawRow[];
    return rows.map(mapCategory);
  }

  getCategory(id: number): Category | null {
    const row = this.db
      .prepare('SELECT * FROM categories WHERE id = ?')
      .get(id) as RawRow | undefined;
    return row ? mapCategory(row) : null;
  }

  createCategory(name: string, emoji = '📁'): Category {
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(sort_order), -1) AS max_sort FROM categories')
      .get() as RawRow;
    const sortOrder = Number(maxRow.max_sort) + 1;
    const createdAt = nowIso();
    const res = this.db
      .prepare(
        'INSERT INTO categories (name, emoji, sort_order, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(name, emoji, sortOrder, createdAt);
    const created = this.getCategory(Number(res.lastInsertRowid));
    if (!created) {
      throw new Error('Failed to retrieve newly created category');
    }
    return created;
  }

  renameCategory(id: number, name: string, emoji?: string): Category | null {
    const existing = this.getCategory(id);
    if (!existing) {
      return null;
    }
    const nextEmoji = emoji !== undefined ? emoji : existing.emoji;
    this.db
      .prepare('UPDATE categories SET name = ?, emoji = ? WHERE id = ?')
      .run(name, nextEmoji, id);
    return this.getCategory(id);
  }

  deleteCategory(id: number): boolean {
    const res = this.db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    return Number(res.changes) > 0;
  }

  // ── ProjectMeta ─────────────────────────────────────────────────────────────

  getProjectMeta(projectId: string): ProjectMeta | null {
    const row = this.db
      .prepare('SELECT * FROM project_meta WHERE project_id = ?')
      .get(projectId) as RawRow | undefined;
    return row ? mapProjectMeta(row) : null;
  }

  listAllProjectMeta(): ProjectMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM project_meta ORDER BY pinned DESC, updated_at DESC')
      .all() as RawRow[];
    return rows.map(mapProjectMeta);
  }

  private ensureProjectMeta(projectId: string): ProjectMeta {
    const existing = this.getProjectMeta(projectId);
    if (existing) {
      return existing;
    }
    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO project_meta (
          project_id, category_id, pinned, alias, notes, default_model, default_effort, default_mode, updated_at
        ) VALUES (?, NULL, 0, NULL, NULL, NULL, NULL, NULL, ?)`,
      )
      .run(projectId, updatedAt);
    return this.getProjectMeta(projectId)!;
  }

  setProjectCategory(projectId: string, categoryId: number | null): ProjectMeta {
    this.ensureProjectMeta(projectId);
    this.db
      .prepare('UPDATE project_meta SET category_id = ?, updated_at = ? WHERE project_id = ?')
      .run(categoryId, nowIso(), projectId);
    return this.getProjectMeta(projectId)!;
  }

  toggleProjectPin(projectId: string): ProjectMeta {
    const current = this.ensureProjectMeta(projectId);
    const nextPinned = current.pinned ? 0 : 1;
    this.db
      .prepare('UPDATE project_meta SET pinned = ?, updated_at = ? WHERE project_id = ?')
      .run(nextPinned, nowIso(), projectId);
    return this.getProjectMeta(projectId)!;
  }

  setProjectAlias(projectId: string, alias: string | null): ProjectMeta {
    this.ensureProjectMeta(projectId);
    this.db
      .prepare('UPDATE project_meta SET alias = ?, updated_at = ? WHERE project_id = ?')
      .run(alias, nowIso(), projectId);
    return this.getProjectMeta(projectId)!;
  }

  setProjectDefaults(projectId: string, patch: ProjectDefaultsPatch): ProjectMeta {
    const current = this.ensureProjectMeta(projectId);
    const notes = patch.notes !== undefined ? patch.notes : current.notes;
    const defaultModel =
      patch.defaultModel !== undefined ? patch.defaultModel : current.defaultModel;
    const defaultEffort =
      patch.defaultEffort !== undefined ? patch.defaultEffort : current.defaultEffort;
    const defaultMode =
      patch.defaultMode !== undefined ? patch.defaultMode : current.defaultMode;

    this.db
      .prepare(
        `UPDATE project_meta
         SET notes = ?, default_model = ?, default_effort = ?, default_mode = ?, updated_at = ?
         WHERE project_id = ?`,
      )
      .run(notes, defaultModel, defaultEffort, defaultMode, nowIso(), projectId);

    return this.getProjectMeta(projectId)!;
  }

  // ── ChatMeta ────────────────────────────────────────────────────────────────

  getChatMeta(conversationId: string): ChatMeta | null {
    const row = this.db
      .prepare('SELECT * FROM chat_meta WHERE conversation_id = ?')
      .get(conversationId) as RawRow | undefined;
    return row ? mapChatMeta(row) : null;
  }

  listAllChatMeta(): ChatMeta[] {
    const rows = this.db
      .prepare('SELECT * FROM chat_meta ORDER BY pinned DESC, updated_at DESC')
      .all() as RawRow[];
    return rows.map(mapChatMeta);
  }

  private ensureChatMeta(conversationId: string): ChatMeta {
    const existing = this.getChatMeta(conversationId);
    if (existing) {
      return existing;
    }
    this.db
      .prepare(
        `INSERT INTO chat_meta (
          conversation_id, category_id, tags, pinned, custom_title, archived, updated_at
        ) VALUES (?, NULL, '[]', 0, NULL, 0, ?)`,
      )
      .run(conversationId, nowIso());
    return this.getChatMeta(conversationId)!;
  }

  setChatCategory(conversationId: string, categoryId: number | null): ChatMeta {
    this.ensureChatMeta(conversationId);
    this.db
      .prepare('UPDATE chat_meta SET category_id = ?, updated_at = ? WHERE conversation_id = ?')
      .run(categoryId, nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  setChatTitle(conversationId: string, title: string | null): ChatMeta {
    this.ensureChatMeta(conversationId);
    this.db
      .prepare('UPDATE chat_meta SET custom_title = ?, updated_at = ? WHERE conversation_id = ?')
      .run(title, nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  toggleChatPin(conversationId: string): ChatMeta {
    const current = this.ensureChatMeta(conversationId);
    const nextPinned = current.pinned ? 0 : 1;
    this.db
      .prepare('UPDATE chat_meta SET pinned = ?, updated_at = ? WHERE conversation_id = ?')
      .run(nextPinned, nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  toggleChatArchive(conversationId: string): ChatMeta {
    const current = this.ensureChatMeta(conversationId);
    const nextArchived = current.archived ? 0 : 1;
    this.db
      .prepare('UPDATE chat_meta SET archived = ?, updated_at = ? WHERE conversation_id = ?')
      .run(nextArchived, nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  addChatTag(conversationId: string, tag: string): ChatMeta {
    const current = this.ensureChatMeta(conversationId);
    const normalized = tag.trim();
    if (!normalized || current.tags.includes(normalized)) {
      return current;
    }
    const nextTags = [...current.tags, normalized];
    this.db
      .prepare('UPDATE chat_meta SET tags = ?, updated_at = ? WHERE conversation_id = ?')
      .run(JSON.stringify(nextTags), nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  removeChatTag(conversationId: string, tag: string): ChatMeta {
    const current = this.ensureChatMeta(conversationId);
    const normalized = tag.trim();
    if (!current.tags.includes(normalized)) {
      return current;
    }
    const nextTags = current.tags.filter((t) => t !== normalized);
    this.db
      .prepare('UPDATE chat_meta SET tags = ?, updated_at = ? WHERE conversation_id = ?')
      .run(JSON.stringify(nextTags), nowIso(), conversationId);
    return this.getChatMeta(conversationId)!;
  }

  // ── TopicBindings ───────────────────────────────────────────────────────────

  getTopicBinding(chatId: number, threadId: number): TopicBinding | null {
    const row = this.db
      .prepare('SELECT * FROM topic_bindings WHERE chat_id = ? AND thread_id = ?')
      .get(chatId, threadId) as RawRow | undefined;
    return row ? mapTopicBinding(row) : null;
  }

  listTopicBindings(chatId?: number): TopicBinding[] {
    if (chatId !== undefined) {
      const rows = this.db
        .prepare('SELECT * FROM topic_bindings WHERE chat_id = ? ORDER BY created_at DESC')
        .all(chatId) as RawRow[];
      return rows.map(mapTopicBinding);
    }
    const rows = this.db
      .prepare('SELECT * FROM topic_bindings ORDER BY chat_id ASC, created_at DESC')
      .all() as RawRow[];
    return rows.map(mapTopicBinding);
  }

  upsertTopicBinding(binding: TopicBindingInput): TopicBinding {
    const existing = this.getTopicBinding(binding.chatId, binding.threadId);
    const projectId =
      binding.projectId !== undefined ? binding.projectId : (existing?.projectId ?? null);
    const conversationId =
      binding.conversationId !== undefined
        ? binding.conversationId
        : (existing?.conversationId ?? null);
    const label = binding.label !== undefined ? binding.label : (existing?.label ?? null);
    const createdAt = existing?.createdAt ?? nowIso();

    this.db
      .prepare(
        `INSERT INTO topic_bindings (chat_id, thread_id, project_id, conversation_id, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(chat_id, thread_id) DO UPDATE SET
           project_id = excluded.project_id,
           conversation_id = excluded.conversation_id,
           label = excluded.label`,
      )
      .run(binding.chatId, binding.threadId, projectId, conversationId, label, createdAt);

    return this.getTopicBinding(binding.chatId, binding.threadId)!;
  }

  deleteTopicBinding(chatId: number, threadId: number): boolean {
    const res = this.db
      .prepare('DELETE FROM topic_bindings WHERE chat_id = ? AND thread_id = ?')
      .run(chatId, threadId);
    return Number(res.changes) > 0;
  }

  // ── UserSessions ────────────────────────────────────────────────────────────

  getSession(userId: number): UserSession {
    const row = this.db
      .prepare('SELECT * FROM user_sessions WHERE user_id = ?')
      .get(userId) as RawRow | undefined;
    if (row) {
      return mapUserSession(row);
    }

    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO user_sessions (
          user_id, active_project_id, active_conversation_id, model, effort, mode, agent,
          sandbox, skip_permissions, show_tools, show_usage, auto_send_artifacts, lang,
          pending_input, updated_at
        ) VALUES (?, NULL, NULL, ?, ?, ?, NULL, 0, 0, 1, 1, 1, ?, NULL, ?)`,
      )
      .run(
        userId,
        this.defaults.model,
        this.defaults.effort,
        this.defaults.mode,
        this.defaults.lang,
        updatedAt,
      );

    const created = this.db
      .prepare('SELECT * FROM user_sessions WHERE user_id = ?')
      .get(userId) as RawRow;
    return mapUserSession(created);
  }

  updateSession(userId: number, patch: UserSessionPatch): UserSession {
    const current = this.getSession(userId);
    const next: UserSession = {
      ...current,
      ...patch,
      userId,
      updatedAt: nowIso(),
    };

    this.db
      .prepare(
        `UPDATE user_sessions SET
          active_project_id = ?,
          active_conversation_id = ?,
          model = ?,
          effort = ?,
          mode = ?,
          agent = ?,
          sandbox = ?,
          skip_permissions = ?,
          show_tools = ?,
          show_usage = ?,
          auto_send_artifacts = ?,
          lang = ?,
          pending_input = ?,
          updated_at = ?
         WHERE user_id = ?`,
      )
      .run(
        next.activeProjectId,
        next.activeConversationId,
        next.model,
        next.effort,
        next.mode,
        next.agent,
        next.sandbox ? 1 : 0,
        next.skipPermissions ? 1 : 0,
        next.showTools ? 1 : 0,
        next.showUsage ? 1 : 0,
        next.autoSendArtifacts ? 1 : 0,
        next.lang,
        next.pendingInput ? JSON.stringify(next.pendingInput) : null,
        next.updatedAt,
        userId,
      );

    return this.getSession(userId);
  }

  setPendingInput(userId: number, pendingInput: PendingInput): UserSession {
    return this.updateSession(userId, { pendingInput });
  }

  clearPendingInput(userId: number): UserSession {
    return this.updateSession(userId, { pendingInput: null });
  }

  // ── Stats & Lifecycle ───────────────────────────────────────────────────────

  getStats(): BotDbStats {
    const categories = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM categories').get() as RawRow).count,
    );
    const pinnedProjects = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM project_meta WHERE pinned = 1')
          .get() as RawRow
      ).count,
    );
    const pinnedChats = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS count FROM chat_meta WHERE pinned = 1')
          .get() as RawRow
      ).count,
    );
    const topicBindings = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM topic_bindings').get() as RawRow).count,
    );
    const users = Number(
      (this.db.prepare('SELECT COUNT(*) AS count FROM user_sessions').get() as RawRow).count,
    );

    return {
      categories,
      pinnedProjects,
      pinnedChats,
      topicBindings,
      users,
    };
  }

  close(): void {
    this.db.close();
  }
}
