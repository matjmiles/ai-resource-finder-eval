# AI Resource Finder — Synthetic Test & Evaluation Harness

**Date:** 2026-07-09
**Target system:** BYU-Idaho Library Resource Finder — https://library-resource-finder.byui.edu/
**Author:** matjmiles@gmail.com (tool owner) + Claude

## Goal

Generate 100+ synthetic research questions, run each through the live finder,
capture the surfaced resources, score them with AI judges, and synthesize
developer-facing findings that identify concrete ways to improve the tool.

## Target system facts (verified 2026-07-09)

- Reachable without login: `GET /` returns HTTP 200 (~29 KB HTML).
- **Blazor Server** app (`blazor.web.js`, ReconnectModal, `components-reconnect-button`)
  using the **MudBlazor** component library. UI runs over a SignalR WebSocket;
  server renders results and streams them into the DOM.
- **No REST/GraphQL API** to call directly — retrieval must go through a real browser.
- Input field: a MudBlazor text input, `aria-label="Describe what you are researching"`,
  `placeholder="Describe what you are researching..."`. Element IDs are dynamically
  generated (e.g. `mudinputj3zg3dpm`) and MUST NOT be used as selectors.
- Authorization: the user owns the tool, so scripted querying is authorized.
  Still throttle to avoid load/LLM-cost spikes on their server.

## Requirements (from interview)

- **Data access:** browser automation (Playwright). Confirmed necessary given Blazor Server.
- **Eval dimensions:** Relevance, Coverage/Recall, Ranking & Robustness. (Diversity not a primary.)
- **Ground truth:** LLM-as-judge only (no pre-built or manual gold set).
- **Volume:** 100+ questions.
- **Question mix:** ~70% realistic across disciplines/difficulty, ~30% deliberate stress tests.
- **Deliverables:** findings report (markdown) + raw dataset (JSON + CSV) + visual HTML artifact.

## Pipeline

### Stage 1 — Question generation
Build a bank of 100+ questions. Each record:
`{ id, text, discipline, difficulty (easy|typical|hard), type (realistic|stress),
   stress_kind (vague|broad|multitopic|misspelled|offtopic|non_english|adversarial|null),
   intent }` — `intent` is a one-line description of what a good answer looks like, used by the judge.

Coverage targets:
- ~70 realistic across STEM, health/nursing, business, humanities, social science,
  education, religion; spread over easy/typical/hard.
- ~30 stress tests spanning the stress_kind values above.

Saved to `data/questions.json`.

### Stage 2 — Retrieval (Playwright)
For each question:
1. Navigate to `/`, wait for the input to be interactive.
2. Fill the input (select by aria-label/placeholder), submit.
3. Wait for streamed AI results to finish (signal determined empirically in smoke test).
4. Scrape each result: `{ rank, title, type, url, snippet }`, plus full result HTML.
5. Write per-question raw HTML + parsed JSON.

Properties: sequential (not concurrent) against the server; throttle a few seconds
between queries; per-question try/catch with retry; queries that never return are
recorded as failures (a data point, not a crash). Resumable — skip questions already scraped.

Saved to `data/raw/<id>.html` and merged into `data/results.json`.

### Stage 3 — Scoring (parallel AI judges)
LLM-as-judge scores each question's result set against a fixed rubric:
- **Relevance:** 0–3 per item + overall 0–3.
- **Coverage/Recall:** judge reasons about resource types a subject librarian would
  expect for the intent and flags obvious misses; 0–3.
- **Ranking:** are the strongest hits near the top? 0–3.
- **Robustness:** for stress cases, how gracefully handled (good refusal / clarification /
  sensible fallback vs. confident-wrong / empty / broken); 0–3.
- Free-text `notes` and `failure_tags`.

Judges run in parallel across batches of questions. Output merged into `data/results.json`.

### Stage 4 — Aggregation
Roll scores up by discipline, difficulty, and type. Compute score distributions,
failure-rate, retrieval-failure rate. Cluster recurring `failure_tags` into systematic
patterns; identify standout strengths. Produce `data/results.csv` (flat, one row per question).

### Stage 5 — Synthesis & deliverables
- `findings-report.md` — executive summary, what works well, weaknesses (evidence-backed,
  with example queries), ranked actionable recommendations for the developer.
- `summary.html` — visual artifact: score distributions, per-dimension and per-discipline
  breakdowns, stress-test outcomes; published via the Artifact tool.

## Orchestration

Node/Playwright script for retrieval (deterministic waits, resumable, writes JSON).
Parallel Claude subagents for judging (each handles a batch). Rationale: keeps
retrieval deterministic/robust and judging scalable; avoids brittle inline turn-by-turn
runs and does not require a full Workflow opt-in.

## Risks & mitigations

- **Streaming/wait timing:** run a **1-query smoke test first**, confirm the scrape
  output with the user, and lock the "results finished" signal before the full run.
- **Blazor dynamic DOM:** select by stable attributes only.
- **Partial failures:** retries + resume; failures logged as findings.
- **Politeness/cost:** throttle, sequential, not concurrent.
- **Judge reliability:** fixed rubric + structured output; consistent prompt across judges.

## Out of scope

- Manual/librarian gold sets. Diversity as a scored dimension. Changes to the finder itself.

## Success criteria

- 100+ questions run with results captured (or failures recorded) for each.
- Every question scored on all four rubric fields.
- A findings report with evidence-backed, ranked, actionable recommendations.
- Raw dataset (JSON + CSV) and an HTML summary artifact delivered.
