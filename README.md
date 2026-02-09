# Hermes Log Analyst (HLA)

Hermes Log Analyst is a cross-platform desktop app for viewing and analyzing local system events on macOS, Linux, and Windows.

## MVP goals

- OS-aware local event collection defaults to host OS.
- Event normalization across platforms.
- Severity colors: `Information` (blue), `Warning` (yellow), `Error` (orange), `Critical` (red).
- Filters: date range, event id, severity, category, source, text.
- Event actions: Google search and copy-ready LLM prompt.
- Export: single event or filtered log to JSON/CSV.
- Import: Windows/Linux/macOS exported logs for ad-hoc viewing (session-only, not persisted).
- Theme switcher: `System`, `Light`, `Dark`.

## Planned after MVP

- Remote machine connectors (SSH, WinRM) for sysadmin workflows.
- Authenticated read-only connectors and credential vault integration.

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
3. Run UI only (browser fallback):
   - `npm run dev`
4. Run desktop app (Tauri):
   - `npm run tauri dev` (after adding tauri CLI if needed)

## Notes

- Imported events are intentionally kept out of SQLite for performance and to avoid mixing live and imported data.
- Windows collector uses the native Event Log API (wevtapi) for Application/System/Security and falls back to seeded events on failure.
- Linux collector uses `journalctl --since/--until -o json`.
- macOS collector uses `log show --style json` with start/end ranges.
- Crash import supports host metadata import (Windows WER + dumps, macOS DiagnosticReports, Linux apport/coredump) and stores normalized crash records for correlation.
