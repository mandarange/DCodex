const OFFICIAL_TOP_LEVEL_KEYS = new Set(['interface', 'policy', 'dependencies']);
const OFFICIAL_INTERFACE_KEYS = new Set([
  'display_name',
  'short_description',
  'icon_small',
  'icon_large',
  'brand_color',
  'default_prompt'
]);
const OFFICIAL_POLICY_KEYS = new Set(['allow_implicit_invocation']);
const OFFICIAL_DEPENDENCIES_KEYS = new Set(['tools']);
const OFFICIAL_TOOL_DEPENDENCY_KEYS = new Set([
  'value',
  'description',
  'transport',
  'url'
]);

export const SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS = 64;

export const EXPLICIT_ONLY_SKS_SKILL_NAMES = Object.freeze([
  'sks-align',
  'sks-commit',
  'sks-commit-and-push',
  'sks-mad-sks',
  'sks-fast-mode',
  'sks-fast-on',
  'sks-fast-off',
  'sks-with-local-llm-on',
  'sks-with-local-llm-off'
] as const);

const EXPLICIT_ONLY_SKS_SKILL_NAME_SET = new Set<string>(EXPLICIT_ONLY_SKS_SKILL_NAMES);

export interface SkillAgentMetadata {
  interface: {
    display_name: string;
    short_description: string;
    icon_small?: string;
    icon_large?: string;
    brand_color?: string;
    default_prompt?: string;
  };
  policy: {
    allow_implicit_invocation: boolean;
  };
  dependencies?: {
    tools: Array<{
      type: string;
      value: string;
      description?: string;
      transport?: string;
      url?: string;
    }>;
  };
}

export interface SkillAgentMetadataRenderOptions {
  skillName: string;
  shortDescription: string;
  displayName?: string;
  defaultPrompt?: string;
  allowImplicitInvocation?: boolean;
}

export interface SkillAgentMetadataValidation {
  ok: boolean;
  issues: string[];
  metadata: SkillAgentMetadata | null;
}

export function renderSkillAgentMetadata(options: SkillAgentMetadataRenderOptions): string {
  const skillName = normalizeSkillName(options.skillName);
  if (!skillName) throw new Error('skill_agent_metadata_skill_name_required');
  const displayName = normalizeText(options.displayName || displayNameForSkill(skillName));
  const shortDescription = normalizeText(options.shortDescription);
  const defaultPrompt = normalizeText(options.defaultPrompt || `Use $${skillName}.`);
  if (!displayName) throw new Error(`skill_agent_metadata_display_name_required:${skillName}`);
  if (!shortDescription) throw new Error(`skill_agent_metadata_short_description_required:${skillName}`);
  const allowImplicitInvocation = options.allowImplicitInvocation
    ?? allowsImplicitSksSkillInvocation(skillName);
  const rendered = [
    'interface:',
    `  display_name: ${yamlString(displayName)}`,
    `  short_description: ${yamlString(shortDescription)}`,
    `  default_prompt: ${yamlString(defaultPrompt)}`,
    'policy:',
    `  allow_implicit_invocation: ${allowImplicitInvocation}`,
    ''
  ].join('\n');
  const validation = validateSkillAgentMetadata(rendered, { expectedSkillName: skillName });
  if (!validation.ok) {
    throw new Error(`invalid_rendered_skill_agent_metadata:${skillName}:${validation.issues.join(',')}`);
  }
  return rendered;
}

export function validateSkillAgentMetadata(
  text: string,
  options: { expectedSkillName?: string } = {}
): SkillAgentMetadataValidation {
  const issues: string[] = [];
  const seenTopLevel = new Set<string>();
  const seenInterface = new Set<string>();
  const seenPolicy = new Set<string>();
  const seenDependencies = new Set<string>();
  const parsedInterface: Record<string, string> = {};
  const parsedTools: Array<Record<string, string>> = [];
  let allowImplicitInvocation = true;
  let section = '';
  let inTools = false;
  let currentTool: Record<string, string> | null = null;

  for (const [index, line] of String(text || '').split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) {
      issues.push(`tabs_not_allowed:${index + 1}`);
      continue;
    }
    const indentation = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indentation === 0) {
      const match = /^([a-z_]+):\s*$/.exec(trimmed);
      if (!match) {
        issues.push(`invalid_top_level_entry:${index + 1}`);
        section = '';
        inTools = false;
        currentTool = null;
        continue;
      }
      const key = match[1] || '';
      if (!OFFICIAL_TOP_LEVEL_KEYS.has(key)) issues.push(`unsupported_top_level_key:${key}`);
      if (seenTopLevel.has(key)) issues.push(`duplicate_top_level_key:${key}`);
      seenTopLevel.add(key);
      section = key;
      inTools = false;
      currentTool = null;
      continue;
    }
    if (indentation === 2) {
      const match = /^([a-z_]+):(?:\s*(.*))?$/.exec(trimmed);
      if (!match || !section) {
        issues.push(`invalid_section_entry:${index + 1}`);
        inTools = false;
        currentTool = null;
        continue;
      }
      const key = match[1] || '';
      const rawValue = match[2] || '';
      inTools = section === 'dependencies' && key === 'tools';
      currentTool = null;
      if (section === 'interface') {
        if (!OFFICIAL_INTERFACE_KEYS.has(key)) issues.push(`unsupported_interface_key:${key}`);
        if (seenInterface.has(key)) issues.push(`duplicate_interface_key:${key}`);
        seenInterface.add(key);
        const value = parseYamlScalar(rawValue);
        if (value === null) issues.push(`invalid_interface_value:${key}`);
        else parsedInterface[key] = value;
      } else if (section === 'policy') {
        if (!OFFICIAL_POLICY_KEYS.has(key)) issues.push(`unsupported_policy_key:${key}`);
        if (seenPolicy.has(key)) issues.push(`duplicate_policy_key:${key}`);
        seenPolicy.add(key);
        if (key === 'allow_implicit_invocation') {
          if (rawValue === 'true') allowImplicitInvocation = true;
          else if (rawValue === 'false') allowImplicitInvocation = false;
          else issues.push('invalid_policy_value:allow_implicit_invocation');
        }
      } else if (section === 'dependencies') {
        if (!OFFICIAL_DEPENDENCIES_KEYS.has(key)) issues.push(`unsupported_dependencies_key:${key}`);
        if (seenDependencies.has(key)) issues.push(`duplicate_dependencies_key:${key}`);
        seenDependencies.add(key);
        if (key === 'tools' && rawValue) issues.push('dependencies_tools_must_use_block_list');
      } else {
        issues.push(`entry_under_unsupported_section:${section}`);
      }
      continue;
    }
    if (indentation === 4 && section === 'dependencies' && inTools) {
      const match = /^-\s+type:\s*(.+)$/.exec(trimmed);
      const value = match ? parseYamlScalar(match[1] || '') : null;
      if (value === null) {
        issues.push(`invalid_tool_dependency:${index + 1}`);
        currentTool = null;
      } else {
        currentTool = { type: value };
        parsedTools.push(currentTool);
      }
      continue;
    }
    if (indentation === 6 && section === 'dependencies' && inTools && currentTool) {
      const match = /^([a-z_]+):\s*(.*)$/.exec(trimmed);
      if (!match) {
        issues.push(`invalid_tool_dependency_entry:${index + 1}`);
        continue;
      }
      const key = match[1] || '';
      if (!OFFICIAL_TOOL_DEPENDENCY_KEYS.has(key)) {
        issues.push(`unsupported_tool_dependency_key:${key}`);
        continue;
      }
      if (Object.hasOwn(currentTool, key)) issues.push(`duplicate_tool_dependency_key:${key}`);
      const value = parseYamlScalar(match[2] || '');
      if (value === null) issues.push(`invalid_tool_dependency_value:${key}`);
      else currentTool[key] = value;
      continue;
    }
    issues.push(`unsupported_indentation_or_entry:${index + 1}`);
  }

  if (!seenTopLevel.has('interface')) issues.push('missing_top_level_key:interface');
  if (!normalizeText(parsedInterface.display_name)) issues.push('missing_interface_key:display_name');
  if (!normalizeText(parsedInterface.short_description)) issues.push('missing_interface_key:short_description');
  if (seenTopLevel.has('dependencies')) {
    if (!seenDependencies.has('tools')) issues.push('missing_dependencies_key:tools');
    if (parsedTools.length === 0) issues.push('dependencies_tools_empty');
    for (const [index, tool] of parsedTools.entries()) {
      if (!normalizeText(tool.type)) issues.push(`tool_dependency_type_missing:${index}`);
      if (!normalizeText(tool.value)) issues.push(`tool_dependency_value_missing:${index}`);
    }
  }

  const expectedSkillName = normalizeSkillName(options.expectedSkillName || '');
  const defaultPrompt = normalizeText(parsedInterface.default_prompt);
  if (expectedSkillName) {
    if (!defaultPrompt) issues.push('missing_interface_key:default_prompt');
    else if (!mentionsExactDollarSkill(defaultPrompt, expectedSkillName)) {
      issues.push(`default_prompt_missing_exact_skill:$${expectedSkillName}`);
    }
  }

  const metadata = issues.length === 0
    ? {
        interface: {
          display_name: parsedInterface.display_name || '',
          short_description: parsedInterface.short_description || '',
          ...(parsedInterface.icon_small ? { icon_small: parsedInterface.icon_small } : {}),
          ...(parsedInterface.icon_large ? { icon_large: parsedInterface.icon_large } : {}),
          ...(parsedInterface.brand_color ? { brand_color: parsedInterface.brand_color } : {}),
          ...(defaultPrompt ? { default_prompt: defaultPrompt } : {})
        },
        policy: {
          allow_implicit_invocation: allowImplicitInvocation
        },
        ...(seenTopLevel.has('dependencies')
          ? {
              dependencies: {
                tools: parsedTools.map((tool) => ({
                  type: tool.type || '',
                  value: tool.value || '',
                  ...(tool.description ? { description: tool.description } : {}),
                  ...(tool.transport ? { transport: tool.transport } : {}),
                  ...(tool.url ? { url: tool.url } : {})
                }))
              }
            }
          : {})
      }
    : null;
  return { ok: issues.length === 0, issues: [...new Set(issues)], metadata };
}

export function allowsImplicitSksSkillInvocation(skillName: string): boolean {
  const normalized = normalizeSkillName(skillName);
  const installedName = normalized.startsWith('sks-') ? normalized : `sks-${normalized}`;
  return !EXPLICIT_ONLY_SKS_SKILL_NAME_SET.has(installedName);
}

export function skillFrontmatterDescription(skillText: string): string | null {
  const lines = String(skillText || '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) return null;
  for (const line of lines.slice(1, end)) {
    const match = /^description:\s*(.*)$/.exec(line);
    if (!match) continue;
    return normalizeText(parseYamlScalar(match[1] || '') || '') || null;
  }
  return null;
}

export function compactSkillDiscoveryDescription(
  value: string,
  maxChars: number = SKILL_DISCOVERY_DESCRIPTION_MAX_CHARS
): string {
  const normalized = normalizeText(value);
  if (!normalized) return '';
  const boundedMax = Math.max(24, Math.floor(maxChars));
  if (unicodeLength(normalized) <= boundedMax) return normalized;

  const firstSentence = /^.+?[.!?](?=\s|$)/.exec(normalized)?.[0] || '';
  if (firstSentence && unicodeLength(firstSentence) <= boundedMax) return firstSentence;

  const prefix = Array.from(normalized).slice(0, boundedMax - 1).join('');
  const wordBoundary = prefix.lastIndexOf(' ');
  const candidate = wordBoundary >= Math.floor(boundedMax * 0.6)
    ? prefix.slice(0, wordBoundary)
    : prefix;
  return `${candidate.replace(/[\s,:;.!?\-–—]+$/u, '')}…`;
}

export function isSksGeneratedSkillAgentMetadata(
  text: string,
  expectedSkillName: string,
  options: { allowLegacyOwnershipSignature?: boolean } = {}
): boolean {
  const expected = normalizeSkillName(expectedSkillName);
  if (!expected) return false;
  const current = validateSkillAgentMetadata(text, { expectedSkillName: expected });
  if (
    current.ok
    && current.metadata?.interface.display_name === displayNameForSkill(expected)
    && current.metadata.interface.default_prompt === `Use $${expected}.`
  ) return true;
  if (!options.allowLegacyOwnershipSignature) return false;
  const escaped = escapeRegExp(expected);
  const source = String(text || '');
  return new RegExp(`^name:\\s*${escaped}\\s*$`, 'm').test(source)
    && /^model_reasoning_effort:\s*(?:low|medium|high|xhigh)\s*$/m.test(source)
    && /^routing:\s*temporary\s*$/m.test(source)
    && /^return_to_default_after_route:\s*true\s*$/m.test(source);
}

function displayNameForSkill(skillName: string): string {
  return skillName
    .split('-')
    .map((part) => part.toLowerCase() === 'sks' ? 'SKS' : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function mentionsExactDollarSkill(prompt: string, skillName: string): boolean {
  return new RegExp(`\\$${escapeRegExp(skillName)}(?![a-z0-9-])`, 'i').test(prompt);
}

function normalizeSkillName(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeText(value: string | undefined): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function parseYamlScalar(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) return null;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) return null;
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
