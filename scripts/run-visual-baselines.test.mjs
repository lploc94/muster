import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDockerArgs,
  buildPlaywrightCommand,
  parseArgs,
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
  });
});

test('parseArgs accepts explicit update mode', () => {
  assert.deepEqual(parseArgs(['--update']), {
    mode: 'update',
    update: true,
    diagnosticsOnly: false,
    help: false,
  });
});

test('parseArgs rejects unknown flags', () => {
  assert.throws(() => parseArgs(['--force']), /Unknown argument/);
});

test('buildPlaywrightCommand never includes update-snapshots in compare mode', () => {
  const cmd = buildPlaywrightCommand({ update: false });
  assert.match(cmd, /playwright test e2e\/visual --project=visual-chromium/);
  assert.doesNotMatch(cmd, /update-snapshots/);
});

test('buildPlaywrightCommand includes update-snapshots only when requested', () => {
  const cmd = buildPlaywrightCommand({ update: true });
  assert.match(cmd, /--update-snapshots/);
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
  });
  assert.ok(args.includes('/mnt/d/_Dev/muster:/work'));
});
