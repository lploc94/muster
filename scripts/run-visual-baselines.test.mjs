import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDockerArgs,
  buildPlaywrightCommand,
  buildChownArgs,
  dockerUserArgs,
  parseArgs,
  resolveHostUserIds,
  playwrightDockerImage,
  resolvePlaywrightVersionFromLock,
  toDockerMountPath,
} from './run-visual-baselines.mjs';

test('resolvePlaywrightVersionFromLock reads packages lockfile entry', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      'node_modules/@playwright/test': { version: '1.61.1' },
    },
  };
  assert.equal(resolvePlaywrightVersionFromLock(lock), '1.61.1');
});

test('resolvePlaywrightVersionFromLock rejects missing version', () => {
  assert.throws(
    () => resolvePlaywrightVersionFromLock({ packages: {} }),
    /@playwright\/test/,
  );
});

test('playwrightDockerImage pins lockfile version and jammy tag', () => {
  assert.equal(
    playwrightDockerImage('1.61.1'),
    'mcr.microsoft.com/playwright:v1.61.1-jammy',
  );
});

test('parseArgs defaults to compare mode without update', () => {
  assert.deepEqual(parseArgs([]), {
    mode: 'compare',
    update: false,
    diagnosticsOnly: false,
    help: false,
    playwrightArgs: [],
  });
});

test('parseArgs accepts explicit update mode', () => {
  assert.deepEqual(parseArgs(['--update']), {
    mode: 'update',
    update: true,
    diagnosticsOnly: false,
    help: false,
    playwrightArgs: [],
  });
});

test('parseArgs forwards Playwright passthrough args after known flags', () => {
  assert.deepEqual(
    parseArgs(['--grep', 'M014 S01 flow: deterministic dual-entrypoint pilot']),
    {
      mode: 'compare',
      update: false,
      diagnosticsOnly: false,
      help: false,
      playwrightArgs: [
        '--grep',
        'M014 S01 flow: deterministic dual-entrypoint pilot',
      ],
    },
  );
});


test('parseArgs reassembles multi-word --grep patterns stripped by npm', () => {
  assert.deepEqual(
    parseArgs([
      '--grep',
      'M014',
      'S01',
      'flow:',
      'deterministic',
      'dual-entrypoint',
      'pilot',
    ]),
    {
      mode: 'compare',
      update: false,
      diagnosticsOnly: false,
      help: false,
      playwrightArgs: [
        '--grep',
        'M014 S01 flow: deterministic dual-entrypoint pilot',
      ],
    },
  );
});

test('parseArgs keeps --update while forwarding remaining Playwright args', () => {
  assert.deepEqual(parseArgs(['--update', '--list']), {
    mode: 'update',
    update: true,
    diagnosticsOnly: false,
    help: false,
    playwrightArgs: ['--list'],
  });
});

test('buildPlaywrightCommand never includes update-snapshots in compare mode', () => {
  const cmd = buildPlaywrightCommand({ update: false });
  assert.match(cmd, /playwright test 'e2e\/visual' --project=visual-chromium/);
  assert.doesNotMatch(cmd, /update-snapshots/);
});

test('buildPlaywrightCommand includes update-snapshots only when requested', () => {
  const cmd = buildPlaywrightCommand({ update: true });
  assert.match(cmd, /--update-snapshots/);
});

test('buildPlaywrightCommand appends shell-safe Playwright passthrough args', () => {
  const cmd = buildPlaywrightCommand({
    update: false,
    playwrightArgs: [
      '--grep',
      'M014 S01 flow: deterministic dual-entrypoint pilot',
    ],
  });
  assert.match(cmd, /'--grep' 'M014 S01 flow: deterministic dual-entrypoint pilot'/);
  assert.doesNotMatch(cmd, /update-snapshots/);
});

test('toDockerMountPath converts Windows paths for WSL docker-ce', () => {
  assert.equal(
    toDockerMountPath('D:\\_Dev\\muster', { style: 'wsl' }),
    '/mnt/d/_Dev/muster',
  );
  assert.equal(
    toDockerMountPath('D:/_Dev/muster', { style: 'native' }),
    'D:/_Dev/muster',
  );
  assert.equal(toDockerMountPath('/repo', { style: 'wsl' }), '/repo');
});

test('buildDockerArgs mounts repo read-write, isolates node_modules, pins image', () => {
  const args = buildDockerArgs({
    image: 'mcr.microsoft.com/playwright:v1.61.1-jammy',
    workdir: '/work',
    hostRepo: '/repo',
    command: 'npm run test:visual',
    userArgs: [],
  });
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('-v'));
  assert.ok(args.includes('/repo:/work'));
  assert.ok(args.includes('/work/node_modules'));
  assert.ok(args.includes('mcr.microsoft.com/playwright:v1.61.1-jammy'));
  assert.ok(args.includes('bash'));
  assert.ok(args.includes('-lc'));
  assert.ok(!args.includes('-t'));
  const shell = args[args.length - 1];
  assert.match(shell, /npm run test:visual/);
  assert.match(shell, /cd \/work/);
  assert.match(shell, /npm ci/);
});

test('buildDockerArgs converts Windows host path when mountStyle=wsl', () => {
  const args = buildDockerArgs({
    image: 'mcr.microsoft.com/playwright:v1.61.1-jammy',
    workdir: '/work',
    hostRepo: 'D:\\_Dev\\muster',
    command: 'npx playwright test e2e/visual --project=visual-chromium',
    mountStyle: 'wsl',
    userArgs: [],
  });
  assert.ok(args.includes('/mnt/d/_Dev/muster:/work'));
});


test('resolveHostUserIds prefers MUSTER_VISUAL_UID/GID', () => {
  assert.deepEqual(
    resolveHostUserIds({ MUSTER_VISUAL_UID: '1001', MUSTER_VISUAL_GID: '1001' }),
    { uid: '1001', gid: '1001' },
  );
});

test('dockerUserArgs emits --user and HOME=/tmp when ids present', () => {
  assert.deepEqual(dockerUserArgs({ MUSTER_VISUAL_UID: '1001', MUSTER_VISUAL_GID: '1001' }), [
    '--user',
    '1001:1001',
    '-e',
    'HOME=/tmp',
  ]);
});

test('dockerUserArgs is empty when ids missing', () => {
  assert.deepEqual(dockerUserArgs({}), []);
});

test('buildDockerArgs inserts --user before image when userArgs provided', () => {
  const args = buildDockerArgs({
    image: 'mcr.microsoft.com/playwright:v1.61.1-jammy',
    workdir: '/work',
    hostRepo: '/repo',
    command: 'true',
    userArgs: ['--user', '1001:1001', '-e', 'HOME=/tmp'],
  });
  const imageIdx = args.indexOf('mcr.microsoft.com/playwright:v1.61.1-jammy');
  const userIdx = args.indexOf('--user');
  assert.ok(userIdx >= 0 && userIdx < imageIdx);
  assert.equal(args[userIdx + 1], '1001:1001');
});


test('buildChownArgs chowns bind-mount outputs as root helper container', () => {
  const args = buildChownArgs({
    image: 'mcr.microsoft.com/playwright:v1.61.1-jammy',
    workdir: '/work',
    hostRepo: '/repo',
    uid: '1001',
    gid: '1001',
  });
  assert.ok(args.includes('--rm'));
  assert.ok(args.includes('/repo:/work'));
  assert.ok(args.includes('chown'));
  assert.ok(args.includes('1001:1001'));
  assert.ok(args.includes('test-results'));
  assert.ok(args.includes('playwright-report'));
});
