import { pathToFileURL } from 'node:url';
import { appendFileSync, writeFileSync } from 'node:fs';

const registered = [];
globalThis.__praxisRegisterTest = (name, options, callback) => {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  if (typeof callback !== 'function') throw new TypeError(`Test ${name} has no callback.`);
  registered.push({ name: String(name), options: options ?? {}, callback });
};

export async function runTestFiles(files) {
  const output = [];
  const emit = (line) => output.push(`${line}\n`);
  const results = [];
  try {
    for (const file of files) await import(pathToFileURL(file).href);
  } catch (error) {
    emit(`not ok 1 - test module loading`);
    emit(`  ---`);
    emit(`  error: ${JSON.stringify(error?.stack || String(error))}`);
    emit(`  ...`);
    return { output: output.join(''), passed: 0, failed: 1, skipped: 0, tests: 1 };
  }

  emit('TAP version 13');
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const progressPath = process.env.PRAXIS_LOOP_EVIDENCE_DIR
    ? `${process.env.PRAXIS_LOOP_EVIDENCE_DIR}\\mechanism-progress.log`
    : null;
  if (progressPath) writeFileSync(progressPath, '', { flag: 'w' });
  const progress = (value) => {
    if (progressPath) appendFileSync(progressPath, `${new Date().toISOString()} ${value}\n`);
  };
  globalThis.__praxisProgress = progress;
  for (const [index, entry] of registered.entries()) {
    if (entry.options.skip) {
      skipped++;
      progress(`SKIP ${index + 1}/${registered.length} ${entry.name}`);
      emit(`ok ${index + 1} - ${entry.name} # SKIP ${typeof entry.options.skip === 'string' ? entry.options.skip : ''}`.trimEnd());
      results.push({ name: entry.name, status: 'skipped' });
      continue;
    }
    const cleanups = [];
    const context = {
      after(callback) {
        if (typeof callback !== 'function') throw new TypeError('t.after requires a function.');
        cleanups.push(callback);
      },
    };
    let failure = null;
    const started = performance.now();
    progress(`START ${index + 1}/${registered.length} ${entry.name}`);
    try { await entry.callback(context); }
    catch (error) { failure = error; }
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); }
      catch (error) { failure ??= error; }
    }
    const durationMs = Math.round(performance.now() - started);
    if (failure) {
      failed++;
      emit(`not ok ${index + 1} - ${entry.name}`);
      emit('  ---');
      emit(`  duration_ms: ${durationMs}`);
      emit(`  error: ${JSON.stringify(failure?.stack || String(failure))}`);
      emit('  ...');
      results.push({ name: entry.name, status: 'failed', durationMs, error: failure?.message || String(failure) });
    } else {
      passed++;
      emit(`ok ${index + 1} - ${entry.name}`);
      results.push({ name: entry.name, status: 'passed', durationMs });
    }
    progress(`${failure ? 'FAIL' : 'PASS'} ${index + 1}/${registered.length} ${entry.name} ${durationMs}ms`);
  }
  emit(`1..${registered.length}`);
  emit(`# tests ${registered.length}`);
  emit(`# pass ${passed}`);
  emit(`# fail ${failed}`);
  emit(`# skipped ${skipped}`);
  return { output: output.join(''), passed, failed, skipped, tests: registered.length, results };
}
