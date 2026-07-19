import { isTerminalLifecycle, isTerminalTurn } from './transitions';
import type { TaskStoreFile, TaskTurn } from './types';

export const TRUNCATION_MARKER = '\n\n[output truncated by retention policy]';

export interface RetentionConfig {
  maxTurnsPerTask: number;
  maxStoredOutputChars: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  maxTurnsPerTask: 200,
  maxStoredOutputChars: 200_000,
};

function cloneFile(file: TaskStoreFile): TaskStoreFile {
  return JSON.parse(JSON.stringify(file)) as TaskStoreFile;
}

function turnsForTask(file: TaskStoreFile, taskId: string): TaskTurn[] {
  return Object.values(file.turns)
    .filter((turn) => turn.taskId === taskId)
    .sort((a, b) => a.sequence - b.sequence);
}

function maxIso(...values: (string | undefined)[]): string | undefined {
  const present = values.filter((value): value is string => typeof value === 'string');
  if (present.length === 0) {
    return undefined;
  }
  return present.reduce((latest, value) => (value.localeCompare(latest) > 0 ? value : latest));
}

function truncateAssistantOutput(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  const markerBudget = TRUNCATION_MARKER.length;
  const sliceEnd = Math.max(0, maxChars - markerBudget);
  return content.slice(0, sliceEnd) + TRUNCATION_MARKER;
}

function turnsToKeep(turns: TaskTurn[], maxKeep: number): Set<string> {
  const sorted = [...turns].sort((a, b) => b.sequence - a.sequence);
  const keep = new Set(sorted.slice(0, maxKeep).map((turn) => turn.id));

  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const turn of turns) {
      if (keep.has(turn.id) && turn.retryOf && !keep.has(turn.retryOf)) {
        keep.add(turn.retryOf);
        expanded = true;
      }
    }
  }

  return keep;
}

function messageIdsReferencedByTurns(file: TaskStoreFile, turnIds: Iterable<string>): Set<string> {
  const referenced = new Set<string>();
  for (const turnId of turnIds) {
    const turn = file.turns[turnId];
    if (!turn) {
      continue;
    }
    for (const input of turn.inputs) {
      if (input.kind === 'message') {
        referenced.add(input.messageId);
      }
    }
  }
  return referenced;
}

function pruneTerminalTaskTurns(file: TaskStoreFile, taskId: string, maxTurnsPerTask: number): void {
  const turns = turnsForTask(file, taskId);
  if (turns.length <= maxTurnsPerTask) {
    return;
  }

  const keep = turnsToKeep(turns, maxTurnsPerTask);
  const drop = turns.filter((turn) => !keep.has(turn.id)).map((turn) => turn.id);
  if (drop.length === 0) {
    return;
  }

  const dropSet = new Set(drop);
  const keptTurnIds = [...keep];
  const referencedMessages = messageIdsReferencedByTurns(file, keptTurnIds);

  for (const messageId of Object.keys(file.messages)) {
    const message = file.messages[messageId];
    if (message.taskId !== taskId) {
      continue;
    }
    if (message.turnId && dropSet.has(message.turnId)) {
      delete file.messages[messageId];
      continue;
    }
    if (!message.turnId && !referencedMessages.has(messageId)) {
      delete file.messages[messageId];
    }
  }

  for (const turnId of drop) {
    delete file.turns[turnId];
    delete file.operations?.[turnId];
    delete file.cancelRequests?.[turnId];
    delete file.reasoning?.[turnId];
  }

  if (file.toolCalls) {
    for (const key of Object.keys(file.toolCalls)) {
      if (dropSet.has(file.toolCalls[key].turnId)) {
        delete file.toolCalls[key];
      }
    }
  }
}

function truncateOpenTaskOutput(file: TaskStoreFile, taskId: string, maxStoredOutputChars: number): void {
  const settledTurnIds = new Set(
    turnsForTask(file, taskId)
      .filter((turn) => isTerminalTurn(turn.status))
      .map((turn) => turn.id),
  );
  for (const message of Object.values(file.messages)) {
    if (
      message.taskId === taskId &&
      message.role === 'assistant' &&
      message.state === 'complete' &&
      message.turnId !== undefined &&
      settledTurnIds.has(message.turnId) &&
      message.content.length > maxStoredOutputChars
    ) {
      file.messages[message.id] = {
        ...message,
        content: truncateAssistantOutput(message.content, maxStoredOutputChars),
      };
    }
  }
  // Cap persisted tool output and reasoning so display records cannot blow up the store.
  if (file.toolCalls) {
    for (const key of Object.keys(file.toolCalls)) {
      const tc = file.toolCalls[key];
      if (
        tc.taskId === taskId &&
        settledTurnIds.has(tc.turnId) &&
        typeof tc.output === 'string' &&
        tc.output.length > maxStoredOutputChars
      ) {
        file.toolCalls[key] = {
          ...tc,
          output: truncateAssistantOutput(tc.output, maxStoredOutputChars),
        };
      }
    }
  }
  if (file.reasoning) {
    for (const key of Object.keys(file.reasoning)) {
      const r = file.reasoning[key];
      if (r.taskId === taskId && settledTurnIds.has(r.turnId) && r.content.length > maxStoredOutputChars) {
        file.reasoning[key] = {
          ...r,
          content: truncateAssistantOutput(r.content, maxStoredOutputChars),
        };
      }
    }
  }
}

/**
 * Pure, idempotent retention transform over a loaded TaskStoreFile.
 * Open tasks: truncate oversized settled assistant output only.
 * Terminal tasks: may drop oldest turns beyond maxTurnsPerTask.
 */
export function applyRetention(file: TaskStoreFile, config: RetentionConfig = DEFAULT_RETENTION_CONFIG): TaskStoreFile {
  const next = cloneFile(file);

  for (const task of Object.values(next.tasks)) {
    if (isTerminalLifecycle(task.lifecycle)) {
      pruneTerminalTaskTurns(next, task.id, config.maxTurnsPerTask);
    } else {
      truncateOpenTaskOutput(next, task.id, config.maxStoredOutputChars);
    }
  }

  return next;
}

export function retentionChanged(before: TaskStoreFile, after: TaskStoreFile): boolean {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export { maxIso };
