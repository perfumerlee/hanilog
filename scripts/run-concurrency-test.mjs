import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const scriptPath = fileURLToPath(new URL('./test-concurrency.ps1', import.meta.url));
const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
const shellArgs = process.platform === 'win32'
  ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
  : ['-NoProfile', '-File', scriptPath];

const result = spawnSync(shell, shellArgs, { stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`Could not start ${shell}: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
