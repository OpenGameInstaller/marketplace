#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const marketplacePath = 'marketplace.json';
const issueTemplatePaths = [
  '.github/ISSUE_TEMPLATE/addon-update.yml',
  '.github/ISSUE_TEMPLATE/addon-metadata-update.yml',
];

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^.*[:/]([^/]+?)(?:\.git)?$/i, '$1')
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function inferAddonId(addon) {
  return (
    addon.id ||
    addon.addonId ||
    addon.addon_id ||
    slugify(addon.source || addon.git || addon.repositoryUrl || addon.url || addon.name)
  );
}

const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
const addons = Array.isArray(marketplace) ? marketplace : marketplace.addons || [];
const addonIds = [
  ...new Set(
    addons
      .map(inferAddonId)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))
  ),
];

const options = addonIds.length ? addonIds : ['no-addons-available'];
const generatedBlock = [
  '      # BEGIN GENERATED ADDON ID OPTIONS - run `bun scripts/update-addon-issue-template.mjs`',
  '      options:',
  ...options.map((id) => `        - ${JSON.stringify(id)}`),
  '      default: 0',
  '      # END GENERATED ADDON ID OPTIONS',
].join('\n');

const generatedBlockPattern = /      # BEGIN GENERATED ADDON ID OPTIONS[\s\S]*?      # END GENERATED ADDON ID OPTIONS/;
for (const issueTemplatePath of issueTemplatePaths) {
  const template = readFileSync(issueTemplatePath, 'utf8');
  if (!generatedBlockPattern.test(template)) {
    throw new Error(`Could not find generated addon ID options block in ${issueTemplatePath}.`);
  }

  const nextTemplate = template.replace(generatedBlockPattern, generatedBlock);
  writeFileSync(issueTemplatePath, nextTemplate);
}

console.log(`Updated addon issue templates with ${addonIds.length} addon ID option(s).`);
