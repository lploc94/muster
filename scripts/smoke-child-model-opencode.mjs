#!/usr/bin/env node
/** Live SQLite-only smoke for a delegated OpenCode child with an explicit model. */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = process.env.MUSTER_SMOKE_MODEL ?? 'opencode-go/deepseek-v4-flash';
const REQUIRE = process.env.MUSTER_SMOKE_REQUIRE_OPENCODE === '1';

if (spawnSync('opencode', ['--version'], { encoding: 'utf8' }).status !== 0) {
  const message = 'opencode CLI not found on PATH';
  if (REQUIRE) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`SKIP: ${message} (set MUSTER_SMOKE_REQUIRE_OPENCODE=1 to fail)`);
  process.exit(0);
}

const dist = (relative) => path.join(root, 'dist', relative);
const requiredFiles = [
  'src/task/engine.js', 'src/task/repository.js', 'src/task/sqlite/client.js',
  'src/task/sqlite/worker.js', 'src/bridge/credentials.js', 'src/bridge/ask-bridge.js',
  'src/backends/index.js', 'src/backends/opencode.js',
];
for (const relative of requiredFiles) {
  if (!fs.existsSync(dist(relative))) {
    console.error('FAIL: dist/ not built — run `npm run compile` first');
    process.exit(1);
  }
}

const { TaskEngine } = require(dist('src/task/engine.js'));
const { SqliteTaskRepository } = require(dist('src/task/repository.js'));
const { DbClient } = require(dist('src/task/sqlite/client.js'));
const { CredentialRegistry } = require(dist('src/bridge/credentials.js'));
const { AskBridge } = require(dist('src/bridge/ask-bridge.js'));
const { makeBackend } = require(dist('src/backends/index.js'));
const { disposeSharedAcpClient } = require(dist('src/backends/opencode.js'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-smoke-oc-model-'));
const client = new DbClient({ workerPath: dist('src/task/sqlite/worker.js') });
try {
  await client.open(path.join(dir, 'muster.sqlite3'));
  const repository = new SqliteTaskRepository(client, 'smoke-workspace');
  const now = new Date().toISOString();
  await repository.execute({
    kind: 'upsertWorkspace', workspaceId: 'smoke-workspace', identityKey: `smoke:${dir}`,
    displayName: 'OpenCode model smoke', createdAt: now, lastOpenedAt: now,
  });
  await repository.execute({
    kind: 'createTask', workspaceId: 'smoke-workspace', task: {
      id: 'coord', goal: 'smoke coordinator', parentId: null, role: 'coordinator',
      lifecycle: 'open', releaseState: 'released', dependencies: [], backend: 'opencode',
      capabilities: ['create_child', 'wait_child', 'read_subtree'],
      executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 }, revision: 0,
      createdAt: now, updatedAt: now, cwd: dir,
    },
  });
  await repository.execute({
    kind: 'createTurn', workspaceId: 'smoke-workspace', turn: {
      id: 'coord-turn', taskId: 'coord', sequence: 1, trigger: 'user', status: 'running',
      inputs: [], createdAt: now, startedAt: now,
    },
  });

  const credentials = new CredentialRegistry();
  const engine = await TaskEngine.loadAsync({
    repository, workspaceId: 'smoke-workspace', makeBackend,
    askBridge: new AskBridge(), credentialRegistry: credentials, bridgePort: 0,
    getTaskTypeRegistry: () => ({
      status: 'ok', diagnostics: [],
      registry: new Map([['worker', { backend: 'opencode', role: 'worker', briefKind: 'generic' }]]),
    }),
  });
  const token = credentials.issue({
    rootId: 'coord', callerTaskId: 'coord', turnId: 'coord-turn',
    allowedActions: new Set(['delegate_task', 'complete_task']), ttlMs: 120_000,
  });
  const context = credentials.verify(token);
  if (!context) throw new Error('credential verification failed');

  console.log(`Smoke: delegate_task taskType=worker model=${MODEL}`);
  const result = await engine.handleToolCall(context, 'delegate_task', {
    kind: 'delegate_task', opId: 'smoke-oc-model',
    spec: { goal: 'Reply with exactly: PONG', taskType: 'worker', backend: 'opencode', model: MODEL, role: 'worker' },
  });
  if (!result.ok) throw new Error(`delegate_task failed: ${JSON.stringify(result)}`);
  const childId = `task-${createHash('sha256').update('coord-turn:smoke-oc-model:task').digest('hex').slice(0, 16)}`;
  const child = await repository.getTask(childId);
  if (!child || child.model !== MODEL || child.backend !== 'opencode') {
    throw new Error(`child model/backend not pinned: ${JSON.stringify(child)}`);
  }

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await engine.whenIdle();
    const turns = await repository.listTurns(childId);
    if (!turns.some((turn) => turn.status === 'running' || turn.status === 'queued')) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const turns = await repository.listTurns(childId);
  const final = turns.at(-1);
  console.log(`Turn status: ${final?.status ?? 'none'} model_on_task=${(await repository.getTask(childId))?.model}`);
  if (!final || !['succeeded', 'failed', 'interrupted'].includes(final.status)) {
    throw new Error(`child turn did not settle: ${JSON.stringify(final)}`);
  }
  console.log('PASS: opencode child model smoke');
} finally {
  disposeSharedAcpClient();
  await client.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
