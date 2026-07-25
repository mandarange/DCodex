#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function assertGate(condition, message, detail = {}) {
  if (condition) return;
  console.error(JSON.stringify({ ok: false, message, detail }, null, 2));
  process.exit(1);
}

export function emitGate(name, detail = {}) {
  console.log(JSON.stringify({ schema: 'sks.release-gate.v1', ok: true, gate: name, ...detail }, null, 2));
}

export function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

export function readJson(rel) {
  return JSON.parse(readText(rel));
}

export function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

export async function importDist(rel) {
  const absolute = path.join(root, 'dist', rel);
  assertGate(fs.existsSync(absolute), `dist module missing: ${rel}`, { hint: 'run npm run build first' });
  return import(pathToFileURL(absolute).href);
}

export function packageScripts() {
  return readJson('package.json').scripts || {};
}

export function scriptContains(name, token) {
  return String(packageScripts()[name] || '').includes(token);
}

export function assertFiles(files) {
  for (const file of files) assertGate(exists(file), `missing required file: ${file}`);
}

export const SOURCE_INTELLIGENCE_FILES = [
  'src/core/source-intelligence/source-intelligence-policy.ts',
  'src/core/source-intelligence/source-intelligence-runner.ts',
  'src/core/source-intelligence/source-intelligence-proof.ts',
  'src/core/super-search/types.ts',
  'src/core/super-search/runtime.ts',
  'src/core/codex/codex-web-search-adapter.ts'
];

export const AGENT_RUNTIME_FILES = [
  'src/core/agents/scout-policy.ts',
  'src/core/agents/agent-terminal-session.ts',
  'src/core/agents/zellij-right-lane-cockpit.ts',
  'src/core/agents/agent-runner-zellij.ts',
  'src/core/codex/official-goal-mode.ts'
];
