# ghostHR

A browser extension (Chromium / Chrome-based) that helps candidates **ghost back**.

Three capabilities, one extension:
1. **CV ↔ job scan → "hold back" with specific prep** (not just a match %).
2. **Application tracker** — local, standalone, with a local SQLite DB.
3. **Ghosting DB as a pre-apply gate + "ghost back" loop** — reached via opt-in sync to **jobibot** (Phase 2+).

## Standalone-first (MVP)
- Works fully offline: scan job + CV → verdict, track applications, store parsed CV locally.
- CV file never leaves the machine by default.
- Cloud sync (jobibot) is an explicit opt-in (Phase 2+).

## Stack
- Chrome extension: TypeScript + Vite + MV3, local WASM SQLite.
- Cloud backend (Phase 2+): extend **jobibot** (Laravel).
- AI routing: local-first → Hugging Face → Doubleword → OpenRouter.

## Status
Spec only — see `.specs/plans/spec.md`. Build in progress.
