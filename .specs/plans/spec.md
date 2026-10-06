# Ghost Back — Chrome Extension Spec

**Status:** Spec (no code)
**Branch:** `spec/ghost-back`
**Date:** 2026-10-06
**Author:** Fabio (idea) / Olly (spec)

---

## 1. Vision (one line)

A Chrome-browser extension that tells a candidate, before they apply, whether a job is worth it and what to do first to make it worth it — and keeps a crowdsourced record of which employers ghost so you can "ghost back."

## 2. The core decision loop

The hook is the complete loop, which nobody wires end-to-end today:

```
scan job + CV  →  AI verdict  →  [apply] or [hold back + do activities]
     │                                                    │
     │            when the employer ghosts  ───────────────┤
     │                                                    ▼
     └─────────────►  report to central DB  →  feed the employer's ghost score
```

Three capabilities, one extension:
1. **CV ↔ job scan → "hold back" with specific prep** (not just a match %).
2. **Ghosting DB as a pre-apply gate** (check the employer before applying).
3. **"Ghost back"** — one-click withdraw/no-follow-up that feeds the employer's ghost score.

## 3. What already exists (research context)

| Category | Examples | What they do |
|---|---|---|
| Ghost job detection | GhostJob, Trouvr, JobSniff, VantageCV, Commit, Skip This Job | Score listings 0–100 for ghost-job risk (posting age, vagueness, repost signals, AI-language patterns) |
| Crowdsourced ghosting DB | DidTheyGhostYou.com (2,000+ cos), GhostScore, Ghoster.app, Ghostedd, Do Not Ghost Me | Report + look up companies by ghost rate, reply time, stage where they went silent |
| CV ↔ job match | Jobscan, OwlApply, Enhancv | ATS match score, missing keywords, skill gaps |

### Differentiation
- **"Hold back" = coaching layer, not a match score.** Existing tools say *how well you match*; none say *what to do first to make the application worth it*.
- **Ghosting DB as a pre-apply gate** integrated with the CV scan — DidTheyGhostYou is reactive (post-hoc), Ghoster/GhostCheck are closer but don't integrate the CV scan.
- **"Ghost back" action closes the loop** by feeding the score.

## 4. Scope / phased build (recommended by analysis)

Don't build all three at once. Sequencing:

- **Phase 1 — CV + job "hold back" scanner.** Fastest to ship, easiest to demo. Chrome extension on LinkedIn + Indeed. Monetizable. *This is the MVP.*
- **Phase 2 — Ghosting DB layer.** The moat (network effect), but slowest to build. Layer on once users exist. Reactive reporting + pre-apply lookups.
- **Phase 3 — "Ghost back" + score feedback loop.** One-click withdraw that feeds the employer's score.

## 5. Architecture (Phase 1 MVP)

```
┌───────────────────────────── Chrome Extension ─────────────────────────────┐
│  content script (scrapes job listing DOM on LinkedIn/Indeed)               │
│  popup / side panel (CV upload + verdict display)                          │
│  background service worker (calls API, auth, storage)                      │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌────────────────────────────── Backend ────────────────────────────────────┐
│  API (FastAPI)                                                             │
│   POST /jobs/analyze   (job text + CV → verdict)                           │
│   GET  /companies/{id}/ghost-score   (pre-apply gate)                      │
│   POST /ghost-reports  (crowdsourced report, Phase 2)                      │
│   POST /ghost-back     (withdraw event → updates score, Phase 3)           │
│  AI layer (multi-provider: Claude/OpenAI/Ollama)                            │
│  Data: PostgreSQL (jobs, companies, ghost_reports, users, events)          │
│  Admin: review queue for ghost reports (verification)                      │
└────────────────────────────────────────────────────────────────────────────┘
```

### Data model (core tables)
- `users` — auth, preferred CV (stored, encrypted), plan
- `cv_profiles` — parsed CV snapshot per user (skills, years, education, projects)
- `jobs` — scraped listing snapshot (title, company, posting age, repost flag, raw text)
- `analyses` — verdict, hold-back actions, match score, reasoning
- `companies` — canonical employer entity
- `ghost_reports` — per-company ghost incidents (status, stage, timestamps)
- `ghost_scores` — derived scores per company
- `ghost_back_events` — withdraw/no-follow-up events (Phase 3)

### The "hold back" AI prompt (the hard part)
A generic "you're missing 3 keywords" is easy; "spend two weeks building X before applying" requires understanding the *specific* gap between the candidate's profile and the role's *actual* requirements — not just the posted ones.

Prompt inputs: job listing text, candidate's parsed CV, domain heuristics.
Prompt contract → JSON:
```json
{
  "recommendation": "apply_now | apply_with_caveats | hold_back",
  "match_score": 0-100,
  "score_breakdown": {"skills": 0-100, "experience": 0-100, "fit_signal": 0-100},
  "gap_analysis": ["<specific missing skills/evidence>"],
  "hold_back_actions": [
    {"action": "build|study|portfolio|network|reframe", "detail": "...", "est_effort_days": 0-14}
  ],
  "red_flags": ["<ghost-job signals from listing>"],
  "reasoning": "<short plain-language why>"
}
```

## 6. Hard problems / risk register

1. **Cold start on ghosting DB.** DidTheyGhostYou hit 2,000+ cos via viral LinkedIn; Ghostedd sat ~2,000 stories for a year. Moat needs a distribution channel, not just a product.
2. **Verification.** Without evidence (screenshot of last email, application timestamp), the DB is a reputation-attack vector and companies will dispute. Every existing platform reviews manually. MVP must have a light verification signal + admin review queue.
3. **Platform risk.** LinkedIn/Indeed block scraping and extension overlays; DOM changes break selectors → maintenance treadmill. Use resilient selectors + a scraping adapter, and degrade gracefully.
4. **"Hold back" advice quality.** This is where the AI must actually be good. Needs eval harness (golden set of job+CV → expected verdicts) to keep quality high.
5. **Legal/privacy.** CV data is sensitive. Encrypt at rest, minimize retention, clear consent. Scraping ToS risk (client-side analysis only, no scraping on our servers).
6. **Ghost-score fairness.** Companies can dispute; need an appeal path and to prevent weaponized downvoting (rate limits, verified application events).

## 7. Security & privacy stance
- CVs and analyses processed with user consent; stored encrypted; user can delete.
- Extension analyzes the job listing client-side first; only structured verdict round-trips to API.
- No server-side page scraping; data minimization.
- Ghost reports require a minimal proof signal (stage, dates, optional screenshot) and pass a review queue before affecting public score.

## 8. Monetization (sketch, not committed)
- Free: match score + ghost check + basic hold-back actions.
- Pro: deep hold-back roadmap, unlimited analyses, ghost-back automation, advanced filtering.
- Model parallels Ghoster (free tracking → AI tools as Pro).

## 9. Open questions for Fabio (decision needed before build)
1. **Brand/positioning:** name "Ghost Back" vs a less aggressive candidate-facing name? (The frame is good marketing, but "ghost back" as the product name may read as combative on the candidate-facing side.)
2. **Markets first:** LinkedIn + Indeed only (EN) as MVP, or add a local market?
3. **Stack preference:** reuse existing infra (Laravel/FastAPI?) — recommend **FastAPI + PostgreSQL** to match our Python services, but can do Laravel if you want one stack across the platform.
4. **AI provider:** multi-provider like everything else, or pin one for MVP?
5. **Who owns the ghosting DB data** and how is it licensed/moderted?

## 10. Suggested next step
Fabio reviews this spec and answers the 5 open questions (Section 9); then I write the implementation plan (Phase 1 MVP) with micro-steps and tests, on a dedicated feature branch.
