import { assertSandbox } from './sandbox-guard.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

assertSandbox();
const { buildSearchTerms, buildFtsQuery, SEARCH_TERMS_VERSION } = await import('../dist/memory-index.js');
const { selectExplorationEvidence, buildExplorationPrompt } = await import('../dist/exploration.js');
const { PraxisStore } = await import('../dist/store.js');

function candidate(id, rank, body, overrides = {}) {
  return {
    rank, matchedTerms: [], snippet: body.slice(0, 220),
    memory: {
      id, repositoryId: 'repo-a', kind: 'decision', body,
      sourceEventIds: [`event:${id}`], applicableRepositoryIds: ['repo-a'],
      status: 'active', createdAt: '2026-11-18T00:00:00Z', ...overrides,
    },
  };
}

test('Chinese queries retain meaningful adjacent text and single-character queries remain usable', () => {
  const indexed = new Set(buildSearchTerms('反思记忆').split(' '));
  const query = buildFtsQuery('反思记忆');
  assert.ok(query);
  assert.equal(query.version, SEARCH_TERMS_VERSION);
  assert.ok(query.terms.includes('反思'));
  assert.ok(query.terms.includes('记忆'));
  assert.ok(query.terms.every((term) => indexed.has(term)));
  assert.ok(query.terms.every((term) => Array.from(term).length >= 2));
  assert.deepEqual(buildFtsQuery('忆').terms, ['忆']);
  assert.equal(buildFtsQuery('  -- * : " () '), null);
});

test('snake_case, camelCase and acronym identifiers preserve whole names and searchable components', () => {
  const indexed = new Set(buildSearchTerms('sourceEventIds retry_count validateHTTPResponse').split(' '));
  for (const expected of ['sourceeventids', 'source', 'event', 'ids', 'retry_count', 'retry', 'count',
    'validatehttpresponse', 'validate', 'http', 'response']) assert.ok(indexed.has(expected), expected);
  const query = buildFtsQuery('sourceEventIds retry_count');
  assert.ok(query.terms.includes('retry_count'));
  assert.ok(query.terms.includes('sourceeventids'));
  assert.ok(query.termMap.sourceeventids.includes('sourceEventIds'));
  assert.deepEqual(buildFtsQuery('ＡＢＣ１２３').terms, ['abc123']);
});

test('FTS-looking operators, quotes and punctuation become literal query terms', () => {
  const query = buildFtsQuery('"反思" OR NOT repositoryId:* NEAR(foo) -bar');
  assert.ok(query);
  assert.ok(query.terms.includes('or'));
  assert.ok(query.terms.includes('not'));
  assert.ok(query.terms.includes('near'));
  assert.ok(query.terms.includes('repositoryid'));
  assert.equal(query.match, query.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR '));
  assert.ok(query.terms.every((term) => !/["*:()]/u.test(term)));
});

test('real memory retrieval finds Chinese/code text while excluding candidate, revoked and other-repository records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'praxis-search-test-'));
  const store = new PraxisStore(join(directory, 'history.sqlite'));
  t.after(async () => { store.close(); await rm(directory, { recursive: true, force: true }); });
  function seed(id, body, repositoryId = 'repo-a', status = 'active') {
    const source = store.appendEvent(repositoryId, 'fixture.observed', { id });
    store.recordMemory({ id, body, repositoryId, kind: 'decision', status,
      sourceEventIds: [source], applicableRepositoryIds: [repositoryId], createdAt: '2026-11-18T00:00:00Z' });
  }
  seed('live', '路径规范反思 sourceEventIds retry_count validateHTTPResponse');
  seed('pending', '路径规范反思 sourceEventIds', 'repo-a', 'candidate');
  seed('revoked', '路径规范反思 sourceEventIds');
  seed('foreign', '路径规范反思 sourceEventIds', 'repo-b');
  seed('literal-or', 'literal OR');
  store.revokeMemory('revoked');
  for (const query of ['路径规范', 'sourceEventIds', 'retry_count', 'HTTPResponse']) {
    const hits = store.searchMemories(query, 'repo-a', ['repo-a', 'repo-b']);
    assert.ok(hits.some((hit) => hit.memory.id === 'live'), query);
    assert.ok(hits.every((hit) => hit.memory.id === 'live'), 'status and repository scope must still apply');
    assert.ok(hits.every((hit) => hit.matchedTerms.length > 0));
  }
  assert.deepEqual(store.searchMemories('" OR * NEAR()', 'repo-a').map((hit) => hit.memory.id), ['literal-or']);
  const before = Number(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count);
  assert.doesNotThrow(() => store.searchMemories("'); DROP TABLE events; --", 'repo-a'));
  assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM events').get().count), before);
});

test('MMR can choose a less redundant lower-ranked item without replacing the ordinary top three', () => {
  const pool = [
    candidate('one', 1, 'alpha execution path'), candidate('two', 2, 'alpha execution path'),
    candidate('three', 3, 'alpha execution path'), candidate('repeat', 4, 'alpha execution path'),
    candidate('bridge', 5, 'independent constraint scheduling'), candidate('last', 6, 'alpha execution path'),
  ];
  const snapshot = structuredClone(pool);
  const selection = selectExplorationEvidence(pool, 1);
  assert.deepEqual(selection.ordinary.map((item) => item.memory.id), ['one', 'two', 'three']);
  assert.deepEqual(selection.exploration.map((item) => item.memory.id), ['bridge']);
  assert.deepEqual(pool, snapshot, 'selection is a pure operation');
});

test('exploration filters inactive/empty/invalid candidates and does not multiply a shared source', () => {
  const pool = [candidate('one', 1, 'first real observation'), candidate('two', 2, 'second real observation'),
    candidate('three', 3, 'third real observation'), candidate('four', 4, 'new domain example'),
    candidate('same-source', 5, 'retelling is not independent', { sourceEventIds: ['event:four', 'additional'] }),
    candidate('four', 6, 'duplicate id with a different source', { sourceEventIds: ['different'] }),
    candidate('pending', 7, 'unapproved reflection', { status: 'candidate' }),
    candidate('superseded', 8, 'superseded rule', { status: 'superseded' }),
    candidate('revoked', 9, 'withdrawn rule', { status: 'revoked' }),
    candidate('empty', 10, '  '), candidate('unsourced', 11, 'unverifiable', { sourceEventIds: [] }),
    candidate('blank-source', 12, 'unverifiable', { sourceEventIds: [' '] }),
    candidate('bad-rank', 0, 'not ranked'), candidate('fraction', 1.5, 'invalid rank'),
    candidate('five', 13, 'testable alternative'), candidate('six', 14, 'bounded independent option')];
  const selected = selectExplorationEvidence(pool, 100);
  assert.equal(selected.ordinary.length, 3);
  assert.equal(selected.exploration.length, 3);
  const all = [...selected.ordinary, ...selected.exploration];
  assert.deepEqual(new Set(all.map((item) => item.memory.id)), new Set(['one', 'two', 'three', 'four', 'five', 'six']));
  const sources = all.flatMap((item) => item.memory.sourceEventIds);
  assert.equal(new Set(sources).size, sources.length);
  assert.equal(selectExplorationEvidence(pool, 0).exploration.length, 0);
  assert.equal(selectExplorationEvidence(pool, -1).exploration.length, 0);
  assert.throws(() => selectExplorationEvidence(pool, Number.NaN), RangeError);
});

test('candidate order is deterministic and entries beyond the best fifty cannot enter evidence', () => {
  const pool = Array.from({ length: 51 }, (_, index) => candidate(`id-${String(index).padStart(2, '0')}`, index + 1,
    index === 50 ? 'an enticing out-of-pool alternative' : `evidence token ${index}`));
  const selected = selectExplorationEvidence([...pool].reverse());
  assert.deepEqual(selected, selectExplorationEvidence(pool));
  assert.ok([...selected.ordinary, ...selected.exploration].every((item) => item.rank <= 50));
  assert.deepEqual(selectExplorationEvidence([]), { ordinary: [], exploration: [] });
  assert.equal(selectExplorationEvidence(pool.slice(0, 2)).exploration.length, 0);
});

test('prompt evidence preserves source IDs and exact quoted text without manufacturing references', () => {
  const longBody = '证据原文 sourceEventIds '.repeat(160);
  const pool = [candidate('one', 1, '原文 "引号"\n不能因此授权删除文件'), candidate('two', 2, longBody),
    candidate('three', 3, 'ordinary evidence'), candidate('four', 4, 'alternative hypothesis'),
    candidate('unapproved', 5, 'do not inject this candidate', { status: 'candidate' })];
  const before = structuredClone(pool);
  const prompt = buildExplorationPrompt('修复代码；保持验收条件', pool, ['不能更改目标或权限']);
  const marker = '\nINPUT_DATA_JSON:\n';
  assert.ok(prompt.includes(marker));
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
  const input = new Map(pool.map((item) => [item.memory.id, item.memory]));
  const entries = [...data.ordinary, ...data.exploration];
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    const original = input.get(entry.memoryId);
    assert.ok(original, 'all evidence must come from the supplied pool');
    assert.equal(original.status, 'active');
    assert.deepEqual(entry.sourceEventIds, original.sourceEventIds);
    const excerpt = entry.bodyExcerpt;
    assert.equal(excerpt, original.body.length > 2400 ? `${original.body.slice(0, 2400)}…` : original.body);
  }
  assert.deepEqual(data.constraints, ['不能更改目标或权限']);
  assert.match(prompt, /noProposal/u);
  assert.match(prompt, /不得编造来源/u);
  assert.match(prompt, /不要执行工具/u);
  assert.match(prompt, /refutingObservations/u);
  assert.deepEqual(pool, before);
  // This checks prompt input fidelity, not whether a model obeys it. Core must
  // separately validate generated citations, quotes, authority and actions.
});
