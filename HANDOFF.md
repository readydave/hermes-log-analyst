# Hermes Log Analyst - Handoff

## Repo
- Path: `C:\Code\hermes`
- Branch: `main`
- Stack: React + TypeScript + Tailwind (Vite), Rust + Tauri, SQLite
- Status date: `2026-02-09`

## Current Product State
- Desktop-first log triage app with real host collectors and local SQLite cache.
- UI layout now keeps top action bar and bottom selected-event bar always visible.
- Middle content region is scrollable so Filters/Data Window do not hide core actions.
- Analysis panels can be:
  - hidden as a full group
  - collapsed/expanded all at once
  - collapsed individually (Crash Correlation, Filters, Data Window)

## Implemented Capabilities
- Event collection:
  - Windows: native Event Log API (`Application`, `System`, `Security`) with selectable channels.
  - Linux: `journalctl --since/--until -o json`.
  - macOS: `log show --style json`.
- Crash workflow:
  - host crash import (metadata-first)
  - crash-to-event correlation
  - pre-crash focus (`5/15/30/60 min`)
- Filtering and analysis:
  - text, provider/source, category, severity, date range, Windows Event ID, and log type
  - sortable table with sticky headers and reset sort
  - clear selection + per-event actions in footer
- Data Window:
  - configurable ingest window (days)
  - explicit date-range `Load Events`
  - loading state and success status: `Data loaded and ready: ...`
  - range-focused view reminder to return with `Refresh Logs`
- Export/actions:
  - filtered and single-event export to JSON/CSV
  - Google search and copy-ready LLM prompt
- Settings persistence:
  - theme
  - export directory
  - ingest profile (`autoSyncOnStartup`, `maxEventsPerSync`, `windowsChannels`)

## Data and Settings Model
- Ingest window default: `7` days.
- Ingest profile default:
  - `autoSyncOnStartup: true`
  - `maxEventsPerSync: 2000` (clamped `100..20000`)
  - Windows channels default: `Application,System,Security`
- Settings location (Windows): `%LOCALAPPDATA%\hermes-log-analyst\`
  - `ingest_window_days.txt`
  - `ingest_profile.json`
  - `theme.txt`
  - `export_dir.txt`

## Runtime Behavior
- `npm run tauri dev`:
  - full host collection and persistence enabled
  - startup auto-sync runs if enabled in ingest profile
- `npm run dev`:
  - browser mode, no host collector bridge
  - UI still works with imported data and frontend controls

## Known Caveats
- Crash import is metadata-first (no deep dump/core symbolication yet).
- Large ranges plus high max-event settings can still create startup/refresh latency.
- Ingest telemetry is basic; per-channel timing/count breakdown is not yet surfaced.
- Common terminal message during `tauri dev` is usually benign:
  - `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`

## Objective Recheck (2026-02-09)
- 1) UX polish (coverage hint + out-of-range warning): `done`
- 2) Crash importers (metadata-first): `done`
- 3) Performance (virtualized table rows): `pending`
- 4) Remote machine support (SSH/WinRM): `pending`
- Notes:
  - Collectors objective is complete (native Windows/macOS/Linux collectors in place).
  - Crash correlation supports host-imported metadata.
  - Log-type filtering and persisted ingest profile controls are complete.

## Next Work Items (Recommended)
1. Add table virtualization for large datasets.
2. Add remote machine connectors (SSH/WinRM).
3. Enrich crash importers with minidump/panic/core parsing and optional symbolication.
4. Add ingest diagnostics in UI (per-channel counts + timing).
5. Add application diagnostics logging:
   - write structured app logs to `/logs`
   - capture typical operational failures (access denied, read/write failures, collector errors, startup/sync exceptions)
   - enforce retention to keep only the last 7 days of log files
6. After the above items, target Garuda Linux (Arch-based) validation and compatibility hardening.

## Quick Validation Checklist
1. Run `npm run tauri dev`.
2. Confirm startup auto-sync behavior matches setting.
3. Set Backfill Range and click `Load Events`; verify loading and ready statuses.
4. Apply log-type filter and confirm visible rows update as expected.
5. Select/clear event selection and confirm footer actions enable/disable correctly.

## Planned Logging Spec (Not Yet Implemented)
- Scope:
  - backend/runtime operational logs for troubleshooting and support
  - include access errors, file/db read-write failures, and collector/runtime exceptions
- Storage:
  - persist to `/logs` directory
  - rotate/prune so only the most recent 7 days are retained
- Follow-up implementation notes:
  - initialize logger during app startup
  - include timestamp, level, subsystem, and error context in each entry
  - add startup check that prunes stale log files before normal operations

## How to run
- `npm install`
- `npm run tauri dev`
