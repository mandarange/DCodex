#!/usr/bin/env node
import { main } from '../src/cli/main.mjs';

main(process.argv.slice(2)).catch((err) => {
  const message = err && err.stack ? err.stack : String(err);
  console.error(message);
  process.exitCode = 1;
});
