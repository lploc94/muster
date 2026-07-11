/**
 * Command service — single entry for slash/palette/CLI.
 * No vscode imports.
 */

import { workflowError, type CommandEffectClass, type NativeCommandId } from '../workflow/contracts';
import { getCommandSpec, resolveCommandId } from './registry';
import { parseInput } from './parser';
import type {
  CommandDomainPort,
  CommandInteractionPort,
  CommandPresenterHint,
  CommandRequest,
  CommandResult,
} from './types';

export interface CommandServiceOptions {
  domain: CommandDomainPort;
  interaction?: CommandInteractionPort;
}

function err(
  code: Parameters<typeof workflowError>[0],
  message: string,
  commandId?: NativeCommandId,
  details?: Record<string, unknown>,
): CommandResult {
  return {
    ok: false,
    commandId,
    error: workflowError(code, message, details),
    presenter: 'error',
  };
}

function ok(
  commandId: NativeCommandId,
  presenter: CommandPresenterHint,
  partial: { message?: string; data?: unknown; effectClass?: CommandEffectClass } = {},
): CommandResult {
  const spec = getCommandSpec(commandId);
  return {
    ok: true,
    commandId,
    effectClass: partial.effectClass ?? spec?.effectClass ?? 'read',
    presenter,
    message: partial.message,
    data: partial.data,
  };
}

export class CommandService {
  private readonly domain: CommandDomainPort;
  private readonly interaction?: CommandInteractionPort;

  constructor(options: CommandServiceOptions) {
    this.domain = options.domain;
    this.interaction = options.interaction;
  }

  /** Parse raw input and execute if it is a slash command; otherwise return null (plain prompt). */
  async handleInput(
    input: string,
    context: { focusedTaskId?: string; rootTaskId?: string; opId?: string; now?: string } = {},
  ): Promise<CommandResult | { kind: 'plain'; text: string } | { kind: 'empty' }> {
    const parsed = parseInput(input);
    if (parsed.kind === 'empty') return parsed;
    if (parsed.kind === 'plain') return parsed;

    const commandId = resolveCommandId(parsed.name);
    if (!commandId) {
      return err('COMMAND_UNKNOWN', `Unknown command /${parsed.name}. Try /help.`, undefined, {
        name: parsed.name,
      });
    }

    const request: CommandRequest = {
      commandId,
      rawName: parsed.name,
      argv: parsed.argv,
      rawArgs: parsed.rawArgs,
      focusedTaskId: context.focusedTaskId ?? this.domain.getFocusedTaskId(),
      rootTaskId: context.rootTaskId,
      opId: context.opId,
      now: context.now,
    };
    return this.execute(request);
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    const spec = getCommandSpec(request.commandId);
    if (!spec) {
      return err('COMMAND_UNKNOWN', `Unknown command ${request.commandId}`);
    }

    const focused = request.focusedTaskId ?? this.domain.getFocusedTaskId();
    if (spec.requiresTask && !focused && request.commandId !== 'new') {
      // /new does not require an existing task
      if (request.commandId !== 'help' && request.commandId !== 'tasks' && request.commandId !== 'mcp') {
        return err(
          'NOT_FOUND',
          `/${request.commandId} requires a focused task`,
          request.commandId,
        );
      }
    }

    const rootId = request.rootTaskId ?? focused;
    if (spec.requiredPhases && rootId) {
      const phase = this.domain.getWorkflowPhase(rootId);
      if (phase && !spec.requiredPhases.includes(phase)) {
        return err(
          'COMMAND_PHASE',
          `/${request.commandId} is not available in phase '${phase}'`,
          request.commandId,
          { phase, required: spec.requiredPhases },
        );
      }
    }

    switch (request.commandId) {
      case 'help':
        return ok('help', 'help', {
          message: 'Native Muster commands',
          data: { commands: this.domain.getHelpEntries() },
        });
      case 'tasks':
        return ok('tasks', 'task_list', {
          data: { tasks: this.domain.listTasks() },
        });
      case 'new':
        return this.handleNew(request);
      case 'focus':
        return this.handleFocus(request);
      case 'status': {
        const taskId = request.argv[0] ?? focused;
        if (!taskId) {
          return err('NOT_FOUND', 'No task id for /status', 'status');
        }
        return ok('status', 'status', { data: this.domain.getStatus(taskId) });
      }
      case 'cancel': {
        const taskId = request.argv[0] ?? focused;
        if (!taskId) {
          return err('NOT_FOUND', 'No task id for /cancel', 'cancel');
        }
        if (this.interaction) {
          const yes = await this.interaction.confirm(`Cancel task ${taskId}?`);
          if (!yes) {
            return ok('cancel', 'message', { message: 'Cancel aborted' });
          }
        }
        const result = this.domain.cancelTask(taskId);
        if (!result.ok) {
          return err('NOT_FOUND', result.reason, 'cancel');
        }
        return ok('cancel', 'message', { message: `Cancelled ${taskId}` });
      }
      case 'approve': {
        if (!rootId) {
          return err('NOT_FOUND', 'No root task for /approve', 'approve');
        }
        return this.domain.approvePlan({
          rootTaskId: rootId,
          planArtifactId: request.argv[0],
          opId: request.opId ?? `approve:${rootId}:${request.now ?? Date.now()}`,
        });
      }
      case 'replan': {
        if (!rootId) {
          return err('NOT_FOUND', 'No root task for /replan', 'replan');
        }
        return this.domain.replan({ rootTaskId: rootId });
      }
      case 'mcp':
        return ok('mcp', 'message', {
          message: 'MCP is injected per turn via Muster Bridge + optional context_engine',
          data: { servers: ['muster_bridge', 'context_engine?'] },
        });
      case 'context':
      case 'compact':
      case 'export':
      case 'archive':
        // Utility commands — domain may implement via runWorkflowCommand or specialized handlers
        return this.domain.runWorkflowCommand({ ...request, focusedTaskId: focused });
      default:
        // Workflow routes implemented in later phases via domain port
        return this.domain.runWorkflowCommand({ ...request, focusedTaskId: focused });
    }
  }

  private handleNew(request: CommandRequest): CommandResult {
    const backendIndex = request.argv.indexOf('--backend');
    const modelIndex = request.argv.indexOf('--model');
    const backend = backendIndex >= 0 ? request.argv[backendIndex + 1] : undefined;
    const model = modelIndex >= 0 ? request.argv[modelIndex + 1] : undefined;
    if ((backendIndex >= 0 && !backend) || (modelIndex >= 0 && !model)) {
      return err('COMMAND_ARGS', '/new option requires a value', 'new');
    }
    const goal = request.argv
      .filter((arg, index) => {
        if (backendIndex >= 0 && (index === backendIndex || index === backendIndex + 1)) return false;
        if (modelIndex >= 0 && (index === modelIndex || index === modelIndex + 1)) return false;
        return true;
      })
      .join(' ')
      .trim();
    if (!goal) {
      const draft = this.domain.createDraft();
      return ok('new', 'message', {
        message: `Draft chat created (${draft.taskId})`,
        data: draft,
      });
    }
    // backend defaults left to domain (settings / last used)
    const created = this.domain.createRootWithGoal({
      goal,
      backend: backend ?? 'claude',
      ...(model ? { model } : {}),
      message: goal,
    });
    return ok('new', 'plan_card', {
      message: `Root task created for: ${goal}`,
      data: created,
    });
  }

  private handleFocus(request: CommandRequest): CommandResult {
    const taskId = request.argv[0];
    if (!taskId) {
      return err('COMMAND_ARGS', '/focus requires a task id', 'focus');
    }
    const result = this.domain.focusTask(taskId);
    if (!result.ok) {
      return err('NOT_FOUND', result.reason, 'focus');
    }
    return ok('focus', 'message', { message: `Focused ${taskId}`, data: { taskId } });
  }
}

// Re-export helpers used by adapters
export { parseInput, isSlashCommand } from './parser';
export { listCommandSpecs, resolveCommandId, helpEntries } from './registry';
export type { CommandRequest, CommandResult, CommandDomainPort, CommandInteractionPort } from './types';
