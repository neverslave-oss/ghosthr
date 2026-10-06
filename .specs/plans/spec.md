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

- **Phase 1 (MVP) — standalone extension.** CV + job "hold back" scanner + **local application tracker** with a **local SQLite DB**. Runs fully standalone — no backend dependency — so it's testable the moment it loads. *This is the immediate priority.*
- **Phase 2 — Ghosting DB layer** on top of **jobibot** (extend it, don't build new) reached via **explicit cloud sync**. The moat (network effect), but slowest to populate. Reactive reporting + pre-apply lookups.
- **Phase 3 — "Ghost back" + score feedback loop.** One-click withdraw that feeds the employer's score.

### Standalone-first principle (Fabio decision, 2026-10-06)
The MVP is **not** extension-→-cloud. It's a local-first app inside the browser:
- **CV stays on the user's machine**; only the parsed/scanned CV data is stored, in the **local SQLite DB**.
- Candidates **track every application they submit** in the local DB (company, role, date, stage, notes, outcome).
- The ghost DB (jobibot) is reached only through an **explicit, opt-in sync**: user chooses to sync, we **upsert the user + the relevant data**, and the user separately opts whether to **sync their CV into jobibot.com** or not.
- **Priority: the browser extension works standalone so Fabio can test it immediately.** No cloud account, no backend required to use the core scanner + tracker.

### Target markets (Fabio decision)
**Any job board with an ATS application form** — not just LinkedIn/Indeed. Most applications from known companies happen **outside LinkedIn**; their flow is near-identical (prefill a form from your CV, a few textareas, job description at top). Many run **Workable** or similar.
Example: `https://apply.workable.com/boardofinnovation/j/531B141B6C/`

So the extension targets: **Workable + other common ATS form flows** first, then generic form detection as a fallback.

## 5. Architecture (Phase 1 MVP — standalone-first)

**Stack decision (Fabio: "it's a chrome extension, pick the best fit"):**
- **Extension:** TypeScript + Vite, content script + MV3 service worker + a UI (React/Preact) for the popup/application tracker. Best fit for a Chromium extension (MV3, module bundling, typed against the DOM/ATS forms).
- **Local storage:** **SQLite** inside the extension. Best-fit implementations for MV3 are WASM SQLite (e.g. `@sqlite.org/sqlite-wasm` / `sql.js`) or IndexedDB-backed storage; spec picks **WASM SQLite** for real SQL + easy outbox pattern. Everything works offline.
- **Cloud (Phase 2+):** **extend jobibot** (Laravel) as the central API + DB — it already has `Company`, `JobAdvertisement`, `Candidate`, `Feedback`. Add the ghosting layer + a **sync endpoint** there.
- **AI:** multi-provider, **local-first → Hugging Face → Doubleword → OpenRouter** routing. In standalone mode the AI call originates from the extension (through an optional lightweight relay keyed to the user) so even Phase 1 can use the providers directly.

```
┌──────────────────────────── Chrome Extension (TS/Vite/MV3) ────────────────┐
│  content script — ATS form detector + prefill (Workable + generic forms)   │
│  popup / application tracker UI (local, offline)                            │
│  ✓ LOCAL SQLite DB                                                          │
│      • cv_profiles (parsed CV, local)                                       │
│      • applications (tracked submissions: company/role/date/stage/notes)    │
│      • analyses (verdicts), ghost signals                                   │
│      • outbox (pending sync events)                                         │
│  MV3 service worker                                                         │
└───────────────────────────────┬─────────────────────────────────────────────┘
        standalone = everything above, no backend                            │
        optional sync = user opts in                                         │
                                │ HTTPS (opt-in, Phase 2+)
                                ▼
┌─────────────────────────────── Backend: jobibot (extended) ───────────────┐
│  POST /api/ghost/sync        upsert user + tracked apps + CV (opt-in)      │
│  GET  /api/ghost/companies/{id}/ghost-score   (pre-apply gate)             │
│  POST /api/ghost/reports     (crowdsourced report)                         │
│  POST /api/ghost/back        (withdraw event → updates score, Phase 3)     │
│  AI router (optional relay): local-first → HF → doubleword → openrouter     │
└────────────────────────────────────────────────────────────────────────────┘
```

### Data model
**Local (extension SQLite, Phase 1):**
- `cv_profiles` — parsed CV snapshot per user (skills, years, education, projects) — **stays local**
- `applications` — every submitted application: company, role, date, stage, notes, outcome
- `analyses` — verdict, hold-back actions, match score, reasoning
- `outbox` — pending sync events (created offline, flushed on sync)
- `ghost_flags` — locally cached employer ghost signals

**Cloud (jobibot, Phase 2+, reached only via opt-in sync):**
- reuse `users`, `companies`, `job_advertisements`, `candidates`, `feedbacks`
- add `ghost_cv_profiles`, `ghost_analyses`, `ghost_reports`, `ghost_scores`, `ghost_back_events`
- add `sync_events` — outbox counterpart for idempotent upserts

**Sync contract (opt-in):**
1. User clicks "Sync" in the extension.
2. Upsert the user (create-if-missing).
3. Upsert tracked applications + their ghost-relevant signals.
4. **Separate opt-in** to sync the CV into jobibot.com (default off).
5. Idempotent (outbox has stable event ids), so re-sync never duplicates.

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
- **CV files never leave the machine unless the user opts to sync them** into jobibot (default: CV stays local; only parsed CV data is in the local SQLite DB).
- Local DB is user-owned; the extension offers export + full delete.
- Outbox ensures sync is explicit, idempotent, and user-triggered.
- Analyses: structured verdict only. No server-side page scraping.
- Ghost reports (Phase 2) require a minimal proof signal (stage, dates, optional screenshot) and pass a review queue before affecting public score.

**Standalone guarantee:** all Phase 1 features (scan, verdict, CV local storage, application tracking) function with **no network, no account, no backend**. Cloud features only light up after explicit sync consent.

## 8. Monetization (sketch, not committed)
- Free: match score + ghost check + basic hold-back actions.
- Pro: deep hold-back roadmap, unlimited analyses, ghost-back automation, advanced filtering.
- Model parallels Ghoster (free tracking → AI tools as Pro).

## 9. Decisions locked (Fabio, 2026-10-06)
1. **Name:** **ghostHR**.
2. **Markets:** any job board with an ATS application form (Workable + generic forms), not just LinkedIn/Indeed.
3. **Ghosting DB:** **reuse jobibot** as the cloud DB/backend; add a ghost layer — reached only via opt-in sync.
4. **AI providers:** **local-first → Hugging Face → Doubleword → OpenRouter**.
5. **Stack:** Chrome extension — **TypeScript + Vite + MV3**; **local SQLite** for standalone local-first; **extend jobibot (Laravel)** for the opt-in cloud layer.
6. **Standalone-first (added):** the extension must work fully standalone (local SQLite, CV stays local, application tracker) so Fabio can test it immediately with no backend. Cloud sync is an explicit, later, opt-in feature.

## 10. Suggested next step
Write the implementation plan (Phase 1 MVP) with micro-steps and tests. **Priority: standalone extension first** — (a) scaffold TS/Vite/MV3 with local SQLite, (b) ATS form detector + CV parse/store locally + application tracker, (c) hold-back verdict routed across the AI providers, then (d) design the opt-in sync to jobibot. All on a dedicated feature branch, test-first, per the tracker workflow.
