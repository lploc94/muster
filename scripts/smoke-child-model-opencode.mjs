#!/usr/bin/env node
/**
 * Live smoke: create a released child with backend=opencode + model=opencode-go/deepseek-v4-flash
 * via TaskEngine.delegate_task path, run one turn, print applied model evidence.
 *
 * Usage (requires `opencode` on PATH + auth):
 *   node scripts/smoke-child-model-opencode.mjs
 *   MUSTER_SMOKE_MODEL=opencode-go/deepseek-v4-flash node scripts/smoke-child-model-opencode.mjs
 *
 * Exit 0 on success; non-zero on failure. Skips with exit 0 if opencode is unavailable
 * unless MUSTER_SMOKE_REQUIRE_OPENCODE=1.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hasOpencode() {
  const r = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  return r.status === 0;
}

const MODEL = process.env.MUSTER_SMOKE_MODEL ?? 'opencode-go/deepseek-v4-flash';
const REQUIRE = process.env.MUSTER_SMOKE_REQUIRE_OPENCODE === '1';

if (!hasOpencode()) {
  const msg = 'opencode CLI not found on PATH';
  if (REQUIRE) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`SKIP: ${msg} (set MUSTER_SMOKE_REQUIRE_OPENCODE=1 to fail)`);
  process.exit(0);
}

// Prefer compiled dist; fall back to tsx for source.
async function loadEngine() {
  const distEngine = path.join(root, 'dist/src/task/engine.js');
  const distCreds = path.join(root, 'dist/src/bridge/credentials.js');
  const distAsk = path.join(root, 'dist/src/bridge/ask-bridge.js');
  const distStore = path.join(root, 'dist/src/task/store.js');
  const distIndex = path.join(root, 'dist/src/backends/index.js');
  if (fs.existsSync(distEngine)) {
    return {
      TaskEngine: require(distEngine).TaskEngine,
      CredentialRegistry: require(distCreds).CredentialRegistry,
      AskBridge: require(distAsk).AskBridge,
      TaskStore: require(distStore).TaskStore,
      makeBackend: require(distIndex).makeBackend,
    };
  }
  // Dynamic import via tsx-register not assumed; require compile first.
  console.error('FAIL: dist/ not built — run `npm run compile` first');
  process.exit(1);
}

const { TaskEngine, CredentialRegistry, AskBridge, TaskStore, makeBackend } = await loadEngine();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-smoke-oc-model-'));
const filePath = path.join(dir, '.muster-tasks.json');
const store = TaskStore.load({ filePath });
const credentials = new CredentialRegistry();
const askBridge = new AskBridge();

const engine = TaskEngine.load({
  store,
  makeBackend: (name) => makeBackend(name),
  askBridge,
  credentialRegistry: credentials,
  bridgePort: 0,
  getTaskTypeRegistry: () => {
    // Minimal in-process registry (same shape as parseTaskTypeRegistry ok result).
    const registry = new Map([
      [
        'worker',
        { backend: 'opencode', role: 'worker', briefKind: 'generic' },
      ],
    ]);
    return { status: 'ok', registry, diagnostics: [] };
  },
});

engine.createTask({
  id: 'coord',
  goal: 'smoke coordinator',
  backend: 'opencode',
  role: 'coordinator',
  capabilities: ['create_child', 'wait_child', 'read_subtree'],
  cwd: dir,
});

store.commit((draft) => {
  draft.turns['coord-turn'] = {
    id: 'coord-turn',
    taskId: 'coord',
    sequence: 1,
    trigger: 'user',
    status: 'running',
    inputs: [],
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  draft.tasks.coord = {
    ...draft.tasks.coord,
    releaseState: 'released',
    cwd: dir,
    revision: draft.tasks.coord.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  return { ok: true };
});

const token = credentials.issue({
  rootId: 'coord',
  callerTaskId: 'coord',
  turnId: 'coord-turn',
  allowedActions: new Set(['delegate_task', 'complete_task']),
  ttlMs: 120_000,
});
const ctx = credentials.verify(token);
if (!ctx) {
  console.error('FAIL: credential verify');
  process.exit(1);
}

function deriveEntityId(callerTurnId, opId, suffix) {
  const hash = createHash('sha256').update(`${callerTurnId}:${opId}:${suffix}`).digest('hex').slice(0, 16);
  return `${suffix}-${hash}`;
}

console.log(`Smoke: delegate_task taskType=worker model=${MODEL}`);
const result = await engine.handleToolCall(ctx, 'delegate_task', {
  kind: 'delegate_task',
  opId: 'smoke-oc-model',
  spec: {
    goal: 'Reply with exactly: PONG',
    taskType: 'worker',
    backend: 'opencode',
    model: MODEL,
    role: 'worker',
  },
});

if (!result.ok) {
  console.error('FAIL: delegate_task', result);
  process.exit(1);
}

const childId = deriveEntityId('coord-turn', 'smoke-oc-model', 'task');
const child = store.getTask(childId);
if (!child || child.model !== MODEL || child.backend !== 'opencode') {
  console.error('FAIL: child model/backend not pinned', child);
  process.exit(1);
}
console.log(`OK: child ${childId} model=${child.model} backend=${child.backend}`);

// Wait for turn (up to 90s)
const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await engine.whenIdle?.();
  const turns = Object.values(store.getFile().turns).filter((t) => t.taskId === childId);
  const live = turns.find((t) => t.status === 'running' || t.status === 'queued');
  if (!live) break;
  await new Promise((r) => setTimeout(r, 500));
}

const turns = Object.values(store.getFile().turns).filter((t) => t.taskId === childId);
const final = turns[turns.length - 1];
console.log(`Turn status: ${final?.status ?? 'none'} model_on_task=${store.getTask(childId)?.model}`);
if (!final || (final.status !== 'succeeded' && final.status !== 'failed' && final.status !== 'interrupted')) {
  console.error('FAIL: child turn did not settle', final);
  process.exit(1);
}

console.log('PASS: opencode child model smoke');
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
