#!/usr/bin/env node
// Entrypoint for the detached sksd hook daemon process (spawned by
// spawnSksdHookDaemonDetached). Not invoked directly by users.
import { startSksdHookDaemon } from './sksd-hook-daemon.js';
import { evaluateHookPayloadOnce } from '../hooks-runtime.js';

const root = process.argv[2];
if (!root) {
  process.stderr.write('sksd-hook-daemon-entrypoint: root argument required\n');
  process.exit(1);
}

await startSksdHookDaemon(root, async (name, payload) => evaluateHookPayloadOnce(name, payload, { root }), { exitOnRetire: true });
