const fs = require('fs');
const path = require('path');
const {
  meanScores, rollupBy, failureTagCounts, toCsvRows, DIMENSIONS,
} = require('./lib/aggregate');

const RESULTS = path.join(__dirname, '../data/results.json');
const CSV_OUT = path.join(__dirname, '../data/results.csv');
const ROLLUP_OUT = path.join(__dirname, '../data/rollups.json');

const store = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
const records = Object.values(store);

// --- CSV ---
fs.writeFileSync(CSV_OUT, toCsvRows(records).join('\n') + '\n');

// --- Rollups ---
const overall = {};
for (const d of DIMENSIONS) overall[d] = meanScores(records, d);

const byField = (field) => {
  const out = {};
  for (const d of DIMENSIONS) out[d] = rollupBy(records, field, d);
  return out;
};

const statusCounts = records.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] || 0) + 1;
  return acc;
}, {});
const retrievalErrorRate =
  (records.filter((r) => r.status !== 'ok').length / records.length) || 0;

// Stress-question outcomes: mean robustness per stress_kind + how often results were empty.
const stress = records.filter((r) => r.type === 'stress');
const stressByKind = {};
for (const r of stress) {
  const k = r.stress_kind || 'unknown';
  const b = (stressByKind[k] = stressByKind[k] || { n: 0, robustnessSum: 0, robustnessN: 0, emptyResults: 0 });
  b.n++;
  if (r.results && r.results.length === 0) b.emptyResults++;
  if (r.scores && typeof r.scores.robustness === 'number') {
    b.robustnessSum += r.scores.robustness;
    b.robustnessN++;
  }
}
for (const b of Object.values(stressByKind)) {
  b.meanRobustness = b.robustnessN ? b.robustnessSum / b.robustnessN : null;
  delete b.robustnessSum;
  delete b.robustnessN;
}

const rollups = {
  n: records.length,
  scored: records.filter((r) => r.scores).length,
  statusCounts,
  retrievalErrorRate,
  overall,
  byDiscipline: byField('discipline'),
  byDifficulty: byField('difficulty'),
  byType: byField('type'),
  realisticVsStress: {
    realistic: DIMENSIONS.reduce((o, d) => ({ ...o, [d]: meanScores(records.filter((r) => r.type === 'realistic'), d) }), {}),
    stress: DIMENSIONS.reduce((o, d) => ({ ...o, [d]: meanScores(records.filter((r) => r.type === 'stress'), d) }), {}),
  },
  stressByKind,
  failureTags: failureTagCounts(records),
  avgResultCount:
    records.filter((r) => typeof r.resultCount === 'number').reduce((a, r) => a + r.resultCount, 0) /
      (records.filter((r) => typeof r.resultCount === 'number').length || 1),
};

fs.writeFileSync(ROLLUP_OUT, JSON.stringify(rollups, null, 2));

console.log(`Wrote ${CSV_OUT} (${records.length} rows) and ${ROLLUP_OUT}`);
console.log('Overall means:', overall);
console.log('Top failure tags:', rollups.failureTags.slice(0, 8));
