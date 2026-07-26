import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate } from './gate-lib.js';
import { renderCoreSkillTemplate } from '../core/codex-native/core-skill-manifest.js';

export { assertGate, emitGate };

export async function makeTempRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.mkdir(path.join(root, '.sneakoscope', 'reports'), { recursive: true });
  await fs.mkdir(path.join(root, '.sneakoscope', 'locks'), { recursive: true });
  return root;
}

export async function writeText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}

export async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
}

export async function writeManagedCoreSkill(root: string, relRoot: string, name: string): Promise<string> {
  const file = path.join(root, relRoot, name, 'SKILL.md');
  await writeText(file, renderCoreSkillTemplate(name));
  return file;
}

export async function writeUserSkill(root: string, relRoot: string, name: string, display = name): Promise<string> {
  const file = path.join(root, relRoot, name, 'SKILL.md');
  await writeText(file, `---\nname: ${display}\ndescription: user-authored fixture\n---\n\nUser skill fixture.\n`);
  return file;
}
