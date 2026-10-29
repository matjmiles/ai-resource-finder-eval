const { test } = require('node:test');
const assert = require('node:assert');
const g = require('./goldSet');

const logRow = (session, n, at, query, rank, result, extra = {}) => ({
  Session: session, 'Search #': n, 'Searched At (UTC)': at, Query: query, 'Detected Intent': 'None',
  'Unmatched Picks': '[]', Rank: String(rank), Result: result, Score: '90', Origin: 'LlmMatch',
  'Match Reason': 'r', Vendor: 'EBSCO ', ...extra,
});

test('cacheKey matches the Python prototype (sha1 of normalized query)', () => {
  // hashlib.sha1("sample topic alpha".encode()).hexdigest()[:16]
  assert.strictEqual(g.cacheKey('sample topic alpha'), '0bf53522cb83b763');
  assert.strictEqual(g.cacheKey('  Sample   Topic Alpha '), '0bf53522cb83b763');
});

test('loadSearches keeps the latest run of each query, strips names, counts runs', () => {
  const rows = [
    logRow('s1', '1', '2026-09-01 10:00:00', 'Topic Alpha', 2, 'PubMed '),
    logRow('s1', '1', '2026-09-01 10:00:00', 'Topic Alpha', 1, 'APA PsycInfo'),
    logRow('s2', '4', '2026-09-03 10:00:00', 'topic alpha ', 1, 'CINAHL '),
    logRow('s3', '1', '2026-09-02 10:00:00', 'topic beta', 1, ''), // no results
  ];
  const s = g.loadSearches(rows);
  assert.strictEqual(s.length, 2);
  assert.deepStrictEqual(s[0].results.map((r) => r.database), ['CINAHL']);
  assert.strictEqual(s[0].runs, 2);
  assert.strictEqual(s[0].results[0].vendor, 'EBSCO');
  assert.deepStrictEqual(s[1].results, []);
});

test('sample is reproducible for a seed and draws without replacement', () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const a = g.sample(items, 5, g.rng(7));
  assert.deepStrictEqual(a, g.sample(items, 5, g.rng(7)));
  assert.strictEqual(new Set(a).size, 5);
});

test('checkGold flags unknown names with a suggestion, duplicates, and hidden databases', () => {
  const dbs = [
    { database: 'CINAHL', az_status: 'shown' },
    { database: 'ERIC (Education Resources Information Center)', az_status: 'shown' },
    { database: 'Old DB', az_status: 'hidden' },
  ];
  const rows = [
    { query: 'a', ideal_databases: 'cinahl; ERIC; CINAHL ;CINAHL' },
    { query: 'b', ideal_databases: '' },
    { query: 'c', ideal_databases: 'Old DB' },
  ];
  const r = g.checkGold(rows, dbs);
  assert.strictEqual(r.filled, 2);
  assert.strictEqual(r.empty, 1);
  const kinds = r.problems.map((p) => [p.kind, p.name, p.suggestion]);
  assert.deepStrictEqual(kinds, [
    ['unknown', 'cinahl', 'CINAHL'],
    ['unknown', 'ERIC', 'ERIC (Education Resources Information Center)'],
    ['duplicate', 'CINAHL', undefined],
    ['hidden', 'Old DB', undefined],
  ]);
  assert.strictEqual(r.problems[0].row, 2);
});

test('goldNames reads ranked columns in rank order, skipping blanks', () => {
  const row = { query: 'q', ideal_10: 'J', ideal_2: 'B', ideal_1: 'A ', ideal_3: '' };
  assert.deepStrictEqual(g.goldNames(row), ['A', 'B', 'J']);
});

test('goldNames falls back to the older ideal_databases cell', () => {
  assert.deepStrictEqual(g.goldNames({ ideal_databases: 'A; B' }), ['A', 'B']);
});

test('checkGold reads ranked columns and flags a skipped rank', () => {
  const r = g.checkGold([{ query: 'q', ideal_1: '', ideal_2: 'CINAHL', ideal_3: '' }], [{ database: 'CINAHL', az_status: 'shown' }]);
  assert.strictEqual(r.filled, 1);
  assert.deepStrictEqual(r.problems.map((p) => [p.kind, p.name]), [['gap', 'ideal_1']]);
});

test('suggestName returns null when nothing is close', () => {
  assert.strictEqual(g.suggestName('Zebra Finch Archive', ['CINAHL', 'PubMed']), null);
});

test('parseResultsCell keeps parentheses that belong to the name', () => {
  const r = g.parseResultsCell('1. ERIC (Education Resources Information Center) (100)\n2. CINAHL (96)');
  assert.deepStrictEqual(r, [
    { rank: 1, database: 'ERIC (Education Resources Information Center)' },
    { rank: 2, database: 'CINAHL' },
  ]);
});

test('parseJevCell maps rank to probability', () => {
  assert.deepStrictEqual([...g.parseJevCell('1. 0.98\n2. 0.05')], [[1, 0.98], [2, 0.05]]);
});

test('scoreQuery computes hit, precision@3, recall and the first choice rank', () => {
  const s = g.scoreQuery(['A', 'X', 'B', 'C'], ['B', 'A', 'D']);
  assert.strictEqual(s.top1_in_gold, 1);
  assert.strictEqual(s.precision_at_3, 2 / 3);
  assert.strictEqual(s.gold_recall, 2 / 3);
  assert.strictEqual(s.first_gold_rank, 3);
  assert.deepStrictEqual(s.missing_gold, ['D']);
  assert.deepStrictEqual(s.not_in_gold, ['X', 'C']);
});

test('scoreQuery handles no results and a first choice that was never returned', () => {
  const s = g.scoreQuery([], ['A']);
  assert.deepStrictEqual([s.top1_in_gold, s.precision_at_3, s.gold_recall, s.first_gold_rank], [0, 0, 0, null]);
});

test('summarize averages per-query scores', () => {
  const sum = g.summarize([g.scoreQuery(['A'], ['A']), g.scoreQuery(['X'], ['A'])]);
  assert.strictEqual(sum.n, 2);
  assert.strictEqual(sum.top1_in_gold, 0.5);
  assert.strictEqual(sum.first_choice_in_top3, 0.5);
});

test('jevAgreement ignores unsettled answers', () => {
  const r = g.jevAgreement([
    { p: 0.9, inGold: true }, { p: 0.1, inGold: false }, { p: 0.9, inGold: false }, { p: 0.5, inGold: true },
  ], 0.7, 0.3);
  assert.strictEqual(r.settled, 3);
  assert.strictEqual(r.agreement, 2 / 3);
});
