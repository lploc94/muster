import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TaskEngine, type TaskEngineConfig } from '../src/task/engine';
import { SqliteTaskRepository } from '../src/task/repository';
import { DbClient } from '../src/task/sqlite/client';

export async function openScriptEngine(
  prefix: string,
  config: Omit<TaskEngineConfig, 'repository' | 'workspaceId'>,
): Promise<{
  engine: TaskEngine;
  repository: SqliteTaskRepository;
  close(): Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const client = new DbClient({
    workerPath: path.join(__dirname, '../src/task/sqlite/worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  try {
    await client.open(path.join(dir, 'muster.sqlite3'));
    const repository = new SqliteTaskRepository(client, 'script-workspace');
    const now = new Date().toISOString();
    await repository.execute({
      kind: 'upsertWorkspace', workspaceId: 'script-workspace',
      identityKey: `script:${dir}`, displayName: 'Muster script harness',
      createdAt: now, lastOpenedAt: now,
    });
    const engine = await TaskEngine.loadAsync({
      ...config,
      repository,
      workspaceId: 'script-workspace',
    });
    return {
      engine,
      repository,
      async close() {
        await engine.whenIdle();
        await client.close();
        fs.rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
