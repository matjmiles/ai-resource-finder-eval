const { test } = require('node:test');
const assert = require('node:assert');
const { parseCsv, readCsvObjects, writeCsvObjects } = require('./csv');

test('parseCsv handles quotes, escaped quotes, commas and newlines in fields', () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\n');
  assert.deepStrictEqual(rows, [['a', 'b'], ['x, y', 'say "hi"\nthere']]);
});

test('readCsvObjects strips the BOM and keys rows by header', () => {
  const objs = readCsvObjects('﻿name,n\nERIC,1\n\n');
  assert.deepStrictEqual(objs, [{ name: 'ERIC', n: '1' }]);
});

test('writeCsvObjects round-trips through readCsvObjects', () => {
  const objs = [{ q: 'a "b", c', list: '1. X\n2. Y' }, { q: 'plain', list: '' }];
  assert.deepStrictEqual(readCsvObjects(writeCsvObjects(objs)), objs);
});
