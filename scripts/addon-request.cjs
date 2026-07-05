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

function findAddonForUpdate(body) {
  const payload = parseUpdatePayload(body);
  if (!payload.addonId) return undefined;
  const { addons } = readMarketplace();
  return addons.find((entry) => inferAddonId(entry) === payload.addonId);
}

function getFieldByPrefix(fields, prefix) {
  return Object.entries(fields).find(([key]) => key.startsWith(prefix))?.[1] || '';
}

function getTargetRef(fields) {
  return getFieldByPrefix(fields, 'target commit, tag, or branch');
}

function getDescription(fields) {
  return fields.description || getFieldByPrefix(fields, 'new description');
}

function parseUpdatePayload(body) {
  const fields = parseIssueForm(body);
  return {
    addonId: fields['addon id'],
    targetRef: getTargetRef(fields),
    notes: fields['update notes'],
    name: getFieldByPrefix(fields, 'new addon name'),
    author: getFieldByPrefix(fields, 'new author'),
    source: getFieldByPrefix(fields, 'new repository url'),
    img: getFieldByPrefix(fields, 'new image url'),
    description: getDescription(fields),
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

function requesterOwnsAddon(addon, requesterId) {
  const ownerId = addon?.submittedBy?.id || addon?.submitter?.id || addon?.githubUserId || addon?.github_user_id;
  if (!ownerId || !requesterId) return true;
  return String(ownerId) === String(requesterId);
}

function validateUpdate(body, options = {}) {
  const payload = parseUpdatePayload(body);
  const errors = [];

  if (!payload.addonId || payload.addonId === 'no-addons-available') errors.push('Missing addon ID.');
  if (!payload.notes) errors.push('Missing update notes.');
  if (payload.source) validateUrl(payload.source, 'Repository URL', errors);
  if (payload.img) validateUrl(payload.img, 'Image URL', errors);
  if (options.banned) errors.push(`@${options.user || 'this user'} is banned from addon requests.`);

  let addon;
  try {
    const { addons } = readMarketplace();
    addon = addons.find((entry) => inferAddonId(entry) === payload.addonId);
    if (!addon) errors.push('No matching addon ID was found in marketplace.json.');
    if (addon && !addonSource(addon)) errors.push('Marketplace entry is missing a source field.');
    if (addon && !requesterOwnsAddon(addon, options.userId)) errors.push('Only the original addon submitter can request updates for this addon.');
  } catch (error) {
    errors.push(`Could not read marketplace.json: ${error.message}`);
  }

  const repoUrl = addon && addonSource(addon);
  const summary = [
    '## Addon update request',
    '',
    `**Addon ID:** ${payload.addonId || '_missing_'}`,
    addon ? `**Addon:** ${addon.name || '_unnamed_'}` : '',
    `**Repository:** ${repoUrl || '_found after the addon is matched_'}`,
    `**Requested target:** ${payload.targetRef || '_newest tag on approval_'}`,
    addon ? `**Current pinned commit/ref:** ${addon.pinnedCommit || '_unset_'}` : '',
    addon?.submittedBy?.login ? `**Original submitter:** @${addon.submittedBy.login}` : '',
    payload.name ? `**New name:** ${payload.name}` : '',
    payload.author ? `**New author:** ${payload.author}` : '',
    payload.source ? `**New repository:** ${payload.source}` : '',
    payload.img ? `**New image:** ${payload.img}` : '',
    payload.description ? `**New description:** ${payload.description}` : '',
    options.trusted ? `**Requester trust:** @${options.user} is trusted; this request can be auto-approved.` : '',
    '',
    errors.length ? `**Needs changes before review**\n\n${errors.map((error) => `- ${error}`).join('\n')}` : '**Ready for review**',
    '',
    '### What happens next',
    '',
    '- If no target is listed, I will use the newest tag from the addon repository when this is approved.',
    '- A maintainer can approve this with `/approve`.',
    '- The issue creator or addon owner can still update details here with `/bump`, `/set-name`, `/set-author`, `/set-description`, `/set-repository`, or `/set-image`.',
    '- After approval, the marketplace listing is updated and this issue is closed.',
    '',
    errors.length ? 'Please update the issue with the missing or incorrect details above.' : (options.trusted ? 'This trusted update is ready to be applied automatically.' : 'This request is ready for a maintainer to review.'),
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
    '## Addon submission',
    '',
    `**Addon:** ${payload.name || '_missing_'}`,
    `**Author:** ${payload.author || '_missing_'}`,
    `**Repository:** ${payload.source || '_missing_'}`,
    `**Image:** ${payload.img || '_missing_'}`,
    `**Requested target:** ${payload.targetRef || '_newest tag on approval_'}`,
    '',
    errors.length ? `**Needs changes before review**\n\n${errors.map((error) => `- ${error}`).join('\n')}` : '**Ready for review**',
    '',
    '### What happens next',
    '',
    '- A maintainer will review the listing details, repository, image, and description.',
    '- If no target is listed, I will use the newest tag from the addon repository when this is approved.',
    '- A maintainer can add this with `/approve`.',
    '- The issue creator can still update details here with `/bump`, `/set-name`, `/set-author`, `/set-description`, `/set-repository`, or `/set-image`.',
    '- After approval, the addon is added to the marketplace and this issue is closed.',
    '',
    errors.length ? 'Please update the issue with the missing or incorrect details above.' : 'This submission is ready for a maintainer to review.',
  ].filter(Boolean).join('\n');

  return { payload, duplicate, errors, summary };
}

function applyUpdate(body, options = {}) {
  const payload = parseUpdatePayload(body);
  if (!payload.addonId || payload.addonId === 'no-addons-available') throw new Error('Missing required field: addonId');
  if (!payload.notes) throw new Error('Missing required field: notes');
  const metadataErrors = [];
  if (payload.source) validateUrl(payload.source, 'Repository URL', metadataErrors);
  if (payload.img) validateUrl(payload.img, 'Image URL', metadataErrors);
  if (metadataErrors.length) throw new Error(metadataErrors.join('\n'));

  const { marketplace: addons } = readMarketplace();
  const addon = addons.find((entry) => inferAddonId(entry) === payload.addonId);
  if (!addon) throw new Error(`No matching addon found for ID ${payload.addonId}`);

  if (!requesterOwnsAddon(addon, options.userId || process.env.ADDON_REQUESTER_ID)) {
    throw new Error('Only the original addon submitter can update this addon.');
  }

  const source = payload.source || addonSource(addon);
  if (!source) throw new Error('Marketplace entry is missing a source field.');

  addon.pinnedCommit = resolveTargetRef(source, payload.targetRef);
  addon.updatedAt = new Date().toISOString();
  addon.updateNotes = payload.notes;
  if (payload.name) addon.name = payload.name;
  if (payload.author) addon.author = payload.author;
  if (payload.source) addon.source = payload.source;
  if (payload.img) addon.img = payload.img;
  if (payload.description) addon.description = payload.description;

  fs.writeFileSync('marketplace.json', `${JSON.stringify(addons, null, 2)}\n`);
  return { payload, pinnedCommit: addon.pinnedCommit };
}

function applyCreate(body, options = {}) {
  const validation = validateCreate(body);
  if (validation.errors.length) throw new Error(validation.errors.join('\n'));

  const payload = validation.payload;
  const { marketplace: addons } = readMarketplace();
  const pinnedCommit = resolveTargetRef(payload.source, payload.targetRef);
  const submitterId = options.submitterId || process.env.ADDON_SUBMITTER_ID;
  const submitterLogin = options.submitterLogin || process.env.ADDON_SUBMITTER_LOGIN;
  const discussionUrl = options.discussionUrl || process.env.ADDON_DISCUSSION_URL;
  const discussionId = options.discussionId || process.env.ADDON_DISCUSSION_ID;

  const addon = {
    name: payload.name,
    author: payload.author,
    source: payload.source,
    img: payload.img,
    pinnedCommit,
    description: payload.description,
    submittedBy: {
      id: submitterId ? String(submitterId) : undefined,
      login: submitterLogin || undefined,
    },
    discussion: discussionUrl || discussionId ? {
      id: discussionId || undefined,
      url: discussionUrl || undefined,
    } : undefined,
  };

  if (!addon.submittedBy.id && !addon.submittedBy.login) delete addon.submittedBy;
  if (!addon.discussion) delete addon.discussion;

  addons.push(addon);
  addons.sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync('marketplace.json', `${JSON.stringify(addons, null, 2)}\n`);
  return { payload, pinnedCommit };
}

function inferRequestType(body, labels = []) {
  if (labels.includes('addon-create')) return 'create';
  if (labels.includes('addon-update')) return 'update';

  const fields = parseIssueForm(body);
  if (fields['addon name'] && fields['repository url'] && fields['image url']) return 'create';
  if (fields['addon id']) return 'update';
  return '';
}

function applyByLabel(body, labels = [], options = {}) {
  const type = inferRequestType(body, labels);
  if (type === 'create') return applyCreate(body, options);
  if (type === 'update') return applyUpdate(body, options);
  throw new Error('Issue is not an addon creation or update request.');
}

function replaceTargetRef(body, targetRef) {
  if (!targetRef) throw new Error('Usage: /bump <commit, tag, or branch>');
  return replaceIssueField(body, 'target', targetRef);
}

const EDITABLE_FIELDS = {
  name: {
    heading: 'Addon name',
    updateHeading: 'New addon name',
    aliases: ['addon-name', 'addon name', 'name'],
    usage: '/set-name <new addon name>',
  },
  author: {
    heading: 'Author',
    updateHeading: 'New author',
    aliases: ['author'],
    usage: '/set-author <new author>',
  },
  description: {
    heading: 'Description',
    updateHeading: 'New description',
    aliases: ['description', 'desc'],
    usage: '/set-description <new description>',
  },
  repository: {
    heading: 'Repository URL',
    updateHeading: 'New repository URL',
    aliases: ['repository', 'repository-url', 'repo', 'source'],
    usage: '/set-repository <new repository URL>',
  },
  image: {
    heading: 'Image URL',
    updateHeading: 'New image URL',
    aliases: ['image', 'image-url', 'img'],
    usage: '/set-image <new image URL>',
  },
  target: {
    heading: 'Target commit, tag, or branch',
    aliases: ['target', 'target-ref', 'bump'],
    usage: '/bump <commit, tag, or branch>',
  },
};

function editableFieldForAlias(alias) {
  const normalized = String(alias || '').trim().toLowerCase();
  return Object.entries(EDITABLE_FIELDS).find(([, field]) => field.aliases.includes(normalized));
}

function fieldPattern(heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(###\\s+${escaped}[^\\n]*\\n+)([\\s\\S]*?)(?=\\n###\\s+|$)`, 'i');
}

function insertIssueField(body, heading, value) {
  const text = String(body || '').trimEnd();
  const block = `### ${heading}\n\n${value}\n`;
  const insertionPoint = text.search(/\n###\s+(Update notes|Submission notes|Confirmation)\b/i);
  if (insertionPoint === -1) return `${text}\n\n${block}`;
  return `${text.slice(0, insertionPoint)}\n\n${block}${text.slice(insertionPoint)}`;
}

function replaceIssueField(body, fieldAlias, value) {
  if (!String(value || '').trim()) {
    const [, field] = editableFieldForAlias(fieldAlias) || [];
    throw new Error(`Usage: ${field?.usage || '/set-field <value>'}`);
  }

  const entry = editableFieldForAlias(fieldAlias);
  if (!entry) throw new Error(`Unknown editable field: ${fieldAlias}`);

  const [, field] = entry;
  const nextValue = String(value).trim();
  const existingPattern = fieldPattern(field.heading);
  if (existingPattern.test(body)) {
    return body.replace(existingPattern, (_, heading) => `${heading}${nextValue}\n`);
  }

  const updateHeading = field.updateHeading || field.heading;
  const updatePattern = fieldPattern(updateHeading);
  if (updatePattern.test(body)) {
    return body.replace(updatePattern, (_, heading) => `${heading}${nextValue}\n`);
  }

  return insertIssueField(body, updateHeading, nextValue);
}

module.exports = {
  parseIssueForm,
  parseUpdatePayload,
  parseCreatePayload,
  readMarketplace,
  findAddonForUpdate,
  validate: validateUpdate,
  validateUpdate,
  validateCreate,
  requesterOwnsAddon,
  applyUpdate,
  applyCreate,
  inferRequestType,
  applyByLabel,
  replaceTargetRef,
  replaceIssueField,
  editableFieldForAlias,
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
    process.stdout.write(JSON.stringify(applyUpdate(body, { userId: process.env.ADDON_REQUESTER_ID })));
  } else if (command === 'apply-create') {
    process.stdout.write(JSON.stringify(applyCreate(body)));
  } else if (command === 'apply-by-label') {
    process.stdout.write(JSON.stringify(applyByLabel(body, (process.env.ISSUE_LABELS || '').split(',').filter(Boolean), { userId: process.env.ADDON_REQUESTER_ID })));
  } else if (command === 'bump') {
    process.stdout.write(replaceTargetRef(body, process.env.BUMP_REF || process.argv[3] || ''));
  } else if (command === 'set-field') {
    process.stdout.write(replaceIssueField(body, process.env.FIELD_NAME || process.argv[3] || '', process.env.FIELD_VALUE || process.argv.slice(4).join(' ')));
  } else {
    throw new Error('Usage: addon-request.cjs <validate-update|validate-create|apply-update|apply-create|apply-by-label|bump|set-field>');
  }
}
