import test from 'node:test';
import assert from 'node:assert/strict';
import { safeReadOnlySubcommand } from '../../../cli/router.js';
import { remoteCommand } from '../remote-command.js';
import { telegramCommand } from '../telegram-command.js';

async function captureHelp(run: () => Promise<unknown>): Promise<{ result: any; output: string }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    const result = await run();
    return { result, output: lines.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

for (const form of [['--help'], ['-h'], ['help']]) {
  test(`telegram ${form[0]} prints usage without reporting unknown_action`, async () => {
    const exitBefore = process.exitCode;
    const { result, output } = await captureHelp(() => telegramCommand([...form]));

    assert.equal(result?.ok, true);
    assert.equal(result?.action, 'help');
    // A pure usage request must never be answered with an error or a failing exit code.
    assert.notEqual(result?.error, 'unknown_action');
    assert.equal(process.exitCode, exitBefore);
    assert.ok(output.includes('Usage:'), output);
    assert.ok(output.includes('sks telegram setup --bot-token-stdin'), output);
    assert.ok(output.includes('sks telegram hub start'), output);
    // The pairing prerequisite is the single most common setup failure.
    assert.ok(output.includes('/newbot'), output);
    assert.ok(output.includes('/start'), output);
    assert.ok(output.includes('macOS Keychain'), output);
    assert.ok(output.includes('telegram_webhook_conflict'), output);
    assert.ok(output.includes('does not delete external webhook state implicitly'), output);
    assert.ok(output.includes('telegram_409_conflict'), output);
    assert.ok(output.includes('stop the other poller'), output);
    assert.ok(output.includes('before rerunning setup or rotating'), output);
    assert.ok(output.includes('docs/telegram-and-center.md'), output);
  });

  test(`remote ${form[0]} prints usage without reporting unknown_action`, async () => {
    const exitBefore = process.exitCode;
    const { result, output } = await captureHelp(() => remoteCommand([...form]));

    assert.equal(result?.ok, true);
    assert.equal(result?.action, 'help');
    assert.notEqual(result?.error, 'unknown_action');
    assert.equal(process.exitCode, exitBefore);
    assert.ok(output.includes('Usage:'), output);
    assert.ok(output.includes('sks remote readiness'), output);
  });
}

test('telegram and remote read-only diagnostics survive a blocked project migration', () => {
  // These are the commands an operator runs to find out why pairing is broken.
  // If the migration gate swallows them, a blocked project becomes undiagnosable.
  assert.equal(safeReadOnlySubcommand('telegram', ['status']), true);
  assert.equal(safeReadOnlySubcommand('telegram', ['validate-config']), true);
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'status']), true);
  assert.equal(safeReadOnlySubcommand('remote', ['readiness']), true);
  assert.equal(safeReadOnlySubcommand('remote', ['machines', 'list']), true);
  assert.equal(safeReadOnlySubcommand('remote', ['machines', 'validate']), true);
});

test('telegram and remote mutating subcommands stay behind the migration gate', () => {
  // `hub` with no explicit action defaults to `run`, which starts the hub, so a
  // bare `hub` must never be treated as a read-only probe.
  assert.equal(safeReadOnlySubcommand('telegram', ['hub']), false);
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'run']), false);
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'start']), false);
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'stop']), false);
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'restart']), false);
  assert.equal(safeReadOnlySubcommand('telegram', ['setup']), false);
  assert.equal(safeReadOnlySubcommand('remote', ['worker', '--stdio']), false);
  // Mutation flags disqualify an otherwise read-only path.
  assert.equal(safeReadOnlySubcommand('telegram', ['hub', 'status', '--fix']), false);
  assert.equal(safeReadOnlySubcommand('remote', ['machines', 'list', '--write']), false);
});
