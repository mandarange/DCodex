// @ts-nocheck
import fs from 'node:fs';
import { assertGate, emitGate, readText, root } from './gate-lib.js';

const registry = readText('src/cli/command-registry.ts');
const routes = readText('src/core/routes.ts');
const skills = readText('src/core/init/skills.ts');
const removedCommands = ['team', 'mad-db', 'tmux', 'xai', 'swarm', 'agent', 'ralph', 'ui'];
const removedDollarCommands = ['$Agent', '$Team', '$MAD-DB', '$Swarm', '$ShadowClone', '$Kagebunshin', '$Ralph'];
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

assertGate(!registry.includes("auth: '") && !registry.includes("dollars: '"), 'obsolete compatibility aliases must be purged from command registry');
for (const command of removedCommands) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assertGate(!new RegExp(`(?:^|\\n)\\s*(?:['\"]${escaped}['\"]|${escaped})\\s*:`).test(registry), `retired command must not have a registry entry: ${command}`);
}
for (const command of removedDollarCommands) {
  assertGate(!routes.includes(`command: '${command}'`), `retired dollar command must not have a route entry: ${command}`);
}
for (const skill of ['team', 'mad-db', 'swarm', 'shadow-clone', 'kage-bunshin', 'ralph']) {
  assertGate(!skills.includes(`'${skill}': \``), `retired skill template must not be generated: ${skill}`);
}
for (const file of removedHandlers) {
  assertGate(!fs.existsSync(`${root}/${file}`), `retired command handler must be physically absent: ${file}`);
}
emitGate('legacy:gate-purge', {
  removed_command_count: removedCommands.length,
  removed_dollar_command_count: removedDollarCommands.length,
  removed_handler_count: removedHandlers.length
});
