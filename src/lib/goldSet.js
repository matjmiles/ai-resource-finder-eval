// Pure helpers for the gold set: search-log loading, sampling, name checks, scoring.
const crypto = require('crypto');

const norm = (query) => query.replace(/\s+/g, ' ').trim().toLowerCase();

// Same key as the Python prototype (sha1 of the normalized query, 16 hex chars),
// so ratings cached by either version are reused.
const cacheKey = (query) => crypto.createHash('sha1').update(norm(query), 'utf8').digest('hex').slice(0, 16);

// Search-log CSV rows (one per recommended database) -> one search per distinct
// query, its latest run, with results in rank order.
function loadSearches(rows) {
  const searches = new Map();
  for (const row of rows) {
    const id = `${row.Session}|${row['Search #']}`;
    if (!searches.has(id)) {
      searches.set(id, {
        query: row.Query.trim(),
        searchedAt: row['Searched At (UTC)'],
        intent: row['Detected Intent'],
        unmatched: JSON.parse(row['Unmatched Picks'] || '[]'),
        results: [],
      });
    }
    if (row.Result) {
      searches.get(id).results.push({
        rank: Number(row.Rank),
        database: row.Result.trim(), // the log pads some names with a space
        score: row.Score,
        origin: row.Origin,
        reason: row['Match Reason'],
        vendor: row.Vendor.trim(),
      });
    }
  }
  const latest = new Map();
  const runs = new Map();
  for (const s of searches.values()) {
    const key = norm(s.query);
    if (!key) continue;
    runs.set(key, (runs.get(key) || 0) + 1);
    if (!latest.has(key) || s.searchedAt > latest.get(key).searchedAt) latest.set(key, s);
  }
  return [...latest.entries()]
    .map(([key, s]) => ({ ...s, results: s.results.sort((a, b) => a.rank - b.rank), runs: runs.get(key) }))
    .sort((a, b) => (norm(a.query) < norm(b.query) ? -1 : 1));
}

// Seeded PRNG (mulberry32) so samples can be reproduced.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(items, rand) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const sample = (items, n, rand) => shuffle(items, rand).slice(0, n);

// --- librarian answers --------------------------------------------------------

const splitNames = (cell) => (cell || '').split(';').map((s) => s.trim()).filter(Boolean);

function levenshtein(a, b) {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return d[b.length];
}

// Closest official name, or null when nothing is close.
function suggestName(name, official) {
  const low = name.toLowerCase();
  const exactCase = official.find((o) => o.toLowerCase() === low);
  if (exactCase) return exactCase;
  const containing = official.filter((o) => o.toLowerCase().startsWith(low) || low.startsWith(o.toLowerCase()));
  if (containing.length === 1) return containing[0];
  let best = null;
  let bestD = Infinity;
  for (const o of official) {
    const dist = levenshtein(low, o.toLowerCase());
    if (dist < bestD) { best = o; bestD = dist; }
  }
  return bestD <= Math.max(3, Math.floor(low.length * 0.3)) ? best : null;
}

// sheetRows: librarian CSV rows; databases: databases.csv rows.
// Returns { filled, empty, problems: [{ row, query, kind, name, suggestion? }] }
// Kinds: unknown (not in databases.csv), duplicate (named twice in one row),
// hidden / not_in_az (allowed, but worth a second look).
function checkGold(sheetRows, databases) {
  const byName = new Map(databases.map((d) => [d.database, d]));
  const official = [...byName.keys()];
  const problems = [];
  let filled = 0;
  sheetRows.forEach((r, i) => {
    const names = splitNames(r.ideal_databases);
    if (!names.length) return;
    filled++;
    const seen = new Set();
    for (const name of names) {
      const at = { row: i + 2, query: r.query, name }; // +2: header row, 1-based
      if (seen.has(name)) problems.push({ ...at, kind: 'duplicate' });
      seen.add(name);
      const db = byName.get(name);
      if (!db) problems.push({ ...at, kind: 'unknown', suggestion: suggestName(name, official) });
      else if (db.az_status === 'hidden') problems.push({ ...at, kind: 'hidden' });
      else if (db.az_status === 'not in A-Z') problems.push({ ...at, kind: 'not_in_az' });
    }
  });
  return { filled, empty: sheetRows.length - filled, problems };
}

// --- scoring ------------------------------------------------------------------

// "1. ERIC (Education Resources Information Center) (100)" -> { rank: 1, database: 'ERIC (...)' }
function parseResultsCell(cell) {
  return (cell || '').split(/\r?\n/).filter(Boolean).map((line) => {
    const m = line.match(/^(\d+)\. (.*) \([^()]*\)$/);
    return m ? { rank: Number(m[1]), database: m[2] } : { rank: NaN, database: line };
  });
}

// "1. 0.98" lines -> Map(rank -> P(helpful))
function parseJevCell(cell) {
  const out = new Map();
  for (const line of (cell || '').split(/\r?\n/)) {
    const m = line.match(/^(\d+)\. ([\d.]+)$/);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

// results: ranked database names the Resource Finder returned; gold: the
// librarians' ranked ideal databases.
function scoreQuery(results, gold) {
  const goldSet = new Set(gold);
  const top3 = results.slice(0, 3);
  const firstGoldRank = results.indexOf(gold[0]) + 1;
  return {
    top1_in_gold: results.length ? Number(goldSet.has(results[0])) : 0,
    precision_at_3: top3.length ? top3.filter((d) => goldSet.has(d)).length / top3.length : 0,
    gold_recall: gold.filter((d) => results.includes(d)).length / gold.length,
    first_gold_rank: firstGoldRank || null, // where the librarians' first choice appears, if at all
    missing_gold: gold.filter((d) => !results.includes(d)),
    not_in_gold: results.filter((d) => !goldSet.has(d)),
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function summarize(scored) {
  const firsts = scored.map((s) => s.first_gold_rank);
  return {
    n: scored.length,
    top1_in_gold: mean(scored.map((s) => s.top1_in_gold)),
    precision_at_3: mean(scored.map((s) => s.precision_at_3)),
    gold_recall: mean(scored.map((s) => s.gold_recall)),
    first_choice_returned: mean(firsts.map((r) => Number(r !== null))),
    first_choice_in_top3: mean(firsts.map((r) => Number(r !== null && r <= 3))),
  };
}

// How often Jev's helpful/unhelpful call matches the librarians' gold list,
// over results where Jev was settled (P >= yes or P < no).
function jevAgreement(pairs, yes, no) {
  const settled = pairs.filter((p) => p.p >= yes || p.p < no);
  const agree = settled.filter((p) => (p.p >= yes) === p.inGold).length;
  return {
    results: pairs.length,
    settled: settled.length,
    agreement: settled.length ? agree / settled.length : null,
    mean_p_in_gold: mean(pairs.filter((p) => p.inGold).map((p) => p.p)),
    mean_p_not_in_gold: mean(pairs.filter((p) => !p.inGold).map((p) => p.p)),
  };
}

module.exports = {
  norm, cacheKey, loadSearches, rng, shuffle, sample, splitNames, suggestName, checkGold,
  parseResultsCell, parseJevCell, scoreQuery, summarize, jevAgreement, mean,
};
