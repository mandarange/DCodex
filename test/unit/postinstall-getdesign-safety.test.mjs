import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureGlobalGetdesignSkillDuringInstall } from '../../dist/cli/install-helpers-install-support.js';
import { GETDESIGN_REFERENCE } from '../../dist/core/routes.js';

test('getdesign postinstall never runs the third-party installer', async () => {
  const calls = [];
  const runProcess = async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: 'installed', stderr: '' };
  };

  const skipped = await ensureGlobalGetdesignSkillDuringInstall({
    env: {
      HOME: '/tmp/sks-getdesign-home',
      PATH: '/tmp/sks-getdesign-bin',
      TOP_SECRET_CANARY: 'must-not-reach-child'
    },
    skillsBin: '/tmp/sks-getdesign-bin/skills',
    runProcess
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'manual_install_only');
  assert.equal(calls.length, 0);
  assert.match(GETDESIGN_REFERENCE.codex_skill_ref, /^[a-f0-9]{40}$/);
  assert.equal(GETDESIGN_REFERENCE.codex_skill, GETDESIGN_REFERENCE.codex_skill_repository);
  assert.equal(GETDESIGN_REFERENCE.codex_skill_install_mode, 'manual_only');
  assert.equal(skipped.reviewed_ref, GETDESIGN_REFERENCE.codex_skill_ref);
  assert.equal(skipped.install, GETDESIGN_REFERENCE.codex_skill_install);
  assert.equal(GETDESIGN_REFERENCE.codex_skill_install, 'skills add MohtashamMurshid/getdesign -g -a codex -y');
});
