import type { Backend } from '../types';
import { ClaudeBackend } from './claude';
import { CodexBackend } from './codex';
import { GrokBackend } from './grok';
import { KiroBackend } from './kiro';
import { OpenCodeBackend } from './opencode';
import { ScriptBackend } from './script';

export type ExecutorKind = 'acp' | 'script';
export type ExecutorFactory = (executorId: string) => Backend;

export interface ExecutorFamilyDescriptor<Ids extends readonly string[] = readonly string[]> {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly executorIds: Ids;
  readonly factory: ExecutorFactory;
}

export interface RegisteredExecutorFamily {
  readonly id: string;
  readonly kind: ExecutorKind;
  readonly executorIds: readonly string[];
  readonly factory: ExecutorFactory;
}

/** Isolated registry so test registrations never widen production inventories. */
export class ExecutorRegistry {
  private readonly familiesById = new Map<string, RegisteredExecutorFamily>();
  private readonly familiesByExecutorId = new Map<string, RegisteredExecutorFamily>();

  register<Ids extends readonly string[]>(
    descriptor: ExecutorFamilyDescriptor<Ids>,
  ): RegisteredExecutorFamily {
    if (!descriptor.id.trim()) throw new Error('executor family id must be non-empty');
    if (descriptor.executorIds.length === 0) {
      throw new Error(`executor family "${descriptor.id}" must register at least one executor id`);
    }
    if (this.familiesById.has(descriptor.id)) {
      throw new Error(`executor family "${descriptor.id}" is already registered`);
    }
    if (new Set(descriptor.executorIds).size !== descriptor.executorIds.length) {
      throw new Error(`executor family "${descriptor.id}" contains duplicate executor ids`);
    }
    for (const executorId of descriptor.executorIds) {
      if (!executorId.trim()) {
        throw new Error(`executor family "${descriptor.id}" contains an empty executor id`);
      }
      if (this.familiesByExecutorId.has(executorId)) {
        throw new Error(`executor id "${executorId}" is already registered`);
      }
    }

    const family: RegisteredExecutorFamily = {
      id: descriptor.id,
      kind: descriptor.kind,
      executorIds: [...descriptor.executorIds],
      factory: descriptor.factory,
    };
    this.familiesById.set(family.id, family);
    for (const executorId of family.executorIds) this.familiesByExecutorId.set(executorId, family);
    return family;
  }

  resolve(executorId: string): Backend {
    const family = this.familiesByExecutorId.get(executorId);
    if (!family) {
      const registered = [...this.familiesByExecutorId.keys()];
      throw new Error(
        `unsupported backend: ${executorId}; registered executor ids: ${registered.join(', ') || '(none)'}`,
      );
    }
    return family.factory(executorId);
  }

  kindOf(executorId: string): ExecutorKind | undefined {
    return this.familiesByExecutorId.get(executorId)?.kind;
  }

  ids(kind?: ExecutorKind): readonly string[] {
    return [...this.familiesByExecutorId.entries()]
      .filter(([, family]) => kind === undefined || family.kind === kind)
      .map(([executorId]) => executorId);
  }
}

export const ACP_EXECUTOR_IDS = ['claude', 'grok', 'kiro', 'codex', 'opencode'] as const;
export const DEFAULT_ACP_EXECUTOR_ID: (typeof ACP_EXECUTOR_IDS)[number] = 'grok';

const ACP_FACTORIES: Record<(typeof ACP_EXECUTOR_IDS)[number], () => Backend> = {
  claude: () => new ClaudeBackend(),
  grok: () => new GrokBackend(),
  kiro: () => new KiroBackend(),
  codex: () => new CodexBackend(),
  opencode: () => new OpenCodeBackend(),
};

export const executorRegistry = new ExecutorRegistry();
executorRegistry.register({
  id: 'acp',
  kind: 'acp',
  executorIds: ACP_EXECUTOR_IDS,
  factory: (executorId) => {
    const factory = ACP_FACTORIES[executorId as (typeof ACP_EXECUTOR_IDS)[number]];
    if (!factory) throw new Error(`executor id "${executorId}" is not part of the ACP family`);
    return factory();
  },
});
executorRegistry.register({
  id: 'script',
  kind: 'script',
  executorIds: ['script'] as const,
  factory: () => new ScriptBackend(),
});

export function resolveExecutor(executorId: string): Backend {
  return executorRegistry.resolve(executorId);
}

export function executorKindOf(executorId: string): ExecutorKind | undefined {
  return executorRegistry.kindOf(executorId);
}
