import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  SEND_OUTBOX_MAX_ENTRIES,
  SqliteTaskRepository,
  type PresentationRecord,
} from './repository';
import { DbClient } from './sqlite/client';
import type { MusterTask } from './types';

const ISO = '2026-07-17T00:00:00.000Z';

function task(id: string): MusterTask {
  return {
    id,
    role: 'coordinator',
    lifecycle: 'open',
    releaseState: 'released',
    goal: id,
    parentId: null,
    dependencies: [],
    backend: 'grok',
    capabilities: [],
    executionPolicy: { maxTurns: 10, maxAutomaticRetries: 0 },
    revision: 0,
    createdAt: ISO,
    updatedAt: ISO,
  };
}

async function openRepository(dbPath: string) {
  const client = new DbClient({
    workerPath: path.join(__dirname, 'sqlite', 'worker.ts'),
    execArgv: ['--import', 'tsx'],
  });
  await client.open(dbPath);
  return { client, repository: new SqliteTaskRepository(client, 'ws') };
}

async function initialize(repository: SqliteTaskRepository): Promise<void> {
  await repository.execute({
    kind: 'upsertWorkspace',
    workspaceId: 'ws',
    identityKey: 'durable-surfaces',
    displayName: 'Durable surfaces',
    createdAt: ISO,
    lastOpenedAt: ISO,
  });
}

describe('SQLite durable UI surfaces', () => {
  it('restores the complete send draft after reopen and enforces durable capacity', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-outbox-durable-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    let opened = await openRepository(dbPath);
    try {
      await initialize(opened.repository);
      await opened.repository.execute({
        kind: 'putSendOutbox',
        workspaceId: 'ws',
        entry: {
          clientRequestId: 'request-0',
          status: 'rejected',
          taskId: undefined,
          payload: {
            version: 1,
            text: '@plan',
            llmText: '/workspace/docs/plan.md',
            mentionBindings: [['@plan', '/workspace/docs/plan.md']],
            skills: ['review'],
            backend: 'grok',
            model: 'grok-4',
          },
          createdAt: ISO,
          updatedAt: ISO,
        },
      });
      await opened.client.close();
      opened = await openRepository(dbPath);
      await expect(opened.repository.getSendOutbox('request-0')).resolves.toMatchObject({
        status: 'rejected',
        payload: {
          text: '@plan',
          llmText: '/workspace/docs/plan.md',
          mentionBindings: [['@plan', '/workspace/docs/plan.md']],
          skills: ['review'],
          backend: 'grok',
          model: 'grok-4',
        },
      });

      for (let i = 1; i < SEND_OUTBOX_MAX_ENTRIES; i += 1) {
        await opened.repository.execute({
          kind: 'putSendOutbox',
          workspaceId: 'ws',
          entry: {
            clientRequestId: `request-${i}`,
            status: 'pending',
            payload: { version: 1, text: `draft ${i}` },
            createdAt: `2026-07-17T00:00:${String(i).padStart(2, '0')}.000Z`,
            updatedAt: `2026-07-17T00:00:${String(i).padStart(2, '0')}.000Z`,
          },
        });
      }
      await expect(opened.repository.execute({
        kind: 'putSendOutbox',
        workspaceId: 'ws',
        entry: {
          clientRequestId: 'request-over-cap',
          status: 'pending',
          payload: { version: 1, text: 'must not be dropped silently' },
          createdAt: '2026-07-17T00:01:00.000Z',
          updatedAt: '2026-07-17T00:01:00.000Z',
        },
      })).rejects.toThrow(/capacity/i);
      await expect(opened.repository.listSendOutbox()).resolves.toHaveLength(
        SEND_OUTBOX_MAX_ENTRIES,
      );
    } finally {
      await opened.client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keys presentations by root and keeps operation idempotency durable across reopen', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-presentation-durable-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    let opened = await openRepository(dbPath);
    const document = (rootId: string, revision: number, markdown: string): PresentationRecord => ({
      presentationId: 'plan.main',
      ownerTaskId: rootId,
      rootId,
      revision,
      title: `Plan ${rootId}`,
      markdown,
      updatedAt: ISO,
    });
    try {
      await initialize(opened.repository);
      await opened.repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('root-a') });
      await opened.repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('root-b') });
      await opened.repository.execute({
        kind: 'putPresentation', workspaceId: 'ws', document: document('root-a', 1, '# A1'),
      });
      await opened.repository.execute({
        kind: 'putPresentation', workspaceId: 'ws', document: document('root-b', 1, '# B1'),
      });
      await expect(opened.repository.getPresentation('root-a', 'plan.main')).resolves.toMatchObject({
        markdown: '# A1', ownerTaskId: 'root-a',
      });
      await expect(opened.repository.getPresentation('root-b', 'plan.main')).resolves.toMatchObject({
        markdown: '# B1', ownerTaskId: 'root-b',
      });

      const operationKey = 'a'.repeat(64);
      const fingerprint = 'b'.repeat(64);
      const committed = await opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey,
        fingerprint,
        document: document('root-a', 2, '# A2'),
      });
      expect(committed).toMatchObject({ changed: true, presentationStatus: 'committed' });
      await expect(opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey,
        fingerprint,
        document: document('root-a', 2, '# A2'),
      })).resolves.toMatchObject({ changed: false, presentationStatus: 'idempotent' });
      await expect(opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey,
        fingerprint: 'c'.repeat(64),
        document: document('root-a', 3, '# conflict'),
      })).resolves.toMatchObject({ changed: false, presentationStatus: 'op_conflict' });

      // A stale claim is rolled back; the same operation key remains available.
      const retryableKey = 'd'.repeat(64);
      await expect(opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey: retryableKey,
        fingerprint: 'e'.repeat(64),
        document: document('root-a', 1, '# stale'),
      })).resolves.toMatchObject({ changed: false, presentationStatus: 'stale_revision' });
      await expect(opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey: retryableKey,
        fingerprint: 'f'.repeat(64),
        document: document('root-a', 3, '# A3'),
      })).resolves.toMatchObject({ changed: true, presentationStatus: 'committed' });

      await opened.client.close();
      opened = await openRepository(dbPath);
      await expect(opened.repository.execute({
        kind: 'commitPresentationOperation',
        workspaceId: 'ws',
        operationKey: retryableKey,
        fingerprint: 'f'.repeat(64),
        document: document('root-a', 3, '# A3'),
      })).resolves.toMatchObject({ changed: false, presentationStatus: 'idempotent' });
      await expect(opened.repository.getPresentation('root-a', 'plan.main')).resolves.toMatchObject({
        revision: 3,
        markdown: '# A3',
      });
    } finally {
      await opened.client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('fails closed on malformed durable presentation payloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-presentation-corrupt-'));
    const dbPath = path.join(dir, 'muster.sqlite3');
    const opened = await openRepository(dbPath);
    try {
      await initialize(opened.repository);
      await opened.repository.execute({ kind: 'createTask', workspaceId: 'ws', task: task('root-a') });
      await opened.repository.execute({
        kind: 'putPresentation',
        workspaceId: 'ws',
        document: {
          presentationId: 'plan.main',
          ownerTaskId: 'root-a',
          rootId: 'root-a',
          revision: 1,
          title: 'Plan',
          markdown: '# valid',
          updatedAt: ISO,
        },
      });
      await opened.client.run(
        `UPDATE presentations SET payload_json = '{"unexpected":true}'
          WHERE workspace_id = ? AND root_id = ? AND presentation_id = ?`,
        ['ws', 'root-a', 'plan.main'],
      );
      await expect(opened.repository.getPresentation('root-a', 'plan.main')).rejects.toThrow(
        /payload corrupt/i,
      );
    } finally {
      await opened.client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
