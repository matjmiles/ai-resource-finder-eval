// Gold-set builder: state, Jev questions, and bucketing in one place.
//
// Jev rates how useful each recommended database is for a query; the code below
// buckets each search as good, poor, or mixed so librarians get a balanced set
// of queries to write gold-standard answers for. Edit wording and thresholds here only.
//
// Sections:
//   1. STATE      - what each search looks like when it reaches Jev
//   2. QUESTIONS  - one request per distinct query, one Score per recommended database
//   3. BUCKETING  - thresholds and the good / poor / mixed truth table

// =============================================================================
// 1. STATE
// =============================================================================
// Only the query. Each database is named in its own question, so no question
// has to look anything up. The Resource Finder's match reasons are left out:
// they were written by the system under evaluation to argue for each pick.

function buildState(search) {
  return { query: search.query };
}

// =============================================================================
// 2. QUESTIONS
// =============================================================================

const MEANINGFUL = {
  type: 'noul',
  instructions: 'Is `query` something a library user could be looking for?',
  criteria: {
    true:
      'It names a topic, a title, an author, a database, or a kind of material, ' +
      'even if it is misspelled or only a word or two.',
    false: "It is random characters, a keyboard test such as 'asdf' or 'test', or empty of meaning.",
  },
};

const USEFULNESS_LEVELS = [
  'The database has nothing on the subject of the search.',
  'The database touches the subject only in passing; a searcher would find little there.',
  'The database covers the subject well, alongside other subjects.',
  'The database is one of the main places a librarian would send someone for this search.',
];

function usefulnessQuestion(database, vendor) {
  const by = vendor ? ` (from ${vendor})` : '';
  return {
    type: 'score',
    instructions: `How useful is the database "${database}"${by} for the search in \`query\`?`,
    criteria: USEFULNESS_LEVELS,
  };
}

// search: { query, results: [{ rank, database, vendor, ... }] }
function buildRequest(search, model = 'jev-latest') {
  const questions = { meaningful: MEANINGFUL };
  for (const r of search.results) questions[`result_${r.rank}`] = usefulnessQuestion(r.database, r.vendor);
  return { model, state: buildState(search), questions };
}

// =============================================================================
// 3. BUCKETING
// =============================================================================

const YES = 0.7; // probability at or above this reads as yes
const NO = 0.3; // below this reads as no; between is unsettled

const TOP_N = 3; // results a searcher actually looks at
const POOR_MIN_UNHELPFUL = 2; // this many of the top results unhelpful -> poor

// Probability the database covers the subject well or is a main source (levels 2-3).
function pHelpful(answer) {
  const p = answer.probabilities;
  return (p['2'] || 0) + (p['3'] || 0);
}

// Returns { bucket, rating } where rating is mean P(helpful) over the top results.
//
// meaningful | top results (up to TOP_N)                    -> bucket
// -----------+----------------------------------------------+---------
// no         | any                                          -> junk (not sampled)
// yes/unsure | every one helpful (>= YES)                   -> good
// yes/unsure | POOR_MIN_UNHELPFUL or more unhelpful (< NO), -> poor
//            | or the only result is unhelpful              |
// yes/unsure | anything else                                -> mixed
//
// The sheet step relabels the lowest-rated mixed searches near_poor when there
// are too few poor ones to fill that bucket.
function bucket(answers, ranks) {
  const top = [...ranks].sort((a, b) => a - b).slice(0, TOP_N);
  const ps = top.map((r) => pHelpful(answers[`result_${r}`]));
  const rating = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : 0;
  if (answers.meaningful.noul < NO) return { bucket: 'junk', rating };
  if (!ps.length) return { bucket: 'poor', rating };
  const unhelpful = ps.filter((p) => p < NO).length;
  if (ps.every((p) => p >= YES)) return { bucket: 'good', rating };
  if (unhelpful >= Math.min(POOR_MIN_UNHELPFUL, ps.length)) return { bucket: 'poor', rating };
  return { bucket: 'mixed', rating };
}

module.exports = {
  buildState, buildRequest, usefulnessQuestion, MEANINGFUL, USEFULNESS_LEVELS,
  YES, NO, TOP_N, POOR_MIN_UNHELPFUL, pHelpful, bucket,
};
