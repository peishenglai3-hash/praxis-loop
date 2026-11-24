import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertSandbox } from './sandbox-guard.mjs';

assertSandbox();
const { PraxisStore } = await import('../dist/store.js');
const { SEARCH_TERMS_VERSION } = await import('../dist/memory-index.js');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'praxis-store-'));
  const database = join(directory, 'events.sqlite');
  let store = new PraxisStore(database);
  t.after(() => {
    try { store.close(); } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return {
    get store() { return store; },
    reopen() { store.close(); store = new PraxisStore(database); return store; },
  };
}

function memory(id, overrides = {}) {
  return {
    id, repositoryId: 'repo-a', kind: 'decision', body: `retryBuffer 反思 ${id}`,
    sourceEventIds: [], applicableRepositoryIds: ['repo-a'],
    createdAt: '2026-11-20T00:00:00.000Z', ...overrides,
  };
}

function ledger(store) { return store.db.prepare('SELECT * FROM events ORDER BY seq').all(); }
function statuses(store) {
  return Object.fromEntries(store.allMemories('repo-a', true).map((item) => [item.id, item.status]));
}
function activeIds(store) { return store.searchMemories('retryBuffer', 'repo-a').map((item) => item.memory.id).sort(); }

test('approved candidate survives full projection recreation, repetition and reopen', (t) => {
  const f = fixture(t);
  f.store.recordMemory(memory('approved', { kind: 'reflection', status: 'candidate' }));
  assert.deepEqual(activeIds(f.store), []);
  f.store.approveMemory('approved');
  const before = ledger(f.store);
  for (let attempt = 0; attempt < 3; attempt++) {
    f.store.rebuildMemoryProjectionFromEvents();
    assert.deepEqual(statuses(f.store), { approved: 'active' });
    assert.deepEqual(activeIds(f.store), ['approved']);
    assert.deepEqual(ledger(f.store), before);
    assert.equal(f.store.db.prepare("SELECT value FROM store_meta WHERE key = 'search_terms_version'").get().value, SEARCH_TERMS_VERSION);
    f.reopen();
    assert.deepEqual(statuses(f.store), { approved: 'active' });
    assert.deepEqual(activeIds(f.store), ['approved']);
  }
});

test('approval replay is idempotent and cannot reactivate revoked memories', (t) => {
  const f = fixture(t);
  f.store.recordMemory(memory('approved', { status: 'candidate' }));
  f.store.approveMemory('approved');
  f.store.appendEvent('repo-a', 'memory.approved', { memoryId: 'approved' });
  f.reopen();
  assert.deepEqual(activeIds(f.store), ['approved']);
  if (f.store.ftsAvailable) {
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memory_id = 'approved'").get().n, 1);
  }
  f.store.revokeMemory('approved');
  f.store.appendEvent('repo-a', 'memory.approved', { memoryId: 'approved' });
  f.reopen();
  f.store.rebuildMemoryProjectionFromEvents();
  assert.deepEqual(statuses(f.store), { approved: 'revoked' });
  assert.deepEqual(activeIds(f.store), []);
});

test('revocation propagates through active and candidate descendants after rebuild and reopen', (t) => {
  const f = fixture(t);
  const parentEvent = f.store.recordMemory(memory('parent'));
  const childEvent = f.store.recordMemory(memory('child', { sourceEventIds: [parentEvent] }));
  f.store.recordMemory(memory('grandchild', { kind: 'reflection', status: 'candidate', sourceEventIds: [childEvent] }));
  f.store.revokeMemory('parent');
  const before = ledger(f.store);
  const expected = { parent: 'revoked', child: 'revoked', grandchild: 'revoked' };
  assert.deepEqual(statuses(f.store), expected);
  assert.throws(() => f.store.approveMemory('grandchild'), /No candidate memory/);
  for (let attempt = 0; attempt < 2; attempt++) {
    f.store.rebuildMemoryProjectionFromEvents();
    f.reopen();
    assert.deepEqual(statuses(f.store), expected);
    assert.deepEqual(activeIds(f.store), []);
    assert.deepEqual(ledger(f.store), before);
  }
});

test('new memories cannot reuse revoked or superseded memory sources', (t) => {
  const f = fixture(t);
  const revokedEvent = f.store.recordMemory(memory('revoked-parent'));
  f.store.revokeMemory('revoked-parent');
  const oldEvent = f.store.recordMemory(memory('superseded-parent'));
  f.store.reviseMemory('superseded-parent', memory('replacement'));
  const before = ledger(f.store);
  for (const source of [revokedEvent, oldEvent]) {
    assert.throws(() => f.store.recordMemory(memory(`late-${source}`, { sourceEventIds: [source] })), /revoked or superseded/);
  }
  assert.deepEqual(ledger(f.store), before);
  assert.deepEqual(activeIds(f.store), ['replacement']);
});

test('legacy late-derived events remain revoked when projections are reconstructed', (t) => {
  const f = fixture(t);
  const source = f.store.recordMemory(memory('parent'));
  f.store.revokeMemory('parent');
  // Reproduce a ledger written by the earlier API, which checked existence only.
  f.store.appendEvent('repo-a', 'memory.created', memory('late', { sourceEventIds: [source] }));
  const before = ledger(f.store);
  f.reopen();
  assert.deepEqual(statuses(f.store), { parent: 'revoked', late: 'revoked' });
  f.store.rebuildMemoryProjectionFromEvents();
  assert.deepEqual(statuses(f.store), { parent: 'revoked', late: 'revoked' });
  assert.deepEqual(activeIds(f.store), []);
  assert.deepEqual(ledger(f.store), before);
});

test('revision rejects foreign scopes and a dependency on its superseded source atomically', (t) => {
  const f = fixture(t);
  const source = f.store.recordMemory(memory('original'));
  const before = ledger(f.store);
  assert.throws(() => f.store.reviseMemory('original', memory('foreign', { applicableRepositoryIds: ['repo-a', 'repo-b'] })), /scope is limited/);
  assert.throws(() => f.store.reviseMemory('original', memory('circular', { sourceEventIds: [source] })), /cannot depend/);
  assert.deepEqual(ledger(f.store), before);
  assert.deepEqual(statuses(f.store), { original: 'active' });
});

test('valid revision preserves its replacement but invalidates old descendants during replay', (t) => {
  const f = fixture(t);
  const evidence = f.store.appendEvent('repo-a', 'verification.result', { status: 'pass' });
  const oldEvent = f.store.recordMemory(memory('original', { sourceEventIds: [evidence] }));
  f.store.recordMemory(memory('derived', { sourceEventIds: [oldEvent] }));
  f.store.reviseMemory('original', memory('replacement', { sourceEventIds: [evidence] }));
  const expected = { original: 'superseded', derived: 'revoked', replacement: 'active' };
  assert.deepEqual(statuses(f.store), expected);
  f.store.rebuildMemoryProjectionFromEvents();
  f.reopen();
  assert.deepEqual(statuses(f.store), expected);
  assert.deepEqual(activeIds(f.store), ['replacement']);
  assert.equal(f.store.allMemories('repo-a').at(0).revisedFrom, 'original');
});

test('failed reconstruction rolls back dropped projections without changing events or runs', (t) => {
  const f = fixture(t);
  f.store.createRun({
    id: 'run-a', repositoryId: 'repo-a', baseCommit: 'base', prompt: 'test', acceptance: [],
    createdAt: '2026-11-20T00:00:00.000Z', maxSteps: 1, correctionCycles: 0, deadlineMs: 1000,
  }, '/tmp/praxis-test-worktree');
  f.store.recordMemory(memory('kept'));
  const beforeRuns = f.store.getRun('run-a');
  const beforeCursor = f.store.db.prepare("SELECT last_seq FROM projection_state WHERE name = 'memories'").get();
  // Malformed historical payload forces replay to fail after transactional DROP/CREATE.
  f.store.appendEvent('repo-a', 'memory.created', { id: 'malformed' });
  const beforeEvents = ledger(f.store);
  assert.throws(() => f.store.rebuildMemoryProjectionFromEvents());
  assert.deepEqual(statuses(f.store), { kept: 'active' });
  assert.deepEqual(activeIds(f.store), ['kept']);
  assert.deepEqual(ledger(f.store), beforeEvents);
  assert.deepEqual(f.store.getRun('run-a'), beforeRuns);
  assert.deepEqual(f.store.db.prepare("SELECT last_seq FROM projection_state WHERE name = 'memories'").get(), beforeCursor);
});
