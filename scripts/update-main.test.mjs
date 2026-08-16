import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

function git(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...options }).trim();
}

function writeUpdateTemplate(path) {
  writeFileSync(path, [
    'name: Update addon',
    'body:',
    '  - type: dropdown',
    '    attributes:',
    '      # BEGIN GENERATED ADDON ID OPTIONS - run `bun scripts/update-addon-issue-template.mjs`',
    '      options:',
    '        - "placeholder"',
    '      default: 0',
    '      # END GENERATED ADDON ID OPTIONS',
    '',
  ].join('\n'));
}

function issueBody(addonId, targetRef) {
  return [
    '### Addon ID',
    '',
    addonId,
    '',
    '### Target commit, tag, or branch',
    '',
    targetRef,
    '',
    '### Update notes',
    '',
    `Update ${addonId}`,
    '',
  ].join('\n');
}

function prepareAddonRepository(root, name) {
  const source = join(root, `${name}-addon`);
  mkdirSync(source);
  git(source, ['init', '--initial-branch=main']);
  git(source, ['config', 'user.name', 'Test']);
  git(source, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(source, 'addon.json'), `${name}-old\n`);
  git(source, ['add', 'addon.json']);
  git(source, ['commit', '-m', 'old version']);
  git(source, ['tag', `${name}-old`]);
  writeFileSync(join(source, 'addon.json'), `${name}-new\n`);
  git(source, ['commit', '-am', 'new version']);
  git(source, ['tag', `${name}-new`]);
  return source;
}

function prepareRemote(root) {
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const alphaSource = prepareAddonRepository(root, 'alpha');
  const betaSource = prepareAddonRepository(root, 'beta');
  mkdirSync(seed);
  git(root, ['init', '--bare', '--initial-branch=main', remote]);
  git(seed, ['init', '--initial-branch=main']);
  git(seed, ['config', 'user.name', 'Test']);
  git(seed, ['config', 'user.email', 'test@example.com']);

  mkdirSync(join(seed, 'scripts'));
  mkdirSync(join(seed, '.github', 'ISSUE_TEMPLATE'), { recursive: true });
  cpSync(join(repositoryRoot, 'scripts', 'addon-request.cjs'), join(seed, 'scripts', 'addon-request.cjs'));
  cpSync(join(repositoryRoot, 'scripts', 'update-addon-issue-template.mjs'), join(seed, 'scripts', 'update-addon-issue-template.mjs'));
  cpSync(join(repositoryRoot, 'scripts', 'sync-pages-api.mjs'), join(seed, 'scripts', 'sync-pages-api.mjs'));
  cpSync(join(repositoryRoot, 'scripts', 'update-main.mjs'), join(seed, 'scripts', 'update-main.mjs'));
  writeUpdateTemplate(join(seed, '.github', 'ISSUE_TEMPLATE', 'addon-update.yml'));
  writeUpdateTemplate(join(seed, '.github', 'ISSUE_TEMPLATE', 'addon-metadata-update.yml'));
  writeFileSync(join(seed, '.gitignore'), '_site/\n');
  writeFileSync(join(seed, 'marketplace.json'), `${JSON.stringify([
    { id: 'alpha', name: 'Alpha', source: alphaSource, pinnedCommit: git(alphaSource, ['rev-parse', 'alpha-old']) },
    { id: 'beta', name: 'Beta', source: betaSource, pinnedCommit: git(betaSource, ['rev-parse', 'beta-old']) },
  ], null, 2)}\n`);

  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'initial']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  return remote;
}

function prepareRunner(root, remote, name) {
  const runner = join(root, name);
  git(root, ['clone', remote, runner]);
  git(runner, ['config', 'user.name', 'github-actions[bot]']);
  git(runner, ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  return runner;
}

const updateCommand = [
  'scripts/update-main.mjs',
  '--',
  'node',
  'scripts/addon-request.cjs',
  'apply-by-label',
];

function updateEnvironment(addonId, targetRef) {
  return {
    ...process.env,
    COMMIT_MESSAGE: `update ${addonId}`,
    ISSUE_BODY: issueBody(addonId, targetRef),
    ISSUE_LABELS: 'addon-update',
  };
}

function applyUpdate(runner, addonId, targetRef) {
  return execFileSync('node', updateCommand, {
    cwd: runner,
    env: updateEnvironment(addonId, targetRef),
    encoding: 'utf8',
  });
}

function applyUpdateWithBun(runner, addonId, targetRef) {
  return execFileSync('bun', updateCommand, {
    cwd: runner,
    env: updateEnvironment(addonId, targetRef),
    encoding: 'utf8',
  });
}

function applyUpdateAsync(runner, addonId, targetRef) {
  const child = spawn('node', updateCommand, {
    cwd: runner,
    env: updateEnvironment(addonId, targetRef),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function installPushBarrier(runner, coordinator, name) {
  const waitFor = name === 'alpha' ? 'beta-ready' : 'alpha-done';
  const hook = `#!/bin/sh\ntouch "${join(coordinator, `${name}-ready`)}"\nwhile [ ! -f "${join(coordinator, waitFor)}" ]; do sleep 0.01; done\n`;
  const hookPath = join(runner, '.git', 'hooks', 'pre-push');
  writeFileSync(hookPath, hook);
  chmodSync(hookPath, 0o755);
}

test('a stale runner replays its marketplace update on latest main', () => {
  const root = mkdtempSync(join(tmpdir(), 'ogi-update-main-'));
  try {
    const remote = prepareRemote(root);
    const alphaRunner = prepareRunner(root, remote, 'alpha-runner');
    const betaRunner = prepareRunner(root, remote, 'beta-runner');
    const alphaCommit = git(join(root, 'alpha-addon'), ['rev-parse', 'alpha-new']);
    const betaCommit = git(join(root, 'beta-addon'), ['rev-parse', 'beta-new']);

    applyUpdate(alphaRunner, 'alpha', 'alpha-new');
    const betaOutput = applyUpdate(betaRunner, 'beta', 'beta-new');
    assert.match(betaOutput, /latest remote state/);

    const result = prepareRunner(root, remote, 'result');
    const marketplace = JSON.parse(readFileSync(join(result, 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.find((addon) => addon.name === 'Alpha').pinnedCommit, alphaCommit);
    assert.equal(marketplace.find((addon) => addon.name === 'Beta').pinnedCommit, betaCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the workflow-style Bun invocation applies its mutation', () => {
  const root = mkdtempSync(join(tmpdir(), 'ogi-update-main-bun-'));
  try {
    const remote = prepareRemote(root);
    const runner = prepareRunner(root, remote, 'runner');
    const alphaCommit = git(join(root, 'alpha-addon'), ['rev-parse', 'alpha-new']);

    const output = applyUpdateWithBun(runner, 'alpha', 'alpha-new');
    assert.match(output, new RegExp(`"pinnedCommit":"${alphaCommit}"`));

    const result = prepareRunner(root, remote, 'result');
    const marketplace = JSON.parse(readFileSync(join(result, 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.find((addon) => addon.name === 'Alpha').pinnedCommit, alphaCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected concurrent push retries without losing either update', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ogi-update-main-retry-'));
  try {
    const remote = prepareRemote(root);
    const coordinator = join(root, 'coordinator');
    mkdirSync(coordinator);
    const alphaRunner = prepareRunner(root, remote, 'alpha-runner');
    const betaRunner = prepareRunner(root, remote, 'beta-runner');
    const alphaCommit = git(join(root, 'alpha-addon'), ['rev-parse', 'alpha-new']);
    const betaCommit = git(join(root, 'beta-addon'), ['rev-parse', 'beta-new']);
    installPushBarrier(alphaRunner, coordinator, 'alpha');
    installPushBarrier(betaRunner, coordinator, 'beta');

    const alphaPromise = applyUpdateAsync(alphaRunner, 'alpha', 'alpha-new');
    const betaPromise = applyUpdateAsync(betaRunner, 'beta', 'beta-new');
    const alpha = await alphaPromise;
    assert.equal(alpha.status, 0, alpha.stderr);
    writeFileSync(join(coordinator, 'alpha-done'), '');
    const beta = await betaPromise;
    assert.equal(beta.status, 0, beta.stderr);
    assert.match(beta.stdout, /advanced during the update; replaying the mutation/);

    const result = prepareRunner(root, remote, 'result');
    const marketplace = JSON.parse(readFileSync(join(result, 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.find((addon) => addon.name === 'Alpha').pinnedCommit, alphaCommit);
    assert.equal(marketplace.find((addon) => addon.name === 'Beta').pinnedCommit, betaCommit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
