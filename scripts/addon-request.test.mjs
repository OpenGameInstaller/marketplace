import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const addonRequestScript = resolve(import.meta.dir, 'addon-request.cjs');
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(directory, args, options = {}) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
  }).trim();
}

function createTaggedRepository() {
  const directory = mkdtempSync(join(tmpdir(), 'ogi-addon-ref-'));
  temporaryDirectories.push(directory);
  git(directory, ['init', '--initial-branch=main']);
  git(directory, ['config', 'user.name', 'Test User']);
  git(directory, ['config', 'user.email', 'test@example.com']);
  writeFileSync(join(directory, 'addon.json'), '{}\n');
  git(directory, ['add', 'addon.json']);
  git(directory, ['commit', '-m', 'initial']);
  const commit = git(directory, ['rev-parse', 'HEAD']);
  git(directory, ['tag', '-a', 'v1.0.0', '-m', 'v1.0.0']);
  git(directory, ['branch', 'release']);
  writeFileSync(join(directory, 'addon.json'), '{"next":true}\n');
  git(directory, ['add', 'addon.json']);
  git(directory, ['commit', '-m', 'untagged change']);
  return { commit, directory, head: git(directory, ['rev-parse', 'HEAD']) };
}

function updateBody(targetRef) {
  return [
    '### Addon ID', 'tagged-addon',
    '### Target commit, tag, or branch', targetRef || '_No response_',
    '### Update notes', 'Test tag resolution',
  ].join('\n\n');
}

function applyTaggedUpdate(source, targetRef, body = updateBody(targetRef)) {
  const marketplaceDirectory = mkdtempSync(join(tmpdir(), 'ogi-marketplace-'));
  temporaryDirectories.push(marketplaceDirectory);
  writeFileSync(join(marketplaceDirectory, 'marketplace.json'), `${JSON.stringify([{
    id: 'tagged-addon',
    name: 'Tagged addon',
    source: source.directory,
    pinnedCommit: 'old-commit',
  }], null, 2)}\n`);

  execFileSync('bun', [addonRequestScript, 'apply-update'], {
    cwd: marketplaceDirectory,
    env: { ...process.env, ISSUE_BODY: body },
    stdio: 'pipe',
  });

  const [addon] = JSON.parse(readFileSync(join(marketplaceDirectory, 'marketplace.json'), 'utf8'));
  return addon.pinnedCommit;
}

test('a requested tag pins the commit behind the tag', () => {
  const source = createTaggedRepository();
  expect(applyTaggedUpdate(source, 'v1.0.0')).toBe(source.commit);
});

test('requested branches and commits are normalized to full commit SHAs', () => {
  const source = createTaggedRepository();
  expect(applyTaggedUpdate(source, 'release')).toBe(source.commit);
  expect(applyTaggedUpdate(source, source.commit)).toBe(source.commit);
});

test('an omitted target pins the newest tag commit instead of HEAD', () => {
  const source = createTaggedRepository();
  expect(applyTaggedUpdate(source)).toBe(source.commit);
});

test('latest pins HEAD even when the newest tag points to an older commit', () => {
  const source = createTaggedRepository();
  expect(applyTaggedUpdate(source, 'latest')).toBe(source.head);
});

test('/bump latest updates a blank target and pins HEAD on approval', () => {
  const source = createTaggedRepository();
  const bumpedBody = execFileSync('bun', [addonRequestScript, 'bump'], {
    env: { ...process.env, ISSUE_BODY: updateBody(), BUMP_REF: 'latest' },
    encoding: 'utf8',
  });

  expect(bumpedBody).toContain('### Target commit, tag, or branch\n\nlatest');
  expect(applyTaggedUpdate(source, undefined, bumpedBody)).toBe(source.head);
});
