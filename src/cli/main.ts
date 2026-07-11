/**
 * CLI entry harness (optional milestone surface).
 * Invoked as: npx tsx src/cli/main.ts <command> [--yes] [--json]
 *
 * Store location: MUSTER_STORE_PATH or ./.muster-tasks.json
 */

import * as path from 'path';
import { TaskStore } from '../task/store';
import { TaskEngine } from '../task/engine';
import { makeBackend } from '../backends';
import { createEngineDomainPort } from '../commands/domain-adapter';
import { CliAdapter } from './adapter';

async function main(): Promise<void> {
  const storePath =
    process.env.MUSTER_STORE_PATH ?? path.join(process.cwd(), '.muster-tasks.json');
  const store = TaskStore.load({ filePath: storePath });
  const engine = TaskEngine.load({
    store,
    makeBackend,
  });
  let focused: string | undefined;
  const domain = createEngineDomainPort({
    engine,
    store,
    getFocusedTaskId: () => focused,
    setFocusedTaskId: (id) => {
      focused = id;
    },
    cwd: process.cwd(),
  });
  const adapter = new CliAdapter({ domain });
  const code = await adapter.run(process.argv.slice(2));
  process.exitCode = code;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
