#!/usr/bin/env node
import fs from 'node:fs';
import { assertGate, emitGate, importDist, readText, root } from './gate-lib.js';

const removed = ['team', 'mad-db', 'tmux', 'xai', 'swarm', 'agent', 'ralph', 'ui', 'glm'];
const removedDollar = ['$Agent', '$Team', '$MAD-DB', '$Swarm', '$ShadowClone', '$Kagebunshin', '$Ralph'];
const removedHandlers = [
  'src/commands/team.ts',
  'src/core/commands/team-command.ts',
  'src/core/commands/team-legacy-observe-command.ts',
  'src/commands/mad-db.ts',
  'src/core/commands/mad-db-command.ts',
  'src/commands/tmux.ts',
  'src/cli/xai-command.ts',
  'src/core/commands/agent-command.ts',
  'src/core/agents/agent-command-surface.ts',
  'src/core/commands/ui-command.ts',
  'src/core/ui/dashboard-html.ts'
];

const [{ COMMANDS, COMMAND_ALIASES, commandNames }, { REMOVED_PUBLIC_COMMANDS }, routes, init] = await Promise.all([
  importDist('cli/command-registry.js'),
  importDist('core/doctor/retired-managed-residue-private.js'),
  importDist('core/routes.js'),
  importDist('core/init.js')
]);
const catalogNames = routes.COMMAND_CATALOG.map((entry: any) => entry.name);
const catalogDollarTokens = JSON.stringify(routes.COMMAND_CATALOG).match(/\$[A-Za-z][A-Za-z0-9_-]*/g) || [];
const listedDollarCommands = routes.DOLLAR_COMMANDS.map((entry: any) => entry.command);
const listedSkillAliases = routes.DOLLAR_COMMAND_ALIASES.map((entry: any) => entry.app_skill);
const liteManifest = readText('src/core/routes/dollar-manifest-lite.ts');
const commandManifestLite = readText('src/cli/command-manifest-lite.ts');
const argsSource = readText('src/cli/args.ts');
const installerSource = readText('src/bin/install.ts');

assertGate(
  JSON.stringify([...REMOVED_PUBLIC_COMMANDS].sort()) === JSON.stringify([...removed].sort()),
  'internal cleanup tombstones must cover every retired public command without registering aliases',
  { expected_count: removed.length, observed_count: REMOVED_PUBLIC_COMMANDS.length }
);

for (const command of removed) {
  assertGate(!Object.hasOwn(COMMANDS, command), `removed command must not be registered: ${command}`);
  assertGate(!Object.hasOwn(COMMAND_ALIASES, command), `removed command must not redirect: ${command}`);
  assertGate(!commandNames().includes(command), `removed command must not be listed: ${command}`);
  assertGate(!catalogNames.includes(command), `removed command must not be in the command catalog: ${command}`);
  assertGate(!commandManifestLite.includes(`{ name: '${command}',`), `removed command must not remain in the lite manifest: ${command}`);
}
for (const command of removedDollar) {
  assertGate(!listedDollarCommands.includes(command), `removed dollar command must not be listed: ${command}`);
  assertGate(routes.routePrompt(`${command} fixture`) === null, `removed dollar command must not redirect: ${command}`);
  assertGate(!liteManifest.includes(`command: '${command}'`), `removed dollar command must not remain in the lite manifest: ${command}`);
}
for (const skill of ['$agent', '$team', '$mad-db', '$swarm', '$shadow-clone', '$kage-bunshin', '$ralph']) {
  assertGate(!listedSkillAliases.includes(skill), `removed skill alias must not be listed: ${skill}`);
  assertGate(!liteManifest.includes(`app_skill: '${skill}'`), `removed skill alias must not remain in the lite manifest: ${skill}`);
}
for (const file of removedHandlers) {
  assertGate(!fs.existsSync(`${root}/${file}`), `removed command handler must not remain: ${file}`);
}
assertGate(!argsSource.includes("'--agent',"), 'CLI value-flag parsing must not preserve the retired public scheduler flag');
const managedAgents = init.agentsBlockText();
assertGate(!/\bralph\b/i.test(managedAgents), 'managed project guidance must describe only the current Goal surface');
assertGate(!managedAgents.includes('$From-Chat-IMG'), 'managed project guidance must not advertise an unregistered visual route name');
assertGate(!managedAgents.includes('$from-chat-img'), 'managed project guidance must not advertise the visual add-on skill as another execution alias');
assertGate(
  listedSkillAliases.includes('$sks-from-chat-img'),
  'visible Codex App picker skills must retain the namespaced Naruto visual add-on skill'
);
assertGate(listedSkillAliases.every((name: string) => name === '$sks' || name.startsWith('$sks-')), 'every visible Codex App picker skill must use the sks- namespace');
assertGate(new Set(listedSkillAliases).size === listedSkillAliases.length, 'visible Codex App picker skills must not contain duplicates');
assertGate(listedDollarCommands.every((name: string) => name === '$sks' || name.startsWith('$sks-')), 'every visible dollar command must use the sks- namespace');
assertGate(catalogDollarTokens.every((name: string) => name === '$sks' || name.startsWith('$sks-')), 'public CLI catalog descriptions must use only namespaced SKS dollar commands', { invalid: catalogDollarTokens.filter((name: string) => name !== '$sks' && !name.startsWith('$sks-')) });
assertGate(listedDollarCommands.includes('$sks-naruto') && listedDollarCommands.includes('$sks-work'), 'current execution surface must list the namespaced canonical workflow and its intended alias');
assertGate(!listedDollarCommands.includes('$Naruto') && !listedDollarCommands.includes('$Work'), 'legacy unprefixed workflow commands must not remain visible');
const narutoRoute = routes.ROUTES.find((entry: any) => entry.id === 'Naruto');
assertGate(
  JSON.stringify(narutoRoute?.dollarAliases || []) === JSON.stringify(['$Work']),
  'canonical official subagent route must have exactly one execution alias',
  { alias_count: narutoRoute?.dollarAliases?.length || 0 }
);
assertGate(routes.routePrompt('$sks-work fixture')?.id === 'Naruto', 'the namespaced execution alias must resolve to the canonical official subagent route');
assertGate(routes.routePrompt('$sks-from-chat-img fixture')?.id === 'Naruto', 'the namespaced chat-image add-on must resolve to Naruto');
assertGate(routes.hasFromChatImgSignal('$sks-from-chat-img fixture') === true, 'the namespaced chat-image add-on must activate forensic intake');
assertGate(routes.routePrompt('$sks-mad-sks $sks-naruto fixture')?.id === 'Naruto', 'the namespaced MAD-SKS modifier must preserve nested route selection');
assertGate(!/\$(?:Plan|Work)\b/.test(installerSource), 'installer guidance must not advertise legacy unprefixed dollar commands');
assertGate(installerSource.includes('$sks-plan') && installerSource.includes('$sks-work'), 'installer guidance must advertise namespaced planning and execution commands');

emitGate('commands:current-surface-only', {
  removed_command_count: removed.length,
  removed_dollar_count: removedDollar.length,
  removed_handler_count: removedHandlers.length,
  canonical_execution_surface_count: 2
});
