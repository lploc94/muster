/**
 * Bounded schema fingerprint (P5-W2 / M018 S01).
 *
 * The golden manifest describes the only supported development schema. Validates
 * ordered columns, FKs, explicit indexes (index_xinfo +
 * normalized SQL), triggers, and rejects extra user tables/views/indexes/triggers.
 * SQL normalization preserves quoted literal contents (CHECK 'draft' ≠ 'DRAFT').
 * Read-only; before WAL.
 */

import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SCHEMA_STATEMENTS } from './schema';

export type SchemaFingerprintFailure = {
  reason:
    | 'missing_table'
    | 'extra_table'
    | 'extra_view'
    | 'column_mismatch'
    | 'fk_mismatch'
    | 'missing_index'
    | 'index_mismatch'
    | 'extra_index'
    | 'missing_trigger'
    | 'trigger_mismatch'
    | 'table_sql_mismatch'
    | 'extra_trigger';
  object: string;
};

type ColumnSpec = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type FkSpec = {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
};

type IndexColumnSpec = {
  name: string;
  desc: number;
  coll: string;
  key: number;
};

type IndexSpec = {
  name: string;
  table: string;
  unique: number;
  partial: number;
  columns: readonly IndexColumnSpec[];
  sql: string;
};

type TableSpec = {
  name: string;
  columns: readonly ColumnSpec[];
  foreignKeys: readonly FkSpec[];
  sql: string;
};

type TriggerSpec = {
  name: string;
  tbl_name: string;
  sql: string;
};

export type SchemaManifest = {
  tables: readonly TableSpec[];
  views: readonly string[];
  indexes: readonly IndexSpec[];
  triggers: readonly TriggerSpec[];
};

/**
 * Normalize DDL for comparison with a single quote-aware scanner.
 * Outside quotes only: collapse whitespace, uppercase tokens, strip line comments,
 * remove IF NOT EXISTS. Inside quotes/brackets: preserve every character byte-for-byte
 * (including whitespace and case). Unterminated quotes fail closed.
 */
export function normalizeSchemaSql(sql: string | null | undefined): string {
  if (!sql) return '';
  const out: string[] = [];
  let i = 0;
  let quote: "'" | '"' | '`' | '[' | null = null;
  let pendingSpace = false;
  let sawNonSpaceOutside = false;
  /** Rolling uppercase token buffer outside quotes (for IF NOT EXISTS strip). */
  let tokenBuf = '';

  const flushToken = (): void => {
    if (!tokenBuf) return;
    // Match IF NOT EXISTS as three consecutive uppercase tokens with spaces between.
    // Handled by emitToken which tracks a small state machine.
    emitToken(tokenBuf);
    tokenBuf = '';
  };

  /** Tokens seen for IF NOT EXISTS: 0=none, 1=IF, 2=IF NOT */
  let ifNotExistsState = 0;
  const emitToken = (tok: string): void => {
    if (tok === 'IF' && ifNotExistsState === 0) {
      ifNotExistsState = 1;
      return;
    }
    if (tok === 'NOT' && ifNotExistsState === 1) {
      ifNotExistsState = 2;
      return;
    }
    if (tok === 'EXISTS' && ifNotExistsState === 2) {
      ifNotExistsState = 0;
      return;
    }
    // Flush any partial IF/NOT that was not completed.
    if (ifNotExistsState === 1) {
      pushOutsideToken('IF');
    } else if (ifNotExistsState === 2) {
      pushOutsideToken('IF');
      pushOutsideToken('NOT');
    }
    ifNotExistsState = 0;
    pushOutsideToken(tok);
  };
  const flushPartialIfNot = (): void => {
    if (ifNotExistsState === 1) {
      pushOutsideToken('IF');
    } else if (ifNotExistsState === 2) {
      pushOutsideToken('IF');
      pushOutsideToken('NOT');
    }
    ifNotExistsState = 0;
  };
  const pushOutsideToken = (tok: string): void => {
    if (pendingSpace && sawNonSpaceOutside) out.push(' ');
    pendingSpace = false;
    out.push(tok);
    sawNonSpaceOutside = true;
  };
  const pushOutsideChar = (ch: string): void => {
    flushToken();
    flushPartialIfNot();
    if (pendingSpace && sawNonSpaceOutside) out.push(' ');
    pendingSpace = false;
    out.push(ch);
    sawNonSpaceOutside = true;
  };

  while (i < sql.length) {
    const ch = sql[i]!;
    if (quote) {
      out.push(ch);
      if (quote === '[' && ch === ']') {
        quote = null;
      } else if (quote !== '[' && ch === quote) {
        // SQL doubled quote escape — preserve both bytes.
        if (i + 1 < sql.length && sql[i + 1] === quote) {
          out.push(sql[i + 1]!);
          i += 2;
          continue;
        }
        quote = null;
      }
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      flushToken();
      flushPartialIfNot();
      if (pendingSpace && sawNonSpaceOutside) out.push(' ');
      pendingSpace = false;
      quote = ch;
      out.push(ch);
      sawNonSpaceOutside = true;
      i += 1;
      continue;
    }
    if (ch === '[') {
      flushToken();
      flushPartialIfNot();
      if (pendingSpace && sawNonSpaceOutside) out.push(' ');
      pendingSpace = false;
      quote = '[';
      out.push(ch);
      sawNonSpaceOutside = true;
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      flushToken();
      flushPartialIfNot();
      while (i < sql.length && sql[i] !== '\n') i += 1;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flushToken();
      // Do not flush partial IF/NOT on whitespace — next token may complete EXISTS.
      pendingSpace = true;
      i += 1;
      continue;
    }
    // Identifier / keyword character: accumulate for uppercase + IF NOT EXISTS.
    if (/[A-Za-z0-9_]/.test(ch)) {
      tokenBuf += ch.toUpperCase();
      i += 1;
      continue;
    }
    // Punctuation / operators.
    pushOutsideChar(ch);
    i += 1;
  }

  if (quote !== null) {
    // Unterminated quote — fail closed so fingerprint cannot match golden.
    throw new Error('unterminated quoted SQL in schema fingerprint');
  }
  flushToken();
  flushPartialIfNot();
  return out.join('').trim();
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('invalid schema object name');
  }
  return `"${name}"`;
}

function captureTables(db: DatabaseSync): TableSpec[] {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string; sql: string | null }>;
  return rows.map((row) => {
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteIdent(row.name)})`).all() as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>
    )
      .slice()
      .sort((a, b) => a.cid - b.cid)
      .map((c) => ({
        name: c.name,
        type: String(c.type ?? '').toUpperCase(),
        notnull: c.notnull,
        dflt_value: c.dflt_value == null ? null : String(c.dflt_value),
        pk: c.pk,
      }));
    const foreignKeys = (
      db.prepare(`PRAGMA foreign_key_list(${quoteIdent(row.name)})`).all() as Array<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
      }>
    )
      .slice()
      .sort((a, b) => a.id - b.id || a.seq - b.seq)
      .map((fk) => ({
        id: fk.id,
        seq: fk.seq,
        table: fk.table,
        from: fk.from,
        to: fk.to,
        on_update: String(fk.on_update ?? '').toUpperCase(),
        on_delete: String(fk.on_delete ?? '').toUpperCase(),
      }));
    return {
      name: row.name,
      columns,
      foreignKeys,
      sql: normalizeSchemaSql(row.sql),
    };
  });
}

function captureViews(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'view' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function captureIndexes(db: DatabaseSync): IndexSpec[] {
  const rows = db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_schema
        WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  const out: IndexSpec[] = [];
  for (const row of rows) {
    // Only explicit CREATE INDEX (sql non-null). UNIQUE autoindexes covered via table SQL.
    if (!row.sql) continue;
    const list = db.prepare(`PRAGMA index_list(${quoteIdent(row.tbl_name)})`).all() as Array<{
      name: string;
      unique: number;
      origin: string;
      partial: number;
    }>;
    const meta = list.find((i) => i.name === row.name);
    let xinfo: Array<{
      seqno: number;
      cid: number;
      name: string | null;
      desc: number;
      coll: string;
      key: number;
    }> = [];
    try {
      xinfo = db.prepare(`PRAGMA index_xinfo(${quoteIdent(row.name)})`).all() as typeof xinfo;
    } catch {
      // Fallback if index_xinfo unavailable: name-only from index_info.
      const info = db.prepare(`PRAGMA index_info(${quoteIdent(row.name)})`).all() as Array<{
        seqno: number;
        name: string | null;
      }>;
      xinfo = info.map((c) => ({
        seqno: c.seqno,
        cid: 0,
        name: c.name,
        desc: 0,
        coll: 'BINARY',
        key: 1,
      }));
    }
    const columns = xinfo
      .slice()
      .sort((a, b) => a.seqno - b.seqno)
      .filter((c) => c.key === 1 || c.cid >= 0)
      .filter((c) => c.name != null || c.cid === -2) // key columns + expressions
      .map((c) => ({
        name: c.name ?? '',
        desc: c.desc ? 1 : 0,
        coll: String(c.coll ?? 'BINARY').toUpperCase(),
        key: c.key ? 1 : 0,
      }));
    out.push({
      name: row.name,
      table: row.tbl_name,
      unique: meta?.unique ?? 0,
      partial: meta?.partial ?? 0,
      columns,
      sql: normalizeSchemaSql(row.sql),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function captureTriggers(db: DatabaseSync): TriggerSpec[] {
  const rows = db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_schema
        WHERE type = 'trigger' AND name NOT LIKE 'sqlite_%'
        ORDER BY name`,
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string | null }>;
  return rows.map((row) => ({
    name: row.name,
    tbl_name: row.tbl_name,
    sql: normalizeSchemaSql(row.sql),
  }));
}

export function captureSchemaManifest(db: DatabaseSync): SchemaManifest {
  return {
    tables: captureTables(db),
    views: captureViews(db),
    indexes: captureIndexes(db),
    triggers: captureTriggers(db),
  };
}

let cachedExpected: SchemaManifest | undefined;

/** Golden manifest from CURRENT_SCHEMA_STATEMENTS (lazy, once per process). */
export function expectedSchemaManifest(): SchemaManifest {
  if (cachedExpected) return cachedExpected;
  const db = new DatabaseSync(':memory:');
  try {
    for (const statement of CURRENT_SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    const manifest = captureSchemaManifest(db);
    cachedExpected = manifest;
    return manifest;
  } finally {
    db.close();
  }
}

// Keep a direct reference so tree-shaking / dead-code reviews still see current DDL usage.
void CURRENT_SCHEMA_STATEMENTS;

function sameColumns(a: readonly ColumnSpec[], b: readonly ColumnSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.name !== right.name ||
      left.type !== right.type ||
      left.notnull !== right.notnull ||
      left.dflt_value !== right.dflt_value ||
      left.pk !== right.pk
    ) {
      return false;
    }
  }
  return true;
}

function sameFks(a: readonly FkSpec[], b: readonly FkSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.seq !== right.seq ||
      left.table !== right.table ||
      left.from !== right.from ||
      left.to !== right.to ||
      left.on_update !== right.on_update ||
      left.on_delete !== right.on_delete
    ) {
      return false;
    }
  }
  return true;
}

function sameIndexColumns(a: readonly IndexColumnSpec[], b: readonly IndexColumnSpec[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i]!;
    const right = b[i]!;
    if (
      left.name !== right.name ||
      left.desc !== right.desc ||
      left.coll !== right.coll ||
      left.key !== right.key
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Returns the first fingerprint failure, or undefined when the DB matches the
 * expected structure. Read-only; no journal/application mutations.
 *
 * @param expected Optional explicit golden manifest. Defaults to current schema.
 */
export function findSchemaFingerprintFailure(
  db: DatabaseSync,
  expected: SchemaManifest = expectedSchemaManifest(),
): SchemaFingerprintFailure | undefined {
  const golden = expected;
  const actual = captureSchemaManifest(db);

  const expectedTables = new Map(golden.tables.map((t) => [t.name, t]));
  const actualTables = new Map(actual.tables.map((t) => [t.name, t]));

  for (const name of expectedTables.keys()) {
    if (!actualTables.has(name)) {
      return { reason: 'missing_table', object: name };
    }
  }
  for (const name of actualTables.keys()) {
    if (!expectedTables.has(name)) {
      return { reason: 'extra_table', object: name };
    }
  }
  if (actual.views.length > 0) {
    return { reason: 'extra_view', object: actual.views[0]! };
  }

  for (const [name, exp] of expectedTables) {
    const act = actualTables.get(name)!;
    if (!sameColumns(exp.columns, act.columns)) {
      return { reason: 'column_mismatch', object: name };
    }
    if (!sameFks(exp.foreignKeys, act.foreignKeys)) {
      return { reason: 'fk_mismatch', object: name };
    }
    if (exp.sql !== act.sql) {
      return { reason: 'table_sql_mismatch', object: name };
    }
  }

  const expectedIndexes = new Map(golden.indexes.map((i) => [i.name, i]));
  const actualIndexes = new Map(actual.indexes.map((i) => [i.name, i]));
  for (const [name, exp] of expectedIndexes) {
    const act = actualIndexes.get(name);
    if (!act) return { reason: 'missing_index', object: name };
    if (
      act.table !== exp.table ||
      act.unique !== exp.unique ||
      act.partial !== exp.partial ||
      !sameIndexColumns(exp.columns, act.columns) ||
      act.sql !== exp.sql
    ) {
      return { reason: 'index_mismatch', object: name };
    }
  }
  for (const name of actualIndexes.keys()) {
    if (!expectedIndexes.has(name)) {
      return { reason: 'extra_index', object: name };
    }
  }

  const expectedTriggers = new Map(golden.triggers.map((t) => [t.name, t]));
  const actualTriggers = new Map(actual.triggers.map((t) => [t.name, t]));
  for (const [name, exp] of expectedTriggers) {
    const act = actualTriggers.get(name);
    if (!act) return { reason: 'missing_trigger', object: name };
    if (act.tbl_name !== exp.tbl_name || act.sql !== exp.sql) {
      return { reason: 'trigger_mismatch', object: name };
    }
  }
  for (const name of actualTriggers.keys()) {
    if (!expectedTriggers.has(name)) {
      return { reason: 'extra_trigger', object: name };
    }
  }

  return undefined;
}
