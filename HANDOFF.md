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
- Memory controls:
  - startup auto-sync default disabled (`autoSyncOnStartup: false`)
  - in-memory local event cache cap: `10,000`
  - in-memory imported event cache cap: `5,000`
  - virtualized event-table row rendering (only viewport rows + overscan)
- Export/actions:
  - filtered and single-event export to JSON/CSV
  - Google search and copy-ready LLM prompt
- Settings persistence:
  - theme
  - export directory
  - ingest profile (`autoSyncOnStartup`, `maxEventsPerSync`, `windowsChannels`)
- Diagnostics logging:
  - daily JSONL diagnostics logs (`diagnostics-YYYY-MM-DD.log`)
  - automatic 7-day retention prune on startup/day rollover
  - captures collector issues (including access denied), startup/runtime exceptions, and storage/settings failures
  - sync/backfill warning details are surfaced in UI when collection is partially successful
- Security hardening:
  - CSV export formula-injection mitigation on frontend and backend export paths
  - explicit Tauri CSP configured (replaced `csp: null`)
  - CSV import parser upgraded from naive comma split to quoted-field parser
  - frontend dev toolchain upgraded to Vite 7.x (`npm audit` now clean)

## Data and Settings Model
- Ingest window default: `7` days.
- Ingest profile default:
  - `autoSyncOnStartup: false`
  - `maxEventsPerSync: 2000` (clamped `100..20000`)
  - Windows channels default: `Application,System,Security`
- Settings location (Windows): `%LOCALAPPDATA%\hermes-log-analyst\`
  - `ingest_window_days.txt`
  - `ingest_profile.json`
  - `theme.txt`
  - `export_dir.txt`
  - `logs\diagnostics-YYYY-MM-DD.log`

## Runtime Behavior
- `npm run tauri dev`:
  - full host collection and persistence enabled
  - startup auto-sync runs if enabled in ingest profile
  - diagnostics logger initializes at startup and prunes stale log files older than 7 days
- `npm run dev`:
  - browser mode, no host collector bridge
  - UI still works with imported data and frontend controls

## Known Caveats
- Crash import is metadata-first (no deep dump/core symbolication yet).
- Large ranges plus high max-event settings can still create startup/refresh latency.
- Ingest telemetry is basic; per-channel timing/count breakdown is not yet surfaced.
- Collector warning details are summarized in UI; full context remains diagnostics-log first.
- Local/imported event lists are memory-capped; large loads are intentionally truncated in-memory for stability.
- `cargo audit` reports no vulnerabilities, but Linux-target transitive GTK3 dependencies are flagged as unmaintained/unsound informational warnings via Tauri/Wry stack.
- Common terminal message during `tauri dev` is usually benign:
  - `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`

## Objective Recheck (2026-02-09)
- 1) UX polish (coverage hint + out-of-range warning): `done`
- 2) Crash importers (metadata-first): `done`
- 3) Performance (virtualized table rows): `done`
- 4) Remote machine support (SSH/WinRM): `pending`
- Notes:
  - Collectors objective is complete (native Windows/macOS/Linux collectors in place).
  - Crash correlation supports host-imported metadata.
  - Log-type filtering and persisted ingest profile controls are complete.

## Next Work Items (Recommended)
1. Add remote machine connectors (SSH/WinRM).
2. Enrich crash importers with minidump/panic/core parsing and optional symbolication.
3. Add ingest diagnostics in UI (per-channel counts + timing).
4. After the above items, target Garuda Linux (Arch-based) validation and compatibility hardening.

## Quick Validation Checklist
1. Run `npm run tauri dev`.
2. Confirm startup auto-sync behavior matches setting.
3. Set Backfill Range and click `Load Events`; verify loading and ready statuses.
4. Apply log-type filter and confirm visible rows update as expected.
5. Select/clear event selection and confirm footer actions enable/disable correctly.

## Diagnostics Logging Implementation
- Logger module: `src-tauri/src/diagnostics.rs`
  - writes JSONL records with `timestamp`, `level`, `subsystem`, and `message`
  - file naming: `diagnostics-YYYY-MM-DD.log`
- Log directory:
  - resolved via `dirs::data_local_dir()/hermes-log-analyst/logs`
  - on Windows this is `%LOCALAPPDATA%\hermes-log-analyst\logs`
- Retention:
  - startup prune removes log files older than 7 days
  - day rollover also triggers prune after opening the next daily log
- Collector behavior changes:
  - collectors now return structured `events + warnings + errors`
  - sync/backfill commands fail when collectors return no events and hard errors
  - partial-success collection warnings are returned to UI and logged

## How to run
- `npm install`
- `npm run tauri dev`
