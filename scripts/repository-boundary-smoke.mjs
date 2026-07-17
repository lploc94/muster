#!/usr/bin/env node

/**
 * Phase 3 source-boundary audit.
 *
 * This is deliberately a small source scan rather than a runtime test: the
 * contract is about dependency direction. Runtime code may use only named
 * repository queries/commands; no filesystem store or full-envelope escape hatch exists.
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
    if (/\.commit\s*\(/.test(text)) {
      const line = text.split('\n').findIndex((entry) => entry.includes('.commit(')) + 1;
      failures.push(`${rel}:${line} calls .commit(); use a named repository command.`);
    }
    if (text.includes('readEnvelopeForMigration')) {
      failures.push(`${rel} references the removed full-envelope migration API.`);
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

  // P4-W4: activation/bootstrap surfaces must stay on bounded helpers — never full
  // listMessages/listToolCalls/listReasoning/listTurns hydration.
  const BANNED_FULL_HYDRATION = [
    'listMessages(',
    'listToolCalls(',
    'listReasoning(',
    'listTurns(',
    'listTurnsForTasks(',
  ];
  for (const rel of [
    'src/host/repository-snapshot.ts',
    'src/task/repository-projection.ts',
    'src/host/transcript-page-route.ts',
    'src/host/workspace-patch.ts',
  ]) {
    const raw = texts.get(rel);
    if (raw === undefined) {
      failures.push(`Missing bounded bootstrap source file: ${rel}`);
      continue;
    }
    const code = stripComments(raw);
    for (const banned of BANNED_FULL_HYDRATION) {
      if (code.includes(banned)) {
        failures.push(`${rel} reintroduced full hydration call ${banned}; use bounded activity/page queries.`);
      }
    }
    if (rel === 'src/host/repository-snapshot.ts') {
      if (!code.includes('getTranscriptPage')) {
        failures.push(`${rel} must call getTranscriptPage for the focused bootstrap transcript.`);
      }
      if (!code.includes('BOOTSTRAP_TRANSCRIPT_LIMIT')) {
        failures.push(`${rel} must keep BOOTSTRAP_TRANSCRIPT_LIMIT as the focused page bound.`);
      }
    }
    if (rel === 'src/task/repository-projection.ts') {
      if (!code.includes('listTurnActivityForTasks')) {
        failures.push(`${rel} must load turns via listTurnActivityForTasks.`);
      }
      if (!code.includes('listActiveTurnInputMessages')) {
        failures.push(`${rel} must load active inputs via listActiveTurnInputMessages.`);
      }
    }
    // P4-W5: older-page host route must stay on getTranscriptPage with fixed limit 100.
    if (rel === 'src/host/transcript-page-route.ts') {
      if (!code.includes('getTranscriptPage')) {
        failures.push(`${rel} must call getTranscriptPage for older transcript pages.`);
      }
      if (!code.includes('TRANSCRIPT_PAGE_LIMIT') && !code.includes('BOOTSTRAP_TRANSCRIPT_LIMIT')) {
        failures.push(`${rel} must keep a fixed page limit constant (100).`);
      }
      if (code.includes('loadHistory') || code.includes('historyChunk')) {
        failures.push(`${rel} must not introduce loadHistory/historyChunk compatibility aliases.`);
      }
    }
    // P4-W7: local patch projection must not rehydrate full transcripts.
    if (rel === 'src/host/workspace-patch.ts') {
      if (code.includes('getTranscriptPage')) {
        failures.push(`${rel} must not call getTranscriptPage on the mutation path.`);
      }
      if (!code.includes('projectWorkspacePatches')) {
        failures.push(`${rel} must export projectWorkspacePatches.`);
      }
    }
  }

  // P4-W7: production host must not post legacy one-off messages.
  const extension = texts.get('src/extension.ts') ?? '';
  const extensionCode = stripComments(extension);
  if (/type:\s*['"]taskUpdated['"]/.test(extensionCode)) {
    failures.push(`src/extension.ts still posts production taskUpdated; use workspacePatchBatch.`);
  }
  if (/type:\s*['"]transcriptAppend['"]/.test(extensionCode)) {
    failures.push(`src/extension.ts still posts production transcriptAppend; use workspacePatchBatch.`);
  }
  if (!extensionCode.includes('workspacePatchBatch') && !extensionCode.includes('buildWorkspacePatchBatch')) {
    failures.push(`src/extension.ts must publish workspacePatchBatch after durable commits.`);
  }

  try {
    const matrix = await readFile(path.join(rootDir, 'docs/plans/sqlite-entity-matrix.vi.md'), 'utf8');
    for (const term of [
      'TaskStoreFile.schemaVersion', 'workspace_revisions', 'SQLite-only',
      'runtime_claims', 'expires_at', 'stale', 'taskPayload', 'wait',
      'turn_inputs', 'reasoning_segments', 'change_log', 'change_feed_watermarks',
      'send_outbox', 'presentations', 'presentation_operations',
    ]) {
      if (!matrix.includes(term)) failures.push(`sqlite-entity-matrix.vi.md is missing required parity marker: ${term}`);
    }

  // P4-W9: change feed / data_version stay behind named repository APIs.
  const repoText = texts.get('src/task/repository.ts') ?? '';
  if (!repoText.includes('getWorkspaceChangesSince') || !repoText.includes('getStorageDataVersion')) {
    failures.push('src/task/repository.ts must expose getWorkspaceChangesSince and getStorageDataVersion.');
  }
  for (const [rel, raw] of texts) {
    if (rel === 'src/task/repository.ts' || rel.startsWith('src/task/sqlite/')) continue;
    if (rel.endsWith('.test.ts') || rel.endsWith('.testkit.ts')) continue;
    const code = stripComments(raw);
    if (/\bchange_log\b/.test(code) || /PRAGMA\s+data_version/i.test(code) || /\.pragma\(\s*['"]data_version['"]/.test(code)) {
      failures.push(`${rel} must not query change_log or data_version directly; use TaskRepository feed APIs.`);
    }
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
