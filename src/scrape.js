const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parseResultsFromHtml } = require('./lib/parseResults');

const URL = 'https://library-resource-finder.byui.edu/';
const QUESTIONS = require('../data/questions.json');
const RAW_DIR = path.join(__dirname, '../data/raw');
const OUT = path.join(__dirname, '../data/results.json');

const THROTTLE_MS = 3000; // politeness pause between queries
const SEARCH_TIMEOUT_MS = 150000; // max wait for the AI to finish (some queries take ~90s)
const POLL_MS = 2000;

// Optional CLI limit: `node src/scrape.js 3` runs only the first 3 questions.
const LIMIT = process.argv[2] ? Number(process.argv[2]) : Infinity;

function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(OUT, 'utf8'));
  } catch {
    return {};
  }
}

/** Submit one question and wait for the "SEARCHING..." state to clear, then parse. */
async function runOne(page, q) {
  await page.goto(URL, { waitUntil: 'networkidle' });
  const input = page.getByPlaceholder('Describe what you are researching...');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(q.text);
  await input.press('Enter');

  // The submit button reads "SEARCHING..." while the AI works; wait for it to appear
  // (search accepted) then disappear (results rendered).
  const searching = page.getByText('SEARCHING', { exact: false });
  try {
    await searching.first().waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    // Some queries (e.g. refusals) may return almost instantly; fall through to polling.
  }

  let waited = 0;
  while (waited < SEARCH_TIMEOUT_MS) {
    await page.waitForTimeout(POLL_MS);
    waited += POLL_MS;
    const stillSearching = await searching.count();
    if (stillSearching === 0) break;
  }
  const finished = (await searching.count()) === 0;

  const html = await page.content();
  fs.writeFileSync(path.join(RAW_DIR, `${q.id}.html`), html);
  const results = parseResultsFromHtml(html);
  return { results, finished, waited };
}

(async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const store = loadStore();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(SEARCH_TIMEOUT_MS);

  const todo = QUESTIONS.slice(0, LIMIT);
  let ok = 0;
  let err = 0;
  for (const q of todo) {
    if (store[q.id] && store[q.id].status === 'ok') {
      console.log('skip', q.id, '(already ok)');
      ok++;
      continue;
    }
    const t0 = Number(process.hrtime.bigint() / 1000000n);
    try {
      const { results, finished, waited } = await runOne(page, q);
      store[q.id] = {
        ...q,
        status: finished ? 'ok' : 'timeout',
        resultCount: results.length,
        elapsedMs: Number(process.hrtime.bigint() / 1000000n) - t0,
        finished,
        results,
      };
      if (finished) ok++;
      else err++;
      console.log(
        (finished ? 'ok  ' : 'TIMEOUT ') + q.id,
        results.length + ' results',
        `${store[q.id].elapsedMs}ms`
      );
    } catch (e) {
      store[q.id] = { ...q, status: 'error', error: String(e.message || e), results: [] };
      err++;
      console.error('ERR ', q.id, e.message);
    }
    fs.writeFileSync(OUT, JSON.stringify(store, null, 2)); // checkpoint every question (resumable)
    await page.waitForTimeout(THROTTLE_MS);
  }

  await browser.close();
  console.log(`\ndone: ${ok} ok, ${err} problem(s), ${Object.keys(store).length} total in store`);
})();
