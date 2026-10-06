# ghostHR — Chrome Extension Spec

**Status:** Spec (no code)
**Branch:** `spec/ghost-back`
**Date:** 2026-10-06
**Author:** Fabio (idea) / Olly (spec)
**Brand:** ghostHR

---

## 1. Vision (one line)

A Chrome-browser extension (**ghostHR**) that tells a candidate, before they apply, whether a job is worth it and what to do first to make it worth it — and keeps a crowdsourced record (reusing **jobibot** as the DB) of which employers ghost, so you can "ghost back."

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

- **Phase 1 — CV + job "hold back" scanner.** Fastest to ship, easiest to demo. *This is the MVP.*
- **Phase 2 — Ghosting DB layer** on top of **jobibot** (extend it, don't build new). The moat (network effect), but slowest to populate. Reactive reporting + pre-apply lookups.
- **Phase 3 — "Ghost back" + score feedback loop.** One-click withdraw that feeds the employer's score.

### Target markets (Fabio decision)
**Any job board with an ATS application form** — not just LinkedIn/Indeed. Most applications from known companies happen **outside LinkedIn**; their flow is near-identical (prefill a form from your CV, a few textareas, job description at top). Many run **Workable** or similar.
Example: `https://apply.workable.com/boardofinnovation/j/531B141B6C/`

So the extension targets: **Workable + other common ATS form flows** first, then generic form detection as a fallback.

## 5. Architecture (Phase 1 MVP)

**Stack decision (Fabio: "it's a chrome extension, pick the best fit"):**
- **Extension frontend:** TypeScript + Vite, content script + MV3 service worker + React (or Preact) for the popup/side panel. Best fit for a Chromium extension (MV3, module bundling, typed against the DOM/ATS forms).
- **Backend/DB:** **extend jobibot** (Laravel + existing MySQL/Postgres) as the API + central data store — it already has `Company`, `JobAdvertisement`, `Candidate`, `Feedback`. Add the ghosting layer there. Reuses auth, admin, and the company graph.
- **AI:** multi-provider, **local-first → Hugging Face → Doubleword → OpenRouter** routing (matches our other services).

```
┌───────────────────────────── Chrome Extension (TS/Vite/MV3) ───────────────┐
│  content script — ATS form detector + prefill (Workable + generic forms)   │
│  popup / side panel (CV upload + verdict display)                          │
│  MV3 service worker (calls jobibot API, auth, storage)                     │
└──────────────────────────────────┬─────────────────────────────────────────┘
                                   │ HTTPS
                                   ▼
┌────────────────────────────── Backend: jobibot (extended) ────────────────┐
│  Laravel API routes                                                       │
│   POST /api/ghost/jobs/analyze   (job text + CV → verdict)                │
│   GET  /api/ghost/companies/{id}/ghost-score   (pre-apply gate)           │
│   POST /api/ghost/reports         (crowdsourced report, Phase 2)          │
│   POST /api/ghost/back            (withdraw event → updates score, P3)    │
│  AI router: local-first → HF → doubleword → openrouter                     │
│  Data: reuse jobibot tables + NEW ghost tables                             │
│  Admin: existing jobibot admin + new review queue                         │
└────────────────────────────────────────────────────────────────────────────┘
```

### Data model
**Reuse from jobibot:** `users`, `companies`, `job_advertisements`, `candidates`, `feedbacks`.
**New tables (added to jobibot):**
- `ghost_cv_profiles` — parsed CV snapshot per user (skills, years, education, projects)
- `ghost_analyses` — verdict, hold-back actions, match score, reasoning
- `ghost_reports` — per-company ghost incidents (status, stage, timestamps, proof)
- `ghost_scores` — derived ghosting scores per company
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

1. **Cold start on ghosting DB.** DidTheyGhostYou hit 2,000+ cos via viral LinkedIn; Ghostedd sat ~2,000 stories for a year. Reusing jobibot's existing user base + candidate graph helps bootstrap, but a distribution channel is still needed.
2. **Verification.** Without evidence (screenshot of last email, application timestamp), the DB is a reputation-attack vector. MVP needs a light verification signal + admin review queue (reuse jobibot moderation patterns).
3. **Platform/ATS risk.** Workable + ATS DOM changes break selectors → maintenance treadmill. Use resilient selectors + a form-recognition adapter (generic 'job description + textareas' heuristics as fallback), and degrade gracefully.
4. **"Hold back" advice quality.** This is where the AI must actually be good. Needs eval harness (golden set of job+CV → expected verdicts) to keep quality high.
5. **Legal/privacy.** CV data is sensitive. Encrypt at rest, minimize retention, clear consent. Client-side analysis + prefill; no server-side scraping; the ATS form is on the user's machine/in their session.
6. **Ghost-score fairness.** Companies can dispute; need an appeal path and to prevent weaponized downvoting (rate limits, verified application events).

## 7. Security & privacy stance
- CVs and analyses processed with user consent; stored encrypted; user can delete.
- Extension analyzes the job listing client-side first (and prefills the ATS form locally); only structured verdict round-trips to API.
- No server-side page scraping; data minimization.
- Ghost reports require a minimal proof signal (stage, dates, optional screenshot) and pass a review queue before affecting public score.

## 8. Monetization (sketch, not committed)
- Free: match score + ghost check + basic hold-back actions.
- Pro: deep hold-back roadmap, unlimited analyses, ghost-back automation, advanced filtering.
- Model parallels Ghoster (free tracking → AI tools as Pro).

## 9. Decisions locked (Fabio, 2026-10-06)
1. **Name:** **ghostHR**.
2. **Markets:** any job board with an ATS application form (Workable + generic forms), not just LinkedIn/Indeed — most known-company applications happen outside LinkedIn.
3. **Ghosting DB:** **reuse jobibot** as the central DB/backend; add a ghost layer rather than build a new one.
4. **AI providers:** **local-first → Hugging Face → Doubleword → OpenRouter**.
5. **Stack:** it's a Chrome extension — **best-fit = TypeScript + Vite + MV3** for the extension; **extend jobibot (Laravel)** as the backend/DB.

## 10. Suggested next step
Write the implementation plan (Phase 1 MVP) with micro-steps and tests: (a) scaffold the TS/Vite/MV3 extension with an ATS form detector + CV prefill for Workable, (b) add a `analyze` endpoint to jobibot routed across the AI providers, (c) eval harness for the hold-back verdict. All on a dedicated feature branch, test-first, per the tracker workflow.
