/**
 * TypeScript definitions matching Antigravity CLI (`agy` v1.5.18)
 * stream-JSON events, CLI metadata outputs, and execution options.
 */

export type AgyEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type AgyPermissionMode = 'auto' | 'accept-edits' | 'plan';

export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
}

export interface AgyInitEvent {
  event: 'init';
  conversation_id: string;
  init: {
    model: string;
    cwd: string;
    tools: string[];
    permission_mode: string;
  };
}

export interface AgyStepUpdateEvent {
  event: 'step_update';
  step_update: {
    conversation_id: string;
    step_index: number;
    state: string;
    step_type: string;
    text_delta?: string;
    thinking_delta?: string;
    tool_name?: string;
    tool_input?: unknown;
    tool_output?: unknown;
    duration_seconds?: number;
    usage?: AgyUsage;
  };
}

export interface AgyResultEvent {
  event: 'result';
  result: {
    conversation_id: string;
    status: string;
    response?: string;
    error?: string;
    finished_reason?: string;
    duration_seconds?: number;
    num_turns?: number;
    usage?: AgyUsage;
  };
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export interface AgyProject {
  id: string;
  name: string;
  paths: string[];
  isWorkspaceOnly?: boolean;
  raw?: Record<string, unknown>;
}

export interface AgyConversation {
  conversationId: string;
  title: string;
  preview: string;
  stepCount: number;
  lastModifiedTime: string;
  workspaceUris: string[];
  status: string;
  projectId: string;
  agentName: string;
  lastUserInputTime: string;
}

export interface AgyModel {
  id: string;
  label: string;
  family: string;
}

export interface AgyMcpServer {
  name: string;
  type: string;
  status: string;
  target: string;
}

export interface AgySkill {
  name: string;
  description: string;
  path: string;
}

export interface AgyArtifact {
  name: string;
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
  mtimeMs: number;
  ext: string;
}

export interface AgyRunOptions {
  prompt: string;
  conversationId?: string;
  project?: string;
  cwd?: string;
  addDirs?: string[];
  model?: string;
  effort?: AgyEffort;
  mode?: AgyPermissionMode;
  agent?: string;
  sandbox?: boolean;
  skipPermissions?: boolean;
  timeoutMs?: number;
}
