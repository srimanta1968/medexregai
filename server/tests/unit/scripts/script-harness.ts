import { spawn } from 'child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'dotenv';

export const REPO_ROOT: string = join(__dirname, '../../../..');

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * A throwaway copy of the repo layout the scripts expect: scripts/, server/ and
 * client/ with the committed .env.example templates, and no real env files.
 */
export function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'medex-scripts-'));
  for (const sub of ['scripts', 'server', 'client']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  for (const file of ['scripts/setup-env.sh', 'scripts/pull-models.sh', 'server/.env.example', 'client/.env.example']) {
    copyFileSync(join(REPO_ROOT, file), join(dir, file));
  }
  return dir;
}

/** Run a script with bash, stdin closed (non-interactive), without blocking the event loop. */
export function runScript(
  sandbox: string,
  script: string,
  args: string[] = [],
  env: Record<string, string> = {}
): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [join(sandbox, script), ...args], {
      cwd: sandbox,
      env: { ...process.env, DB_PASSWORD: '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Parse an env file exactly as the API does (dotenv). */
export function readEnv(path: string): Record<string, string> {
  return parse(readFileSync(path, 'utf8'));
}
