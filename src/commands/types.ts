/**
 * VS Code-free command contracts.
 * Adapters (webview, palette, CLI) present results; core returns structured data.
 */

import type {
  CommandEffectClass,
  NativeCommandId,
  WorkflowError,
  WorkflowPhase,
} from '../workflow/contracts';

export type CommandParseResult =
  | { kind: 'command'; name: string; rawArgs: string; argv: string[] }
  | { kind: 'plain'; text: string }
  | { kind: 'empty' };

export interface CommandRequest {
  /** Canonical command id (after alias resolution). */
  commandId: NativeCommandId;
  /** Original slash name as typed. */
  rawName: string;
  argv: string[];
  rawArgs: string;
  /** Focused task id when known. */
  focusedTaskId?: string;
  /** Root task id when known. */
  rootTaskId?: string;
  /** Optional idempotency key from the adapter. */
  opId?: string;
  /** ISO time for deterministic tests. */
  now?: string;
}

export type CommandPresenterHint =
  | 'help'
  | 'task_list'
  | 'status'
  | 'plan_card'
  | 'approval'
  | 'message'
  | 'error'
  | 'export'
  | 'context'
  | 'none';

export type CommandResult =
  | {
      ok: true;
      commandId: NativeCommandId;
      effectClass: CommandEffectClass;
      presenter: CommandPresenterHint;
      message?: string;
      data?: unknown;
    }
  | {
      ok: false;
      commandId?: NativeCommandId;
      error: WorkflowError;
      presenter: 'error';
    };

/** Interaction port — VS Code dialogs / CLI prompts implement this. */
export interface CommandInteractionPort {
  confirm(message: string): Promise<boolean>;
  choose(message: string, options: string[]): Promise<string | undefined>;
  ask(message: string): Promise<string | undefined>;
  /** Save exported content; returns path or undefined if cancelled. */
  save?(defaultName: string, content: string, format: 'md' | 'json'): Promise<string | undefined>;
}

/** Domain port — implemented by TaskEngine + workflow orchestration. */
export interface CommandDomainPort {
  getFocusedTaskId(): string | undefined;
  getWorkflowPhase(rootTaskId: string): WorkflowPhase | undefined;
  listTasks(): Array<{ id: string; goal: string; lifecycle: string; parentId: string | null }>;
  createDraft(params?: { backend?: string }): { taskId: string };
  createRootWithGoal(params: {
    goal: string;
    backend: string;
    model?: string;
    message?: string;
  }): { taskId: string; turnId?: string };
  focusTask(taskId: string): { ok: true } | { ok: false; reason: string };
  cancelTask(taskId: string): { ok: true } | { ok: false; reason: string };
  getStatus(taskId: string): unknown;
  approvePlan(params: {
    rootTaskId: string;
    planArtifactId?: string;
    opId: string;
  }): CommandResult;
  replan(params: { rootTaskId: string }): CommandResult;
  /** Generic workflow command dispatch for implement/test/… */
  runWorkflowCommand(request: CommandRequest): CommandResult | Promise<CommandResult>;
  getHelpEntries(): Array<{ id: string; summary: string; aliases: string[] }>;
}
