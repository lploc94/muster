import {
  NATIVE_COMMAND_SPECS,
  findCommandSpec,
  type CommandSpecMeta,
  type NativeCommandId,
} from '../workflow/contracts';

export type { CommandSpecMeta, NativeCommandId };

export function listCommandSpecs(): readonly CommandSpecMeta[] {
  return NATIVE_COMMAND_SPECS;
}

export function resolveCommandId(name: string): NativeCommandId | undefined {
  return findCommandSpec(name)?.id;
}

export function getCommandSpec(id: NativeCommandId): CommandSpecMeta | undefined {
  return NATIVE_COMMAND_SPECS.find((s) => s.id === id);
}

export function helpEntries(): Array<{ id: string; summary: string; aliases: string[] }> {
  return NATIVE_COMMAND_SPECS.map((s) => ({
    id: s.id,
    summary: s.summary,
    aliases: [...s.aliases],
  }));
}
