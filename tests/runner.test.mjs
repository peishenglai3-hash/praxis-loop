import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertSandbox } from './sandbox-guard.mjs';

// Refuse host execution before importing application code or provisioning files.
assertSandbox();
const { runTask } = await import('../dist/runner.js');
const { PraxisStore } = await import('../dist/store.js');
const { captureDiff, headCommit } = await import('../dist/git.js');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const check = { executable: 'scripted-check', args: ['fixed-acceptance'], timeoutMs: 1000 };
const plan = JSON.stringify({ summary: 'Repair value', steps: ['Change value'], assumptions: [] });
const repair = JSON.stringify({ action: 'repair', analysis: 'The check rejected the current value.', repairInstructions: 'Correct the value without changing acceptance.', question: '' });
const stop = JSON.stringify({ action: 'stop', analysis: 'Do not continue.', repairInstructions: '', question: '' });
function result(cwd, overrides = {}) {
  return { executable: 'scripted', args: [], cwd, exitCode: 0, signal: null, stdout: 'done', stderr: '', timedOut: false, durationMs: 1, ...overrides };
}
function git(cwd, ...args) {
  const disabledHooks = join(tmpdir(), 'praxis-loop-hooks-disabled');
  return execFileSync('git', ['-c', `core.hooksPath=${disabledHooks}`, ...args], { cwd, encoding: 'utf8', windowsHide: true });
}
async function fixture(t, { modelStep, commandStep, acceptance = [check] } = {}) {
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'praxis-loop-runner-test-'));
  const root = join(directory, 'source');
  const home = join(directory, 'home');
  await mkdir(root);
  await mkdir(home);
  const overrides = { PRAXIS_LOOP_STATE_DIR: join(directory, 'state'), HOME: home, USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.state'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'empty.gitconfig') };
  await writeFile(overrides.GIT_CONFIG_GLOBAL, '');
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  let store;
  t.after(async () => {
    store?.close();
    try {
      assert.equal(dirname(resolve(directory)), temporaryRoot);
      assert.ok(directory.startsWith(join(temporaryRoot, 'praxis-loop-runner-test-')));
      await rm(directory, { recursive: true, force: true });
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.name', 'Isolated Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  await writeFile(join(root, 'value.txt'), 'base\n');
  git(root, 'add', '--', 'value.txt');
  git(root, 'commit', '--quiet', '-m', 'fixture base');
  store = new PraxisStore(join(directory, 'test.db'));
  const modelCalls = [];
  const commandCalls = [];
  const model = { async generate(input) {
    modelCalls.push(input);
    if (modelStep) return await modelStep(input, modelCalls);
    return result(input.cwd, { stdout: input.purpose === 'plan' ? plan : input.purpose === 'critic' ? stop : 'done' });
  } };
  const commands = { async execute(command, cwd, budget, signal) {
    const call = { command, cwd, budget, signal };
    commandCalls.push(call);
    return commandStep ? await commandStep(call, commandCalls) : result(cwd);
  } };
  return { directory, root, store, modelCalls, commandCalls,
    async run(extra = {}) { return await runTask({ root, prompt: 'Repair the value', acceptance, useMemory: false, explore: false, ...extra }, store, model, commands); },
    events(id) { return store.getRun(id).events; },
  };
}

test('repair rounds preserve separate immutable logs and hash-bound summaries', { concurrency: false }, async (t) => {
  let attempts = 0;
  const f = await fixture(t, {
    async modelStep(input) {
      if (input.purpose === 'plan') return result(input.cwd, { stdout: plan });
      if (input.purpose === 'critic') return result(input.cwd, { stdout: repair });
      await writeFile(join(input.cwd, 'value.txt'), ++attempts === 1 ? 'first\n' : 'fixed\n');
      return result(input.cwd);
    },
    commandStep({ cwd }, calls) { return result(cwd, { exitCode: calls.length === 1 ? 1 : 0, stdout: `round-${calls.length}` }); },
  });
  const outcome = await f.run();
  assert.equal(outcome.status, 'completed');
  assert.equal(attempts, 2);
  const events = f.events(outcome.runId);
  const checks = events.filter((event) => event.type === 'run.check');
  const summaries = events.filter((event) => event.type === 'run.verification');
  assert.equal(checks.length, 2);
  assert.equal(summaries.length, 2);
  assert.notEqual(checks[0].payload.log.path, checks[1].payload.log.path);
  for (const [index, event] of checks.entries()) {
    const contents = await readFile(event.payload.log.path);
    assert.equal(hash(contents), event.payload.log.sha256);
    assert.match(contents.toString(), new RegExp(`round-${index + 1}`));
    assert.equal(event.payload.round, index + 1);
  }
  for (const event of summaries) {
    const contents = await readFile(event.payload.summary.path);
    assert.equal(hash(contents), event.payload.summary.sha256);
    const parsed = JSON.parse(contents);
    assert.equal(parsed.round, event.payload.round);
    assert.equal(parsed.beforeDiffHash, parsed.afterDiffHash);
    assert.equal(parsed.baseVerified, true);
  }
  assert.notEqual(summaries[0].payload.beforeDiffHash, summaries[1].payload.beforeDiffHash);
  assert.equal(outcome.diffHash, outcome.verification.diffHash);
  assert.equal(hash(await readFile(outcome.diffPath)), outcome.diffHash);
  assert.equal(captureDiff(outcome.worktreePath, headCommit(f.root)).hash, outcome.diffHash);
  assert.equal(await readFile(join(f.root, 'value.txt'), 'utf8'), 'base\n');
  const owner = JSON.parse(await readFile(join(dirname(outcome.diffPath), 'owner.json'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.hostname, hostname());
  assert.ok(Number.isFinite(Date.parse(owner.startedAt)));
});

test('planner raw output and diagnostics survive malformed JSON', { concurrency: false }, async (t) => {
  const raw = '  { malformed planner text\n';
  const f = await fixture(t, { modelStep(input) { return result(input.cwd, { stdout: raw, stderr: 'planner diagnostic' }); } });
  const outcome = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.equal(f.commandCalls.length, 0);
  assert.equal(f.modelCalls.length, 1);
  const event = f.events(outcome.runId).find((entry) => entry.type === 'run.planner.result');
  assert.equal(event.payload.exitCode, 0);
  assert.equal(await readFile(event.payload.plannerOutput.path, 'utf8'), raw);
  assert.equal(hash(await readFile(event.payload.plannerOutput.path)), event.payload.plannerOutput.sha256);
  assert.equal(await readFile(event.payload.plannerStderr.path, 'utf8'), 'planner diagnostic');
  assert.match(outcome.detail, /JSON/);
});

test('unsuccessful planner preserves command status before validation', { concurrency: false }, async (t) => {
  const f = await fixture(t, { modelStep(input) { return result(input.cwd, { exitCode: 7, stdout: '', stderr: 'provider failed' }); } });
  const outcome = await f.run();
  assert.equal(outcome.status, 'failed');
  const event = f.events(outcome.runId).find((entry) => entry.type === 'run.planner.result');
  assert.equal(event.payload.exitCode, 7);
  assert.equal(await readFile(event.payload.plannerOutput.path, 'utf8'), '');
  assert.match(await readFile(event.payload.plannerStderr.path, 'utf8'), /provider failed/);
});

test('planner adapter rejection leaves a durable error event', { concurrency: false }, async (t) => {
  const f = await fixture(t, { modelStep() { throw new Error('planner launch rejected'); } });
  const outcome = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.match(f.events(outcome.runId).find((event) => event.type === 'run.planner.error').payload.error, /launch rejected/);
});

test('unknown acceptance is not masked by another failed check', { concurrency: false }, async (t) => {
  const f = await fixture(t, {
    acceptance: [check, { ...check, args: ['another-fixed-check'] }],
    commandStep({ cwd }, calls) { return result(cwd, calls.length === 1 ? { exitCode: 1 } : { exitCode: 1, signal: 'SIGTERM', timedOut: true }); },
  });
  const outcome = await f.run();
  assert.equal(outcome.verification.status, 'unknown');
  assert.deepEqual(outcome.verification.checks.map((entry) => entry.status), ['fail', 'unknown']);
  assert.equal(outcome.status, 'interrupted');
  assert.equal(f.modelCalls.filter((input) => input.purpose === 'critic').length, 0);
});

test('acceptance adapter rejection is recorded as unknown', { concurrency: false }, async (t) => {
  const f = await fixture(t, { commandStep() { throw new Error('check unavailable'); } });
  const outcome = await f.run();
  assert.equal(outcome.verification.status, 'unknown');
  assert.equal(outcome.status, 'interrupted');
  assert.match(outcome.verification.checks[0].result.stderr, /check unavailable/);
  assert.equal(f.events(outcome.runId).filter((entry) => entry.type === 'run.check').length, 1);
});

test('signalled nonzero acceptance remains unknown even without a timeout', { concurrency: false }, async (t) => {
  const f = await fixture(t, { commandStep({ cwd }) { return result(cwd, { exitCode: 1, signal: 'SIGTERM' }); } });
  const outcome = await f.run();
  assert.equal(outcome.verification.checks[0].status, 'unknown');
  assert.equal(outcome.status, 'interrupted');
});

test('planner interruption persists diagnostics and is never completed', { concurrency: false }, async (t) => {
  const f = await fixture(t, { modelStep(input) { return result(input.cwd, { stdout: plan, timedOut: true, signal: 'SIGTERM', exitCode: null }); } });
  const outcome = await f.run();
  assert.equal(outcome.status, 'interrupted');
  assert.equal(f.commandCalls.length, 0);
  assert.equal(f.events(outcome.runId).find((event) => event.type === 'run.planner.result').payload.timedOut, true);
});

test('acceptance mutation invalidates even an exit-zero check', { concurrency: false }, async (t) => {
  const f = await fixture(t, { async commandStep({ cwd }) {
    await writeFile(join(cwd, 'value.txt'), 'changed while checking\n');
    return result(cwd);
  } });
  const outcome = await f.run();
  assert.equal(outcome.verification.status, 'unknown');
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.verification.checks[0].status, 'unknown');
  assert.notEqual(outcome.diffHash, outcome.verification.diffHash);
});

test('mutation after verification cannot be delivered as verified success', { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const append = f.store.appendEvent.bind(f.store);
  f.store.appendEvent = (...args) => {
    const id = append(...args);
    if (args[1] === 'run.verification') writeFileSync(join(f.commandCalls[0].cwd, 'value.txt'), 'late mutation\n');
    return id;
  };
  const outcome = await f.run();
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.verification.status, 'unknown');
  assert.notEqual(outcome.diffHash, outcome.verification.diffHash);
  assert.equal(f.events(outcome.runId).find((entry) => entry.type === 'run.outcome').payload.finalMatchesVerification, false);
});

test('final HEAD change invalidates an otherwise successful verification', { concurrency: false }, async (t) => {
  const f = await fixture(t);
  const append = f.store.appendEvent.bind(f.store);
  f.store.appendEvent = (...args) => {
    const id = append(...args);
    if (args[1] === 'run.verification') git(f.commandCalls[0].cwd, 'commit', '--allow-empty', '--quiet', '-m', 'unexpected head change');
    return id;
  };
  const outcome = await f.run();
  assert.equal(outcome.status, 'interrupted');
  assert.equal(outcome.verification.status, 'unknown');
  assert.equal(f.events(outcome.runId).find((entry) => entry.type === 'run.outcome').payload.finalBaseVerified, false);
});

test('repeated failure permits only one corrective execution', { concurrency: false }, async (t) => {
  const f = await fixture(t, {
    modelStep(input) { return result(input.cwd, { stdout: input.purpose === 'plan' ? plan : input.purpose === 'critic' ? repair : 'done' }); },
    commandStep({ cwd }) { return result(cwd, { exitCode: 1 }); },
  });
  const outcome = await f.run();
  assert.equal(outcome.status, 'failed');
  assert.equal(f.modelCalls.filter((input) => input.purpose === 'execute').length, 2);
  assert.equal(f.modelCalls.filter((input) => input.purpose === 'critic').length, 1);
  assert.equal(f.commandCalls.length, 2);
});

test('fixed checks passing do not hide executor failure', { concurrency: false }, async (t) => {
  const f = await fixture(t, { modelStep(input) {
    return result(input.cwd, { stdout: input.purpose === 'plan' ? plan : input.purpose === 'critic' ? stop : 'partial output', exitCode: input.purpose === 'execute' ? 4 : 0 });
  } });
  const outcome = await f.run();
  assert.equal(outcome.verification.status, 'pass');
  assert.equal(outcome.status, 'failed');
});

test('critic requests for changed acceptance stop for user input', { concurrency: false }, async (t) => {
  const needsInput = JSON.stringify({ action: 'needs_input', analysis: 'Requires a changed task contract.', repairInstructions: '', question: 'May the acceptance criteria change?' });
  const f = await fixture(t, {
    modelStep(input) { return result(input.cwd, { stdout: input.purpose === 'plan' ? plan : input.purpose === 'critic' ? needsInput : 'done' }); },
    commandStep({ cwd }) { return result(cwd, { exitCode: 1 }); },
  });
  const outcome = await f.run();
  assert.equal(outcome.status, 'needs_input');
  assert.equal(f.modelCalls.filter((input) => input.purpose === 'execute').length, 1);
  assert.match(outcome.detail, /acceptance criteria/);
});
