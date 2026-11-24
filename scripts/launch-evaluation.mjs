import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (!['mechanism', 'stability', 'soak'].includes(mode)) {
  throw new Error('Usage: node scripts/launch-evaluation.mjs mechanism|stability|soak');
}

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
let executable;
let args;
if (process.platform === 'win32') {
  executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    resolve(scriptDirectory, 'run-windows-appcontainer.ps1'), '-Mode', mode];
} else {
  executable = process.execPath;
  args = [resolve(scriptDirectory, 'evaluate.mjs'), mode];
}

const result = spawnSync(executable, args, { stdio: 'inherit', windowsHide: true, shell: false });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
