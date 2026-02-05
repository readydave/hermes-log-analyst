# Hermes Log Analyst – Handoff

## Repo
- Path: /Users/dave/Documents/code/hermes
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
- Prompt redaction & improved prompt template (security risk flagging; commands in code fences).
- Export settings with saved export directory.
- Theme persistence across launches.
- Sortable columns with reset sort.

## Ingest / Backfill Model
- Default ingest window: 7 days (configurable).
- Settings stored in local config files.
- Ingest sync uses date ranges; pruning of old rows based on ingest window.
- Backfill range supported (1–365 days).

## What’s Still Stubbed
- Linux/macOS collectors are seeded (no real log data yet).
- Windows collector uses PowerShell (Get-WinEvent) with max events.
- Real crash importers not implemented yet.

## Next Work Items (Recommended)
1) Implement real log collectors:
   - macOS: Unified Logging (`log show --start --end`)
   - Linux: journald (`journalctl --since/--until`)
   - Windows: native Event Log API for scale/perf
2) UX polish:
   - Data coverage hint (ingested range)
   - Warning if filters outside ingested range
3) Crash importers (metadata-first)
4) Performance: virtualized table rows
5) Remote machine support (SSH/WinRM)

## How to run
- `npm install`
- `npm run tauri dev`
