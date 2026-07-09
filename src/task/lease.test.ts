import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_LEASE_AGE_MS,
  isLeaseReclaimable,
  leaseOwnerAlive,
  leasePath,
  tryAcquireLease,
} from './engine';

const tempDirs: string[] = [];

function makeStorePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-lease-'));
  tempDirs.push(dir);
  return path.join(dir, '.muster-tasks.json');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('turn lease hardening', () => {
  it('reclaims an empty lease file left by a crash mid-acquire (no deadlock)', () => {
    const storePath = makeStorePath();
    const turnId = 'turn-empty';
    // Simulate a crash between the old openSync('wx') and the separate write.
    fs.writeFileSync(leasePath(storePath, turnId), '', 'utf8');

    expect(isLeaseReclaimable(undefined)).toBe(true);
    expect(leaseOwnerAlive(storePath, turnId)).toBe(false);

    const acquired = tryAcquireLease(storePath, turnId);
    expect(acquired).toBeDefined();
    expect(acquired?.pid).toBe(process.pid);
  });

  it('reclaims an unparseable lease file', () => {
    const storePath = makeStorePath();
    const turnId = 'turn-corrupt';
    fs.writeFileSync(leasePath(storePath, turnId), 'not-json', 'utf8');

    expect(leaseOwnerAlive(storePath, turnId)).toBe(false);
    const acquired = tryAcquireLease(storePath, turnId);
    expect(acquired).toBeDefined();
  });

  it('reclaims a lease older than max-age even when its PID appears alive (PID reuse)', () => {
    const storePath = makeStorePath();
    const turnId = 'turn-stale';
    const staleCreatedAt = new Date(Date.now() - MAX_LEASE_AGE_MS - 60_000).toISOString();
    // process.pid is definitely alive, but the lease is well past MAX_LEASE_AGE_MS.
    fs.writeFileSync(
      leasePath(storePath, turnId),
      JSON.stringify({ pid: process.pid, token: 'old', createdAt: staleCreatedAt }),
      'utf8',
    );

    expect(isLeaseReclaimable({ pid: process.pid, token: 'old', createdAt: staleCreatedAt })).toBe(
      true,
    );
    expect(leaseOwnerAlive(storePath, turnId)).toBe(false);

    const acquired = tryAcquireLease(storePath, turnId);
    expect(acquired).toBeDefined();
    // The reclaimer must have replaced the stale record with its own fresh one.
    expect(acquired?.token).not.toBe('old');
    // The atomic claim-via-rename must not leave a `.stale` quarantine copy behind.
    const dir = path.dirname(storePath);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.stale'))).toEqual([]);
  });

  it('treats a legacy lease without createdAt as reclaimable', () => {
    expect(isLeaseReclaimable({ pid: process.pid, token: 'legacy' })).toBe(true);
  });

  it('does NOT reclaim a fresh lease held by a live PID', () => {
    const storePath = makeStorePath();
    const turnId = 'turn-live';
    const dir = path.dirname(storePath);
    fs.writeFileSync(
      leasePath(storePath, turnId),
      JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() }),
      'utf8',
    );

    expect(leaseOwnerAlive(storePath, turnId)).toBe(true);
    expect(tryAcquireLease(storePath, turnId)).toBeUndefined();

    // The live lease must be preserved byte-for-byte — the reclaim path must never
    // displace a lease owned by a running peer (would allow two engines to run one turn).
    const survivor = JSON.parse(fs.readFileSync(leasePath(storePath, turnId), 'utf8')) as {
      token: string;
    };
    expect(survivor.token).toBe('live');
    // No quarantine (.stale) or temp (.tmp) litter from the aborted reclaim.
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.stale') || n.endsWith('.tmp'))).toEqual([]);
  });

  it('acquires atomically, leaving a complete record and no temp file', () => {
    const storePath = makeStorePath();
    const turnId = 'turn-fresh';
    const dir = path.dirname(storePath);

    const acquired = tryAcquireLease(storePath, turnId);
    expect(acquired).toBeDefined();

    // The published lease file must be a complete record — never empty/partial.
    const raw = fs.readFileSync(leasePath(storePath, turnId), 'utf8');
    const parsed = JSON.parse(raw) as { pid: number; token: string; createdAt: string };
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.token).toBe(acquired?.token);
    expect(typeof parsed.createdAt).toBe('string');
    expect(Number.isNaN(Date.parse(parsed.createdAt))).toBe(false);

    // No `.tmp` scratch file may survive the atomic temp+link publish.
    const leftoverTemp = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftoverTemp).toEqual([]);
  });
});
