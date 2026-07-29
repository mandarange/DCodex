#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_MANIFEST_LITE,
  commandManifestNames
} from '../cli/command-manifest-lite.js';
import { COMMANDS } from '../cli/command-registry.js';
import { buildSksCoreSkillManifest } from '../core/codex-native/core-skill-manifest.js';
import { installGlobalSkills } from '../core/init/skills.js';
import { MANAGED_ROUTE_SKILL_NAMES } from '../core/routes.js';
import {
  EXPLICIT_ONLY_SKS_SKILL_NAMES,
  SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS,
  renderSkillAgentMetadata,
  validateSkillAgentMetadata
} from '../core/skills/skill-agent-metadata.js';
import { assertGate, emitGate, root as packageRoot } from './gate-lib.js';

const SKILL_LIST_BUDGET_CHARS = 8_000;
const OPENAI_SKILLS_REFERENCE_RE = /(?:github\.com\/openai\/skills\b|\bopenai\/skills\b)/gi;
const CURRENT_SKILL_NAME_RE = /^(?:sks|sks-[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const EXPLICIT_ONLY_SKILL_NAMES = new Set<string>(EXPLICIT_ONLY_SKS_SKILL_NAMES);

interface SurfaceCounts {
  expected: number;
  audited: number;
  missing: number;
  unexpected: number;
  invalid: number;
}

export interface SkillSurfaceInventory {
  schema: 'sks.skill-surface-inventory.v1';
  version: 1;
  command_names: string[];
  audited_command_names: string[];
  missing_command_names: string[];
  unexpected_command_names: string[];
  duplicate_command_names: string[];
  skill_names: string[];
  audited_skill_names: string[];
  missing_skill_names: string[];
  unexpected_skill_names: string[];
  duplicate_skill_names: string[];
}

export interface SkillSurfaceInventoryInput {
  authoritativeCommandNames: readonly string[];
  auditedCommandNames: readonly string[];
  authoritativeSkillNames: readonly string[];
  auditedSkillNames: readonly string[];
  declaredSkillNames?: readonly string[];
}

interface SkillSurfaceModernizationReport {
  schema: 'sks.skill-surface-modernization-audit.v1';
  version: 1;
  ok: boolean;
  inventory: SkillSurfaceInventory;
  inventory_sha256: string;
  skills: SurfaceCounts;
  metadata: SurfaceCounts;
  commands: SurfaceCounts;
  core_skills: SurfaceCounts;
  skill_list_budget: {
    accounting: 'name+description+relative_path';
    chars: number;
    limit: number;
    remaining: number;
  };
  explicit_only: {
    expected: number;
    audited: number;
    missing: number;
    unexpected: number;
  };
  active_openai_skills_reference_count: number;
  issues: string[];
}

interface GeneratedSkillManifest {
  skills?: unknown;
}

interface PackagedSkillManifest {
  skills?: unknown;
}

interface PackagedSkillRow {
  canonical_name?: unknown;
  type?: unknown;
  content_sha256?: unknown;
}

interface ParsedSkillFrontmatter {
  name: string | null;
  description: string | null;
  issues: string[];
}

interface AuditedSkill {
  name: string;
  text: string;
  frontmatter: ParsedSkillFrontmatter;
}

if (isMain()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

export async function main(): Promise<void> {
  const fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-skill-surface-modernization-'));
  const fixtureHome = path.join(fixtureRoot, 'home');
  const previousEnvironment = {
    home: process.env.HOME,
    codexHome: process.env.CODEX_HOME,
    globalRoot: process.env.SKS_GLOBAL_ROOT
  };
  let report: SkillSurfaceModernizationReport;
  try {
    await fsp.mkdir(fixtureHome, { recursive: true });
    process.env.HOME = fixtureHome;
    process.env.CODEX_HOME = path.join(fixtureHome, '.codex');
    process.env.SKS_GLOBAL_ROOT = path.join(fixtureHome, '.sneakoscope-global');
    report = await auditSkillSurfaceModernization(fixtureHome);
  } finally {
    restoreEnvironment('HOME', previousEnvironment.home);
    restoreEnvironment('CODEX_HOME', previousEnvironment.codexHome);
    restoreEnvironment('SKS_GLOBAL_ROOT', previousEnvironment.globalRoot);
    await fsp.rm(fixtureRoot, { recursive: true, force: true });
  }

  assertGate(report.ok, 'generated SKS skill/command surface modernization audit failed', report);
  emitGate('skill:surface-modernization', {
    inventory: report.inventory,
    inventory_sha256: report.inventory_sha256,
    skills: report.skills,
    metadata: report.metadata,
    commands: report.commands,
    core_skills: report.core_skills,
    explicit_only: report.explicit_only,
    skill_list_budget: report.skill_list_budget,
    active_openai_skills_reference_count: report.active_openai_skills_reference_count,
    issues: report.issues
  });
}

export async function auditSkillSurfaceModernization(
  fixtureHome: string
): Promise<SkillSurfaceModernizationReport> {
  const issues: string[] = [];
  const invalidSkills = new Set<string>();
  const invalidMetadata = new Set<string>();
  const invalidCommands = new Set<string>();
  const invalidCoreSkills = new Set<string>();
  const sourcePackagedManifest = readJson<PackagedSkillManifest>(
    path.join(packageRoot, 'dist', 'config', 'skills-manifest.json'),
    issues,
    'source_packaged_skill_manifest'
  );
  const sourcePackagedRows = Array.isArray(sourcePackagedManifest?.skills)
    ? sourcePackagedManifest.skills.filter(isRecord) as PackagedSkillRow[]
    : [];
  const sourceSkillNames = sourcePackagedRows
    .map((row) => typeof row.canonical_name === 'string' ? row.canonical_name : '')
    .filter(Boolean);
  if (!sourceSkillNames.length) issues.push('source_packaged_skill_manifest_has_no_skills');
  recordDuplicateOrUnsortedNames(sourceSkillNames, issues, 'source_packaged_skill_manifest');
  const managedRouteSkillNames = sortedUnique(MANAGED_ROUTE_SKILL_NAMES);
  const sourceSkillNameSet = new Set(sourceSkillNames);
  const managedRouteSkillNameSet = new Set(managedRouteSkillNames);
  for (const name of sourceSkillNames) {
    if (!managedRouteSkillNameSet.has(name)) issues.push(`managed_route_skill_inventory_missing:${name}`);
  }
  for (const name of managedRouteSkillNames) {
    if (!sourceSkillNameSet.has(name)) issues.push(`managed_route_skill_inventory_unexpected:${name}`);
  }

  const install = await installGlobalSkills(fixtureHome);
  if (!install.ok) issues.push('skill_install_report_not_ok');

  const skillsRoot = path.join(fixtureHome, '.agents', 'skills');
  const generatedManifest = readJson<GeneratedSkillManifest>(
    path.join(skillsRoot, '.sks-generated.json'),
    issues,
    'generated_skill_manifest'
  );
  const expectedFromManifest = stringArray(generatedManifest?.skills);
  const expectedSkillNames = sortedUnique(sourceSkillNames);
  if (!expectedFromManifest.length) issues.push('generated_skill_manifest_has_no_skills');
  recordDuplicateOrUnsortedNames(expectedFromManifest, issues, 'generated_skill_manifest');
  const generatedSkillNames = sortedUnique(expectedFromManifest);
  for (const name of expectedSkillNames) {
    if (!generatedSkillNames.includes(name)) issues.push(`generated_skill_manifest_missing:${name}`);
  }
  for (const name of generatedSkillNames) {
    if (!expectedSkillNames.includes(name)) issues.push(`generated_skill_manifest_unexpected:${name}`);
  }
  const installedReportNames = sortedUnique(install.installed_skills || []);
  for (const name of expectedSkillNames) {
    if (!installedReportNames.includes(name)) issues.push(`skill_install_report_missing:${name}`);
  }
  for (const name of installedReportNames) {
    if (!expectedSkillNames.includes(name)) issues.push(`skill_install_report_unexpected:${name}`);
  }
  for (const name of expectedSkillNames) {
    if (!CURRENT_SKILL_NAME_RE.test(name)) issues.push(`generated_skill_name_not_current:${name}`);
  }

  const skillDirectories = (await fsp.readdir(skillsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isDirectory() && CURRENT_SKILL_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const actualSkillNames: string[] = [];
  const auditedSkills = new Map<string, AuditedSkill>();
  for (const name of skillDirectories) {
    const skillPath = path.join(skillsRoot, name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    actualSkillNames.push(name);
    const text = await fsp.readFile(skillPath, 'utf8');
    const frontmatter = parseSkillFrontmatter(text);
    auditedSkills.set(name, { name, text, frontmatter });
  }

  const expectedSet = new Set(expectedSkillNames);
  const actualSet = new Set(actualSkillNames);
  const missingSkills = expectedSkillNames.filter((name) => !actualSet.has(name));
  const unexpectedSkills = actualSkillNames.filter((name) => !expectedSet.has(name));
  for (const name of missingSkills) issues.push(`installed_skill_missing:${name}`);
  for (const name of unexpectedSkills) issues.push(`installed_skill_unexpected:${name}`);

  let activeReferenceCount = 0;
  let skillListChars = 0;
  const declaredNames = new Map<string, string[]>();
  const frontmatterDescriptions = new Map<string, string>();
  for (const skill of auditedSkills.values()) {
    for (const issue of skill.frontmatter.issues) {
      invalidSkills.add(skill.name);
      issues.push(`skill_frontmatter:${skill.name}:${issue}`);
    }
    const declaredName = skill.frontmatter.name;
    const description = skill.frontmatter.description;
    if (declaredName) {
      const directories = declaredNames.get(declaredName) || [];
      directories.push(skill.name);
      declaredNames.set(declaredName, directories);
      if (declaredName !== skill.name) {
        invalidSkills.add(skill.name);
        issues.push(`skill_name_directory_mismatch:${skill.name}:${declaredName}`);
      }
    }
    if (declaredName && description) {
      const relativePath = `.agents/skills/${skill.name}/SKILL.md`;
      skillListChars += charCount(declaredName) + charCount(description) + charCount(relativePath);
      frontmatterDescriptions.set(skill.name, description);
      if (charCount(description) > SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS) {
        invalidSkills.add(skill.name);
        issues.push(`skill_frontmatter_description_too_long:${skill.name}:${charCount(description)}`);
      }
    }
    const skillActiveReferenceCount = countActiveOpenaiSkillsReferences(skill.text);
    if (skillActiveReferenceCount > 0) {
      activeReferenceCount += skillActiveReferenceCount;
      invalidSkills.add(skill.name);
      issues.push(`active_openai_skills_reference:${skill.name}`);
    }
  }
  for (const [declaredName, directories] of declaredNames) {
    if (directories.length < 2) continue;
    for (const name of directories) invalidSkills.add(name);
    issues.push(`duplicate_declared_skill_name:${declaredName}:${directories.sort().join(',')}`);
  }
  if (skillListChars > SKILL_LIST_BUDGET_CHARS) {
    issues.push(`skill_list_budget_exceeded:${skillListChars}:${SKILL_LIST_BUDGET_CHARS}`);
  }

  const actualMetadataNames: string[] = [];
  const explicitOnlyAudited: string[] = [];
  for (const name of actualSkillNames) {
    const metadataPath = path.join(skillsRoot, name, 'agents', 'openai.yaml');
    if (!fs.existsSync(metadataPath)) continue;
    actualMetadataNames.push(name);
    const metadataText = await fsp.readFile(metadataPath, 'utf8');
    const validation = validateSkillAgentMetadata(metadataText, { expectedSkillName: name });
    for (const issue of validation.issues) {
      invalidMetadata.add(name);
      issues.push(`skill_metadata:${name}:${issue}`);
    }
    const expectedDescription = frontmatterDescriptions.get(name) || null;
    if (validation.metadata?.interface.short_description !== expectedDescription) {
      invalidMetadata.add(name);
      issues.push(`skill_metadata_short_description_stale:${name}`);
    }
    const expectedPrompt = `Use $${name}.`;
    if (validation.metadata?.interface.default_prompt !== expectedPrompt) {
      invalidMetadata.add(name);
      issues.push(`skill_metadata_default_prompt_not_exact:${name}`);
    }
    const expectedImplicit = !EXPLICIT_ONLY_SKILL_NAMES.has(name);
    if (validation.metadata?.policy.allow_implicit_invocation !== expectedImplicit) {
      invalidMetadata.add(name);
      issues.push(`skill_metadata_implicit_policy_mismatch:${name}:${expectedImplicit}`);
    }
    const expectedMetadata = expectedDescription
      ? renderSkillAgentMetadata({ skillName: name, shortDescription: expectedDescription })
      : '';
    if (metadataText !== expectedMetadata) {
      invalidMetadata.add(name);
      issues.push(`skill_metadata_not_canonical_generated_profile:${name}`);
    }
    if (validation.metadata?.policy.allow_implicit_invocation === false) explicitOnlyAudited.push(name);
  }
  const actualMetadataSet = new Set(actualMetadataNames);
  const missingMetadata = expectedSkillNames.filter((name) => !actualMetadataSet.has(name));
  const unexpectedMetadata = actualMetadataNames.filter((name) => !expectedSet.has(name));
  for (const name of missingMetadata) issues.push(`skill_metadata_missing:${name}`);
  for (const name of unexpectedMetadata) issues.push(`skill_metadata_unexpected:${name}`);

  const expectedExplicitOnly = [...EXPLICIT_ONLY_SKILL_NAMES].sort();
  const explicitOnlySet = new Set(explicitOnlyAudited);
  const missingExplicitOnly = expectedExplicitOnly.filter((name) => !explicitOnlySet.has(name));
  const unexpectedExplicitOnly = [...explicitOnlySet].filter((name) => !EXPLICIT_ONLY_SKILL_NAMES.has(name)).sort();
  for (const name of missingExplicitOnly) issues.push(`explicit_only_policy_missing:${name}`);
  for (const name of unexpectedExplicitOnly) issues.push(`explicit_only_policy_unexpected:${name}`);

  const packagedManifest = readJson<PackagedSkillManifest>(
    path.join(skillsRoot, 'skills-manifest.json'),
    issues,
    'packaged_skill_manifest'
  );
  const packagedRows = Array.isArray(packagedManifest?.skills)
    ? packagedManifest.skills.filter(isRecord) as PackagedSkillRow[]
    : [];
  const packagedByName = new Map<string, PackagedSkillRow>();
  for (const row of packagedRows) {
    const name = typeof row.canonical_name === 'string' ? row.canonical_name : '';
    if (!name) {
      issues.push('packaged_skill_manifest_row_missing_name');
      continue;
    }
    if (packagedByName.has(name)) issues.push(`packaged_skill_manifest_duplicate:${name}`);
    packagedByName.set(name, row);
  }
  for (const name of expectedSkillNames) {
    if (!packagedByName.has(name)) issues.push(`packaged_skill_manifest_missing:${name}`);
  }
  for (const name of packagedByName.keys()) {
    if (!expectedSet.has(name)) issues.push(`packaged_skill_manifest_unexpected:${name}`);
  }

  const coreManifest = buildSksCoreSkillManifest('1970-01-01T00:00:00.000Z');
  const expectedCoreNames = coreManifest.skills.map((skill) => skill.canonical_name).sort();
  const auditedCoreNames: string[] = [];
  for (const coreSkill of coreManifest.skills) {
    const installed = auditedSkills.get(coreSkill.canonical_name);
    if (!installed) continue;
    auditedCoreNames.push(coreSkill.canonical_name);
    const actualHash = crypto.createHash('sha256').update(installed.text).digest('hex');
    if (actualHash !== coreSkill.content_sha256) {
      invalidCoreSkills.add(coreSkill.canonical_name);
      issues.push(`core_skill_content_hash_mismatch:${coreSkill.canonical_name}`);
    }
    if (
      coreSkill.mutable_by_doctor !== false
      || coreSkill.mutable_by_update !== false
      || coreSkill.mutable_by_setup !== false
    ) {
      invalidCoreSkills.add(coreSkill.canonical_name);
      issues.push(`core_skill_manifest_mutability_not_protected:${coreSkill.canonical_name}`);
    }
    for (const key of ['doctor', 'update', 'setup']) {
      if (!installed.text.includes(`mutable_by_${key}: false`)) {
        invalidCoreSkills.add(coreSkill.canonical_name);
        issues.push(`core_skill_body_mutability_not_protected:${coreSkill.canonical_name}:${key}`);
      }
    }
    const packaged = packagedByName.get(coreSkill.canonical_name);
    if (
      packaged?.type !== 'core'
      || packaged.content_sha256 !== coreSkill.content_sha256
    ) {
      invalidCoreSkills.add(coreSkill.canonical_name);
      issues.push(`core_skill_packaged_manifest_mismatch:${coreSkill.canonical_name}`);
    }
  }
  const auditedCoreSet = new Set(auditedCoreNames);
  const missingCoreSkills = expectedCoreNames.filter((name) => !auditedCoreSet.has(name));
  for (const name of missingCoreSkills) issues.push(`core_skill_missing:${name}`);

  const registryNames = Object.keys(COMMANDS).sort();
  const manifestNames = commandManifestNames();
  const manifestNameSet = new Set<string>(manifestNames);
  const registryNameSet = new Set(registryNames);
  const missingCommands = manifestNames.filter((name) => !registryNameSet.has(name));
  const unexpectedCommands = registryNames.filter((name) => !manifestNameSet.has(name));
  const duplicateCommandNames = duplicateValues(COMMAND_MANIFEST_LITE.map((entry) => entry.name));
  for (const name of missingCommands) issues.push(`command_manifest_missing:${name}`);
  for (const name of unexpectedCommands) issues.push(`command_manifest_unexpected:${name}`);
  for (const name of duplicateCommandNames) {
    invalidCommands.add(name);
    issues.push(`command_manifest_duplicate:${name}`);
  }
  for (const entry of COMMAND_MANIFEST_LITE) {
    const summary = String(entry.summary || '');
    if (!summary.trim() || summary !== summary.trim()) {
      invalidCommands.add(entry.name);
      issues.push(`command_summary_empty_or_untrimmed:${entry.name}`);
    }
    if ((COMMANDS as Record<string, { summary?: string }>)[entry.name]?.summary !== summary) {
      invalidCommands.add(entry.name);
      issues.push(`command_summary_not_current:${entry.name}`);
    }
    const commandActiveReferenceCount = countActiveOpenaiSkillsReferences(summary);
    if (commandActiveReferenceCount > 0) {
      activeReferenceCount += commandActiveReferenceCount;
      invalidCommands.add(entry.name);
      issues.push(`command_summary_active_openai_skills_reference:${entry.name}`);
    }
  }

  const inventory = buildSkillSurfaceInventory({
    authoritativeCommandNames: manifestNames,
    auditedCommandNames: registryNames,
    authoritativeSkillNames: expectedSkillNames,
    auditedSkillNames: actualSkillNames,
    declaredSkillNames: [...declaredNames.entries()]
      .flatMap(([declaredName, directories]) => directories.map(() => declaredName))
  });
  const sortedIssues = [...new Set(issues)].sort();
  const inventorySha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(inventory))
    .digest('hex');
  return {
    schema: 'sks.skill-surface-modernization-audit.v1',
    version: 1,
    ok: sortedIssues.length === 0,
    inventory,
    inventory_sha256: inventorySha256,
    skills: counts(
      expectedSkillNames.length,
      actualSkillNames.length,
      missingSkills.length,
      unexpectedSkills.length,
      invalidSkills.size
    ),
    metadata: counts(
      expectedSkillNames.length,
      actualMetadataNames.length,
      missingMetadata.length,
      unexpectedMetadata.length,
      invalidMetadata.size
    ),
    commands: counts(
      inventory.command_names.length,
      inventory.audited_command_names.length,
      missingCommands.length,
      unexpectedCommands.length,
      invalidCommands.size
    ),
    core_skills: counts(
      expectedCoreNames.length,
      auditedCoreNames.length,
      missingCoreSkills.length,
      0,
      invalidCoreSkills.size
    ),
    skill_list_budget: {
      accounting: 'name+description+relative_path',
      chars: skillListChars,
      limit: SKILL_LIST_BUDGET_CHARS,
      remaining: SKILL_LIST_BUDGET_CHARS - skillListChars
    },
    explicit_only: {
      expected: expectedExplicitOnly.length,
      audited: explicitOnlySet.size,
      missing: missingExplicitOnly.length,
      unexpected: unexpectedExplicitOnly.length
    },
    active_openai_skills_reference_count: activeReferenceCount,
    issues: sortedIssues
  };
}

export function buildSkillSurfaceInventory(
  input: SkillSurfaceInventoryInput
): SkillSurfaceInventory {
  const commandNames = sortedUnique(input.authoritativeCommandNames);
  const auditedCommandNames = sortedUnique(input.auditedCommandNames);
  const skillNames = sortedUnique(input.authoritativeSkillNames);
  const auditedSkillNames = sortedUnique(input.auditedSkillNames);
  const declaredSkillNames = input.declaredSkillNames || [];
  return {
    schema: 'sks.skill-surface-inventory.v1',
    version: 1,
    command_names: commandNames,
    audited_command_names: auditedCommandNames,
    missing_command_names: commandNames.filter((name) => !auditedCommandNames.includes(name)),
    unexpected_command_names: auditedCommandNames.filter((name) => !commandNames.includes(name)),
    duplicate_command_names: duplicateValues(input.authoritativeCommandNames),
    skill_names: skillNames,
    audited_skill_names: auditedSkillNames,
    missing_skill_names: skillNames.filter((name) => !auditedSkillNames.includes(name)),
    unexpected_skill_names: auditedSkillNames.filter((name) => !skillNames.includes(name)),
    duplicate_skill_names: sortedUnique([
      ...duplicateValues(input.authoritativeSkillNames),
      ...duplicateValues(declaredSkillNames)
    ])
  };
}

export function authoritativeCommandSurfaceInventory(): {
  command_names: string[];
  duplicate_command_names: string[];
} {
  const names = COMMAND_MANIFEST_LITE.map((entry) => entry.name);
  return {
    command_names: sortedUnique(names),
    duplicate_command_names: duplicateValues(names)
  };
}

export function containsActiveOpenaiSkillsReference(value: string): boolean {
  return countActiveOpenaiSkillsReferences(value) > 0;
}

export function countActiveOpenaiSkillsReferences(value: string): number {
  return String(value || '').split(/\r?\n/).reduce((count, line) => {
    const references = line.match(OPENAI_SKILLS_REFERENCE_RE)?.length || 0;
    if (references === 0) return count;
    const migrationOnly = /\bdeprecated\b/i.test(line)
      && /\bmigration evidence\b/i.test(line)
      && /\b(?:only|rather than|not\s+(?:an?\s+)?active)\b/i.test(line);
    return count + (migrationOnly ? 0 : references);
  }, 0);
}

function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter {
  const lines = String(text || '').split(/\r?\n/);
  const issues: string[] = [];
  if (lines[0] !== '---') {
    return { name: null, description: null, issues: ['missing_opening_delimiter'] };
  }
  const closingIndex = lines.findIndex((line, index) => index > 0 && line === '---');
  if (closingIndex < 0) {
    return { name: null, description: null, issues: ['missing_closing_delimiter'] };
  }
  const values = new Map<string, string>();
  for (const [offset, line] of lines.slice(1, closingIndex).entries()) {
    if (!line.trim()) continue;
    const match = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!match) {
      issues.push(`invalid_entry:${offset + 2}`);
      continue;
    }
    const key = match[1] || '';
    if (!['name', 'description'].includes(key)) issues.push(`unsupported_key:${key}`);
    if (values.has(key)) issues.push(`duplicate_key:${key}`);
    const value = parseScalar(match[2] || '');
    if (value === null) issues.push(`invalid_value:${key}`);
    else values.set(key, value);
  }
  const name = normalizeText(values.get('name'));
  const description = normalizeText(values.get('description'));
  if (!name) issues.push('missing_name');
  if (!description) issues.push('missing_description');
  if (name && !CURRENT_SKILL_NAME_RE.test(name)) issues.push(`name_not_current:${name}`);
  return { name, description, issues: [...new Set(issues)].sort() };
}

function recordDuplicateOrUnsortedNames(names: string[], issues: string[], label: string): void {
  for (const duplicate of duplicateValues(names)) issues.push(`${label}_duplicate:${duplicate}`);
  const sorted = [...new Set(names)].sort();
  if (JSON.stringify(names) !== JSON.stringify(sorted)) issues.push(`${label}_not_unique_sorted`);
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readJson<T>(file: string, issues: string[], label: string): T | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) {
      issues.push(`${label}_not_object`);
      return null;
    }
    return parsed as T;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.name : 'unknown';
    issues.push(`${label}_unreadable:${reason}`);
    return null;
  }
}

function parseScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith('"')) return parseQuotedScalar(value);
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) return null;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseQuotedScalar(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeText(value: string | undefined): string | null {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function charCount(value: string): number {
  return Array.from(value).length;
}

function counts(
  expected: number,
  audited: number,
  missing: number,
  unexpected: number,
  invalid: number
): SurfaceCounts {
  return { expected, audited, missing, unexpected, invalid };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function isMain(): boolean {
  return Boolean(process.argv[1])
    && path.resolve(process.argv[1] as string) === fileURLToPath(import.meta.url);
}
