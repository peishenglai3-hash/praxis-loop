import { assertSandbox } from './sandbox-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assertSandbox();
const { ShellCommandAdapter, CodexAdapter } = await import('../dist/adapters.js');

const command = (script, args = [], timeoutMs = 5_000) => ({
  executable: process.execPath, args: ['-e', script, '--', ...args], timeoutMs,
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-adapter-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    if (await predicate()) return;
    await delay(25);
  } while (performance.now() < deadline);
  assert.fail(message);
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

test('argv and a cwd with spaces/Chinese survive literally without shell expansion', async (t) => {
  const directory = await fixture(t);
  const cwd = join(directory, '工作 空格');
  await mkdir(cwd);
  const argv = ['', 'a b', '"quoted"', "'single'", '$HOME', '$(touch SHELL_RAN)',
    '; touch SHELL_RAN', 'a&b|c>d', '路径\\文件', '第一行\n第二行', '--flag=value'];
  const request = command('process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd()}))', argv);
  const before = structuredClone(request);
  const result = await new ShellCommandAdapter().execute(request, cwd, 5_000);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(result.stdout), { argv, cwd: resolve(cwd) });
  assert.deepEqual(request, before, 'adapter must not mutate caller argv');
  assert.equal(await exists(join(cwd, 'SHELL_RAN')), false);
});

test('missing binaries settle as execution failures and do not hang', { timeout: 10_000 }, async (t) => {
  const directory = await fixture(t);
  const result = await new ShellCommandAdapter().execute({
    executable: join(directory, 'binary-that-does-not-exist'), args: [], timeoutMs: 2_000,
  }, directory, 2_000);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /Unable to execute command|ENOENT/u);
});

test('a nonzero exit retains separate stdout/stderr and its exit code', async (t) => {
  const directory = await fixture(t);
  const result = await new ShellCommandAdapter().execute(command(
    'process.stdout.write("partial result"); process.stderr.write("rejected input"); process.exitCode=7;',
  ), directory, 5_000);
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, 'partial result');
  assert.equal(result.stderr, 'rejected input');
  assert.equal(result.timedOut, false);
});

test('the total remaining budget can terminate a command before its own deadline', { timeout: 10_000 }, async (t) => {
  const directory = await fixture(t);
  const result = await new ShellCommandAdapter().execute(
    command('setInterval(()=>{},1000)', [], 30_000), directory, 120,
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.signal);
  assert.ok(result.durationMs < 8_000, 'termination must settle, rather than wait for the 30s command budget');
});

test('an already aborted signal prevents command startup', async (t) => {
  const directory = await fixture(t);
  const marker = join(directory, 'started');
  const controller = new AbortController();
  controller.abort();
  const result = await new ShellCommandAdapter(controller.signal).execute(
    command('require("node:fs").writeFileSync(process.argv[1],"started")', [marker]), directory, 5_000,
  );
  assert.equal(result.signal, 'ABORT_ERR');
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(await exists(marker), false);
});

test('a running command can be cancelled through the per-call signal', { timeout: 15_000 }, async (t) => {
  const directory = await fixture(t);
  const marker = join(directory, 'ready');
  const controller = new AbortController();
  const pending = new ShellCommandAdapter().execute(command(
    'require("node:fs").writeFileSync(process.argv[1],"ready"); setInterval(()=>{},1000);', [marker], 10_000,
  ), directory, 10_000, controller.signal);
  try {
    await waitFor(() => exists(marker), 'fixture did not become ready');
    controller.abort();
    const result = await pending;
    assert.equal(result.timedOut, false);
    assert.notEqual(result.exitCode, 0);
    assert.ok(result.signal);
  } finally {
    controller.abort();
    await pending;
  }
});

async function liveProcess(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if (error.code === 'ESRCH' || error.code === 'EINVAL') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    // A zombie is already terminated; only its parent/init can reap its PID.
    return !/^\s*[ZX]\b/u.test(stat.slice(stat.lastIndexOf(')') + 1));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error;
  }
}

for (const termination of ['timeout', 'cancellation']) {
  test(`${termination} kills the process tree including a termination-resistant grandchild`, {
    skip: !['linux', 'win32'].includes(process.platform), timeout: 20_000,
  }, async (t) => {
    const directory = await fixture(t);
    const paths = ['parent', 'child', 'grandchild'].map((name) => join(directory, `${name}.pid`));
    const program = (pidPath, childProgram) => [
      'process.on("SIGTERM",()=>{});',
      `require("node:fs").writeFileSync(${JSON.stringify(pidPath)},String(process.pid));`,
      childProgram ? `require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(childProgram)}],{stdio:["ignore","inherit","inherit"]});` : '',
      'setInterval(()=>{},1000);',
    ].join('\n');
    const rootProgram = program(paths[0], program(paths[1], program(paths[2])));
    const controller = new AbortController();
    const timeoutMs = termination === 'timeout' ? 3_000 : 10_000;
    const pending = new ShellCommandAdapter().execute(command(rootProgram, [], timeoutMs), directory, timeoutMs, controller.signal);
    let pids = [];
    try {
      await waitFor(async () => (await Promise.all(paths.map(exists))).every(Boolean), 'process tree did not become ready', 2_500);
      pids = await Promise.all(paths.map(async (path) => Number(await readFile(path, 'utf8'))));
      assert.ok(pids.every((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid));
      if (termination === 'cancellation') controller.abort();
      const result = await pending;
      assert.equal(result.timedOut, termination === 'timeout');
      assert.notEqual(result.exitCode, 0);
      assert.doesNotMatch(result.stderr, /descendant cleanup is unconfirmed/u);
      await waitFor(async () => (await Promise.all(pids.map(liveProcess))).every((alive) => !alive),
        'fixture left a live parent/child/grandchild after adapter completion');
    } finally {
      controller.abort();
      await pending;
      // Only PIDs read from this fixture are considered. Never kill by a process name.
      if (pids.length === 0) {
        for (const path of paths) if (await exists(path)) pids.push(Number(await readFile(path, 'utf8')));
      }
      for (const pid of pids) {
        if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) continue;
        if (await liveProcess(pid)) {
          if (process.platform === 'win32') {
            const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
            const cleanup = spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
            if (cleanup.error && (await liveProcess(pid))) throw cleanup.error;
          } else {
            try { process.kill(pid, 'SIGKILL'); }
            catch (error) { if (error.code !== 'ESRCH') throw error; }
          }
        }
      }
    }
  });
}

test('combined stdout/stderr stops at the output cap without retaining an oversized payload', { timeout: 15_000 }, async (t) => {
  const directory = await fixture(t);
  // 257 x 64KiB is just one chunk above the 16MiB limit; no unbounded output loop.
  const script = 'const {once}=require("node:events"); (async()=>{const chunk=Buffer.alloc(65536,120); for(let i=0;i<257;i++){const stream=i%2?process.stderr:process.stdout;if(!stream.write(chunk))await once(stream,"drain");}setInterval(()=>{},1000);})()';
  const result = await new ShellCommandAdapter().execute(command(script, [], 10_000), directory, 10_000);
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stderr, /Combined command output exceeded 16 MiB/u);
  const retainedBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  assert.ok(retainedBytes <= 16 * 1024 * 1024 + 512, 'allow only the small diagnostic beyond the configured cap');
});

test('Codex adapter forwards argv/stdin to an offline fixture and collects its final message', { concurrency: false }, async (t) => {
  const directory = await fixture(t);
  let executable;
  if (process.platform === 'win32') {
    const packageRoot = join(directory, 'fake-cli', 'node_modules', '@openai', 'codex');
    const entry = join(packageRoot, 'bin', 'codex.js');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'commonjs' }));
    await writeFile(entry, `const fs=require('node:fs');const args=process.argv.slice(2);let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({args,input}));process.stdout.write('offline diagnostic');});\n`);
    executable = join(directory, 'fake-cli', 'codex.cmd');
  } else {
    executable = join(directory, 'fake-codex');
    await writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({args,input}));process.stdout.write('offline diagnostic');});\n`);
    await chmod(executable, 0o700);
  }
  const previous = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = executable;
  try {
    const result = await new CodexAdapter().generate({
      purpose: 'explore', prompt: '证据 $HOME ; 保持原样', cwd: directory, writable: false, timeoutMs: 5_000,
    });
    assert.equal(result.exitCode, 0);
    const message = JSON.parse(result.stdout);
    assert.equal(message.args[0], 'exec');
    assert.equal(message.args[message.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(message.args[message.args.indexOf('--cd') + 1], resolve(directory));
    assert.ok(message.args.includes('approval_policy="never"'));
    assert.equal(message.args.at(-1), '-');
    assert.ok(message.input.endsWith('证据 $HOME ; 保持原样'));
    assert.match(result.stderr, /offline diagnostic/u);
  } finally {
    if (previous === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = previous;
  }
});
