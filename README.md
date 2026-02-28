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
- Memory controls:
  - In-memory local event cache capped at `10,000`.
  - In-memory imported event cache capped at `5,000`.
  - Virtualized event table rendering to prevent full-row DOM inflation.
- Collection settings (saved):
  - Auto-sync on startup.
  - Max events per sync.
  - Windows channel selection.
- LLM settings and discovery (foundation):
  - Provider profiles for `ollama`, `lmstudio`, `openai`, `gemini`, `claude`, `perplexity`, and generic `openai-compatible`.
  - Local provider detection for Ollama/LM Studio endpoints.
  - Optional LAN scan for Ollama/LM Studio endpoints on detected private subnets.
  - Preferred provider, trusted-host list, and untrusted-payload guardrail controls.
- Diagnostics logging:
  - JSONL app diagnostics written to `logs` under the app data directory.
  - Captures collector failures, access denied conditions, startup/runtime exceptions, and storage/settings read-write failures.
  - Automatic pruning retains only the most recent 7 days of log files.
- Security hardening:
  - CSV export now neutralizes formula-prefixed cells (`=`, `+`, `-`, `@`) to prevent spreadsheet formula injection.
  - Tauri app CSP is now explicitly configured (previously `null`).
  - CSV import parser now handles quoted fields and escaped quotes correctly (instead of naive `split(",")` parsing).
- UX:
  - Collapsible Analysis Panels (group + per panel).
  - Sticky table headers, sortable columns, and row detail footer actions.
  - Fixed top and bottom bars with scrollable middle content region.
  - Collector warning banner shown when sync/backfill completes with recoverable collector issues.
- Export and actions:
  - Export filtered/single events to JSON, CSV, or TXT.
  - Guided save dialog export workflow in desktop runtime.
  - Google search and copy-ready LLM prompt for selected event.
- Theme switcher: `System`, `Light`, `Dark`.

## Runtime model

- Startup can either:
  - load existing cached data only (default), or
  - auto-sync host logs when enabled in settings.
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
- Keep `Auto-sync on startup` disabled if startup responsiveness is the priority.
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
- Auto-sync on startup: off
- Max events per sync: 1000
- Channels: Application + System (enable Security when needed)

## Notes and troubleshooting

- Imported events are intentionally kept out of SQLite for performance and to avoid mixing live and imported data.
- Dependency audit status:
  - `npm audit` (including dev dependencies): 0 vulnerabilities.
  - `cargo audit`: 0 vulnerabilities (transitive GTK3 maintenance warnings remain on Linux-target dependency chain).
- Diagnostics logs location (daily files, 7-day retention):
  - Windows: `%LOCALAPPDATA%\hermes-log-analyst\logs\diagnostics-YYYY-MM-DD.log`
  - macOS: `~/Library/Application Support/hermes-log-analyst/logs/diagnostics-YYYY-MM-DD.log`
  - Linux: `~/.local/share/hermes-log-analyst/logs/diagnostics-YYYY-MM-DD.log`
- If sync/backfill succeeds with warnings (for example, access denied to a selected channel), the app shows a yellow warning status and details are also written to diagnostics logs.
- If no events appear for a chosen date range, confirm:
  - `Load Events` completed for that exact range.
  - Filters (date/log type/severity/category/text) are not excluding results.
  - Ingest profile settings are not overly restrictive for your use case.
- During `tauri dev`, this message is typically benign if app behavior is otherwise normal:
  - `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`

## Planned next

- LLM-assisted research panel and settings:
  - Local providers: Ollama and LM Studio (localhost detection + optional LAN discovery).
  - Cloud providers: OpenAI, Gemini, Claude, and Perplexity.
  - Generic OpenAI-compatible connector for custom/self-hosted endpoints.
  - OS-aware built-in prompt templates for Windows, Linux, and macOS event triage.
- Deeper crash artifact parsing and optional symbolication pipeline.
- Remote machine log access (future state): connect to remote host collectors for investigation without mandatory full download.
- Continue Garuda Linux (Arch-based) packaging/compatibility hardening (AppImage path and install validation).
