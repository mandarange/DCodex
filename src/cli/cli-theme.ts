import { PACKAGE_VERSION } from '../core/version.js';

const ANSI_CODES = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m'
};

const colorEnabled = process.env.NO_COLOR !== '1' && process.stdout.isTTY !== false;

function paint(code: string, text: string) {
  return colorEnabled && code ? `${code}${text}${ANSI_CODES.reset}` : text;
}

export const ui = {
  banner(cmd: string) {
    console.log(paint(ANSI_CODES.dim, `SKS ${PACKAGE_VERSION} · ${cmd}`));
  },
  ok(msg: string) {
    console.log(`${paint(ANSI_CODES.green, '✔')} ${msg}`);
  },
  warn(msg: string) {
    console.log(`${paint(ANSI_CODES.yellow, '▲')} ${msg}`);
  },
  fail(msg: string) {
    console.log(`${paint(ANSI_CODES.red, '✖')} ${msg}`);
  },
  step(msg: string) {
    console.log(`${paint(ANSI_CODES.dim, '>')} ${msg}`);
  },
  kv(k: string, v: string) {
    console.log(`  ${paint(ANSI_CODES.dim, k.padEnd(18))} ${v}`);
  },
  table(rows: string[][]) {
    if (!rows.length) return;
    const widths = rows[0]?.map((_cell, index) => Math.max(...rows.map((row) => String(row[index] || '').length))) || [];
    for (const [rowIndex, row] of rows.entries()) {
      const line = row.map((cell, index) => String(cell || '').padEnd(widths[index] || 0)).join('  ').trimEnd();
      console.log(rowIndex === 0 ? paint(ANSI_CODES.dim, line) : line);
    }
  }
};

export function withHeartbeat<T>(label: string, work: Promise<T>, opts: { warnAfterMs?: number } = {}): Promise<T> {
  if (process.env.SKS_UPDATE_QUIET || !process.stderr.isTTY) return work;
  const started = Date.now();
  let index = 0;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const timer = setInterval(() => {
    const elapsed = Date.now() - started;
    const seconds = Math.floor(elapsed / 1000);
    const warn = opts.warnAfterMs && elapsed > opts.warnAfterMs ? '  (still working; this can be normal)' : '';
    process.stderr.write(`\r  ${frames[index++ % frames.length]} ${label} ... ${seconds}s${warn}   `);
  }, 120);
  timer.unref?.();
  return work.finally(() => {
    clearInterval(timer);
    process.stderr.write(`\r${' '.repeat(80)}\r`);
  });
}
