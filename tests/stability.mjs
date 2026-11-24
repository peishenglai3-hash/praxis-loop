import { assertSandbox } from './sandbox-guard.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay, setImmediate as yieldEventLoop } from 'node:timers/promises';

const sandbox = assertSandbox();
// Deliberately dynamic: no runtime module is loaded before VM admission succeeds.
const { PraxisStore } = await import('../dist/store.js');
const { buildFtsQuery, buildSearchTerms } = await import('../dist/memory-index.js');
const { selectExplorationEvidence } = await import('../dist/exploration.js');
const { ShellCommandAdapter } = await import('../dist/adapters.js');

function options(argv) {
  const result = { cycles: 1_000, durationHours: 0, intervalMs: 1_000, output: null,
    resourceLimits: { rssBytes: 1024 * 1024 * 1024, databaseTotalBytes: 512 * 1024 * 1024,
      ...(process.platform === 'win32' ? {} : { openHandleCount: 128, ownLiveDescendantCount: 0 }) } };
  const limitOptions = { '--max-rss-mib': ['rssBytes', 1024 * 1024], '--max-open-handles': ['openHandleCount', 1],
    '--max-live-descendants': ['ownLiveDescendantCount', 1], '--max-db-mib': ['databaseTotalBytes', 1024 * 1024] };
  for (let index = 0; index < argv.length; index++) {
    const [flag, inline] = argv[index].split('=', 2);
    if (!['--cycles', '--duration-hours', '--interval-ms', '--output', ...Object.keys(limitOptions)].includes(flag)) {
      throw new Error(`Unknown stability option: ${flag}`);
    }
    const value = inline ?? argv[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--output') result.output = resolve(value);
    else if (flag === '--cycles') result.cycles = Number(value);
    else if (flag === '--duration-hours') result.durationHours = Number(value);
    else if (flag in limitOptions) {
      const [name, multiplier] = limitOptions[flag];
      result.resourceLimits[name] = Number(value) * multiplier;
    }
    else result.intervalMs = Number(value);
  }
  if (!Number.isSafeInteger(result.cycles) || result.cycles < 1) throw new Error('--cycles must be a positive integer');
  if (!Number.isFinite(result.durationHours) || result.durationHours < 0 || result.durationHours > 24) {
    throw new Error('--duration-hours must be between 0 and 24');
  }
  if (!Number.isSafeInteger(result.intervalMs) || result.intervalMs < 1_000) {
    throw new Error('--interval-ms must be an integer >= 1000 for low-load duration runs');
  }
  for (const [name, value] of Object.entries(result.resourceLimits)) {
    if (!Number.isSafeInteger(value) || value < (name === 'ownLiveDescendantCount' ? 0 : 1)) {
      throw new Error(`Resource limit ${name} must be a finite safe integer ${name === 'ownLiveDescendantCount' ? '>= 0' : '> 0'}`);
    }
  }
  return result;
}

class Latency {
  // Percentiles describe a bounded trailing window, not all observations in a long run.
  values = [];
  count = 0;
  sum = 0;
  minimum = Number.POSITIVE_INFINITY;
  maximum = 0;
  add(milliseconds) {
    const slot = this.count % 10_000;
    if (this.values.length < 10_000) this.values.push(milliseconds);
    else this.values[slot] = milliseconds;
    this.count++;
    this.sum += milliseconds;
    this.minimum = Math.min(this.minimum, milliseconds);
    this.maximum = Math.max(this.maximum, milliseconds);
  }
  summary() {
    const sorted = [...this.values].sort((left, right) => left - right);
    const percentile = (fraction) => sorted.length === 0 ? null
      : sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
    return { unit: 'ms', count: this.count, sampleCount: sorted.length,
      percentileScope: 'last at most 10000 observations; nearest rank',
      meanAll: this.count === 0 ? null : this.sum / this.count,
      minAll: this.count === 0 ? null : this.minimum, maxAll: this.count === 0 ? null : this.maximum,
      p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) };
  }
}

async function processCounts() {
  if (process.platform === 'win32') {
    return { openHandleCount: null, visibleProcessCount: null, ownLiveDescendantCount: null,
      unreadableProcessEntries: 0, externalResourceMonitor: 'host Job Object monitor' };
  }
  let openHandleCount = null;
  let visibleProcessCount = null;
  let ownLiveDescendantCount = null;
  let unreadableProcessEntries = 0;
  try { openHandleCount = (await readdir('/proc/self/fd')).length; } catch { /* Explicitly unavailable in report. */ }
  try {
    const ids = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
    visibleProcessCount = ids.length;
    const descendantsByParent = new Map();
    for (const id of ids) {
      try {
        const value = await readFile(`/proc/${id}/stat`, 'utf8');
        const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/u);
        if (fields[0] === 'Z' || fields[0] === 'X') continue;
        const parent = Number(fields[1]);
        const children = descendantsByParent.get(parent) ?? [];
        children.push(Number(id));
        descendantsByParent.set(parent, children);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ESRCH') unreadableProcessEntries++;
      }
    }
    const visited = new Set([process.pid]);
    const queue = [process.pid];
    while (queue.length > 0) {
      const parent = queue.pop();
      for (const child of descendantsByParent.get(parent) ?? []) {
        if (!visited.has(child)) { visited.add(child); queue.push(child); }
      }
    }
    ownLiveDescendantCount = visited.size - 1;
  } catch { /* Explicitly unavailable in report. */ }
  return { openHandleCount, visibleProcessCount, ownLiveDescendantCount, unreadableProcessEntries };
}

async function databaseBytes(path) {
  const result = {};
  for (const suffix of ['', '-wal', '-shm']) {
    try { result[suffix || 'main'] = (await stat(`${path}${suffix}`)).size; }
    catch (error) { if (error.code !== 'ENOENT') throw error; result[suffix || 'main'] = 0; }
  }
  return result;
}

function assertSqliteCheck(store, check) {
  const result = store.db.prepare('PRAGMA ' + check).all();
  assert.equal(result.length, 1, `SQLite ${check} must return one row`);
  assert.deepEqual(Object.keys(result[0]), [check], `SQLite ${check} must return the expected column`);
  assert.equal(result[0][check], 'ok', `SQLite ${check} must return ok`);
  return { check, rows: result.length, status: 'ok' };
}

const config = options(process.argv.slice(2));
const commandLifecycleEnabled = !(process.platform === 'win32' && process.env.PRAXIS_LOOP_APPCONTAINER_VERIFIED === '1');
const startedAt = new Date().toISOString();
const started = performance.now();
const directory = await mkdtemp(join(tmpdir(), 'praxis-stability-'));
const databasePath = join(directory, 'history.sqlite');
const repositoryId = 'stability-fixture-repository';
const controller = new AbortController();
let stopRequested = null;
const onInterrupt = () => { stopRequested = 'SIGINT'; controller.abort(); };
const onTerminate = () => { stopRequested = 'SIGTERM'; controller.abort(); };
process.on('SIGINT', onInterrupt);
process.on('SIGTERM', onTerminate);
const resources = [];
const resourceLimitViolations = [];
const scales = [];
const cycleLatency = new Latency();
const searchLatency = new Latency();
const commandLatency = new Latency();
const reopenLatency = new Latency();
let store;
let completedCycles = 0;
let commandCycles = 0;
let reopenedStores = 0;
let failure = null;
let finalCounts = null;
let finalDatabaseBytes = null;
let ftsAvailable = null;
const sqliteIntegrity = [];
let lastResourceSample = started;
let cyclePhaseStartedAt = null;
let cyclePhaseStarted;

async function sample(label, enforce = true) {
  const memory = process.memoryUsage();
  const sizes = await databaseBytes(databasePath);
  const snapshot = { label, elapsedMs: Math.round(performance.now() - started), cycle: completedCycles,
    rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external,
    databaseTotalBytes: Object.values(sizes).reduce((total, bytes) => total + bytes, 0), ...await processCounts() };
  resources.push(snapshot);
  // Preserve the baseline plus a bounded trailing resource history.
  if (resources.length > 2_048) resources.splice(1, resources.length - 2_048);
  lastResourceSample = performance.now();
  const violations = [];
  for (const [metric, limit] of Object.entries(config.resourceLimits)) {
    const actual = snapshot[metric];
    if (actual === null || actual === undefined || !Number.isFinite(actual)) {
      violations.push({ metric, limit, actual: actual ?? null, reason: 'required measurement unavailable' });
    } else if (actual > limit) violations.push({ metric, limit, actual, reason: 'resource limit exceeded' });
  }
  if (violations.length > 0) {
    resourceLimitViolations.push({ label, cycle: completedCycles, elapsedMs: snapshot.elapsedMs, violations });
    const message = `Resource check failed: ${violations.map((entry) => `${entry.metric}=${entry.actual}, limit=${entry.limit}`).join('; ')}`;
    failure ??= { name: 'ResourceLimitError', message };
    process.exitCode = 1;
    if (enforce) throw Object.assign(new Error(message), { name: 'ResourceLimitError' });
  }
}

try {
  await sample('before-store');
  store = new PraxisStore(databasePath);
  ftsAvailable = store.ftsAvailable;
  let seeded = 0;
  for (const size of [100, 1_000, 10_000]) {
    const writes = new Latency();
    const searches = new Latency();
    const stageStarted = performance.now();
    for (; seeded < size && !stopRequested; seeded++) {
      const writeStarted = performance.now();
      const id = `fixture-${String(seeded).padStart(5, '0')}`;
      const source = store.appendEvent(repositoryId, 'fixture.observation', { index: seeded });
      store.recordDecision({ id, repositoryId,
        body: `反思规划 记忆回溯 sourceEventIds retry_count repairToken${seeded % 32} ${id}`,
        sourceEventIds: [source], applicableRepositoryIds: [repositoryId], createdAt: '2026-11-18T00:00:00Z' });
      writes.add(performance.now() - writeStarted);
      if (seeded % 100 === 0) {
        await sample('fixture-population');
        await yieldEventLoop();
      }
    }
    if (stopRequested) break;
    assert.equal(store.allMemories(repositoryId).length, size);
    for (let queryIndex = 0; queryIndex < 100; queryIndex++) {
      const query = queryIndex % 2 ? '反思规划' : `repairToken${queryIndex % 32}`;
      const queryStarted = performance.now();
      const hits = store.searchMemories(query, repositoryId);
      searches.add(performance.now() - queryStarted);
      assert.ok(hits.length > 0 && hits.length <= 50);
      const selected = selectExplorationEvidence(hits);
      assert.ok(selected.ordinary.length <= 3 && selected.exploration.length <= 3);
      if (queryIndex % 25 === 0) await yieldEventLoop();
    }
    scales.push({ memoryCount: size, additionalWrites: writes.count,
      stageElapsedMs: performance.now() - stageStarted, writeLatency: writes.summary(),
      searchLatency: searches.summary(), databaseBytes: await databaseBytes(databasePath) });
    await sample(`memory-count-${size}`);
  }

const durationMode = config.durationHours > 0;
  // Duration begins after fixture population: --duration-hours 24 observes a full
  // 24-hour low-load phase, unless interrupted or a correctness check fails.
  const cycleStarted = performance.now();
  cyclePhaseStarted = cycleStarted;
  cyclePhaseStartedAt = new Date().toISOString();
  const deadline = cycleStarted + config.durationHours * 3_600_000;
  const adapter = new ShellCommandAdapter(controller.signal);
  const queries = ['反思规划', 'sourceEventIds', 'repairToken7', '"记忆" OR NEAR(missing_term)'];
  while (!stopRequested && (durationMode ? performance.now() < deadline : completedCycles < config.cycles)) {
    const tick = performance.now();
    const query = queries[completedCycles % queries.length];
    const built = buildFtsQuery(query);
    assert.ok(built && built.terms.every((term) => term.length > 0));
    assert.ok(buildSearchTerms('反思 sourceEventIds').includes('sourceeventids'));
    const searchStarted = performance.now();
    const hits = store.searchMemories(query, repositoryId);
    searchLatency.add(performance.now() - searchStarted);
    assert.ok(hits.length > 0 && hits.length <= 50);
    const selected = selectExplorationEvidence(hits);
    const evidence = [...selected.ordinary, ...selected.exploration];
    const sourceIds = evidence.flatMap((entry) => entry.memory.sourceEventIds);
    assert.equal(new Set(sourceIds).size, sourceIds.length);
    assert.ok(evidence.every((entry) => entry.memory.status === 'active'));
    store.appendEvent(repositoryId, 'stability.cycle', { cycle: completedCycles, queryIndex: completedCycles % queries.length });

    // Default mode samples forty process lifecycles per 1000 cycles. In duration
    // mode this remains local, with only one tiny process every sixty cycles.
    const processCadence = durationMode ? 60 : 25;
    if (commandLifecycleEnabled && completedCycles % processCadence === 0) {
      const token = `cycle-${completedCycles}`;
      const processStarted = performance.now();
      const result = await adapter.execute({ executable: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', '--', token], timeoutMs: 5_000 }, directory, 5_000);
      commandLatency.add(performance.now() - processStarted);
      if (stopRequested) break;
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, token);
      assert.equal(result.timedOut, false);
      commandCycles++;
    }
    completedCycles++;
    if (completedCycles % (durationMode ? 1_000 : 100) === 0) {
      const reopenStarted = performance.now();
      store.close();
      store = undefined;
      store = new PraxisStore(databasePath);
      reopenedStores++;
      reopenLatency.add(performance.now() - reopenStarted);
      assert.ok(store.searchMemories('反思规划', repositoryId).length > 0);
      sqliteIntegrity.push(assertSqliteCheck(store, 'quick_check'));
    }
    cycleLatency.add(performance.now() - tick);
    if ((!durationMode && completedCycles % 100 === 0) || performance.now() - lastResourceSample >= 60_000) {
      await sample('cycles');
    }
    if (durationMode && completedCycles % 600 === 0) {
      process.stdout.write(JSON.stringify({ type: 'progress', completedCycles,
        elapsedMs: Math.round(performance.now() - started), latestResourceSample: resources.at(-1) }) + '\n');
    }
    if (durationMode) {
      const remaining = Math.max(0, Math.min(config.intervalMs - (performance.now() - tick), deadline - performance.now()));
      if (remaining > 0) {
        try { await delay(remaining, undefined, { signal: controller.signal }); }
        catch (error) { if (error.name !== 'AbortError') throw error; }
      } else await yieldEventLoop();
    } else await yieldEventLoop();
  }
  finalCounts = {
    events: Number(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count),
    memories: Number(store.db.prepare('SELECT COUNT(*) AS count FROM current_memories').get().count),
  };
  sqliteIntegrity.push(assertSqliteCheck(store, 'integrity_check'));
  finalDatabaseBytes = await databaseBytes(databasePath);
} catch (error) {
  failure = { name: error.name, message: error.message, stack: String(error.stack).slice(0, 8_192) };
  process.exitCode = 1;
} finally {
  try { store?.close(); }
  catch (error) { failure ??= { name: error.name, message: `Closing store: ${error.message}` }; process.exitCode = 1; }
  process.removeListener('SIGINT', onInterrupt);
  process.removeListener('SIGTERM', onTerminate);
  try { await sample('after-store-close', false); }
  catch (error) { failure ??= { name: error.name, message: `Final resource sample: ${error.message}` }; process.exitCode = 1; }
  await rm(directory, { recursive: true, force: true });
}

const rss = resources.map((entry) => entry.rssBytes);
const report = {
  schemaVersion: 1, status: failure ? 'failed' : stopRequested ? 'interrupted' : 'completed',
  startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
  environment: { node: process.version, platform: process.platform, arch: process.arch,
    sandboxProduct: sandbox.product, virtualizationEvidence: sandbox.virtualizationEvidence, ftsAvailable },
  configuration: { ...config, mode: config.durationHours > 0 ? 'low-load-duration' : 'deterministic-cycles',
    externalResourceMonitor: process.platform === 'win32' ? 'host Job Object monitor' : null,
    commandLifecycle: commandLifecycleEnabled ? 'sampled' : 'excluded: redirected child spawn unavailable in this AppContainer',
    memoryScales: [100, 1_000, 10_000], noModelCalls: true, cycleSchedule: 'fixed round-robin; event IDs/timestamps are not deterministic' },
  cyclePhaseStartedAt, cyclePhaseElapsedMs: cyclePhaseStarted === undefined ? 0 : Math.round(performance.now() - cyclePhaseStarted),
  completedCycles, commandCycles, reopenedStores, stopRequested, failure,
  resourceLimitViolations, resourceLimitStatus: resourceLimitViolations.length > 0 ? 'failed' : 'no-sampled-violation',
  sqliteIntegrity,
  finalCounts, finalDatabaseBytes, memoryScales: scales,
  latency: { cycle: cycleLatency.summary(), search: searchLatency.summary(),
    command: commandLatency.summary(), storeReopen: reopenLatency.summary() },
  resourceSummary: { sampleCount: resources.length, rssFirstBytes: rss[0] ?? null,
    rssLastBytes: rss.at(-1) ?? null, rssMaxBytes: rss.length ? Math.max(...rss) : null },
  resourceSamples: resources,
  interpretation: [
    'Measurements describe this isolated process and local fixture workload; they are not performance or leak-free guarantees.',
    'RSS includes allocator/SQLite/cache behavior; memory/database growth alone does not establish a leak.',
    'openHandleCount and descendant counts are sampled in-process on Linux; Windows handle and Job Object counts are recorded by the host supervisor.',
    'ownLiveDescendantCount is sampled and excludes the measurement helper; zero does not prove that no transient descendant existed between samples.',
    'Null resource counts mean unavailable. Resource samples are bounded; latency percentile windows are explicitly reported.',
    'Recorded resource limits fail fast at each resource sample; an unavailable required measurement fails the run. Between-sample peaks may be missed.',
    'A duration-mode run is not a completed one-hour experiment unless its recorded configuration, status and elapsed phase support that claim.',
  ],
};
const json = `${JSON.stringify(report, null, 2)}\n`;
if (config.output) {
  await mkdir(dirname(config.output), { recursive: true });
  await writeFile(config.output, json);
}
process.stdout.write(json);
