# AI Resource Finder Eval Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node/Playwright harness that runs 100+ synthetic research questions through the live BYU-Idaho Library Resource Finder, scores the results with AI judges, and produces a developer-facing findings report, raw dataset, and visual HTML artifact.

**Architecture:** A deterministic Node/Playwright script scrapes the Blazor Server app (SignalR-driven; no REST API) by selecting stable DOM attributes and waiting for streamed AI results. Scraped data is written to disk as JSON. Parallel Claude subagents then judge each question's results against a fixed rubric. A Node aggregation step flattens scores to CSV and computes rollups. Finally the findings report and an HTML summary artifact are authored.

**Tech Stack:** Node 22, Playwright 1.61 (Chromium), plain JS (no TypeScript, no Python). No git repo — `git init` is optional Task 0.

**Note on TDD:** This harness's core work is scraping a live external site and LLM judging, which unit tests can't meaningfully assert. Verification is therefore **empirical**: each stage has an explicit "run it and inspect the output with the user" checkpoint instead of a pre-written unit test. Pure-logic helpers (parsing, CSV, aggregation) DO get real assertions.

---

## File Structure

- `package.json` — declares Playwright dependency, run scripts.
- `data/questions.json` — the 100+ question bank (Task 2 output).
- `src/scrape.js` — Playwright retrieval script (Task 3–4).
- `src/lib/parseResults.js` — pure function: DOM/HTML → structured results array (Task 3).
- `src/lib/parseResults.test.js` — assertions for the parser (Task 3).
- `data/raw/<id>.html` — per-question raw results HTML (Task 4 output).
- `data/results.json` — merged questions + scraped results, later + scores (Task 4/5).
- `src/aggregate.js` — reads scored results.json → results.csv + rollups.json (Task 6).
- `src/lib/aggregate.js` + `src/lib/aggregate.test.js` — pure rollup/CSV helpers with assertions (Task 6).
- `data/results.csv`, `data/rollups.json` — aggregation outputs (Task 6).
- `findings-report.md` — the written report (Task 7).
- `summary.html` — visual artifact source (Task 8).

---

## Task 0: Project scaffold (optional git + npm)

**Files:**
- Create: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Initialize npm and (optionally) git**

Run:
```bash
cd "c:/Users/milesm/Documents/repos/ai resource finder tests"
npm init -y
git init   # optional; skip if not using version control
```

- [ ] **Step 2: Add Playwright and a Chromium browser**

Run:
```bash
npm install -D playwright
npx playwright install chromium
```
Expected: installs Playwright and downloads Chromium without error.

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
data/raw/
*.log
```

- [ ] **Step 4: Add run scripts to `package.json`**

Add to the `"scripts"` block:
```json
{
  "scripts": {
    "scrape": "node src/scrape.js",
    "aggregate": "node src/aggregate.js",
    "test": "node --test"
  }
}
```

---

## Task 1: Lock the retrieval selectors + "results finished" signal (smoke test)

This de-risks everything. Do it before writing the full scraper.

**Files:**
- Create: `src/smoke.js`

- [ ] **Step 1: Write a minimal one-query script**

`src/smoke.js`:
```js
const { chromium } = require('playwright');

(async () => {
  const question = 'peer reviewed research on adolescent social media use and anxiety';
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://library-resource-finder.byui.edu/', { waitUntil: 'networkidle' });

  const input = page.getByPlaceholder('Describe what you are researching...');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(question);
  await input.press('Enter'); // fallback: click the adjacent submit button

  // Give the streamed AI response time; capture the page after it settles.
  await page.waitForTimeout(20000);

  const html = await page.content();
  require('fs').writeFileSync('data/raw/_smoke.html', html);
  console.log('Captured', html.length, 'chars');
  await browser.close();
})();
```

- [ ] **Step 2: Run it and inspect**

Run:
```bash
mkdir -p data/raw
node src/smoke.js
```
Expected: writes `data/raw/_smoke.html`. Open it and identify:
  - the exact container element wrapping each result,
  - fields available per result (title, type, link, description),
  - a reliable DOM signal that streaming has finished (e.g. a results list becoming non-empty, a spinner disappearing, or a stable "results count" element).

- [ ] **Step 3: CHECKPOINT — confirm findings with the user**

Report back: the result-item selector, the fields found, and the chosen "finished" wait strategy. Do not proceed to the full scraper until the user confirms the scraped structure looks right. Adjust submit method (Enter vs. clicking the filled MudButton) if Enter doesn't trigger a search.

---

## Task 2: Generate the question bank

**Files:**
- Create: `data/questions.json`

- [ ] **Step 1: Author 100+ questions as structured records**

Write `data/questions.json` as an array of objects with this exact shape:
```json
{
  "id": "q001",
  "text": "How does intermittent fasting affect type 2 diabetes management?",
  "discipline": "health",
  "difficulty": "typical",
  "type": "realistic",
  "stress_kind": null,
  "intent": "Peer-reviewed clinical/nutrition sources on intermittent fasting and glycemic control; nursing/medical databases expected."
}
```
Composition rules:
  - ~70 `type:"realistic"` spread across disciplines: `stem`, `health`, `business`, `humanities`, `social_science`, `education`, `religion`. Mix `difficulty` across `easy`/`typical`/`hard`.
  - ~30 `type:"stress"`, each with a `stress_kind` from: `vague`, `broad`, `multitopic`, `misspelled`, `offtopic`, `non_english`, `adversarial`.
  - Every record has a one-line `intent` describing what a good result set looks like (the judge uses this).
  - `id` values are zero-padded and unique (`q001`…`q1xx`).

- [ ] **Step 2: Validate the file**

Run:
```bash
node -e "const q=require('./data/questions.json'); const ids=new Set(q.map(x=>x.id)); console.log('count',q.length,'unique',ids.size,'realistic',q.filter(x=>x.type==='realistic').length,'stress',q.filter(x=>x.type==='stress').length); const bad=q.filter(x=>!x.id||!x.text||!x.intent||!x.discipline); if(bad.length){console.error('INVALID',bad); process.exit(1);}"
```
Expected: count ≥ 100, unique === count, realistic ≈ 70, stress ≈ 30, no INVALID records.

---

## Task 3: Build and test the result parser (pure function)

**Files:**
- Create: `src/lib/parseResults.js`
- Test: `src/lib/parseResults.test.js`

Use the concrete selector/structure confirmed in Task 1. The parser takes a Playwright `page` (or a locator root) and returns an array of result objects. Keep DOM-specific selectors in ONE place.

- [ ] **Step 1: Write a failing test with a fixture**

Save a trimmed copy of one real result block from `data/raw/_smoke.html` as `src/lib/fixture.result.html` (2–3 result items). Then:

`src/lib/parseResults.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { parseResultsFromHtml } = require('./parseResults');

test('parses result items from real fixture', () => {
  const html = fs.readFileSync(__dirname + '/fixture.result.html', 'utf8');
  const results = parseResultsFromHtml(html);
  assert.ok(results.length >= 2, 'finds at least 2 results');
  assert.ok(results[0].title && results[0].title.length > 0, 'has a title');
  assert.ok('rank' in results[0], 'has a rank');
  assert.strictEqual(results[0].rank, 1);
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test src/lib/parseResults.test.js`
Expected: FAIL — `parseResultsFromHtml` not defined.

- [ ] **Step 3: Implement the parser**

`src/lib/parseResults.js` — implement `parseResultsFromHtml(html)` using the container/field selectors confirmed in Task 1 (use a lightweight regex/`node-html-parser` approach, or export a `parseResultsFromPage(page)` sibling for live use that shares field logic). Return `[{ rank, title, type, url, snippet }]`. Fill the real selectors discovered in Task 1 — do not leave them as guesses.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test src/lib/parseResults.test.js`
Expected: PASS.

---

## Task 4: Full retrieval script

**Files:**
- Create: `src/scrape.js`

- [ ] **Step 1: Implement the scraper loop**

`src/scrape.js`:
```js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { parseResultsFromPage } = require('./lib/parseResults');

const QUESTIONS = require('../data/questions.json');
const RAW_DIR = path.join(__dirname, '../data/raw');
const OUT = path.join(__dirname, '../data/results.json');
const THROTTLE_MS = 4000;
const TIMEOUT_MS = 60000;

function loadExisting() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch { return {}; }
}

async function runOne(page, q) {
  await page.goto('https://library-resource-finder.byui.edu/', { waitUntil: 'networkidle' });
  const input = page.getByPlaceholder('Describe what you are researching...');
  await input.waitFor({ state: 'visible', timeout: 30000 });
  await input.fill(q.text);
  await input.press('Enter');
  // Wait for the "results finished" signal locked in Task 1 (replace selector below):
  await page.waitForSelector('SELECTOR_FROM_TASK1', { timeout: TIMEOUT_MS });
  const results = await parseResultsFromPage(page);
  const html = await page.content();
  fs.writeFileSync(path.join(RAW_DIR, `${q.id}.html`), html);
  return results;
}

(async () => {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const store = loadExisting();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  for (const q of QUESTIONS) {
    if (store[q.id] && store[q.id].status === 'ok') { console.log('skip', q.id); continue; }
    try {
      const results = await runOne(page, q);
      store[q.id] = { ...q, status: 'ok', resultCount: results.length, results };
      console.log('ok', q.id, results.length, 'results');
    } catch (err) {
      store[q.id] = { ...q, status: 'error', error: String(err.message || err), results: [] };
      console.error('ERR', q.id, err.message);
    }
    fs.writeFileSync(OUT, JSON.stringify(store, null, 2)); // checkpoint every question (resumable)
    await page.waitForTimeout(THROTTLE_MS);
  }
  await browser.close();
  console.log('done');
})();
```
Replace `SELECTOR_FROM_TASK1` with the confirmed finished-signal selector and confirm `parseResultsFromPage` exists (add it in Task 3 alongside the HTML parser, sharing field logic).

- [ ] **Step 2: Dry-run on a 3-question subset**

Temporarily point the script at `QUESTIONS.slice(0,3)` (or filter by id). Run:
```bash
node src/scrape.js
```
Expected: `data/results.json` has 3 entries with `status:"ok"` and non-empty `results`. Inspect one to confirm titles/links look right.

- [ ] **Step 3: CHECKPOINT — confirm subset quality with the user, then run the full set**

After the user confirms the subset looks correct, restore the full loop and run to completion. Expected: every `q.id` present in `data/results.json` with `status` `ok` or `error`. Errors are acceptable data points, not failures.

---

## Task 5: AI judging (parallel subagents)

**Files:**
- Modify: `data/results.json` (adds a `scores` object per question)

- [ ] **Step 1: Split questions into batches**

Run:
```bash
node -e "const s=require('./data/results.json'); const ids=Object.keys(s); const n=Math.ceil(ids.length/5); for(let i=0;i<5;i++){require('fs').writeFileSync('data/batch'+i+'.json', JSON.stringify(ids.slice(i*n,(i+1)*n).map(id=>s[id]),null,2));} console.log('wrote 5 batches');"
```

- [ ] **Step 2: Dispatch one judging subagent per batch**

Use superpowers:dispatching-parallel-agents. Give each subagent `data/batchN.json` and this exact rubric. Each returns a JSON array of `{ id, scores }` written to `data/scoresN.json`:

Rubric (each 0–3; 0=absent/broken, 1=poor, 2=adequate, 3=strong):
  - `relevance` — do surfaced resources match the question's `intent`?
  - `coverage` — reason about resource types a subject librarian would expect for this `intent`; penalize obvious misses. List missing types in `notes`.
  - `ranking` — are the strongest hits near the top?
  - `robustness` — for stress questions, was handling graceful (sensible fallback / clarification / honest "no results") vs. confident-wrong / empty / broken? For realistic questions, score 3 unless something broke.
  - `failure_tags` — array of short kebab-case tags (e.g. `missed-core-database`, `off-topic-results`, `empty-on-vague`, `duplicate-results`).
  - `notes` — 1–2 sentences of evidence.

Judges must base scores ONLY on the scraped `results` in the batch file, not outside knowledge of what the tool "should" do beyond librarian expectations.

- [ ] **Step 3: Merge scores back into results.json**

Run:
```bash
node -e "const fs=require('fs'); const s=require('./data/results.json'); for(let i=0;i<5;i++){const arr=require('./data/scores'+i+'.json'); for(const r of arr){ if(s[r.id]) s[r.id].scores=r.scores; }} fs.writeFileSync('data/results.json', JSON.stringify(s,null,2)); const missing=Object.values(s).filter(x=>!x.scores); console.log('scored',Object.keys(s).length-missing.length,'missing',missing.length); if(missing.length) console.log('MISSING', missing.map(x=>x.id));"
```
Expected: `missing 0`. If any missing, re-run that batch's judge.

---

## Task 6: Aggregation → CSV + rollups (pure helpers, tested)

**Files:**
- Create: `src/lib/aggregate.js`
- Test: `src/lib/aggregate.test.js`
- Create: `src/aggregate.js`

- [ ] **Step 1: Write failing tests for the pure helpers**

`src/lib/aggregate.test.js`:
```js
const { test } = require('node:test');
const assert = require('node:assert');
const { toCsvRows, rollupBy, meanScores } = require('./aggregate');

const sample = [
  { id:'q1', discipline:'health', difficulty:'typical', type:'realistic', status:'ok', resultCount:5, scores:{relevance:3,coverage:2,ranking:3,robustness:3} },
  { id:'q2', discipline:'health', difficulty:'hard', type:'realistic', status:'ok', resultCount:2, scores:{relevance:1,coverage:1,ranking:2,robustness:3} },
];

test('meanScores averages a dimension', () => {
  assert.strictEqual(meanScores(sample, 'relevance'), 2);
});
test('rollupBy groups and averages', () => {
  const r = rollupBy(sample, 'discipline', 'coverage');
  assert.strictEqual(r.health, 1.5);
});
test('toCsvRows emits one row per record with a header', () => {
  const rows = toCsvRows(sample);
  assert.strictEqual(rows.length, 3); // header + 2
  assert.ok(rows[0].includes('id') && rows[0].includes('relevance'));
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `node --test src/lib/aggregate.test.js`
Expected: FAIL — functions not defined.

- [ ] **Step 3: Implement the helpers**

`src/lib/aggregate.js` — implement `meanScores(records, dim)`, `rollupBy(records, groupField, dim)` (returns `{group: mean}`), and `toCsvRows(records)` (returns array of CSV strings, header first; columns: `id,discipline,difficulty,type,stress_kind,status,resultCount,relevance,coverage,ranking,robustness,failure_tags,notes`; escape commas/quotes). Ignore records with no `scores` in mean/rollup math.

- [ ] **Step 4: Run tests to confirm they pass**

Run: `node --test src/lib/aggregate.test.js`
Expected: PASS.

- [ ] **Step 5: Write the aggregation entrypoint**

`src/aggregate.js` — read `data/results.json`, write `data/results.csv` (via `toCsvRows`) and `data/rollups.json` containing: overall mean per dimension; `rollupBy` for `discipline`, `difficulty`, and `type` × each dimension; retrieval error rate; a sorted frequency count of all `failure_tags`; and stress-question outcomes.

- [ ] **Step 6: Run it**

Run: `node src/aggregate.js`
Expected: `data/results.csv` and `data/rollups.json` written. Sanity-check counts match question count.

---

## Task 7: Findings report

**Files:**
- Create: `findings-report.md`

- [ ] **Step 1: Author the report from `rollups.json` + illustrative examples**

Structure:
  - **Executive summary** — 3–5 bullet takeaways.
  - **Method** — question bank composition, retrieval via browser automation, LLM-as-judge rubric, sample size, and limitations (no manual gold set; judge subjectivity).
  - **What works well** — strengths with example queries + their scores.
  - **Weaknesses** — grouped by the top `failure_tags`, each with concrete example queries, what happened, and why it matters. Cover discipline/difficulty patterns and stress-test behavior.
  - **Ranked recommendations** — prioritized, actionable changes for the developer (e.g. specific retrieval, ranking, query-understanding, or fallback fixes), each tied to the evidence above.
  - **Appendix** — links to `results.csv` / `results.json`.

- [ ] **Step 2: Verify every claim traces to data**

Re-read the report against `rollups.json`/`results.json`. Every number and example must come from the data. Fix any unsupported claim.

---

## Task 8: Visual HTML summary artifact

**Files:**
- Create: `summary.html`

- [ ] **Step 1: Build a self-contained HTML dashboard**

Before writing, load the `artifact-design` and `dataviz` skills. `summary.html` must be fully self-contained (inline CSS/JS, no external requests), theme-aware, and contain: per-dimension score distribution, discipline × dimension heatmap or bar chart, difficulty breakdown, realistic-vs-stress comparison, and a table of the top failure tags. Hard-code the numbers from `rollups.json` into the file (no fetch).

- [ ] **Step 2: Publish via the Artifact tool**

Publish `summary.html` with a title and favicon. Confirm it renders.

- [ ] **Step 3: Final CHECKPOINT — deliver to user**

Summarize: report path, dataset paths, artifact URL, and the top 3 recommendations.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Q-generation (T2), retrieval/Playwright (T1,T3,T4), scoring/LLM-judge (T5), aggregation (T6), report+CSV+JSON+artifact deliverables (T6,T7,T8). All spec stages mapped.
- **Placeholders:** two intentional, clearly-flagged empirical unknowns (`SELECTOR_FROM_TASK1`, fixture selectors) that are RESOLVED by the Task 1 smoke-test checkpoint before use — not hand-waves. All logic/rubric/commands are concrete.
- **Type consistency:** record shape (`id,text,discipline,difficulty,type,stress_kind,intent` → +`status,resultCount,results` → +`scores{relevance,coverage,ranking,robustness,failure_tags,notes}`) is consistent across Tasks 2→4→5→6. Helper names (`parseResultsFromHtml`/`parseResultsFromPage`, `meanScores`/`rollupBy`/`toCsvRows`) match between definition and use.
