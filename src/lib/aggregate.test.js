const { test } = require('node:test');
const assert = require('node:assert');
const { meanScores, rollupBy, toCsvRows, failureTagCounts } = require('./aggregate');

const sample = [
  {
    id: 'q1', discipline: 'health', difficulty: 'typical', type: 'realistic', stress_kind: null,
    status: 'ok', resultCount: 5,
    scores: { relevance: 3, coverage: 2, ranking: 3, robustness: 3, failure_tags: ['off-topic-results'], notes: 'good, one stray' },
  },
  {
    id: 'q2', discipline: 'health', difficulty: 'hard', type: 'realistic', stress_kind: null,
    status: 'ok', resultCount: 2,
    scores: { relevance: 1, coverage: 1, ranking: 2, robustness: 3, failure_tags: ['off-topic-results', 'missed-core-database'], notes: 'weak' },
  },
  {
    id: 'q3', discipline: 'stem', difficulty: 'easy', type: 'stress', stress_kind: 'vague',
    status: 'error', resultCount: 0, error: 'boom',
    // no scores -> must be ignored by math
  },
];

test('meanScores averages a dimension, ignoring records without scores', () => {
  assert.strictEqual(meanScores(sample, 'relevance'), 2); // (3+1)/2
  assert.strictEqual(meanScores(sample, 'robustness'), 3);
});

test('meanScores returns null when no scored records', () => {
  assert.strictEqual(meanScores([{ id: 'x' }], 'relevance'), null);
});

test('rollupBy groups by a field and averages the dimension', () => {
  const r = rollupBy(sample, 'discipline', 'coverage');
  assert.strictEqual(r.health, 1.5); // (2+1)/2
  assert.ok(!('stem' in r), 'unscored-only groups are omitted');
});

test('failureTagCounts tallies tags across scored records, sorted desc', () => {
  const counts = failureTagCounts(sample);
  assert.deepStrictEqual(counts[0], { tag: 'off-topic-results', count: 2 });
  assert.strictEqual(counts.find((c) => c.tag === 'missed-core-database').count, 1);
});

test('toCsvRows emits a header plus one row per record, escaping commas/quotes', () => {
  const rows = toCsvRows(sample);
  assert.strictEqual(rows.length, 4); // header + 3
  assert.ok(rows[0].startsWith('id,discipline,difficulty,type,stress_kind,status,resultCount,relevance,coverage,ranking,robustness,failure_tags,notes'));
  // q1 row has quoted notes and semicolon-joined tags
  assert.ok(rows[1].includes('q1,health,typical,realistic'));
  // a record without scores still emits a row with blank score cells
  const q3row = rows.find((r) => r.startsWith('q3,'));
  assert.ok(q3row.includes('q3,stem,easy,stress,vague,error,0,,,,,'));
});

test('toCsvRows escapes a value containing a comma by quoting it', () => {
  const rows = toCsvRows([
    { id: 'q9', discipline: 'x', difficulty: 'easy', type: 'realistic', stress_kind: null, status: 'ok', resultCount: 1,
      scores: { relevance: 3, coverage: 3, ranking: 3, robustness: 3, failure_tags: [], notes: 'a, b, c' } },
  ]);
  assert.ok(rows[1].includes('"a, b, c"'));
});
