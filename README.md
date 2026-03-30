# Hermes Log Analyst (HLA)

Hermes Log Analyst is a cross-platform desktop app for viewing and analyzing host and remote system events on macOS, Linux, and Windows.

## Current capabilities

- OS-aware local event collection defaults to host OS.
- Event normalization across platforms with local SQLite caching and per-row `source_host` tracking.
- Real host collectors:
  - Windows: native Event Log API (wevtapi) for Application/System/Security.
  - Linux: `journalctl --since/--until -o json`.
  - macOS: `log show --style json` with start/end range.
- Remote host collection:
  - Linux via SSH.
  - macOS via:
    - SSH for direct remote-log access when Remote Login is enabled
    - Jamf Pro for managed-device lookup and provider-backed evidence collection
    - Microsoft Intune for managed-device lookup and queued/polling evidence collection
  - Windows via:
    - WinRM for direct PowerShell-remoting collection
    - Remote Event Log + WMI/DCOM (`RPC/DCOM`) as the first non-WinRM direct fallback
    - Microsoft Intune for managed-device lookup and queued/polling evidence collection
  - Saved remote-host profiles and target switching across data-loading views.
  - Dedicated remote `Test Connection` flow in Settings for validating transport/provider readiness before a log pull.
  - Current supported remote SSH path is key-based auth; interactive SSH password auth is not implemented.
- Crash workflow:
  - Host crash metadata import (Windows WER + dumps, macOS DiagnosticReports, Linux apport/coredump).
  - Crash correlation against local event timeline.
  - Pre-crash investigation window (5/15/30/60 min) for focused event triage.
  - Metadata-and-evidence dump analysis for Windows minidumps/kernel dumps and Linux core dumps.
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
- LLM settings, execution, and discovery:
  - Provider profiles for `ollama`, `lmstudio`, `openai`, `gemini`, `claude`, `perplexity`, and generic `openai-compatible`.
  - API-key storage in the OS keychain for supported cloud/generic profiles.
  - Connection testing with detected model lists and preferred/active-model auto-selection.
  - Saved default LLM profile is preselected in send/RCA windows, with a connection preflight before first analysis use.
  - Local LLM analysis for selected events and crash RCA packets.
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
  - Home dashboard analytics for timeline, severity, providers, log types, Windows Event IDs, and noisy-source drilldown.
  - Target-host selection for switching between `localhost` and saved remote profiles.
  - Selected-event `Raw` / `Parsed` message view for structured payload inspection.
- Export and actions:
  - Export filtered/single events to JSON, CSV, or TXT.
  - Export scoped Ops Summary reports as plain text or HTML (print/PDF-ready).
  - Guided save dialog export workflow in desktop runtime.
  - Google search and copy-ready LLM prompt for selected event.
- Theme switcher: `System`, `Light`, `Dark`.

## Runtime model

- Startup can either:
  - load existing cached data only (default), or
  - auto-sync host logs when enabled in settings.
- Selecting a target host in the top bar does not connect immediately; it only changes the active target context.
- `Refresh Logs` pulls the configured ingest window for `localhost` or the selected remote target using the saved collection profile.
- `Load Events` in Data Window is fully supported for `localhost`; remote exact-range loading still needs hardening and should not yet be treated as complete remote parity.

## Launch modes and data source behavior

- `npm run tauri dev` (desktop runtime):
  - Uses real host collectors and SQLite cache.
  - Supports ingest profile persistence, remote-host targeting, crash import, dump analysis, LLM execution, and range sync commands.
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
- LLM/provider connectivity is not considered release-stable yet:
  - localhost/LAN/cloud profile configuration exists, but end-to-end connection reliability still needs hardening and full cross-platform validation.
  - treat `Copy LLM Prompt` / prompt-only workflows as the fallback path when provider connectivity is unreliable.
- Remote host collection is implemented, but the credential UX is still rough:
  - SSH key-path workflows are wired in the Settings UI.
  - SSH password auth is not implemented for Linux/macOS remote collection.
  - Jamf Pro and Intune provider tokens can be stored in the OS keychain from Settings.
  - Windows `WinRM` / `RPC/DCOM` password workflows are now wired to per-profile OS-keychain secret storage.
  - remote crash import is not implemented yet.
  - Jamf Pro / Intune macOS collection currently returns managed-device troubleshooting evidence rather than a true remote `log show` slice.
  - Windows Intune collection currently returns managed-device troubleshooting evidence rather than live Event Log transport.
- If no events appear for a chosen date range, confirm:
  - `Load Events` completed for that exact range.
  - Filters (date/log type/severity/category/text) are not excluding results.
  - Ingest profile settings are not overly restrictive for your use case.
- If a remote host refresh returns zero events or fails:
  - Linux/macOS SSH targets must already be reachable non-interactively (for example via key file or ssh-agent).
  - Linux remote users must have permission to read `journalctl`.
  - macOS SSH users only see what `log show` permits for that account.
  - Jamf Pro and Intune macOS targets must exist as uniquely resolvable managed devices for the configured provider account.
  - Windows `RPC/DCOM` depends on Remote Event Log Management plus WMI/DCOM firewall access on the target.
  - Windows Intune targets must exist as uniquely resolvable managed devices for the configured provider account.
- During `tauri dev`, this message is typically benign if app behavior is otherwise normal:
  - `Failed to unregister class Chrome_WidgetWin_0. Error = 1412`

## Planned next

- LLM-assisted research panel and settings:
  - Local providers: Ollama and LM Studio (localhost detection + optional LAN discovery).
  - Cloud providers: OpenAI, Gemini, Claude, and Perplexity.
  - Generic OpenAI-compatible connector for custom/self-hosted endpoints.
  - OS-aware built-in prompt templates for Windows, Linux, and macOS event triage.
- Connectivity stabilization for the LLM layer:
  - harden local/LAN/cloud endpoint testing and profile application behavior.
  - complete manual validation on Windows, macOS, and Garuda before treating provider flows as production-ready.
- Deeper crash artifact parsing and optional symbolication pipeline.
- Remote collection hardening:
  - deepen managed macOS provider collection from inventory/evidence summaries into true remote script-based log gathering.
  - deepen Windows Intune collection beyond inventory/evidence summaries into a richer managed diagnostics payload.
  - continue tightening credential UX and validation for SSH/WinRM/RPC targets.
  - decide whether Linux/macOS SSH remains key-only or gains supported password auth.
  - make remote exact-range `Load Events` target-aware.
  - expand remote crash import and follow-on investigation workflows.
- Continue Garuda Linux (Arch-based) packaging/compatibility hardening (AppImage path and install validation).
