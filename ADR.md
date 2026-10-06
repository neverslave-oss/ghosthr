# ADR-001 — Standalone-first Chrome extension (MV3) with local SQLite

**Status:** Accepted
**Date:** 2026-10-06

## Context
ghostHR is a browser extension to help candidates decide whether to apply to a
job and track their applications. To be immediately testable, it must work
standalone — no backend, no account, no network. Cloud features (a
crowdsourced ghosting DB) are a later, explicitly opt-in addition.

## Decision
1. **Chrome extension, Manifest V3**, built with **TypeScript + Vite**.
2. **Local SQLite** (WASM) as the local data store — CV parse, applications,
   analyses, sync outbox, cached ghost flags.
3. **CV file stays on the user's machine**; only parsed CV data is stored locally.
4. **Cloud = Phase 2+**: extend **jobibot** (Laravel) with a ghost layer, reached
   only through an explicit opt-in sync.
5. **AI routing order:** local-first → Hugging Face → Doubleword → OpenRouter.

## Consequences
- MVP is fully usable offline and immediately testable.
- Cloud sync must be idempotent (outbox with stable event ids).
- Extension must degrade gracefully across ATS DOM changes (Workable + generic forms).
