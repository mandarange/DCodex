// Import this module FIRST in any test file whose code under test may resolve
// the default home (os.homedir(), $HOME, $CODEX_HOME). Library paths that drop
// injected env (e.g. update-migration stages) otherwise write the operator's
// real ~/.codex. Runs at module scope so the redirect lands before the code
// under test is imported.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-test-home-'));
const isolatedCodexHome = path.join(isolatedHome, '.codex');
fs.mkdirSync(isolatedCodexHome, { recursive: true });
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
// Never SET CODEX_HOME here: codexHomePath() prefers env.CODEX_HOME over an
// explicitly passed home, which would hijack tests that isolate via arguments.
// Deleting an inherited value keeps the HOME redirect authoritative.
delete process.env.CODEX_HOME;
// Deep/fix Telegram doctor paths intentionally resolve a live client when a
// token is configured. Never let an operator or CI token leak into hermetic
// tests that did not explicitly provide one.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SKS_TELEGRAM_BOT_TOKEN;

process.once('exit', () => {
  try {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  } catch {}
});

export const ISOLATED_TEST_HOME = isolatedHome;
export const ISOLATED_TEST_CODEX_HOME = isolatedCodexHome;
