#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertSandbox } from '../tests/sandbox-guard.mjs';

const mode = process.argv[2];
if (!['mechanism', 'stability', 'soak'].includes(mode)) throw new Error('Usage: node scripts/evaluate.mjs mechanism|stability|soak');
const sandbox = assertSandbox();
if (!/^v?24\.15\.\d+(?:[-+].*)?$/u.test(process.version)) {
  throw new Error('Evaluation requires the pinned Node 24.15.x runtime; found ' + process.version);
}
const source = fileURLToPath(new URL('../', import.meta.url));
async function snapshotHash(directory) {
  const hash = createHash('sha256');
  async function visit(current, relative = '') {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) {
        hash.update(name).update('\0');
        hash.update(await readFile(path)).update('\0');
      } else throw new Error(`Unsupported file in immutable evaluation snapshot: ${name}`);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}
const sourceSnapshotSha256 = await snapshotHash(source);
const output = resolve(process.env.PRAXIS_LOOP_EVIDENCE_DIR || join(tmpdir(), 'praxis-loop-evidence'), `${mode}-${randomUUID()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
const startedAt = new Date().toISOString();
const discoveredTestFiles = (await readdir(resolve(source, 'tests'))).filter(name => name.endsWith('.test.mjs')).sort();
const windowsAppContainer = process.platform === 'win32' && process.env.PRAXIS_LOOP_APPCONTAINER_VERIFIED === '1';
const windowsInProcessTestFiles = new Set(['search-exploration.test.mjs', 'store.test.mjs']);
const files = windowsAppContainer
  ? discoveredTestFiles.filter(name => windowsInProcessTestFiles.has(name))
  : discoveredTestFiles;
const excludedTestFiles = windowsAppContainer
  ? discoveredTestFiles.filter(name => !windowsInProcessTestFiles.has(name))
  : [];
const argv = mode === 'mechanism'
  ? ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files.map(name => resolve(source, 'tests', name))]
  : [resolve(source, 'tests/stability.mjs'), ...(mode === 'soak' ? ['--duration-hours', '1'] : [])];
const log = [];
let bytes = 0;
let truncated = false;
const deadlineMs = mode === 'soak' ? 2 * 3600000 : mode === 'stability' ? 2 * 3600000 : 30 * 60000;
function stopTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
      killer.on('close', (code) => { if (code !== 0) { try { child.kill('SIGKILL'); } catch {} } });
    } catch { try { child.kill('SIGKILL'); } catch {} }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}
let result;
let raw;
if (process.platform === 'win32') {
  if (mode === 'mechanism') {
    const { runTestFiles } = await import(resolve(source, 'scripts/windows-test-harness.mjs'));
    const suite = await runTestFiles(files.map(name => resolve(source, 'tests', name)));
    raw = Buffer.from(suite.output, 'utf8');
    bytes = raw.length;
    truncated = bytes > 32 * 1024 * 1024;
    if (truncated) raw = raw.subarray(0, 32 * 1024 * 1024);
    result = { exitCode: suite.failed === 0 ? 0 : 1, signal: null, timedOut: false,
      testCount: suite.tests, passed: suite.passed, failed: suite.failed, skipped: suite.skipped };
  } else {
    const stabilityFile = resolve(source, 'tests/stability.mjs');
    const stabilityArgs = mode === 'soak' ? ['--duration-hours', '1'] : [];
    const previousArgv = process.argv;
    const originalWrite = process.stdout.write;
    let durationExitCode = 0;
    process.argv = [process.execPath, stabilityFile, ...stabilityArgs];
    process.exitCode = 0;
    process.stdout.write = function (chunk, encoding, callback) {
      const content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      if (bytes + content.length <= 32 * 1024 * 1024) { log.push(content); bytes += content.length; }
      else truncated = true;
      if (typeof encoding === 'function') encoding();
      else if (typeof callback === 'function') callback();
      return true;
    };
    try { await import(pathToFileURL(stabilityFile).href); }
    catch (error) { log.push(Buffer.from(`${error?.stack || error}\n`)); durationExitCode = 1; }
    finally {
      durationExitCode ||= process.exitCode || 0;
      process.stdout.write = originalWrite;
      process.argv = previousArgv;
    }
    raw = Buffer.concat(log);
    result = { exitCode: durationExitCode, signal: null, timedOut: false };
  }
} else {
  result = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, argv, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const capture = chunk => {
      if (bytes + chunk.length <= 32 * 1024 * 1024) { log.push(chunk); bytes += chunk.length; }
      else { truncated = true; stopTree(child); }
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const stop = () => stopTree(child);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stop(); }, deadlineMs);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.once('error', error => { clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); reject(error); });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
      resolveResult({ exitCode, signal, timedOut });
    });
  });
  raw = Buffer.concat(log);
}
const digest = createHash('sha256').update(raw).digest('hex');
await writeFile(resolve(output, 'output.log'), raw, { flag: 'wx' });
const packageText = await readFile(resolve(source, 'package.json'), 'utf8');
const lockText = await readFile(resolve(source, 'pnpm-lock.yaml'), 'utf8');
const packageJson = JSON.parse(packageText);
const sourceSnapshotSha256After = await snapshotHash(source);
const helperHashes = {};
if (process.env.PRAXIS_LOOP_HOST_SOURCE) {
  try { helperHashes.hostSourceSha256 = createHash('sha256').update(await readFile(process.env.PRAXIS_LOOP_HOST_SOURCE)).digest('hex'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const snapshotCleanAfter = sourceSnapshotSha256 === sourceSnapshotSha256After;
const subprocessCoverageExcluded = windowsAppContainer && mode !== 'mechanism'
  ? 'Adapter child spawn with redirected stdio stalled inside this AppContainer; no command-lifecycle cycles were attempted.'
  : null;
const repositoryHead = process.env.PRAXIS_LOOP_SOURCE_COMMIT || null;
if (repositoryHead && !/^[0-9a-f]{40,64}$/iu.test(repositoryHead)) throw new Error('Invalid source commit in sandbox environment');
const manifest = { schemaVersion: 2, mode, startedAt, endedAt: new Date().toISOString(), sandbox, node: process.version,
  platform: process.platform, arch: process.arch, repositoryHead,
  testCoverage: { executedTestFiles: mode === 'mechanism' ? files : [],
    excludedTestFiles, subprocessCoverageExcluded,
    exclusionReason: excludedTestFiles.length > 0
      ? 'The adapter test suite stalled in ShellCommandAdapter.execute at a Windows child-process spawn with redirected stdio. The AppContainer Job Object stayed at one active process; these suites remain unverified.'
      : null },
  sourceSnapshotSha256, sourceSnapshotSha256After, snapshotCleanAfter, sandboxHelperHashes: helperHashes,
  packageVersion: packageJson.version,
  packageSha256: createHash('sha256').update(packageText).digest('hex'),
  lockfileSha256: createHash('sha256').update(lockText).digest('hex'),
  argv, result, truncated, logSha256: digest,
  status: result.exitCode === 0 && !result.signal && !result.timedOut && !truncated && snapshotCleanAfter
    ? (excludedTestFiles.length > 0 || subprocessCoverageExcluded ? 'partial' : 'passed') : 'failed' };
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
process.stdout.write(`${JSON.stringify({ output, ...manifest }, null, 2)}\n`);
if (manifest.status === 'failed') process.exitCode = 1;
