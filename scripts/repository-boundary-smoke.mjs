#!/usr/bin/env node

/**
 * Phase 3 source-boundary audit.
 *
 * This is deliberately a small source scan rather than a runtime test: the
 * contract is about dependency direction. Runtime code may use repository
 * queries/commands, while the JSON envelope is restricted to the compatibility
 * adapter and explicit export/migration code.
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NO_STORE_IMPORT = [
  'src/task/engine.ts',
  'src/task/engine-graph.ts',
  'src/host/snapshot.ts',
];
const COMMIT_ALLOWED = new Set(['src/task/store.ts', 'src/task/repository.ts']);
const MIGRATION_ALLOWED = new Set(['src/task/repository.ts', 'src/host/task-export-route.ts']);
const NAMED_GRAPH_COMMANDS = [
  'createChildTask', 'delegateChildTask', 'createChildTaskBatch', 'delegateChildTaskBatch',
  'releaseChildTasks', 'continueChildTask', 'cancelChildTasks', 'interruptChildTask',
  'cancelChildTask', 'setChildTaskLifecycle', 'waitForChildTasks', 'completeGraphTask',
  'failGraphTask', 'askParent', 'answerChildQuestion', 'consumeCancelRequest',
];

function relative(filePath) {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && full.endsWith('.ts')) files.push(full);
  }
  return files;
}

export async function runRepositoryBoundarySmoke(rootDir = ROOT) {
  const failures = [];
  const sourceRoot = path.join(rootDir, 'src');
  let files;
  try {
    files = await walk(sourceRoot);
  } catch (error) {
    return { ok: false, failures: [`Cannot scan ${sourceRoot}: ${error.message}`] };
  }

  const texts = new Map();
  for (const file of files) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
    texts.set(rel, await readFile(file, 'utf8'));
  }

  for (const rel of NO_STORE_IMPORT) {
    const text = texts.get(rel);
    if (text === undefined) {
      failures.push(`Missing boundary source file: ${rel}`);
      continue;
    }
    const importsLegacyStore = /(?:from\s*|import\s*\(\s*)['"][^'"]*(?:^|\/)store['"]/.test(text);
    if (importsLegacyStore) {
      failures.push(`${rel} imports the legacy JSON store; use TaskReadPort/TaskRepository instead.`);
    }
  }

  for (const [rel, raw] of texts) {
    const text = stripComments(raw);
    if (!COMMIT_ALLOWED.has(rel) && /\.commit\s*\(/.test(text)) {
      const line = text.split('\n').findIndex((entry) => entry.includes('.commit(')) + 1;
      failures.push(`${rel}:${line} calls .commit(); only the JSON compatibility adapter may do so.`);
    }
    if (text.includes('readEnvelopeForMigration') && !MIGRATION_ALLOWED.has(rel)) {
      failures.push(`${rel} references readEnvelopeForMigration outside repository/export code.`);
    }
    if (text.includes('applyGraphMutation')) {
      failures.push(`${rel} still exposes the forbidden generic applyGraphMutation boundary; use a named graph command.`);
    }
  }

  const repository = texts.get('src/task/repository.ts') ?? '';
  for (const command of NAMED_GRAPH_COMMANDS) {
    if (!repository.includes(`'${command}'`)) {
      failures.push(`src/task/repository.ts is missing named graph command: ${command}`);
    }
  }

  const snapshot = texts.get('src/host/repository-snapshot.ts');
  if (snapshot?.includes('readEnvelopeForMigration')) {
    failures.push('src/host/repository-snapshot.ts must use bounded repository queries, not the migration envelope.');
  }

  try {
    const matrix = await readFile(path.join(rootDir, 'docs/plans/sqlite-entity-matrix.vi.md'), 'utf8');
    for (const term of [
      'TaskStoreFile.schemaVersion', 'workspace_revisions', 'migration_state',
      'runtime_claims', 'expires_at', 'stale', 'taskPayload', 'wait',
      'turn_inputs', 'reasoning_segments', 'change_log',
    ]) {
      if (!matrix.includes(term)) failures.push(`sqlite-entity-matrix.vi.md is missing required parity marker: ${term}`);
    }
  } catch (error) {
    failures.push(`Missing entity matrix: docs/plans/sqlite-entity-matrix.vi.md (${error.message})`);
  }

  return { ok: failures.length === 0, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRepositoryBoundarySmoke();
  if (result.ok) {
    console.log('repository-boundary-smoke: passed');
  } else {
    console.error('repository-boundary-smoke: failed');
    for (const [index, failure] of result.failures.entries()) console.error(`${index + 1}. ${failure}`);
    process.exitCode = 1;
  }
}
