import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCodexDoctorConsoleStatus } from '../../dist/commands/doctor.js';
import { DOCTOR_CONSOLE_NOT_MEASURED } from '../../dist/commands/doctor-helpers.js';

test('doctor console status renders a never-run Codex Doctor bridge as not measured, not unavailable', () => {
  // No report means the profile never ran the probe: that is unmeasured work,
  // and rendering it `unavailable` painted a skipped check as a failure.
  assert.equal(formatCodexDoctorConsoleStatus(null), DOCTOR_CONSOLE_NOT_MEASURED);
  assert.equal(formatCodexDoctorConsoleStatus(undefined), DOCTOR_CONSOLE_NOT_MEASURED);
  assert.match(DOCTOR_CONSOLE_NOT_MEASURED, /not measured/);
  assert.doesNotMatch(DOCTOR_CONSOLE_NOT_MEASURED, /unavailable|degraded|missing/);
});

test('doctor console status keeps unavailable for a probe that ran and found no usable bridge', () => {
  assert.equal(formatCodexDoctorConsoleStatus({ available: false, disposition: 'warn', exit_code: 1 }), 'unavailable');
});

test('doctor console status formats available Codex Doctor bridge results', () => {
  assert.equal(formatCodexDoctorConsoleStatus({ available: true, disposition: 'block', exit_code: 1 }), 'block');
  assert.equal(formatCodexDoctorConsoleStatus({ available: true, disposition: 'warn', exit_code: 1 }), 'warn');
  assert.equal(formatCodexDoctorConsoleStatus({ available: true, exit_code: 0 }), 'pass');
  assert.equal(formatCodexDoctorConsoleStatus({ available: true, exit_code: 1 }), 'warn');
});
