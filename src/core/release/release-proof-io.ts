import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export function unique(values: string[]) {
  return [...new Set(values)]
}

export function relative(root: string, file: string) {
  return path.relative(root, file).split(path.sep).join('/')
}

export function fileSha256(file: string): string | null {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

export function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

export function gitText(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : ''
}

export function gitOk(root: string, args: string[]): boolean {
  return spawnSync('git', args, { cwd: root, stdio: 'ignore' }).status === 0
}
