import path from 'node:path';
import os from 'node:os';

export function codexLbConfigPath(home: unknown = process.env.HOME || os.homedir()) {
  return path.join(String(home), '.codex', 'config.toml');
}

export function codexLbEnvPath(home: unknown = process.env.HOME || os.homedir()) {
  return path.join(String(home), '.codex', 'sks-codex-lb.env');
}

export function codexAuthPath(home: unknown = process.env.HOME || os.homedir()) {
  return path.join(String(home), '.codex', 'auth.json');
}
