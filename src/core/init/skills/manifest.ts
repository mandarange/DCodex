import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PACKAGE_VERSION, readJson, sha256 } from '../../fsx.js';
import { isCoreSkillName } from '../../codex-native/core-skill-manifest.js';
import {
  MAX_SKILL_HASH_HISTORY,
  PACKAGED_SKILLS_MANIFEST_SCHEMA,
  REMOVED_SKS_SKILL_NAME_SET,
  SKILLS_HASH_LEDGER_SCHEMA,
  SKILL_ALIASES,
  buildFallbackSkillsManifest,
  canonicalSkillNameFromValue
} from './inventory.js';

export async function loadSkillsManifest(): Promise<any> {
  const bundled = await loadBundledSkillsManifest();
  if (bundled) return bundled;
  const candidates = [
    path.join(path.resolve(process.env.HOME || os.homedir()), '.agents', 'skills', 'skills-manifest.json')
  ];
  return (await loadFirstCompleteSkillsManifest(candidates)) || buildFallbackSkillsManifest();
}

export async function loadBundledSkillsManifest(): Promise<any | null> {
  const packaged = await loadFirstCompleteSkillsManifest([
    path.join(packageRootDir(), 'dist', 'config', 'skills-manifest.json'),
    path.join(packageRootDir(), 'config', 'skills-manifest.json')
  ]);
  if (packaged) return packaged;
  const ledger = await readJson(path.join(packageRootDir(), 'config', 'skills-hash-ledger.v1.json'), null);
  return skillsManifestFromHashLedger(ledger);
}

export function skillsManifestFromHashLedger(ledger: any): any | null {
  if (ledger?.schema !== SKILLS_HASH_LEDGER_SCHEMA || !Array.isArray(ledger?.skills)) return null;
  const expected = new Set(
    buildFallbackSkillsManifest().skills.map((skill) => canonicalSkillNameFromValue(skill.canonical_name))
  );
  const names = new Set<string>();
  const skills: any[] = [];
  for (const row of ledger.skills) {
    const canonicalName = canonicalSkillNameFromValue(row?.canonical_name);
    const trusted = Array.isArray(row?.trusted_sha256)
      ? row.trusted_sha256.map((value: unknown) => String(value || '').trim().toLowerCase())
      : [];
    if (!canonicalName
      || canonicalName !== row?.canonical_name
      || names.has(canonicalName)
      || trusted.length < 1
      || trusted.length > MAX_SKILL_HASH_HISTORY + 1
      || trusted.some((digest: string) => !/^[a-f0-9]{64}$/.test(digest))
      || new Set(trusted).size !== trusted.length) return null;
    names.add(canonicalName);
    if (REMOVED_SKS_SKILL_NAME_SET.has(canonicalName)) continue;
    skills.push({
      canonical_name: canonicalName,
      type: isCoreSkillName(canonicalName) ? 'core' : 'official',
      content_sha256: trusted[0],
      hash_history: trusted.slice(1),
      deprecated_aliases: SKILL_ALIASES[canonicalName] || []
    });
  }
  if ([...expected].some((name) => !names.has(name))) return null;
  const manifest = {
    schema: PACKAGED_SKILLS_MANIFEST_SCHEMA,
    package_version: PACKAGE_VERSION,
    skills: skills.sort((left, right) => left.canonical_name.localeCompare(right.canonical_name))
  };
  return skillsManifestHasContentDigests(manifest) ? manifest : null;
}

export function normalizeSkillsManifest(manifest: any) {
  const skills = (manifest.skills || [])
    .map((skill: any) => ({
      ...skill,
      deprecated_aliases: (skill.deprecated_aliases || [])
        .filter((name: any) => !REMOVED_SKS_SKILL_NAME_SET.has(canonicalSkillNameFromValue(name)))
    }))
    .filter((skill: any) => !REMOVED_SKS_SKILL_NAME_SET.has(canonicalSkillNameFromValue(skill.canonical_name)));
  const { removed_skills: _retiredInventory, ...current } = manifest || {};
  return { ...current, skills };
}

export function mergePackagedSkillsManifestHashHistory(currentManifest: any, previousManifest: any): any {
  const previousByName = new Map<string, any>(
    (Array.isArray(previousManifest?.skills) ? previousManifest.skills : [])
      .map((row: any) => [canonicalSkillNameFromValue(row?.canonical_name), row])
      .filter(([name]: [string, any]) => Boolean(name))
  );
  return {
    ...currentManifest,
    skills: (Array.isArray(currentManifest?.skills) ? currentManifest.skills : []).map((row: any) => {
      const canonicalName = canonicalSkillNameFromValue(row?.canonical_name);
      const currentDigest = String(row?.content_sha256 || '').trim().toLowerCase();
      const previous = previousByName.get(canonicalName);
      const history = [
        previous?.content_sha256,
        ...(Array.isArray(previous?.hash_history) ? previous.hash_history : []),
        ...(Array.isArray(row?.hash_history) ? row.hash_history : [])
      ]
        .map((value) => String(value || '').trim().toLowerCase())
        .filter((value, index, values) => (
          /^[a-f0-9]{64}$/.test(value)
          && value !== currentDigest
          && values.indexOf(value) === index
        ))
        .slice(0, MAX_SKILL_HASH_HISTORY);
      return { ...row, hash_history: history };
    })
  };
}

export function skillManifestGenerationSha256(manifest: any): string | null {
  if (manifest?.schema !== PACKAGED_SKILLS_MANIFEST_SCHEMA || !Array.isArray(manifest?.skills)) return null;
  const rows = manifest.skills
    .map((skill: any) => ({
      canonical_name: canonicalSkillNameFromValue(skill?.canonical_name),
      content_sha256: String(skill?.content_sha256 || '').trim().toLowerCase()
    }))
    .filter((skill: any) => skill.canonical_name && /^[a-f0-9]{64}$/.test(skill.content_sha256))
    .sort((left: any, right: any) => left.canonical_name.localeCompare(right.canonical_name));
  return rows.length ? sha256(JSON.stringify(rows)) : null;
}

export async function runtimeBuildSourceTime(): Promise<number | null> {
  const stamp: any = await readJson(path.join(packageRootDir(), 'dist', '.sks-build-stamp.json'), null);
  return Number.isFinite(stamp?.built_at_source_time) && stamp.built_at_source_time > 0
    ? stamp.built_at_source_time
    : null;
}

async function loadFirstCompleteSkillsManifest(candidates: readonly string[]): Promise<any | null> {
  for (const file of candidates) {
    const data = await readJson(file, null);
    if (data?.schema !== PACKAGED_SKILLS_MANIFEST_SCHEMA
      || data?.package_version !== PACKAGE_VERSION
      || !Array.isArray(data.skills)) continue;
    const normalized = normalizeSkillsManifest(data);
    if (!skillsManifestHasContentDigests(normalized)) continue;
    return normalized;
  }
  return null;
}

function skillsManifestHasContentDigests(manifest: any): boolean {
  const skills = Array.isArray(manifest?.skills) ? manifest.skills : [];
  if (!skills.length) return false;
  const names = new Set<string>();
  for (const skill of skills) {
    const name = canonicalSkillNameFromValue(skill?.canonical_name);
    if (!name
      || names.has(name)
      || typeof skill?.content_sha256 !== 'string'
      || !/^[a-f0-9]{64}$/i.test(skill.content_sha256)) return false;
    names.add(name);
  }
  return buildFallbackSkillsManifest().skills.every((skill) => (
    names.has(canonicalSkillNameFromValue(skill.canonical_name))
  ));
}

function packageRootDir(): string {
  return path.resolve(
    process.env.SKS_BUILD_SOURCE_ROOT
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
  );
}
