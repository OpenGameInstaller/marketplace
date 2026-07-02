const fs = require('fs');
const { execFileSync } = require('child_process');

function parseIssueForm(body) {
  const fields = {};
  const regex = /###\s+(.+?)\s*\n+([\s\S]*?)(?=\n###\s+|$)/g;
  for (const match of String(body || '').matchAll(regex)) {
    const value = match[2].replace(/<!--[\s\S]*?-->/g, '').trim();
    fields[match[1].trim().toLowerCase()] = /^_no response_$/i.test(value) ? '' : value;
  }
  return fields;
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^.*[:/]([^/]+?)(?:\.git)?$/i, '$1')
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

function inferAddonId(addon) {
  return addon.id || addon.addonId || addon.addon_id || slugify(addon.source || addon.git || addon.repositoryUrl || addon.url || addon.name);
}

function addonSource(addon) {
  return addon.source || addon.git || addon.repositoryUrl || addon.url;
}

function readMarketplace(path = 'marketplace.json') {
  const marketplace = JSON.parse(fs.readFileSync(path, 'utf8'));
  if (!Array.isArray(marketplace)) throw new Error('marketplace.json must be a top-level array.');
  return { marketplace, addons: marketplace };
}

function getFieldByPrefix(fields, prefix) {
  return Object.entries(fields).find(([key]) => key.startsWith(prefix))?.[1] || '';
}

function getTargetRef(fields) {
  return getFieldByPrefix(fields, 'target commit, tag, or branch');
}

function parseUpdatePayload(body) {
  const fields = parseIssueForm(body);
  return {
    addonId: fields['addon id'],
    targetRef: getTargetRef(fields),
    notes: fields['update notes'],
  };
}

function parseCreatePayload(body) {
  const fields = parseIssueForm(body);
  return {
    name: fields['addon name'],
    author: fields['author'],
    source: fields['repository url'],
    img: fields['image url'],
    description: fields['description'],
    targetRef: getTargetRef(fields),
    notes: fields['submission notes'],
  };
}

function resolveTargetRef(source, requestedRef) {
  if (requestedRef) return requestedRef;

  const tmp = fs.mkdtempSync('/tmp/ogi-addon-tags-');
  try {
    execFileSync('git', ['init', '--bare', tmp], { stdio: 'inherit' });
    execFileSync('git', ['--git-dir', tmp, 'remote', 'add', 'origin', source], { stdio: 'inherit' });
    execFileSync('git', ['--git-dir', tmp, 'fetch', '--tags', '--force', 'origin', '+refs/tags/*:refs/tags/*'], { stdio: 'inherit' });

    const latestTag = execFileSync(
      'git',
      ['--git-dir', tmp, 'for-each-ref', '--sort=-creatordate', '--format=%(refname:short)', '--count=1', 'refs/tags'],
      { encoding: 'utf8' }
    ).trim();

    if (latestTag) {
      return execFileSync('git', ['--git-dir', tmp, 'rev-list', '-n', '1', latestTag], { encoding: 'utf8' }).trim();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return execFileSync('git', ['ls-remote', source, 'HEAD'], { encoding: 'utf8' }).trim().split(/\s+/)[0];
}

function validateUrl(value, label, errors) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) errors.push(`${label} must be an HTTP(S) URL.`);
  } catch {
    errors.push(`${label} must be a valid URL.`);
  }
}

function validateUpdate(body, options = {}) {
  const payload = parseUpdatePayload(body);
  const errors = [];

  if (!payload.addonId || payload.addonId === 'no-addons-available') errors.push('Missing addon ID.');
  if (!payload.notes) errors.push('Missing update notes.');
  if (options.banned) errors.push(`@${options.user || 'this user'} is banned from addon requests.`);

  let addon;
  try {
    const { addons } = readMarketplace();
    addon = addons.find((entry) => inferAddonId(entry) === payload.addonId);
    if (!addon) errors.push('No matching addon ID was found in marketplace.json.');
    if (addon && !addonSource(addon)) errors.push('Marketplace entry is missing a source field.');
  } catch (error) {
    errors.push(`Could not read marketplace.json: ${error.message}`);
  }

  const repoUrl = addon && addonSource(addon);
  const summary = [
    '## Addon update request validation',
    '',
    `**Addon ID:** ${payload.addonId || '_missing_'}`,
    addon ? `**Addon:** ${addon.name || '_unnamed_'}` : '',
    `**Repository:** ${repoUrl || '_inferred after addon match_'}`,
    `**Requested target:** ${payload.targetRef || '_latest created tag will be resolved on approval_'}`,
    addon ? `**Current pinned commit/ref:** ${addon.pinnedCommit || '_unset_'}` : '',
    options.trusted ? `**Requester trust:** @${options.user} is trusted; this request can be auto-approved.` : '',
    '',
    errors.length ? `❌ **Validation failed**\n\n${errors.map((error) => `- ${error}`).join('\n')}` : '✅ **Validation passed**',
    '',
    errors.length ? 'Edit the issue to fix the problems above.' : (options.trusted ? 'Trusted requester: this update will be applied automatically.' : 'A maintainer with write access can approve this update by commenting `/approve`.'),
  ].filter(Boolean).join('\n');

  return { payload, addon, errors, summary };
}

function validateCreate(body, options = {}) {
  const payload = parseCreatePayload(body);
  const errors = [];

  if (!payload.name) errors.push('Missing addon name.');
  if (!payload.author) errors.push('Missing author.');
  if (!payload.source) errors.push('Missing repository URL.');
  if (!payload.img) errors.push('Missing image URL.');
  if (!payload.description) errors.push('Missing description.');
  if (payload.source) validateUrl(payload.source, 'Repository URL', errors);
  if (payload.img) validateUrl(payload.img, 'Image URL', errors);
  if (options.banned) errors.push(`@${options.user || 'this user'} is banned from addon requests.`);

  let duplicate;
  try {
    const { addons } = readMarketplace();
    duplicate = addons.find((entry) => entry.name.toLowerCase() === String(payload.name || '').toLowerCase() || normalizeUrl(addonSource(entry)) === normalizeUrl(payload.source));
    if (duplicate) errors.push(`Marketplace already has a matching addon (${duplicate.name}).`);
  } catch (error) {
    errors.push(`Could not read marketplace.json: ${error.message}`);
  }

  const summary = [
    '## Addon submission validation',
    '',
    `**Addon:** ${payload.name || '_missing_'}`,
    `**Author:** ${payload.author || '_missing_'}`,
    `**Repository:** ${payload.source || '_missing_'}`,
    `**Image:** ${payload.img || '_missing_'}`,
    `**Requested target:** ${payload.targetRef || '_latest created tag will be resolved on approval_'}`,
    '',
    errors.length ? `❌ **Validation failed**\n\n${errors.map((error) => `- ${error}`).join('\n')}` : '✅ **Validation passed**',
    '',
    errors.length ? 'Edit the issue to fix the problems above.' : 'A maintainer with write access can add this addon by commenting `/approve`.',
  ].filter(Boolean).join('\n');

  return { payload, duplicate, errors, summary };
}

function applyUpdate(body) {
  const payload = parseUpdatePayload(body);
  if (!payload.addonId || payload.addonId === 'no-addons-available') throw new Error('Missing required field: addonId');
  if (!payload.notes) throw new Error('Missing required field: notes');

  const { marketplace: addons } = readMarketplace();
  const addon = addons.find((entry) => inferAddonId(entry) === payload.addonId);
  if (!addon) throw new Error(`No matching addon found for ID ${payload.addonId}`);

  const source = addonSource(addon);
  if (!source) throw new Error('Marketplace entry is missing a source field.');

  addon.pinnedCommit = resolveTargetRef(source, payload.targetRef);
  addon.updatedAt = new Date().toISOString();
  addon.updateNotes = payload.notes;

  fs.writeFileSync('marketplace.json', `${JSON.stringify(addons, null, 2)}\n`);
  return { payload, pinnedCommit: addon.pinnedCommit };
}

function applyCreate(body) {
  const validation = validateCreate(body);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));

  const payload = validation.payload;
  const { marketplace: addons } = readMarketplace();
  const pinnedCommit = resolveTargetRef(payload.source, payload.targetRef);
  const addon = {
    name: payload.name,
    author: payload.author,
    source: payload.source,
    img: payload.img,
    pinnedCommit,
    description: payload.description,
  };

  addons.push(addon);
  addons.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync('marketplace.json', `${JSON.stringify(addons, null, 2)}\n`);
  return { payload, pinnedCommit };
}

function applyByLabel(body, labels = []) {
  if (labels.includes('addon-create')) return applyCreate(body);
  if (labels.includes('addon-update')) return applyUpdate(body);
  throw new Error('Issue is not an addon creation or update request.');
}

function replaceTargetRef(body, targetRef) {
  if (!targetRef) throw new Error('Usage: /bump <commit, tag, or branch>');
  const pattern = /(###\s+Target commit, tag, or branch[^\n]*\n+)([\s\S]*?)(?=\n###\s+|$)/i;
  if (!pattern.test(body)) throw new Error('Could not find the target ref field in the issue body.');
  return body.replace(pattern, (_, heading) => `${heading}${targetRef}\n`);
}

module.exports = {
  parseIssueForm,
  parseUpdatePayload,
  parseCreatePayload,
  validate: validateUpdate,
  validateUpdate,
  validateCreate,
  applyUpdate,
  applyCreate,
  applyByLabel,
  replaceTargetRef,
};

if (require.main === module) {
  const command = process.argv[2];
  const body = process.env.ISSUE_BODY || fs.readFileSync(0, 'utf8');
  const options = {
    banned: process.env.REQUESTER_BANNED === 'true',
    trusted: process.env.REQUESTER_TRUSTED === 'true',
    user: process.env.REQUESTER_LOGIN || '',
  };

  if (command === 'validate-update') {
    process.stdout.write(JSON.stringify(validateUpdate(body, options)));
  } else if (command === 'validate-create') {
    process.stdout.write(JSON.stringify(validateCreate(body, options)));
  } else if (command === 'apply-update' || command === 'apply') {
    process.stdout.write(JSON.stringify(applyUpdate(body)));
  } else if (command === 'apply-create') {
    process.stdout.write(JSON.stringify(applyCreate(body)));
  } else if (command === 'apply-by-label') {
    process.stdout.write(JSON.stringify(applyByLabel(body, (process.env.ISSUE_LABELS || '').split(',').filter(Boolean))));
  } else if (command === 'bump') {
    process.stdout.write(replaceTargetRef(body, process.env.BUMP_REF || process.argv[3] || ''));
  } else {
    throw new Error('Usage: addon-request.cjs <validate-update|validate-create|apply-update|apply-create|apply-by-label|bump>');
  }
}
