import { COMMAND_ALIASES_LITE, COMMAND_MANIFEST_LITE } from '../../../cli/command-manifest-lite.js';
import { DOLLAR_COMMAND_ALIASES_LITE, DOLLAR_COMMANDS_LITE } from '../../routes/dollar-manifest-lite.js';
import { buildIntentContract, type IntentContract, type IntentEffect, type IntentRisk } from '../../safety/intent-contract/intent-contract.js';
import type { ProviderMode } from '../../architecture-hardening/contracts/contracts.js';

export interface DeprecationDescriptor {
  readonly option: string;
  readonly severity: 'warning' | 'error';
  readonly replacement: string | null;
  readonly code: string;
}

export interface NormalizedIntentCommand {
  readonly schema: 'sks.normalized-intent-command.v1';
  readonly input_form: 'dollar' | 'cli';
  readonly canonical_command: string;
  readonly command_name: string;
  readonly deprecations: readonly DeprecationDescriptor[];
  readonly contract: IntentContract;
}

const CLI_NAMES = new Set<string>(COMMAND_MANIFEST_LITE.map((entry) => entry.name));
const CLI_ALIASES = new Map(Object.entries(COMMAND_ALIASES_LITE).map(([alias, canonical]) => [alias.toLowerCase(), canonical]));
const DOLLAR_CANONICAL = new Map(DOLLAR_COMMANDS_LITE.map((entry) => [entry.command.toLowerCase(), entry.command]));
const DOLLAR_ALIASES = new Map(DOLLAR_COMMAND_ALIASES_LITE.map((entry) => [entry.app_skill.toLowerCase(), entry.canonical]));
const UNSUPPORTED_OPTIONS = new Set(['--skip-evidence', '--no-verify', '--force-fast']);
const WARN_OPTIONS = new Map([['--mad', '--mad-sks'], ['--quick', '--fast']]);

export function normalizeIntentCommand(input: {
  rawCommand: string;
  naturalLanguageEffect: string;
  effect: IntentEffect;
  observedChangedPaths?: readonly string[];
  targetHashes: readonly string[];
  policyVersion: string;
  modeSnapshot: ProviderMode;
  evidenceState: IntentContract['evidence_state'];
  retryBudget?: number;
  requestedRisk?: IntentRisk;
  explicitUltraOptIn?: boolean;
  force?: boolean;
}): NormalizedIntentCommand {
  const raw = String(input.rawCommand || '').trim();
  if (!raw) throw new Error('intent_command_missing');
  const tokens = raw.split(/\s+/);
  const deprecations = deprecatedOptions(tokens);
  if (deprecations.some((entry) => entry.severity === 'error')) throw new Error('intent_legacy_option_unsupported');
  const dollar = raw.startsWith('$');
  const commandName = dollar ? normalizeDollar(tokens[0] || '') : normalizeCli(tokens);
  const canonicalCommand = commandName === 'root' ? 'sks' : `sks ${commandName}`;
  const contract = buildIntentContract({
    naturalLanguageEffect: input.naturalLanguageEffect,
    effect: input.effect,
    canonicalCommand,
    targetHashes: input.targetHashes,
    policyVersion: input.policyVersion,
    modeSnapshot: input.modeSnapshot,
    evidenceState: input.evidenceState,
    ...(input.observedChangedPaths === undefined ? {} : { observedChangedPaths: input.observedChangedPaths }),
    ...(input.retryBudget === undefined ? {} : { retryBudget: input.retryBudget }),
    ...(input.requestedRisk === undefined ? {} : { requestedRisk: input.requestedRisk }),
    ...(input.explicitUltraOptIn === undefined ? {} : { explicitUltraOptIn: input.explicitUltraOptIn }),
    ...(input.force === undefined ? {} : { force: input.force })
  });
  return {
    schema: 'sks.normalized-intent-command.v1', input_form: dollar ? 'dollar' : 'cli',
    canonical_command: canonicalCommand, command_name: commandName, deprecations, contract
  };
}

export function allIntentNormalizationForms(): readonly string[] {
  return [
    ...DOLLAR_COMMANDS_LITE.map((entry) => entry.command),
    ...DOLLAR_COMMAND_ALIASES_LITE.map((entry) => entry.app_skill),
    ...COMMAND_MANIFEST_LITE.map((entry) => `sks ${entry.name}`),
    ...Object.keys(COMMAND_ALIASES_LITE).map((entry) => `sks ${entry}`)
  ];
}

function normalizeDollar(token: string): string {
  const normalized = token.toLowerCase();
  const canonical = DOLLAR_ALIASES.get(normalized) || DOLLAR_CANONICAL.get(normalized);
  if (!canonical) throw new Error('intent_dollar_command_unknown');
  const suffix = canonical === '$sks' ? 'root' : canonical.replace(/^\$sks-/, '');
  if (suffix === 'work') return 'naruto';
  if (suffix === 'with-local-llm-on' || suffix === 'with-local-llm-off') return 'with-local-llm';
  if (suffix === 'fast-on' || suffix === 'fast-off') return 'fast-mode';
  return CLI_NAMES.has(suffix) ? suffix : dollarRouteFallback(suffix);
}

function dollarRouteFallback(value: string): string {
  const fallbacks: Record<string, string> = {
    answer: 'help', plan: 'plan', review: 'review', work: 'naruto', 'release-review': 'review',
    'commit-and-push': 'commit-and-push', 'super-search': 'super-search', 'seo-geo-optimizer': 'seo-geo-optimizer',
    db: 'mad-sks', wiki: 'wiki', help: 'help', goal: 'goal', align: 'align', gx: 'gx', ppt: 'ppt',
    autoresearch: 'autoresearch', research: 'research', 'qa-loop': 'qa-loop', 'image-ux-review': 'image-ux-review',
    'computer-use': 'computer-use', dfix: 'dfix', naruto: 'naruto', commit: 'commit', sks: 'root'
  };
  const command = fallbacks[value];
  if (!command || (command !== 'root' && !CLI_NAMES.has(command))) throw new Error('intent_dollar_command_unmapped');
  return command;
}

function normalizeCli(tokens: readonly string[]): string {
  const first = String(tokens[0] || '').toLowerCase();
  const commandToken = first === 'sks' ? String(tokens[1] || 'root') : first;
  if (commandToken === 'root') return 'root';
  const canonical = CLI_ALIASES.get(commandToken.toLowerCase()) || commandToken.toLowerCase();
  if (!CLI_NAMES.has(canonical)) throw new Error('intent_cli_command_unknown');
  return canonical;
}

function deprecatedOptions(tokens: readonly string[]): DeprecationDescriptor[] {
  const rows: DeprecationDescriptor[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (UNSUPPORTED_OPTIONS.has(lower)) rows.push({ option: token, severity: 'error', replacement: null, code: 'legacy_option_guarantee_unavailable' });
    const replacement = WARN_OPTIONS.get(lower);
    if (replacement) rows.push({ option: token, severity: 'warning', replacement, code: 'legacy_option_deprecated' });
  }
  return rows;
}
