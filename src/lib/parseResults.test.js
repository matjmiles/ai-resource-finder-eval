const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseResultsFromHtml } = require('./parseResults');

const fixture = path.join(__dirname, '../../data/raw/_smoke_after.html');

test('parses all result cards from the real smoke capture', () => {
  const html = fs.readFileSync(fixture, 'utf8');
  const results = parseResultsFromHtml(html);

  assert.strictEqual(results.length, 9, 'finds the 9 result cards');

  const first = results[0];
  assert.match(first.title, /PsycInfo/i, 'first result is APA PsycInfo');
  assert.match(first.url, /ebscohost\.com/, 'first result has the EBSCO url');
  assert.strictEqual(first.rank, 1, 'rank starts at 1');
  assert.strictEqual(first.toolScore, 100, 'captures the tool relevance score');
  assert.ok(first.description.length > 10, 'has a static description');
  assert.ok(first.whyMatches.length > 10, 'captures the "why this matches" text');
});

test('scores are numeric and descending (tool ranks by relevance)', () => {
  const html = fs.readFileSync(fixture, 'utf8');
  const scores = parseResultsFromHtml(html).map((r) => r.toolScore);
  assert.ok(scores.every((s) => typeof s === 'number' && s >= 0 && s <= 100));
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] <= scores[i - 1], `score ${i} not above previous`);
  }
});
