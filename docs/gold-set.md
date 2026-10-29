# Librarian gold set from the search log

This workflow builds a **gold-standard answer set** for the Resource Finder from real searches.
It picks 150 queries from the production search log, with a mix of searches that went well and
searches that went badly. Librarians write the databases each query *should* return, and a
script then scores the Resource Finder against their answers. You can re-score later versions
of the Resource Finder against the same set.

[TypeSafe](https://docs.typesafe.ai)'s **Jev** model helps choose the 150. Jev doesn't pick the
gold answers; librarians do. Jev only rates how useful each recommended database looks for its
query, so the sample isn't all easy cases.

```
search log ──rate──▶ Jev ratings ──sheet──▶ librarian-gold-set.csv ──librarians──▶ ideal_databases
                                              databases.csv (A–Z names)              │
                                                                         check ◀─────┤
                                                                         score ◀─────┘
```

All commands run from the repo root with Node 22+ and no extra packages.

| Step | Command | Sends data? |
| --- | --- | --- |
| Rate searches with Jev | `node src/gold-set/run.js rate [--limit 10] [--cap 0.10] [--dry-run]` | Yes: queries and database names to TypeSafe |
| Build the librarian sheet | `node src/gold-set/run.js sheet [--per-bucket 50] [--force]` | No |
| Validate librarians' names | `node src/gold-set/run.js check [--sheet file.csv]` | No |
| Score the Resource Finder | `node src/gold-set/run.js score [--sheet file.csv] [--log newer-log.csv]` | No |

`npm run gold -- <command> [options]` runs the same thing.

## Privacy: everything lives in `private/gold-set/`

The search log holds real patron queries, so it, the Jev ratings and every output stay in the
git-ignored `private/gold-set/` folder. **Never commit them or quote queries in docs, issues
or commit messages.** This repo is public. Describe cases generically ("a law question", "a
one-word query").

| File in `private/gold-set/` | What it is | Where it comes from |
| --- | --- | --- |
| `search-log-result-*.csv` | Resource Finder search log: one row per recommended database | Resource Finder admin export; the newest file is used |
| `az_database_list.csv` | SpringShare A–Z export | Copied from `Libroot/libroot-/data/springshare/az_database_list.corrected.csv` |
| `ratings/<hash>.json` | Exact Jev request and response for each distinct query | `rate` |
| `librarian-gold-set.csv` | The 150 queries for librarians | `sheet` |
| `databases.csv` | Every name librarians can use | `sheet` |
| `score-report.md`, `score-by-query.csv` | Results of a scoring run | `score` |

## One-time Jev setup

1. **Get a TypeSafe API key** from the TypeSafe dashboard.
2. **Store it as a Windows user environment variable** named `TYPESAFE_API_KEY`. Run this in
   PowerShell; it asks for the key without showing it or saving it to history:

   ```powershell
   $s = Read-Host "TypeSafe API key" -AsSecureString
   $k = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
   [Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $k, 'User')
   Remove-Variable s, k
   ```

3. **Restart VS Code or the terminal** so it sees the variable. To check it's there without
   printing it: `if ($env:TYPESAFE_API_KEY) { 'set' } else { 'not set' }`.
4. *(Optional, for Claude Code)* Install the TypeSafe skill so Claude knows the API:

   ```sh
   claude plugin marketplace add typesafe-ai/skills
   claude plugin install typesafe@typesafe-ai
   ```

Never put the key in a file in the repo, a `.env` file, a log or a commit. If it leaks, revoke it
in the TypeSafe dashboard and make a new one.

## Step 1: rate the searches (`rate`)

```sh
node src/gold-set/run.js rate --dry-run            # print 2 example requests; send nothing
node src/gold-set/run.js rate --limit 10 --cap 0.05 # test batch of 10 random queries
node src/gold-set/run.js rate --cap 0.10            # everything not yet rated
```

The log is first reduced to one search per distinct query, using its latest run. Queries are
compared ignoring case and extra spaces. Typos and searches for a database by name are kept,
because real users type those.

For each query, `rate` sends one request to `https://api.typesafe.ai/v1/systemone` (model
`jev-latest`). The request contains:

- **state:** `{ "query": "<the patron's query>" }` and nothing else. Session IDs, timestamps
  and the Resource Finder's own "why this matches" notes are not sent. Those notes were written
  by the system being evaluated to argue for its picks, so they would bias Jev toward
  "helpful".
- **one Score question per recommended database:** *How useful is the database "Name" (from
  Vendor) for the search in `query`?* It has four levels: nothing on the subject, only in
  passing, covers it well, one of the main places a librarian would send someone.
- **one Noul question,** asking whether the query is something a library user could be looking
  for. It catches gibberish and keyboard tests.

The exact wording is in [src/gold-set/questions.js](../src/gold-set/questions.js), the only
place to edit it.

**Cost and speed.** About 1,100 input tokens per query. TypeSafe charges $0.042 per million input
tokens, and output is free, so all 389 distinct queries in the October 2026 log cost about
$0.017 and took under 10 seconds. `--cap` stops sending once the estimated spend would pass the
cap. Check current prices on the [models page](https://docs.typesafe.ai/go/models.md).

**Caching and errors.** Each successful request and response is saved to
`ratings/<hash>.json`, so re-running `rate` only sends queries not yet rated. A failed call
prints an error and saves nothing; it is never treated as "unhelpful". To rerun one query,
delete its file. The cache key is the first 16 hex characters of the SHA-1 of the normalized
query.

**Before sending a new log,** agree on a budget and remember the queries are patron data. Patrons
can type anything, including names. A `--limit 10` test batch first is a good habit.

## Step 2: build the librarian sheet (`sheet`)

Code turns Jev's ratings into a bucket for each search. Jev's answer for a database is
"helpful" when it puts at least 0.7 probability on the top two levels, and "unhelpful" when
it puts less than 0.3 there. Only the top 3 results count, because those are the ones
searchers look at.

| Query meaningful? | Top 3 results | Bucket |
| --- | --- | --- |
| No (< 0.3) | any | `junk`, not sampled |
| Yes or unsure | every one helpful | `good` |
| Yes or unsure | 2 or more unhelpful (or the only result is unhelpful, or there are none) | `poor` |
| Yes or unsure | anything else | `mixed` |

`sheet` samples 50 queries from each bucket with a fixed seed. Clearly poor searches are rare,
so when there are fewer than 50, it fills the gap with the lowest-rated `mixed` searches and
labels them `near_poor`. The rows are shuffled so the buckets don't appear in blocks.

`sheet` also writes `databases.csv`: every database in the A–Z list, plus any the Resource
Finder returned that are no longer listed. **It won't overwrite an existing
`librarian-gold-set.csv`,** because librarians may be editing it. Use `--force` to replace the
sheet; the new sample will be different.

The October 2026 run gave 212 good, 26 poor, 151 mixed and 0 junk. The sheet has 50 good, 26
poor, 24 near_poor and 50 mixed.

## Step 3: librarians fill in `ideal_databases`

Open `librarian-gold-set.csv` in Excel. Each row is one query.

| Column | Edit? | Meaning |
| --- | --- | --- |
| `query` | no | What the patron typed |
| **`ideal_databases`** | **yes** | The databases this query *should* return, **best first**, separated by `;`. Copy names exactly from `databases.csv`. |
| `jev_bucket` | no | good / poor / near_poor / mixed: why this query was picked |
| `jev_top3_helpful` | no | Jev's mean P(helpful) over the top 3 results |
| `jev_helpful_by_rank` | no | Jev's P(helpful) for each returned database |
| `current_results` | no | What the Resource Finder returned, with its own relevance score |
| `detected_intent` | no | Format the Resource Finder detected (Articles, Books, …) |
| `unmatched_picks` | no | Databases its AI chose that weren't in its catalog |
| `match_reasons` | no | Its "why this matches" note and how it found each result |
| `times_searched`, `last_searched_utc` | no | How often the query appears in the log, and when it was last run |

Write what you would recommend whether or not the Resource Finder returned it. Leave the row
empty to skip a query. `databases.csv` has `subjects`, `types` and `times_recommended` columns
to help you find candidates. Databases with `times_recommended` = 0 have never been suggested.

## Step 4: check the names (`check`)

```sh
node src/gold-set/run.js check
```

`check` lists every name that isn't exactly in `databases.csv` and suggests the closest one,
for example *"cinahl" … did you mean "CINAHL"?*. It also flags a name repeated in a row, and
notes names that are hidden in the A–Z or no longer in it. It exits with an error until every
name matches. `--sheet` checks a separate copy, for example one librarian's file.

## Step 5: score (`score`)

```sh
node src/gold-set/run.js score                         # against the results in the sheet
node src/gold-set/run.js score --log private/gold-set/search-log-result-<newer>.csv
```

`score` won't run until `check` passes. For each query with gold answers, it computes:

| Metric | Meaning |
| --- | --- |
| Top result is gold | The Resource Finder's first result is in the librarians' list |
| Gold share of top 3 | Share of the first 3 results that are in the librarians' list |
| Gold found (any rank) | Share of the librarians' databases that appear anywhere in the results |
| First choice in top 3 / returned | Where the librarians' first choice appears |

The report (`score-report.md`) breaks these down by bucket. It also lists the gold databases
most often missing from results, and the returned databases most often not in gold. Without
`--log`, it also compares Jev's helpful/unhelpful calls with the librarians' lists; treat that
as a rough check of the bucketing. `score-by-query.csv` has the per-query detail.

**To evaluate a new Resource Finder version,** export a fresh search log after re-running the
gold queries, put it in `private/gold-set/`, and pass it with `--log`. Queries are matched by
normalized text. Gold queries missing from the new log are counted and skipped.

## Changing the questions or thresholds

- Edit only [src/gold-set/questions.js](../src/gold-set/questions.js). The thresholds (0.7 /
  0.3, top 3, two unhelpful = poor) are starting points, not fitted to particular queries.
- Keep each question to one judgment a person could make at a glance, and keep the state to
  what a person would need. Don't add criteria that name specific test queries.
- After a wording change, delete `ratings/` (or a sample of it), re-run `rate`, and compare
  buckets on queries you didn't look at while editing.
- `npm test` covers the bucketing, sampling, name checks and scoring. It never calls the API.

TypeSafe docs: [index](https://docs.typesafe.ai/llms.txt) ·
[Score](https://docs.typesafe.ai/primitives/score.md) ·
[Noul](https://docs.typesafe.ai/primitives/noul.md) ·
[HTTP API](https://docs.typesafe.ai/go/api.md) ·
[models and prices](https://docs.typesafe.ai/go/models.md).

The first version was prototyped in Python in a separate Jev test project. This Node version
reuses its cached ratings and produces the same buckets.
