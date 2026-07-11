/**
 * Thin CLI adapter over the shared command core.
 * Noninteractive mutations require --yes.
 */

import { CommandService } from '../commands/service';
import type { CommandDomainPort, CommandInteractionPort, CommandResult } from '../commands/types';

export interface CliAdapterOptions {
  domain: CommandDomainPort;
  /** When true, confirmations auto-accept (must be set via --yes for mutations). */
  yes?: boolean;
  /** Prefer JSON stdout for automation. */
  json?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export function createCliInteraction(yes: boolean): CommandInteractionPort {
  return {
    confirm: async () => yes,
    choose: async (_message, options) => (yes ? options[0] : undefined),
    ask: async () => undefined,
    save: async (_name, content) => {
      process.stdout.write(content);
      return '<stdout>';
    },
  };
}

const REQUIRES_YES = new Set(['approve', 'cancel', 'compact', 'archive', 'finish']);

export class CliAdapter {
  private readonly domain: CommandDomainPort;
  private readonly json: boolean;
  private readonly yes: boolean;
  private readonly out: (line: string) => void;
  private readonly err: (line: string) => void;

  constructor(options: CliAdapterOptions) {
    this.domain = options.domain;
    this.json = options.json ?? false;
    this.yes = options.yes ?? false;
    this.out = options.stdout ?? ((l) => process.stdout.write(`${l}\n`));
    this.err = options.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  }

  async run(argv: string[]): Promise<number> {
    const flags = new Set(argv.filter((a) => a === '--yes' || a === '--json'));
    const yes = this.yes || flags.has('--yes');
    const json = this.json || flags.has('--json');
    // Preserve command-specific flags such as `--backend codex` for the shared
    // slash parser; only consume adapter-level flags here.
    const positional = argv.filter((a) => a !== '--yes' && a !== '--json');
    if (positional.length === 0) {
      this.err('Usage: muster <command> [args] [--yes] [--json]');
      return 2;
    }

    const commandName = positional[0].replace(/^\//, '');
    if (REQUIRES_YES.has(commandName) && !yes) {
      this.err(`Command /${commandName} requires --yes in noninteractive CLI mode`);
      return 2;
    }

    const text = `/${positional.join(' ')}`;
    const service = new CommandService({
      domain: this.domain,
      interaction: createCliInteraction(yes),
    });
    const result = await service.handleInput(text);
    if (!result || !('ok' in result)) {
      this.err('No result');
      return 1;
    }
    return this.present(result, json);
  }

  present(result: CommandResult, json = this.json): number {
    if (json) {
      this.out(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    if (!result.ok) {
      this.err(`${result.error.code}: ${result.error.message}`);
      return 1;
    }
    if (result.message) this.out(result.message);
    if (result.presenter === 'export' && result.data && typeof result.data === 'object') {
      const content = (result.data as { content?: string }).content;
      if (typeof content === 'string') this.out(content);
      return 0;
    }
    if (result.data !== undefined) {
      this.out(JSON.stringify(result.data, null, 2));
    }
    return 0;
  }
}

/** Adapter parity helper: same request through domain yields structured result. */
export async function runCommandText(
  domain: CommandDomainPort,
  text: string,
  opts?: { yes?: boolean },
): Promise<CommandResult | { kind: 'plain'; text: string } | { kind: 'empty' }> {
  const service = new CommandService({
    domain,
    interaction: createCliInteraction(opts?.yes ?? false),
  });
  return service.handleInput(text);
}
