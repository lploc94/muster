/**
 * Pure helpers for the v2 runtime-switch continuation contract.
 *
 * A switch persists only a deterministic cutoff and digest. The readable
 * continuation is rebuilt from committed store rows when the first real target
 * turn is frozen. No source-summary or receiver-bootstrap agent turn exists.
 */

import { createHash } from 'crypto';
import * as path from 'path';
import type {
  MusterTask,
  PersistedToolCall,
  TaskContinuationHandoffState,
  TaskHandoffContextCutoff,
  TaskMessage,
  EngineProjection,
  TaskTurn,
} from './types';
import { sanitizeHandoffFailureMessage } from './sanitization';

export const MAX_CONTINUATION_MESSAGES = 160;
export const MAX_CONTINUATION_TOOL_CALLS = 160;
export const MAX_CONTINUATION_CHARS = 64_000;
const MAX_ENTRY_CHARS = 4_000;

interface ContextRows {
  messages: TaskMessage[];
  toolCalls: PersistedToolCall[];
  turns: TaskTurn[];
  throughTurnSequence: number;
}

function turnMapForTask(file: EngineProjection, taskId: string): Map<string, TaskTurn> {
  return new Map(
    Object.values(file.turns)
      .filter((turn) => turn.taskId === taskId)
      .map((turn) => [turn.id, turn]),
  );
}

function committedRows(
  file: EngineProjection,
  taskId: string,
  throughTurnSequence = Number.POSITIVE_INFINITY,
): ContextRows {
  const turns = turnMapForTask(file, taskId);
  const includedTurns = [...turns.values()]
    .filter((turn) => turn.status !== 'queued' && turn.sequence <= throughTurnSequence)
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
  const includedTurnIds = new Set(includedTurns.map((turn) => turn.id));
  const through = includedTurns.reduce((max, turn) => Math.max(max, turn.sequence), 0);

  const messages = Object.values(file.messages)
    .filter((message) => {
      if (message.taskId !== taskId || message.role === 'system') return false;
      if (message.state === 'pending') return false;
      if (message.turnId) return includedTurnIds.has(message.turnId);
      // User messages are linked from turn.inputs rather than message.turnId.
      return [...includedTurnIds].some((turnId) =>
        turns.get(turnId)?.inputs.some(
          (input) => input.kind === 'message' && input.messageId === message.id,
        ),
      );
    })
    .sort((a, b) => {
      const aSeq = a.turnId ? turns.get(a.turnId)?.sequence ?? 0 : messageSequence(a.id, turns);
      const bSeq = b.turnId ? turns.get(b.turnId)?.sequence ?? 0 : messageSequence(b.id, turns);
      return aSeq - bSeq || (a.order ?? -1) - (b.order ?? -1) || a.id.localeCompare(b.id);
    });

  const toolCalls = Object.values(file.toolCalls ?? {})
    .filter(
      (call) =>
        call.taskId === taskId &&
        includedTurnIds.has(call.turnId) &&
        call.status !== 'running',
    )
    .sort((a, b) => {
      const aSeq = turns.get(a.turnId)?.sequence ?? 0;
      const bSeq = turns.get(b.turnId)?.sequence ?? 0;
      return aSeq - bSeq || a.order - b.order || a.id.localeCompare(b.id);
    });

  return { messages, toolCalls, turns: includedTurns, throughTurnSequence: through };
}

function messageSequence(messageId: string, turns: ReadonlyMap<string, TaskTurn>): number {
  for (const turn of turns.values()) {
    if (turn.inputs.some((input) => input.kind === 'message' && input.messageId === messageId)) {
      return turn.sequence;
    }
  }
  return 0;
}

function digestRows(messages: readonly TaskMessage[], toolCalls: readonly PersistedToolCall[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(`m\0${message.role}\0${message.agentContent ?? message.content}\n`);
  }
  for (const call of toolCalls) {
    hash.update(`t\0${call.name}\0${stableValue(call.input)}\0${call.status}\0`);
    hash.update(call.error ?? stableValue(call.output));
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 32);
}

/** Capture the immutable boundary used by the first real turn after a switch. */
export function captureContinuationCutoff(
  file: EngineProjection,
  taskId: string,
  capturedAt: string,
): TaskHandoffContextCutoff {
  const rows = committedRows(file, taskId);
  const messages = rows.messages.slice(-MAX_CONTINUATION_MESSAGES);
  const toolCalls = rows.toolCalls.slice(-MAX_CONTINUATION_TOOL_CALLS);
  const lastMessage = messages.at(-1);
  const lastToolCall = toolCalls.at(-1);
  return {
    ...(lastMessage ? { throughMessageId: lastMessage.id } : {}),
    ...(lastToolCall ? { throughToolCallId: lastToolCall.id } : {}),
    throughTurnSequence: rows.throughTurnSequence,
    sourceStoreRevision: file.revision,
    messageCount: messages.length,
    toolCallCount: toolCalls.length,
    contextDigest: digestRows(messages, toolCalls),
    capturedAt,
  };
}

function stableValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stableValue).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => `${key}: ${stableValue(record[key])}`)
      .join('\n');
  }
  return String(value);
}

function redactText(text: string): string {
  return sanitizeHandoffFailureMessage(text)
    .replace(/\b(?:session[_-]?id|request[_-]?id|message[_-]?id|tool[_-]?call[_-]?id)\b\s*[:=]\s*\S+/gi, '[id]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[id]');
}

function workspaceRelativePath(raw: string, cwd?: string): string {
  const cleaned = raw.trim();
  if (!cleaned) return cleaned;
  if (cwd) {
    const absCwd = path.resolve(cwd);
    const absPath = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(absCwd, cleaned);
    if (absPath === absCwd) return '.';
    if (absPath.startsWith(`${absCwd}${path.sep}`)) {
      return path.relative(absCwd, absPath).split(path.sep).join('/');
    }
  }
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:[\\/]/.test(cleaned)) {
    return path.basename(cleaned);
  }
  return cleaned.replace(/\\/g, '/');
}

function clip(text: string, max = MAX_ENTRY_CHARS): string {
  const normalized = redactText(text.replace(/\r\n/g, '\n').trim());
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function pickString(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return undefined;
}

function pickNumber(value: unknown, keys: readonly string[]): number | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const item = record[key];
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string' && item.trim() && /^-?\d+$/.test(item.trim())) {
      return Number(item.trim());
    }
  }
  return undefined;
}

function formatTool(call: PersistedToolCall, cwd?: string): string[] {
  const lower = call.name.toLowerCase();
  const isShell = /bash|shell|terminal|exec_command|run_command/.test(lower);
  const isEdit = /edit|write|apply_patch|create_file/.test(lower);
  const isRead = /read|search|grep|glob|list_dir|find/.test(lower);
  const command = pickString(call.input, ['cmd', 'command', 'script']);
  const rawPath = pickString(call.input, ['file_path', 'path', 'file', 'target']);
  const relPath = rawPath ? workspaceRelativePath(rawPath, cwd) : undefined;
  const exitCode = pickNumber(call.output, ['exitCode', 'exit_code', 'code', 'status']);
  const outputText =
    typeof call.output === 'string'
      ? call.output
      : pickString(call.output, ['stdout', 'stderr', 'output', 'content', 'text']);
  const lines: string[] = [];

  if (isShell) {
    // Never serialize arbitrary input objects (env/argv dumps can carry secrets).
    lines.push(command ? `bash ${clip(command, 1_000)}` : `bash ${call.name}`);
    if (exitCode !== undefined) lines.push(`exit: ${exitCode}`);
    else if (call.status === 'error') lines.push('exit: error');
    const tail = clip(call.error ?? outputText ?? '', 800);
    if (tail) {
      lines.push('output:');
      for (const line of tail.split('\n').slice(-8)) lines.push(`  ${line}`);
    }
  } else if (isEdit) {
    lines.push(`edit ${clip(relPath ?? command ?? call.name, 500)}`);
    lines.push(`result: ${call.status === 'error' ? 'failure' : 'success'}`);
    const err = call.error ? clip(call.error, 400) : '';
    if (err) lines.push(`error: ${err}`);
  } else if (isRead) {
    if (call.status === 'error') {
      lines.push(`tool ${call.name}${relPath ? `: ${clip(relPath, 300)}` : ''}`);
      lines.push(`error: ${clip(call.error ?? 'tool failed', 400)}`);
    }
    // Omit repetitive successful read/search noise.
  } else {
    const summary = command ?? relPath;
    lines.push(`tool ${call.name}${summary ? `: ${clip(summary, 500)}` : ''}`);
    if (call.status === 'error') lines.push(`error: ${clip(call.error ?? 'tool failed', 400)}`);
    else if (call.status === 'success') lines.push('result: success');
  }
  return lines;
}

interface TimelineEntry {
  sequence: number;
  order: number;
  tie: string;
  priority: number;
  lines: string[];
}

function formatTurnTerminal(turn: TaskTurn): string[] {
  if (turn.status === 'queued' || turn.status === 'running' || turn.status === 'waiting_user') {
    return [];
  }
  const label =
    turn.status === 'succeeded'
      ? 'completed'
      : turn.status === 'failed'
        ? 'failed'
        : turn.status === 'interrupted'
          ? 'interrupted'
          : turn.status;
  const error =
    typeof turn.error === 'string' && turn.error.trim()
      ? clip(turn.error, 400)
          : turn.disposition?.kind === 'fail' && typeof turn.disposition.error === 'string'
        ? clip(turn.disposition.error, 400)
        : '';
  return error ? [`turn ${turn.sequence}: ${label} — ${error}`] : [`turn ${turn.sequence}: ${label}`];
}

function currentStateLines(task: MusterTask | undefined, turns: readonly TaskTurn[]): string[] {
  const lines: string[] = [];
  const latest = [...turns].sort((a, b) => b.sequence - a.sequence)[0];
  if (latest) {
    const terminal = formatTurnTerminal(latest);
    if (terminal.length > 0) lines.push(...terminal.map((line) => `- ${line}`));
  }
  if (task?.attention?.message) {
    lines.push(`- attention: ${clip(task.attention.message, 300)}`);
  }
  if (task?.pendingParentQuestion) {
    lines.push('- pending parent question');
  }
  if (task?.taskResult?.summary) {
    lines.push(`- last result: ${clip(task.taskResult.summary, 300)}`);
  }
  if (typeof task?.error === 'string' && task.error.trim()) {
    lines.push(`- last error: ${clip(task.error, 300)}`);
  }
  return lines;
}

/**
 * Render useful state as compact prose/tool notation, never protocol JSON. The
 * result intentionally precedes the current user message in projectPrompt.
 *
 * Priority under truncation (newest retained first, then chronological render):
 * 1. current durable state / latest unfinished user request
 * 2. recent user/assistant + state-changing/error tools
 * 3. older history
 */
export function buildCompactContinuationContext(
  file: EngineProjection,
  taskId: string,
  handoff: TaskContinuationHandoffState,
  maxChars = MAX_CONTINUATION_CHARS,
): string {
  const rows = committedRows(file, taskId, handoff.contextCutoff.throughTurnSequence);
  const turns = turnMapForTask(file, taskId);
  const task = file.tasks[taskId];
  const cwd = task?.cwd;
  const messageBoundary = handoff.contextCutoff.throughMessageId
    ? rows.messages.findIndex((message) => message.id === handoff.contextCutoff.throughMessageId)
    : -1;
  const toolBoundary = handoff.contextCutoff.throughToolCallId
    ? rows.toolCalls.findIndex((call) => call.id === handoff.contextCutoff.throughToolCallId)
    : -1;
  const messagesThroughCutoff = handoff.contextCutoff.messageCount === 0
    ? []
    : messageBoundary >= 0
      ? rows.messages.slice(0, messageBoundary + 1)
      : [];
  const toolsThroughCutoff = handoff.contextCutoff.toolCallCount === 0
    ? []
    : toolBoundary >= 0
      ? rows.toolCalls.slice(0, toolBoundary + 1)
      : [];
  const messages = handoff.contextCutoff.messageCount > 0
    ? messagesThroughCutoff.slice(-handoff.contextCutoff.messageCount)
    : [];
  const toolCalls = handoff.contextCutoff.toolCallCount > 0
    ? toolsThroughCutoff.slice(-handoff.contextCutoff.toolCallCount)
    : [];
  const entries: TimelineEntry[] = [];

  const latestUserId = [...messages].reverse().find((message) => message.role === 'user')?.id;
  for (const message of messages) {
    const sequence = message.turnId
      ? turns.get(message.turnId)?.sequence ?? 0
      : messageSequence(message.id, turns);
    const body = clip(message.agentContent ?? message.content);
    if (!body) continue;
    const isLatestUser = message.role === 'user' && message.id === latestUserId;
    entries.push({
      sequence,
      order: message.role === 'user' ? -1 : message.order ?? 0,
      tie: `m:${message.id}`,
      // Only the latest unfinished user request outranks durable state.
      priority: isLatestUser ? 100 : message.role === 'user' ? 55 : 45,
      lines: [`${message.role === 'user' ? 'User' : 'Assistant'}: ${body}`],
    });
  }
  for (const call of toolCalls) {
    const lines = formatTool(call, cwd);
    if (lines.length === 0) continue;
    const lower = call.name.toLowerCase();
    const isShell = /bash|shell|terminal|exec_command|run_command/.test(lower);
    const isEdit = /edit|write|apply_patch|create_file/.test(lower);
    const isVerify = /test|verify|check/.test(lower) || isShell;
    entries.push({
      sequence: turns.get(call.turnId)?.sequence ?? 0,
      order: call.order,
      tie: `t:${call.id}`,
      priority:
        call.status === 'error' ? 90 : isEdit || isVerify ? 85 : isShell ? 80 : 40,
      lines,
    });
  }
  for (const turn of rows.turns) {
    const lines = formatTurnTerminal(turn);
    if (lines.length === 0) continue;
    entries.push({
      sequence: turn.sequence,
      order: 10_000,
      tie: `turn:${turn.id}`,
      // Terminal/current durable state outranks ordinary conversation history.
      priority: turn.status === 'failed' || turn.status === 'interrupted' ? 95 : 88,
      lines,
    });
  }

  const header = [
    '## Continuation context',
    '',
    'This is the compact committed context from the runtime used before the model switch.',
    'Continue the same task. Treat the following as prior conversation/work, not as a new user request.',
    '',
  ];
  const stateLines = currentStateLines(task, rows.turns);
  const stateBlock =
    stateLines.length > 0 ? ['Current state:', ...stateLines, ''] : [];
  const footer: string[] = [];
  const fixed = [...header, ...stateBlock, ...footer].join('\n');
  if (fixed.length > maxChars) {
    return fixed.slice(0, Math.max(0, maxChars - 1)) + (maxChars > 0 ? '…' : '');
  }

  // Newest-first retention under budget, then restore chronological order.
  const ranked = [...entries].sort(
    (a, b) =>
      b.priority - a.priority ||
      b.sequence - a.sequence ||
      b.order - a.order ||
      b.tie.localeCompare(a.tie),
  );
  const retained = new Set<string>();
  let used = fixed.length;
  for (const entry of ranked) {
    const chunk = `${entry.lines.join('\n')}\n`;
    if (used + chunk.length > maxChars) continue;
    retained.add(entry.tie);
    used += chunk.length;
  }

  const chronological = entries
    .filter((entry) => retained.has(entry.tie))
    .sort((a, b) => a.sequence - b.sequence || a.order - b.order || a.tie.localeCompare(b.tie));

  const output = [...header, ...stateBlock];
  for (const entry of chronological) {
    output.push(...entry.lines, '');
  }
  while (output.length > 0 && output[output.length - 1] === '') output.pop();
  return output.join('\n');
}
