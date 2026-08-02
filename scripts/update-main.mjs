#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const branch = process.env.UPDATE_MAIN_BRANCH || 'main';
const maxAttempts = Number.parseInt(process.env.UPDATE_MAIN_ATTEMPTS || '5', 10);
const separator = process.argv.indexOf('--');
const mutation = separator === -1 ? [] : process.argv.slice(separator + 1);
const controlledPaths = [
  'marketplace.json',
  '.github/addon-request-policy.json',
  'api/marketplace.json',
  '.github/ISSUE_TEMPLATE/addon-update.yml',
  '.github/ISSUE_TEMPLATE/addon-metadata-update.yml',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.`);
  }
  return result;
}

function git(args, options = {}) {
  return run('git', args, options);
}

function gitOutput(args) {
  return git(args, { capture: true }).stdout.trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
  throw new Error('UPDATE_MAIN_ATTEMPTS must be a positive integer.');
}
if (separator !== -1 && mutation.length === 0) {
  throw new Error('Expected a mutation command after --.');
}

const commitMessage = process.env.COMMIT_MESSAGE || 'chore: update generated marketplace files';
git(['config', 'user.name', process.env.GIT_AUTHOR_NAME || 'github-actions[bot]']);
git(['config', 'user.email', process.env.GIT_AUTHOR_EMAIL || '41898282+github-actions[bot]@users.noreply.github.com']);

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`Updating ${branch} from its latest remote state (attempt ${attempt}/${maxAttempts}).`);
  git(['fetch', 'origin', branch]);
  const baseSha = gitOutput(['rev-parse', `origin/${branch}`]);
  git(['checkout', '-B', branch, `origin/${branch}`]);
  git(['reset', '--hard', `origin/${branch}`]);

  if (mutation.length > 0) run(mutation[0], mutation.slice(1));
  run('bun', ['scripts/update-addon-issue-template.mjs']);
  run('bun', ['scripts/sync-pages-api.mjs']);

  const paths = controlledPaths.filter((path) => existsSync(path));
  git(['add', '--', ...paths]);
  if (git(['diff', '--cached', '--quiet'], { allowFailure: true }).status === 0) {
    console.log(`${branch} is already up to date.`);
    process.exit(0);
  }

  git(['commit', '-m', commitMessage]);
  const push = git(['push', 'origin', `HEAD:${branch}`], { allowFailure: true });
  if (push.status === 0) process.exit(0);

  git(['fetch', 'origin', branch]);
  const remoteSha = gitOutput(['rev-parse', `origin/${branch}`]);
  if (remoteSha === baseSha || attempt === maxAttempts) {
    throw new Error(`Could not push ${branch}; the remote did not advance in a way that can be replayed.`);
  }

  console.log(`${branch} advanced during the update; replaying the mutation.`);
  await sleep(attempt * 250);
}
