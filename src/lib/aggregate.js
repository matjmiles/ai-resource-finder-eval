const DIMENSIONS = ['relevance', 'coverage', 'ranking', 'robustness'];
const CSV_COLUMNS = [
  'id', 'discipline', 'difficulty', 'type', 'stress_kind', 'status', 'resultCount',
  'relevance', 'coverage', 'ranking', 'robustness', 'failure_tags', 'notes',
];

function scored(records) {
  return records.filter((r) => r && r.scores && typeof r.scores[DIMENSIONS[0]] === 'number');
}

/** Mean of one score dimension across records that have scores. null if none. */
function meanScores(records, dim) {
  const vals = scored(records)
    .map((r) => r.scores[dim])
    .filter((v) => typeof v === 'number');
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Group records by `groupField`, returning { group: meanOfDim }. Unscored-only groups omitted. */
function rollupBy(records, groupField, dim) {
  const groups = {};
  for (const r of scored(records)) {
    const key = r[groupField] == null ? 'null' : String(r[groupField]);
    (groups[key] = groups[key] || []).push(r);
  }
  const out = {};
  for (const [key, recs] of Object.entries(groups)) {
    const m = meanScores(recs, dim);
    if (m != null) out[key] = m;
  }
  return out;
}

/** Tally failure_tags across scored records, sorted by count desc then tag asc. */
function failureTagCounts(records) {
  const counts = {};
  for (const r of scored(records)) {
    for (const tag of r.scores.failure_tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function csvCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** One header row + one row per record. Blank score cells when a record has no scores. */
function toCsvRows(records) {
  const header = CSV_COLUMNS.join(',');
  const rows = records.map((r) => {
    const s = r.scores || {};
    const cells = [
      r.id, r.discipline, r.difficulty, r.type, r.stress_kind, r.status, r.resultCount,
      s.relevance, s.coverage, s.ranking, s.robustness,
      Array.isArray(s.failure_tags) ? s.failure_tags.join(';') : '',
      s.notes,
    ];
    return cells.map(csvCell).join(',');
  });
  return [header, ...rows];
}

module.exports = { meanScores, rollupBy, failureTagCounts, toCsvRows, DIMENSIONS, CSV_COLUMNS };
