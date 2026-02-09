# Hermes Log Analyst – Handoff

## Repo
- Path: C:\Code\hermes
- Branch: main
- Stack: React + TypeScript + Tailwind (Vite), Rust + Tauri, SQLite

## Current UI/UX
- Glassmorphism Tailwind theme with centered max width (max-w-screen-2xl).
- Unified Button component (primary / secondary / danger).
- Table: sticky headers, fixed widths for Time/Severity, merged Log+Category into Type.
- Top Correlated Events shown as tags (process + severity), full message on hover via title.
- Selected Event footer with empty state.
- Filters are collapsible with Apply workflow.
- Data Window (ingest + backfill) now lives under Filters (Option C).

## Key Features Implemented
- Local SQLite cache for events + crashes.
- Crash model + correlation query.
- Host crash importer (metadata-first) with OS-specific source scanning and dedupe by source path.
- Prompt redaction & improved prompt template (security risk flagging; commands in code fences).
- Export settings with saved export directory.
- Theme persistence across launches.
- Sortable columns with reset sort.

## Ingest / Backfill Model
- Default ingest window: 7 days (configurable).
- Settings stored in local config files.
- Ingest sync uses date ranges; pruning of old rows based on ingest window.
- Backfill range supported (1–365 days).

## Collector Status
- Windows: native Event Log API (wevtapi) across Application/System/Security, XML render + message formatting.
- macOS: Unified Logging via `log show --style json` with start/end range.
- Linux: journald via `journalctl --since/--until -o json`.
- All platforms fall back to seeded events if collection fails.

## What’s Still Stubbed
- Crash importers are metadata-first (no deep dump/panic symbolication yet).

## Next Work Items (Recommended)
1) Performance: virtualized table rows
2) Remote machine support (SSH/WinRM)
3) Crash importer depth:
   - Minidump / panic / core parser enrichment
   - Optional symbolication pipeline

## Objective Recheck (2026-02-09)
- 1) UX polish (coverage hint + out-of-range warning): `done`
- 2) Crash importers (metadata-first): `done`
- 3) Performance (virtualized table rows): `pending`
- 4) Remote machine support (SSH/WinRM): `pending`
- Notes:
  - Collectors objective from prior handoff is complete (native Windows/macOS/Linux collectors now in place).
  - Crash correlation now supports real host-imported crash metadata (`import_host_crashes`) plus sample crash generation for demos.

## How to run
- `npm install`
- `npm run tauri dev`
