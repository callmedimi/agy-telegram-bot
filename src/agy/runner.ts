import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AppConfig } from '../config.js';
import type {
  AgyInitEvent,
  AgyResultEvent,
  AgyRunOptions,
  AgyStepUpdateEvent,
  AgyStreamEvent,
} from './types.js';

const SIGKILL_GRACE_MS = 3_000;

export interface AgyToolUseEvent {
  name: string;
  state: string;
  stepIndex: number;
}

export interface AgyRunEventMap {
  init: [event: AgyInitEvent];
  step_update: [event: AgyStepUpdateEvent];
  text_delta: [delta: string];
  thinking_delta: [delta: string];
  tool_use: [tool: AgyToolUseEvent];
  result: [result: AgyResultEvent['result']];
  stderr: [chunk: string];
  error: [error: Error];
  aborted: [];
}

/**
 * Typed handle representing an active or completed `agy` subprocess run.
 */
export class AgyRunHandle extends EventEmitter {
  readonly runId: string;
  readonly startedAt: number;
  readonly options: AgyRunOptions;
  conversationId?: string;
  done: Promise<AgyResultEvent['result']>;

  private child: ChildProcess | null = null;
  private finished = false;
  private abortRequested = false;
  private killTimer: NodeJS.Timeout | null = null;

  constructor(options: AgyRunOptions, done: Promise<AgyResultEvent['result']>) {
    super();
    this.runId = randomUUID();
    this.startedAt = Date.now();
    this.options = options;
    this.done = done;
    // Prevent unhandled rejection crashes when callers rely solely on EventEmitter listeners.
    this.done.catch(() => {});
  }

  override on<K extends keyof AgyRunEventMap>(
    eventName: K,
    listener: (...args: AgyRunEventMap[K]) => void,
  ): this;
  override on(
    eventName: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this;
  override on(
    eventName: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.on(eventName, listener);
  }

  override once<K extends keyof AgyRunEventMap>(
    eventName: K,
    listener: (...args: AgyRunEventMap[K]) => void,
  ): this;
  override once(
    eventName: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this;
  override once(
    eventName: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.once(eventName, listener);
  }

  override off<K extends keyof AgyRunEventMap>(
    eventName: K,
    listener: (...args: AgyRunEventMap[K]) => void,
  ): this;
  override off(
    eventName: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this;
  override off(
    eventName: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.off(eventName, listener);
  }

  override emit<K extends keyof AgyRunEventMap>(
    eventName: K,
    ...args: AgyRunEventMap[K]
  ): boolean;
  override emit(eventName: string | symbol, ...args: unknown[]): boolean;
  override emit(eventName: string | symbol, ...args: any[]): boolean {
    return super.emit(eventName, ...args);
  }

  /** @internal */
  attachChild(child: ChildProcess): void {
    this.child = child;
  }

  /** @internal */
  markFinished(): void {
    this.finished = true;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  /** @internal */
  isAborted(): boolean {
    return this.abortRequested;
  }

  /**
   * Abort the running subprocess with SIGTERM, escalating to SIGKILL after 3 seconds.
   */
  abort(): boolean {
    if (this.finished || this.abortRequested || !this.child) {
      return false;
    }
    this.abortRequested = true;

    try {
      this.child.kill('SIGTERM');
    } catch {
      return false;
    }

    this.killTimer = setTimeout(() => {
      if (!this.finished && this.child && this.child.exitCode === null && !this.child.killed) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }
    }, SIGKILL_GRACE_MS);
    this.killTimer.unref();

    return true;
  }
}

/**
 * Parse a single NDJSON line emitted by `agy --output-format stream-json`.
 */
export function parseStreamLine(line: string): AgyStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (record.event === 'init') {
    if (
      typeof record.conversation_id === 'string' &&
      record.init &&
      typeof record.init === 'object'
    ) {
      return parsed as AgyInitEvent;
    }
    return null;
  }

  if (record.event === 'step_update') {
    if (record.step_update && typeof record.step_update === 'object') {
      return parsed as AgyStepUpdateEvent;
    }
    return null;
  }

  if (record.event === 'result') {
    if (record.result && typeof record.result === 'object') {
      return parsed as AgyResultEvent;
    }
    return null;
  }

  return null;
}

/**
 * Build CLI arguments for spawning `agy` in stream-json print mode.
 */
export function buildAgyArgs(options: AgyRunOptions): string[] {
  const args: string[] = ['-p', options.prompt, '--output-format', 'stream-json'];

  if (options.conversationId) {
    args.push('--conversation', options.conversationId);
  } else if (options.project) {
    args.push('--project', options.project);
  }

  if (options.model) {
    args.push('--model', options.model);
  }
  if (options.effort) {
    args.push('--effort', options.effort);
  }
  if (options.mode) {
    args.push('--mode', options.mode);
  }
  if (options.agent) {
    args.push('--agent', options.agent);
  }
  if (options.sandbox) {
    args.push('--sandbox');
  }
  if (options.skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  if (options.addDirs) {
    for (const dir of options.addDirs) {
      args.push('--add-dir', dir);
    }
  }

  return args;
}

/**
 * Spawns and manages `agy` CLI turns with NDJSON streaming and timeout/abort controls.
 */
export class AgyRunner {
  private readonly config: AppConfig;
  private readonly activeRuns = new Map<string, AgyRunHandle>();

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Start a new `agy` turn and return a streaming handle.
   */
  run(options: AgyRunOptions): AgyRunHandle {
    let resolveDone!: (value: AgyResultEvent['result']) => void;
    let rejectDone!: (reason?: unknown) => void;
    const done = new Promise<AgyResultEvent['result']>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    const handle = new AgyRunHandle(options, done);
    this.activeRuns.set(handle.runId, handle);

    const args = buildAgyArgs(options);
    const cwd = options.cwd || process.cwd();
    const child = spawn(this.config.agyBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    handle.attachChild(child);

    let stdoutBuffer = '';
    let stderrText = '';
    let finalResult: AgyResultEvent['result'] | null = null;
    let timedOut = false;
    let settled = false;

    const emitErrorSafe = (err: Error): void => {
      if (handle.listenerCount('error') > 0) {
        handle.emit('error', err);
      }
    };

    const processLine = (line: string): void => {
      const event = parseStreamLine(line);
      if (!event) {
        return;
      }

      if (event.event === 'init') {
        handle.conversationId = event.conversation_id;
        handle.emit('init', event);
        return;
      }

      if (event.event === 'step_update') {
        const su = event.step_update;
        if (!handle.conversationId && su.conversation_id) {
          handle.conversationId = su.conversation_id;
        }
        handle.emit('step_update', event);

        if (su.text_delta) {
          handle.emit('text_delta', su.text_delta);
        }
        if (su.thinking_delta) {
          handle.emit('thinking_delta', su.thinking_delta);
        }
        const isToolStep =
          Boolean(su.tool_name) ||
          (su.step_type !== '' &&
            su.step_type !== 'user_input' &&
            su.step_type !== 'agent_response');
        if (isToolStep) {
          handle.emit('tool_use', {
            name: su.tool_name ?? su.step_type,
            state: su.state,
            stepIndex: su.step_index,
          });
        }
        return;
      }

      if (event.event === 'result') {
        finalResult = event.result;
        if (event.result.conversation_id) {
          handle.conversationId = event.result.conversation_id;
        }
        handle.emit('result', event.result);
      }
    };

    const timeoutMs = options.timeoutMs ?? this.config.maxTurnTimeoutMs;
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        handle.abort();
      }, timeoutMs);
      timeoutTimer.unref();
    }

    const cleanup = (): void => {
      handle.markFinished();
      this.activeRuns.delete(handle.runId);
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = stdoutBuffer.slice(0, newlineIdx);
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = stdoutBuffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrText += chunk;
      if (stderrText.length > 4000) {
        stderrText = stderrText.slice(-4000);
      }
      handle.emit('stderr', chunk);
    });

    child.on('error', (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      emitErrorSafe(err);
      rejectDone(err);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (stdoutBuffer.trim()) {
        processLine(stdoutBuffer);
        stdoutBuffer = '';
      }

      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      if (timedOut) {
        const err = new Error(`AGY run timed out after ${timeoutMs}ms`);
        emitErrorSafe(err);
        rejectDone(err);
        return;
      }

      if (handle.isAborted()) {
        handle.emit('aborted');
        rejectDone(new Error('AGY run aborted'));
        return;
      }

      if (finalResult) {
        resolveDone(finalResult);
        return;
      }

      const detail = stderrText.trim() ? `: ${stderrText.trim()}` : '';
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`;
      const err = new Error(`AGY exited with ${reason} without a result event${detail}`);
      emitErrorSafe(err);
      rejectDone(err);
    });

    return handle;
  }

  getRun(runId: string): AgyRunHandle | undefined {
    return this.activeRuns.get(runId);
  }

  abortRun(runId: string): boolean {
    const handle = this.activeRuns.get(runId);
    if (!handle) {
      return false;
    }
    return handle.abort();
  }

  listActiveRuns(): AgyRunHandle[] {
    return Array.from(this.activeRuns.values());
  }

  abortAll(): number {
    let abortedCount = 0;
    for (const handle of this.activeRuns.values()) {
      if (handle.abort()) {
        abortedCount += 1;
      }
    }
    return abortedCount;
  }
}
