#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const packagePath = path.join(root, 'package.json');

function fail(message) {
  console.error(`Changelog check failed: ${message}`);
  process.exit(2);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionFor(text, headingRe) {
  const match = headingRe.exec(text);
  if (!match) return null;
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const next = rest.search(/^##\s+/m);
  return next >= 0 ? rest.slice(0, next) : rest;
}

function hasReleaseEntry(section) {
  return /^###\s+(Added|Changed|Fixed|Docs|Internal|Security|Removed)\s*$/m.test(section)
    && /^\s*-\s+\S/m.test(section);
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const version = pkg.version;
if (!version) fail('package.json has no version.');
if (!fs.existsSync(changelogPath)) fail('CHANGELOG.md is missing.');

const text = fs.readFileSync(changelogPath, 'utf8');
if (!/^#\s+Changelog\s*$/m.test(text)) fail('CHANGELOG.md must start with a Changelog title.');
if (!/^##\s+\[Unreleased\]\s*$/m.test(text)) fail('CHANGELOG.md must include an [Unreleased] section.');

const versionHeading = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
const versionSection = sectionFor(text, versionHeading);
if (!versionSection) fail(`CHANGELOG.md is missing a [${version}] - YYYY-MM-DD section.`);
if (!hasReleaseEntry(versionSection)) fail(`CHANGELOG.md [${version}] section must include at least one categorized bullet.`);

console.log(`Changelog check passed: ${version}`);
