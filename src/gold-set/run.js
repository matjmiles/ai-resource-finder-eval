// Build and score a librarian gold set from a Resource Finder search log.
//
//   node src/gold-set/run.js rate  [--limit 10] [--cap 0.10] [--dry-run]
//   node src/gold-set/run.js sheet [--per-bucket 50] [--force]
//   node src/gold-set/run.js xlsx
//   node src/gold-set/run.js check [--sheet <librarian csv>]
//   node src/gold-set/run.js score [--sheet <librarian csv>] [--log private/gold-set/<newer search log>.csv]
//
// rate  - asks Jev how useful each recommended database is, one request per
//         distinct query. Each request and response is cached under
//         private/gold-set/ratings/, so a later run only sends what is missing.
//         A failed call is reported as an error and stays uncached, never read
//         as "unhelpful".
// sheet - buckets rated searches good / poor / mixed, samples each bucket into
//         the librarian CSV, and writes databases.csv from the A-Z list.
// xlsx  - turns the librarian CSV into an Excel workbook with an A-Z dropdown
//         in each ideal_N column, for import into Google Sheets.
// check - validates librarians' ideal_1..ideal_5 names against databases.csv.
//         --sheet takes the Queries tab downloaded from Google Sheets as CSV.
// score - compares Resource Finder results with the librarians' gold answers.
//
// See docs/gold-set.md. All data lives in git-ignored private/gold-set/.
const fs = require('fs');
const path = require('path');
const q = require('./questions');
const g = require('../lib/goldSet');
const { readCsvObjects, writeCsvObjects } = require('../lib/csv');
const { writeWorkbook } = require('./xlsx');

const DATA = path.join(__dirname, '../../private/gold-set');
const LOG_PATTERN = /^search-log-result-.*\.csv$/;
const AZ_LIST = path.join(DATA, 'az_database_list.csv'); // SpringShare A-Z export
const RATINGS = path.join(DATA, 'ratings');
const SHEET = path.join(DATA, 'librarian-gold-set.csv');
const DATABASES = path.join(DATA, 'databases.csv');

const API_URL = 'https://api.typesafe.ai/v1/systemone';
// From https://docs.typesafe.ai/go/models.md (checked 2026-10-29); output tokens are free.
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const WORKERS = 8;
const SEED = 20261029; // fixed so the sample can be reproduced
const BUCKETS = ['good', 'poor', 'mixed'];
const GOLD_RANKS = 5; // ideal_1 (best) .. ideal_5, one A-Z dropdown each
const EDIT_COLUMNS = Array.from({ length: GOLD_RANKS }, (_, i) => `ideal_${i + 1}`);

const readCsv = (file) => readCsvObjects(fs.readFileSync(file, 'utf8'));

function args() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (rest[i + 1] && !rest[i + 1].startsWith('--')) opts[key] = rest[++i];
    else opts[key] = true;
  }
  return { cmd, opts };
}

function latestLog() {
  const logs = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter((f) => LOG_PATTERN.test(f)).sort() : [];
  if (!logs.length) throw new Error(`No search-log-result-*.csv in ${DATA}`);
  return path.join(DATA, logs[logs.length - 1]);
}

const cachePath = (search) => path.join(RATINGS, `${g.cacheKey(search.query)}.json`);

// --- rate -----------------------------------------------------------------------

function apiKey() {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set. See docs/gold-set.md, then restart the terminal.');
  return key;
}

async function askJev(payload, key) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new Error(`network error: ${e.message}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

// Stops new requests once estimated spend would pass the cap.
function budget(capUsd) {
  let spent = 0;
  return {
    reserve(payload) {
      const est = (JSON.stringify(payload).length / 3) * USD_PER_INPUT_TOKEN; // generous chars-per-token guess
      if (spent + est > capUsd) throw new Error(`cap $${capUsd.toFixed(2)} reached (spent ~$${spent.toFixed(5)})`);
      spent += est;
      return est;
    },
    settle(est, inputTokens) { spent += inputTokens * USD_PER_INPUT_TOKEN - est; },
    get spent() { return spent; },
  };
}

async function rateOne(search, key, b) {
  const payload = q.buildRequest(search);
  try {
    const est = b.reserve(payload);
    const response = await askJev(payload, key);
    b.settle(est, response.usage.input_tokens);
    fs.writeFileSync(cachePath(search), JSON.stringify({ request: payload, response }, null, 2));
    return { tokens: response.usage.input_tokens };
  } catch (e) {
    return { error: e.message, query: search.query };
  }
}

async function cmdRate(opts) {
  fs.mkdirSync(RATINGS, { recursive: true });
  const searches = g.loadSearches(readCsv(latestLog()));
  let todo = searches.filter((s) => !fs.existsSync(cachePath(s)));
  if (opts.limit) todo = g.sample(todo, Number(opts.limit), g.rng(SEED));
  if (opts['dry-run']) {
    for (const s of todo.slice(0, 2)) console.log(JSON.stringify(q.buildRequest(s), null, 2));
    console.log(`Dry run: ${todo.length} of ${searches.length} queries would be sent.`);
    return;
  }
  const key = apiKey();
  const b = budget(Number(opts.cap || 0.1));
  const started = Date.now();
  const out = [];
  let next = 0;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (next < todo.length) out.push(await rateOne(todo[next++], key, b));
  }));
  const errors = out.filter((o) => o.error);
  const done = out.filter((o) => !o.error);
  const tokens = done.reduce((a, o) => a + o.tokens, 0);
  console.log(`${done.length} rated, ${errors.length} errors, ${tokens} input tokens, ` +
    `~$${(tokens * USD_PER_INPUT_TOKEN).toFixed(5)}, ${((Date.now() - started) / 1000).toFixed(1)}s`);
  for (const e of errors) console.log(`  error: ${e.error.slice(0, 200)}`);
  const left = searches.filter((s) => !fs.existsSync(cachePath(s))).length;
  if (done.length && left) {
    const per = tokens / done.length;
    console.log(`${left} queries left; at ~${per.toFixed(0)} tokens each that is ~$${(left * per * USD_PER_INPUT_TOKEN).toFixed(4)}`);
  }
}

// --- sheet ----------------------------------------------------------------------

const lines = (items) => items.join('\n');

// Every database librarians can name: the full A-Z list, plus any the
// Resource Finder returned that the A-Z list no longer has.
function writeDatabases(recommended) {
  const out = readCsv(AZ_LIST).map((r) => ({
    database: r.Name.trim(),
    vendor: r.Vendor.trim(),
    az_status: r.Hidden === 'Show in A-Z' ? 'shown' : 'hidden',
    times_recommended: recommended.get(r.Name.trim())?.times || 0,
    subjects: r.Subjects,
    types: r.Types,
  }));
  const inAz = new Set(out.map((d) => d.database));
  for (const [name, info] of recommended) {
    if (!inAz.has(name)) {
      out.push({ database: name, vendor: info.vendor, az_status: 'not in A-Z', times_recommended: info.times, subjects: '', types: '' });
    }
  }
  out.sort((a, b) => a.database.toLowerCase().localeCompare(b.database.toLowerCase()));
  fs.writeFileSync(DATABASES, writeCsvObjects(out));
  return out;
}

function cmdSheet(opts) {
  const perBucket = Number(opts['per-bucket'] || 50);
  const rows = [];
  const recommended = new Map();
  let unrated = 0;
  for (const s of g.loadSearches(readCsv(latestLog()))) {
    for (const r of s.results) {
      const rec = recommended.get(r.database) || { vendor: r.vendor, times: 0 };
      rec.times++;
      recommended.set(r.database, rec);
    }
    if (!fs.existsSync(cachePath(s))) { unrated++; continue; }
    const { answers } = JSON.parse(fs.readFileSync(cachePath(s), 'utf8')).response;
    const { bucket, rating } = q.bucket(answers, s.results.map((r) => r.rank));
    rows.push({
      query: s.query,
      ...Object.fromEntries(EDIT_COLUMNS.map((c) => [c, ''])),
      jev_bucket: bucket,
      jev_top3_helpful: rating.toFixed(2),
      jev_helpful_by_rank: lines(s.results.map((r) => `${r.rank}. ${q.pHelpful(answers[`result_${r.rank}`]).toFixed(2)}`)),
      current_results: lines(s.results.map((r) => `${r.rank}. ${r.database} (${r.score})`)),
      detected_intent: s.intent,
      unmatched_picks: s.unmatched.join('; '),
      match_reasons: lines(s.results.map((r) => `${r.rank}. [${r.origin}] ${r.reason}`)),
      times_searched: s.runs,
      last_searched_utc: s.searchedAt,
    });
  }
  const databases = writeDatabases(recommended);
  console.log(`Wrote ${DATABASES} (${databases.length} databases)`);

  if (fs.existsSync(SHEET) && !opts.force) {
    console.log(`${SHEET} already exists and may hold librarians' edits; not overwritten (use --force).`);
    return;
  }
  // Too few poor searches: make up the gap with the lowest-rated mixed ones,
  // labelled near_poor so the eval can tell them apart.
  const short = perBucket - rows.filter((r) => r.jev_bucket === 'poor').length;
  rows.filter((r) => r.jev_bucket === 'mixed')
    .sort((a, b) => Number(a.jev_top3_helpful) - Number(b.jev_top3_helpful))
    .slice(0, Math.max(short, 0))
    .forEach((r) => { r.jev_bucket = 'near_poor'; });

  const rand = g.rng(SEED);
  let picked = [];
  for (const b of [...BUCKETS, 'near_poor']) {
    const pool = rows.filter((r) => r.jev_bucket === b);
    const take = g.sample(pool, perBucket, rand);
    picked = picked.concat(take);
    console.log(`${b}: ${pool.length} available, ${take.length} taken`);
  }
  console.log(`junk (not sampled): ${rows.filter((r) => r.jev_bucket === 'junk').length}; unrated: ${unrated}`);
  picked = g.shuffle(picked, rand); // so librarians don't see the buckets in blocks
  fs.writeFileSync(SHEET, writeCsvObjects(picked));
  console.log(`Wrote ${SHEET} (${picked.length} queries)`);
}

// --- xlsx -----------------------------------------------------------------------

async function cmdXlsx(opts) {
  // Older sheets have one "A; B" ideal_databases cell; spread it over the ranked columns.
  const rows = readCsv(opts.sheet || SHEET).map((r) => {
    const gold = g.goldNames(r);
    if (gold.length > GOLD_RANKS) throw new Error(`"${r.query}" has ${gold.length} gold databases; the workbook holds ${GOLD_RANKS}.`);
    const ranked = Object.fromEntries(EDIT_COLUMNS.map((c, i) => [c, gold[i] || '']));
    const { ideal_databases, ...rest } = r;
    return { query: r.query, ...ranked, ...rest, ...ranked }; // ranked columns right after the query
  });
  const out = path.join(DATA, 'librarian-gold-set.xlsx');
  await writeWorkbook(out, rows, readCsv(DATABASES), EDIT_COLUMNS);
  console.log(`Wrote ${out} (${rows.length} queries, ${EDIT_COLUMNS.length} dropdown columns)`);
}

// --- check ----------------------------------------------------------------------

const KIND_TEXT = {
  unknown: 'not in databases.csv',
  duplicate: 'named twice in this row',
  hidden: 'hidden in the A-Z (allowed; check it is intended)',
  not_in_az: 'no longer in the A-Z (allowed; check it is intended)',
  gap: 'left empty although a later rank is filled (allowed; check the order)',
};

function runCheck(opts) {
  const sheet = readCsv(opts.sheet || SHEET);
  return { sheet, ...g.checkGold(sheet, readCsv(DATABASES)) };
}

function cmdCheck(opts) {
  const { sheet, filled, empty, problems } = runCheck(opts);
  console.log(`${filled} of ${sheet.length} queries have gold databases filled in; ${empty} still empty.`);
  for (const p of problems) {
    const hint = p.suggestion ? ` - did you mean "${p.suggestion}"?` : '';
    console.log(`  row ${p.row}: "${p.name}" ${KIND_TEXT[p.kind]}${hint}`);
  }
  const blocking = problems.filter((p) => p.kind === 'unknown' || p.kind === 'duplicate').length;
  console.log(blocking ? `${blocking} name(s) to fix before scoring.` : 'All names match databases.csv.');
  process.exitCode = blocking ? 1 : 0;
}

// --- score ----------------------------------------------------------------------

const pct = (x) => (x == null ? '-' : `${Math.round(100 * x)}%`);

function cmdScore(opts) {
  const { sheet, problems } = runCheck(opts);
  if (problems.some((p) => p.kind === 'unknown' || p.kind === 'duplicate')) {
    throw new Error('Some gold database names need fixing first; run: node src/gold-set/run.js check');
  }
  // Results to score: the run in the sheet, or a newer search log.
  const rerun = opts.log ? new Map(g.loadSearches(readCsv(opts.log)).map((s) => [g.norm(s.query), s])) : null;
  const scored = [];
  const jevPairs = [];
  let notRerun = 0;
  for (const r of sheet) {
    const gold = g.goldNames(r);
    if (!gold.length) continue;
    let results;
    if (rerun) {
      const s = rerun.get(g.norm(r.query));
      if (!s) { notRerun++; continue; }
      results = s.results.map((x) => x.database);
    } else {
      const current = g.parseResultsCell(r.current_results);
      results = current.map((x) => x.database);
      const jev = g.parseJevCell(r.jev_helpful_by_rank);
      for (const x of current) {
        if (jev.has(x.rank)) jevPairs.push({ p: jev.get(x.rank), inGold: gold.includes(x.database), bucket: r.jev_bucket });
      }
    }
    scored.push({ query: r.query, bucket: r.jev_bucket, gold, results, ...g.scoreQuery(results, gold) });
  }
  if (!scored.length) throw new Error('No queries have gold databases filled in yet.');

  const row = (label, s) => `| ${label} | ${s.n} | ${pct(s.top1_in_gold)} | ${pct(s.precision_at_3)} | ` +
    `${pct(s.gold_recall)} | ${pct(s.first_choice_in_top3)} | ${pct(s.first_choice_returned)} |`;
  const md = [
    `# Resource Finder vs. librarian gold set`,
    '',
    `Scored ${scored.length} queries with librarian answers, against ` +
      (rerun ? `\`${path.basename(opts.log)}\`${notRerun ? ` (${notRerun} gold queries not in that log)` : ''}` : 'the results in the sheet') + '.',
    '',
    '| Bucket | Queries | Top result is gold | Gold share of top 3 | Gold found (any rank) | First choice in top 3 | First choice returned |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    row('**all**', g.summarize(scored)),
    ...[...BUCKETS, 'near_poor'].map((b) => [b, scored.filter((s) => s.bucket === b)])
      .filter(([, s]) => s.length).map(([b, s]) => row(b, g.summarize(s))),
    '',
  ];
  if (jevPairs.length) {
    const a = g.jevAgreement(jevPairs, q.YES, q.NO);
    md.push('## Did Jev agree with the librarians?', '',
      `Over ${a.results} returned results, Jev was settled on ${a.settled}. Its helpful / unhelpful call matched ` +
      `whether librarians listed the database ${pct(a.agreement)} of the time. Mean P(helpful): ` +
      `${a.mean_p_in_gold?.toFixed(2) ?? '-'} for databases librarians listed, ` +
      `${a.mean_p_not_in_gold?.toFixed(2) ?? '-'} for those they did not.`, '',
      'Librarians list the databases they would send someone to, so a helpful database they left off ' +
      'counts as a disagreement here. Read this as a rough check of the bucketing, not as Jev accuracy.', '');
  }
  const counts = (key) => {
    const c = new Map();
    for (const s of scored) for (const d of s[key]) c.set(d, (c.get(d) || 0) + 1);
    return [...c].sort((a, b) => b[1] - a[1]).slice(0, 15);
  };
  md.push('## Gold databases most often missing from results', '', ...counts('missing_gold').map(([d, n]) => `- ${d} (${n})`), '');
  md.push('## Returned databases most often not in gold', '', ...counts('not_in_gold').map(([d, n]) => `- ${d} (${n})`), '');

  fs.writeFileSync(path.join(DATA, 'score-report.md'), md.join('\n'));
  fs.writeFileSync(path.join(DATA, 'score-by-query.csv'), writeCsvObjects(scored.map((s) => ({
    query: s.query, bucket: s.bucket, top1_in_gold: s.top1_in_gold,
    precision_at_3: s.precision_at_3.toFixed(2), gold_recall: s.gold_recall.toFixed(2),
    first_gold_rank: s.first_gold_rank ?? '', missing_gold: s.missing_gold.join('; '),
    not_in_gold: s.not_in_gold.join('; '),
  }))));
  console.log(md.slice(0, 8 + BUCKETS.length + 1).join('\n'));
  console.log(`Wrote ${path.join(DATA, 'score-report.md')} and score-by-query.csv`);
}

async function main() {
  const { cmd, opts } = args();
  const commands = { rate: cmdRate, sheet: cmdSheet, check: cmdCheck, score: cmdScore, xlsx: cmdXlsx };
  if (!commands[cmd]) {
    console.log('Usage: node src/gold-set/run.js rate|sheet|xlsx|check|score [options] (see docs/gold-set.md)');
    process.exitCode = 2;
    return;
  }
  await commands[cmd](opts);
}

main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
