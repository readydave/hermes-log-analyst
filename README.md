# Hermes Log Analyst (HLA)

Hermes Log Analyst is a cross-platform desktop app for viewing and analyzing local system events on macOS, Linux, and Windows.

## Current capabilities

- OS-aware local event collection defaults to host OS.
- Event normalization across platforms with local SQLite caching.
- Real host collectors:
  - Windows: native Event Log API (wevtapi) for Application/System/Security.
  - Linux: `journalctl --since/--until -o json`.
  - macOS: `log show --style json` with start/end range.
- Crash workflow:
  - Host crash metadata import (Windows WER + dumps, macOS DiagnosticReports, Linux apport/coredump).
  - Crash correlation against local event timeline.
  - Pre-crash investigation window (5/15/30/60 min) for focused event triage.
- Filters:
  - Text, provider/source, severity, category, date range, Windows Event ID, and log type.
- Data Window:
  - Date-range `Load Events` with loading/ready status.
  - Ingest window controls.
  - Coverage hint and out-of-range warning.
- Collection settings (saved):
  - Auto-sync on startup.
  - Max events per sync.
  - Windows channel selection.
- UX:
  - Collapsible Analysis Panels (group + per panel).
  - Sticky table headers, sortable columns, and row detail footer actions.
  - Fixed top and bottom bars with scrollable middle content region.
- Export and actions:
  - Export filtered/single events to JSON or CSV.
  - Google search and copy-ready LLM prompt for selected event.
- Theme switcher: `System`, `Light`, `Dark`.

## Runtime model

- Startup can either:
  - auto-sync host logs (default), or
  - load existing cached data only.
- `Refresh Logs` pulls the configured ingest window using saved collection profile.
- `Load Events` in Data Window pulls the selected date range and applies a range-focused view.

## Launch modes and data source behavior

- `npm run tauri dev` (desktop runtime):
  - Uses real host collectors and SQLite cache.
  - Supports ingest profile persistence, crash import, and range sync commands.
- `npm run dev` (browser mode):
  - No OS log collection APIs are available.
  - The UI can still be explored with imported JSON/CSV and settings interactions.

## Startup and range-load guidance

For fastest Windows startup with useful signal:
- Keep `Auto-sync on startup` enabled.
- Start with `Application + System` channels; add `Security` when needed.
- Keep `Max events per sync` around `1000-5000` for interactive use.

For historical investigations:
1. Set `Backfill Range` in Data Window.
2. Click `Load Events`.
3. Wait for `Loading Events...` to finish and the green `Data loaded and ready: ...` status.
4. Apply/adjust Filters (including `log type`) against that loaded range.

## Tech stack

- Rust + Tauri backend shell
- React + TypeScript frontend
- SQLite cache (for local collected events)

## Run locally

1. Install toolchains:
   - Rust stable
   - Node.js 20+
2. Install frontend deps:
   - `npm install`
3. Run UI only (browser mode):
   - `npm run dev`
4. Run desktop app (Tauri):
   - `npm run tauri dev`

## Recommended Windows baseline

Use these defaults for fast startup with useful breadth:
- Auto-sync on startup: on
- Max events per sync: 1000
- Channels: Application + System (enable Security when needed)

## Notes and troubleshooting

- Imported events are intentionally kept out of SQLite for performance and to avoid mixing live and imported data.
- If no events appear for a chosen date range, confirm:
  - `Load Events` completed for that exact range.
  - Filters (date/log type/severity/category/text) are not excluding results.
  - Ingest profile settings are not overly restrictive for your use case.
- During `tauri dev`, this message is typically benign if app behavior is otherwise normal:
  - `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`

## Planned next

- Virtualized event rows for very large datasets.
- Remote machine connectors (SSH/WinRM).
- Deeper crash artifact parsing and optional symbolication pipeline.
- Application diagnostics logging:
  - write logs to `/logs`
  - cover access/read/write and runtime collector errors
  - keep only the last 7 days of log files
