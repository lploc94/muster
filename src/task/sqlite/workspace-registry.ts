/**
 * Durable workspace registry for the one-global-database model.
 *
 * The registry deliberately owns only workspace identity/location metadata. Task
 * repositories are created after this lookup with the returned UUID, so neither
 * engines nor callers invent a path-derived workspace id.
 */
import { randomUUID } from 'node:crypto';
import type { DbClient } from './client';
import type { WorkspaceIdentity } from './workspace-identity';

export interface RegisteredWorkspace {
  id: string;
  identityKey: string;
  displayName: string;
}

interface WorkspaceIdRow {
  id: string;
}

export class WorkspaceRegistry {
  constructor(private readonly db: DbClient) {}

  /**
   * Find the UUID for an identity or allocate it exactly once. The UNIQUE
   * identity_key constraint makes concurrent extension hosts converge on the
   * winning row; the subsequent read returns that authoritative UUID to both.
   */
  async getOrCreate(identity: WorkspaceIdentity, now: string): Promise<RegisteredWorkspace> {
    const proposedId = randomUUID();
    await this.db.transaction([
      {
        sql: `INSERT INTO workspaces (id, identity_key, display_name, created_at, last_opened_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(identity_key) DO UPDATE SET
                display_name=excluded.display_name,
                last_opened_at=excluded.last_opened_at`,
        params: [proposedId, identity.identityKey, identity.displayName, now, now],
      },
    ]);
    const row = await this.db.get<WorkspaceIdRow>(
      'SELECT id FROM workspaces WHERE identity_key = ?',
      [identity.identityKey],
    );
    if (!row) throw new Error('workspace registry row disappeared after upsert');

    if (identity.locations.length > 0) {
      await this.db.transaction(identity.locations.map((canonicalUri) => ({
        sql: `INSERT INTO workspace_locations (workspace_id, canonical_uri, first_seen_at, last_seen_at)
              VALUES (?,?,?,?)
              ON CONFLICT(workspace_id, canonical_uri) DO UPDATE SET
                last_seen_at=excluded.last_seen_at`,
        params: [row.id, canonicalUri, now, now],
      })));
    }
    return { id: row.id, identityKey: identity.identityKey, displayName: identity.displayName };
  }
}
