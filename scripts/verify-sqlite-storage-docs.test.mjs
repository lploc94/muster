import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

const required = {
  'docs/SQLITE-STORAGE.md': [
    'globalStorageUri',
    'muster.sqlite3',
    'muster.sqlite3-wal',
    'muster.sqlite3-shm',
    'one database per VS Code profile + extension-host authority',
    'Not repository-local',
    'Not cross-host',
    'muster.backupDatabase',
    'Muster: Back Up Global Database',
    'muster.developerResetGlobalDatabase',
    'Muster: Developer Reset Global Database',
    'not a backup',
    'no in-product restore/import command',
    'Supported manual restore',
    'Close every Muster window',
    'Preserve or move the existing trio together',
    'Do not pair the backup with stale',
    'Back Up and Reset',
    'Reset Without Backup',
    'strict no-op',
    'close other Muster windows',
    'Never automatic',
    'Corrupt / not a database',
    'Developer Reset refuses',
    'Foreign database',
    'Incompatible / incomplete Muster schema',
    'Disk full',
    'Read-only',
    'Busy / locked',
    'VS Code SecretStorage',
    'does not encrypt SQLite at rest',
    'no telemetry framework',
  ],
  'docs/README.md': [
    'SQLITE-STORAGE.md',
    'SQLite global storage',
  ],
  'README.md': [
    'docs/SQLITE-STORAGE.md',
  ],
  'CONTRIBUTING.md': [
    '## SQLite storage privacy and recovery verification',
    'npm run test:sqlite-storage-docs',
    'docs/SQLITE-STORAGE.md',
    'privacy-redaction',
  ],
  'package.json': [
    '"test:sqlite-storage-docs": "node --test scripts/verify-sqlite-storage-docs.test.mjs"',
  ],
};

const forbiddenClaims = [
  {
    pattern: /(?:will|does|must)\s+auto-?reset (?:on|when) (?:activation|open|error)/i,
    label: 'auto-reset on error',
  },
  {
    pattern: /(?:can|may|should)\s+delete (?:the )?(?:main|wal|shm) (?:file )?separately/i,
    label: 'partial-file-delete advice',
  },
  {
    pattern: /(?:may|can|should)\s+replace (?:an )?open database/i,
    label: 'open-database replacement advice',
  },
  {
    // Affirmative only — "Do not pair ... stale" is required guidance.
    pattern: /(?<!do not\s)(?<!don't\s)(?:may|can|should|must)\s+(?:pair|reuse|keep)[\s\S]{0,60}stale\s+(?:-?wal|WAL|sidecar)/i,
    label: 'stale-sidecar reuse advice',
  },
  {
    pattern: /export (?:is|provides) (?:a )?(?:full )?(?:database )?backup/i,
    label: 'export as database backup',
  },
  {
    pattern: /migrat(?:e|ion) (?:from )?(?:JSON|\.muster-tasks)/i,
    label: 'legacy JSON migration claim',
  },
  {
    pattern: /in-product restore\/import command is available/i,
    label: 'claims in-product restore exists',
  },
  {
    // Affirmative only — denials like "Do not expect Developer Reset to repair" are required.
    pattern: /(?:use|run|invoke)\s+Developer Reset[^.]*corrupt|Developer Reset after backup to repair/i,
    label: 'developer-reset-for-corrupt advice',
  },
];

/** Strip required denial phrases so residual "encrypted at rest" is a false claim. */
function stripEncryptionDenials(text) {
  return text
    .replace(/Muster does not encrypt SQLite at rest\.?/gi, '')
    .replace(/not encrypted at rest/gi, '')
    .replace(/does not encrypt SQLite at rest/gi, '')
    .replace(/Do not claim SQLCipher or full-disk encryption[^.]*\./gi, '');
}

function validate(files) {
  for (const [name, markers] of Object.entries(required)) {
    const text = files[name];
    assert.ok(typeof text === 'string' && text.trim(), `Missing documentation file: ${name}`);
    for (const marker of markers) {
      assert.ok(text.includes(marker), `${name} missing contract marker: ${marker}`);
    }
  }

  const guide = files['docs/SQLITE-STORAGE.md'];
  const restoreStart = guide.indexOf('## 3. Supported manual restore');
  assert.ok(restoreStart >= 0, 'SQLITE-STORAGE.md missing manual restore section');
  const nextHeading = guide.indexOf('\n## ', restoreStart + 1);
  const restoreSection =
    nextHeading >= 0 ? guide.slice(restoreStart, nextHeading) : guide.slice(restoreStart);
  assert.match(restoreSection, /Close every Muster window/i);
  assert.match(restoreSection, /trio together/i);
  assert.match(restoreSection, /stale/i);
  assert.match(restoreSection, /Reopen Muster/i);
  assert.doesNotMatch(restoreSection, /while (?:any )?Muster window still has the database open[\s\S]*is supported/i);

  const privacyStart = guide.indexOf('## 6. Privacy limitations');
  assert.ok(privacyStart >= 0, 'SQLITE-STORAGE.md missing privacy section');
  const privacyNext = guide.indexOf('\n## ', privacyStart + 1);
  const privacySection =
    privacyNext >= 0 ? guide.slice(privacyStart, privacyNext) : guide.slice(privacyStart);
  assert.match(privacySection, /does not encrypt SQLite at rest/i);
  assert.match(privacySection, /SecretStorage/i);

  const combined = Object.values(files).join('\n');
  // Positive denial must remain; residual affirmative encryption claims are forbidden.
  assert.match(combined, /does not encrypt SQLite at rest/i);
  const withoutDenial = stripEncryptionDenials(combined);
  assert.ok(
    !/encrypted at rest/i.test(withoutDenial),
    'forbidden claim: false encryption-at-rest claim',
  );
  for (const { pattern, label } of forbiddenClaims) {
    assert.ok(!pattern.test(combined), `forbidden claim: ${label}`);
  }

  // Command IDs/titles must match the real package.json manifest (not free-typed literals only).
  const pkg = JSON.parse(files['package.json']);
  const commands = pkg.contributes?.commands ?? [];
  const byId = Object.fromEntries(commands.map((c) => [c.command, c.title]));
  assert.equal(byId['muster.backupDatabase'], 'Muster: Back Up Global Database');
  assert.equal(byId['muster.developerResetGlobalDatabase'], 'Muster: Developer Reset Global Database');
  assert.ok(guide.includes('muster.backupDatabase'));
  assert.ok(guide.includes(byId['muster.backupDatabase']));
  assert.ok(guide.includes('muster.developerResetGlobalDatabase'));
  assert.ok(guide.includes(byId['muster.developerResetGlobalDatabase']));
  assert.match(
    pkg.scripts?.['test:sqlite-storage-docs'] ?? '',
    /verify-sqlite-storage-docs\.test\.mjs/,
  );

  return true;
}

async function trackedFiles() {
  return Object.fromEntries(
    await Promise.all(
      Object.keys(required).map(async (name) => [name, await readFile(new URL(name, root), 'utf8')]),
    ),
  );
}

test('tracked documentation defines the SQLite storage privacy and recovery contract', async () => {
  assert.equal(validate(await trackedFiles()), true);
});

test('rejects omitted location, command, restore, and privacy markers', async () => {
  const files = await trackedFiles();
  for (const marker of [
    'globalStorageUri',
    'muster.backupDatabase',
    'Supported manual restore',
    'does not encrypt SQLite at rest',
    'npm run test:sqlite-storage-docs',
  ]) {
    const owner = Object.keys(required).find(
      (name) => required[name].includes(marker) && files[name].includes(marker),
    );
    assert.ok(owner, `fixture marker owner missing: ${marker}`);
    assert.throws(
      () => validate({ ...files, [owner]: files[owner].split(marker).join('') }),
      /missing contract marker/,
    );
  }
});

test('rejects false encryption, open replace, partial delete, migration, and export-as-backup claims', async () => {
  const files = await trackedFiles();

  const encryption = `${files['docs/SQLITE-STORAGE.md']}\nMuster SQLite is encrypted at rest with SQLCipher.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': encryption }),
    /forbidden claim: false encryption-at-rest claim/,
  );

  const openReplace = `${files['docs/SQLITE-STORAGE.md']}\nYou may replace an open database while Muster runs.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': openReplace }),
    /forbidden claim: open-database replacement advice/,
  );

  const partial = `${files['docs/SQLITE-STORAGE.md']}\nYou can delete the wal file separately.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': partial }),
    /forbidden claim: partial-file-delete advice/,
  );

  const migration = `${files['docs/SQLITE-STORAGE.md']}\nWe migrate from JSON .muster-tasks.json automatically.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': migration }),
    /forbidden claim: legacy JSON migration claim/,
  );

  const exportBackup = files['docs/SQLITE-STORAGE.md'].replace(
    'not a backup',
    'export is a full database backup; not a backup',
  );
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': exportBackup }),
    /forbidden claim: export as database backup/,
  );

  const autoReset = `${files['docs/SQLITE-STORAGE.md']}\nMuster will auto-reset on activation errors.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': autoReset }),
    /forbidden claim: auto-reset on error/,
  );

  const staleSidecar = `${files['docs/SQLITE-STORAGE.md']}\nYou may pair the restored backup with the stale WAL sidecars.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': staleSidecar }),
    /forbidden claim: stale-sidecar reuse advice/,
  );

  const corruptReset = `${files['docs/SQLITE-STORAGE.md']}\nFor corrupt files, use Developer Reset after backup to repair.`;
  assert.throws(
    () => validate({ ...files, 'docs/SQLITE-STORAGE.md': corruptReset }),
    /forbidden claim: developer-reset-for-corrupt advice/,
  );

  const driftedTitle = files['package.json'].replace(
    'Muster: Back Up Global Database',
    'Muster: Backup DB',
  );
  assert.throws(
    () => validate({ ...files, 'package.json': driftedTitle }),
    /Back Up Global Database/,
  );
});
