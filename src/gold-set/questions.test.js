const { test } = require('node:test');
const assert = require('node:assert');
const { bucket, pHelpful, buildRequest } = require('./questions');

// A Score answer that puts probability p on "helpful" (levels 2-3).
const score = (p) => ({ probabilities: { 0: (1 - p) / 2, 1: (1 - p) / 2, 2: p / 2, 3: p / 2 } });
const answers = (meaningful, ...ps) => {
  const a = { meaningful: { noul: meaningful } };
  ps.forEach((p, i) => { a[`result_${i + 1}`] = score(p); });
  return a;
};
const ranks = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('pHelpful adds the two top levels', () => {
  assert.ok(Math.abs(pHelpful(score(0.8)) - 0.8) < 1e-9);
});

test('good: every top-3 result helpful; results past rank 3 are ignored', () => {
  assert.strictEqual(bucket(answers(0.9, 0.9, 0.8, 0.75, 0.0), ranks(4)).bucket, 'good');
});

test('poor: two of the top 3 unhelpful', () => {
  assert.strictEqual(bucket(answers(0.9, 0.9, 0.1, 0.2), ranks(3)).bucket, 'poor');
});

test('poor: a single unhelpful result', () => {
  assert.strictEqual(bucket(answers(0.9, 0.1), ranks(1)).bucket, 'poor');
});

test('poor: no results at all', () => {
  assert.strictEqual(bucket(answers(0.9), []).bucket, 'poor');
});

test('mixed: one unhelpful, or helpfulness unsettled', () => {
  assert.strictEqual(bucket(answers(0.9, 0.9, 0.9, 0.1), ranks(3)).bucket, 'mixed');
  assert.strictEqual(bucket(answers(0.9, 0.9, 0.5, 0.9), ranks(3)).bucket, 'mixed');
});

test('junk: query judged meaningless, whatever the results', () => {
  assert.strictEqual(bucket(answers(0.1, 0.9, 0.9, 0.9), ranks(3)).bucket, 'junk');
});

test('an unsettled meaningful answer is not junk', () => {
  assert.strictEqual(bucket(answers(0.5, 0.9, 0.9, 0.9), ranks(3)).bucket, 'good');
});

test('buildRequest sends only the query as state and one Score per result', () => {
  const req = buildRequest({ query: 'q', results: [{ rank: 1, database: 'ERIC', vendor: 'EBSCO', reason: 'x' }] });
  assert.deepStrictEqual(req.state, { query: 'q' });
  assert.deepStrictEqual(Object.keys(req.questions), ['meaningful', 'result_1']);
  assert.match(req.questions.result_1.instructions, /"ERIC" \(from EBSCO\)/);
});
