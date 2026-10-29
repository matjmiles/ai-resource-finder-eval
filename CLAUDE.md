# CLAUDE.md

Guidance for Claude Code (and humans) working in this repository.

## What this is

An **evaluation harness** for the BYU-Idaho Library Resource Finder
(https://library-resource-finder.byui.edu/) — an AI tool that recommends specialized
library **databases** (not articles or books) for a research question.

This repo generates synthetic research questions, runs them through the live tool,
scores the results with AI reference-librarian judges, and produces a findings report
plus a visual dashboard. It does **not** contain or modify the Resource Finder itself.

## The target tool (important facts)

- It is a **Blazor Server** app (SignalR over WebSocket; MudBlazor UI). There is **no
  REST API** — retrieval must go through a real browser (Playwright).
- The search input is selected by placeholder: `Describe what you are researching...`
  (element IDs are dynamically generated — never select by ID).
- After submitting, the button reads **"SEARCHING…"** for ~20–90s while the AI works.
  The reliable "finished" signal is that **"SEARCHING" text disappearing**.
- Each result card exposes: database name + link, the tool's **own relevance %**
  (`aria-valuenow`), a static description, and an AI "Why this matches your search" note.
- Since we own the tool, scripted querying is authorized — but throttle politely.

## Pipeline (how to reproduce a run)

```bash
npm install                    # deps: playwright, node-html-parser
npx playwright install chromium
npm run scrape                 # runs data/questions.json through the live tool
                               #   -> writes data/results.json (+ data/raw/*.html)
                               #   resumable: re-run to continue; skips status==='ok'
# then score (see Judging below), merge scores into results.json, then:
npm run aggregate              # -> data/results.csv + data/rollups.json
npm test                       # runs the unit tests (node --test)
```

`node src/scrape.js 3` runs only the first N questions (used for dry-runs).

## Judging (the AI-judge step is manual/agent-driven)

Scoring is done by dispatching parallel agents, not a script:

1. Split `data/results.json` into `data/batchN.json` (slimmed records).
2. Dispatch one judge agent per batch. Each scores every question 0–3 on
   **relevance, coverage, ranking, robustness**, plus `failure_tags[]` and `notes`,
   writing `data/scoresN.json`.
3. Merge all `scoresN.json` back into `data/results.json` under each record's `scores`.
4. Run `npm run aggregate`.

The exact judge rubric lives in the plan (see `docs/superpowers/plans/`).

## Librarian gold set from the real search log (Jev)

A second workflow, separate from the synthetic-question pipeline above. It samples 150 real
queries from the production search log (good, poor and mixed searches, as rated by
TypeSafe's **Jev** model). Librarians fill in the ideal databases, then the Resource Finder is
scored against their answers. **Full how-to: [docs/gold-set.md](docs/gold-set.md).**

```bash
node src/gold-set/run.js rate --limit 10 --cap 0.05   # Jev rates searches (sends data; see below)
node src/gold-set/run.js sheet                        # -> private/gold-set/librarian-gold-set.csv
node src/gold-set/run.js xlsx                         # -> .xlsx with A-Z dropdowns, for Google Sheets
node src/gold-set/run.js check --sheet <download>.csv # validate librarians' database names
node src/gold-set/run.js score [--log newer-log.csv]  # Resource Finder vs. gold
```

- **Patron data stays in git-ignored `private/gold-set/`**: the search log, A–Z export, Jev
  ratings, librarian sheet and reports. This repo is **public**. Never commit them, or quote
  queries in docs, tests or commit messages; describe cases generically. Before committing,
  grep the staged diff for queries from the sheet.
- **API key:** `TYPESAFE_API_KEY`, a Windows user environment variable (setup in
  docs/gold-set.md). Read it from `process.env`; never print, log, hard-code or commit it, and
  don't create a `.env` file. Check it exists without echoing it.
- **Ask before sending anything to the live TypeSafe API.** Say what will be sent (patron queries
  and database names) and agree on a budget. `rate` caches every request and response, so
  reruns only send what's missing; `--cap` limits spend.
- **Jev judges, code decides.** All question wording and thresholds live in
  [src/gold-set/questions.js](src/gold-set/questions.js). Keep one judgment per question, and
  keep the state to what a person would need. Don't add criteria that name test queries, and
  don't fit thresholds to a few cases. A failed API call is an error, never "unhelpful".
- Load the `typesafe:typesafe-ai` skill before changing anything that calls TypeSafe. The live
  docs (<https://docs.typesafe.ai/llms.txt>) are the source of truth for request syntax and
  prices.
- `sheet` won't overwrite `librarian-gold-set.csv` (librarians may be editing it) unless
  `--force` is given.

## Layout

```
src/
  scrape.js              # Playwright retrieval loop (resumable, throttled)
  smoke.js               # one-off DOM discovery / wait-signal probe
  shot.js                # screenshots summary.html (light + dark) for QA
  aggregate.js           # results.json -> results.csv + rollups.json
  gold-set/
    questions.js         # Jev state, questions, thresholds, bucket truth table (edit wording here)
    questions.test.js
    run.js               # CLI: rate | sheet | xlsx | check | score
    xlsx.js              # librarian workbook (ideal_1..5 dropdowns from the A-Z list)
  lib/
    csv.js               # RFC 4180 CSV read/write (multi-line fields, Excel BOM)
    goldSet.js           # pure helpers: log loading, sampling, name checks, scoring
    csv.test.js, goldSet.test.js
    parseResults.js      # HTML -> [{rank,title,url,toolScore,description,whyMatches}]
    parseResults.test.js
    aggregate.js         # pure helpers: meanScores/rollupBy/failureTagCounts/toCsvRows
    aggregate.test.js
data/
  questions.json         # the 105-question test bank (committed)
  results.json           # full capture + scores (committed)
  results.csv            # flat scored table (committed)
  rollups.json           # aggregates (committed)
  raw/                   # per-question raw HTML (gitignored)
  batch*.json, scores*.json  # judging intermediates (gitignored)
findings-report.md       # developer-facing report
summary.html             # self-contained visual dashboard (publishable Artifact)
docs/superpowers/        # design spec + implementation plan
```

## Data record shape

A record in `data/results.json` accumulates through the pipeline:

```
{ id, text, discipline, difficulty, type, stress_kind, intent,   // from questions.json
  status, resultCount, elapsedMs, finished, results:[...],        // from scrape.js
  scores: { relevance, coverage, ranking, robustness,            // from judges
            failure_tags:[...], notes } }
```

## Conventions

- Node 22, CommonJS, plain JS (no TypeScript). Python is not available on this machine.
- Tests use the built-in `node --test` runner; keep pure logic (parsing, aggregation)
  in `src/lib/` with real assertions. Browser/LLM steps are verified empirically, not unit-tested.
- Select live DOM by **stable attributes** (aria-label, placeholder, result classes),
  never by generated IDs.
- Be polite to the live server: sequential requests, throttle between queries.
```
