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

## v0.2 Roadmap Draft (Packaging + Local LLM)

### Scope Goals
- Ship polished downloadable builds for Windows, macOS, and Linux (including Garuda/Arch users).
- Add local LLM provider support with both Ollama and LM Studio.
- Add provider auto-detection on localhost and optional LAN discovery with clear data-sensitivity warnings.
- Keep "Generate Prompt Only" as a no-LLM fallback path.

### Milestone 1 - Release Engineering Baseline
- Add versioned release process and artifact naming conventions.
- Produce platform artifacts: Windows `msi` + `nsis` + portable `.exe`; macOS `.app` + `.dmg`; Linux `AppImage` + `deb` + `rpm`.
- Add Arch/Garuda path with an AUR package (`PKGBUILD`) that installs binary + desktop entry.

Acceptance criteria:
1. Clean build artifacts generated per platform using tagged release version.
2. Install, launch, and uninstall validated on Win11, latest macOS, and Garuda.
3. Checksums (`sha256`) generated for all downloadable artifacts.

### Milestone 2 - Local LLM Provider Layer (Ollama + LM Studio)
- Add provider abstraction in backend/frontend with provider ids `ollama` and `lmstudio`.
- Support common provider actions: list models, test connection, submit prompt, return response.
- Add localhost auto-detection on startup/manual refresh:
- Ollama probe: `http://127.0.0.1:11434/api/tags`.
- LM Studio probe (OpenAI-compatible): `http://127.0.0.1:1234/v1/models`.
- Add provider settings UI for preferred provider, model, timeout, max tokens, and temperature.
- Keep fallback mode: "Prompt only (no model call)".

Acceptance criteria:
1. App can detect and connect to Ollama and LM Studio when running locally.
2. User can choose provider/model and run log-entry lookup from selected event.
3. Connection failures are surfaced as actionable warnings and diagnostics log entries.

### Milestone 3 - LAN Discovery (Optional, Security-First)
- Add a separate opt-in action: `Discover providers on LAN`.
- Default behavior: LAN scanning disabled; localhost detection always allowed.
- Scan strategy: probe active-interface RFC1918 ranges on configured ports (`11434`, `1234` by default) using lightweight health/model endpoint checks only.
- Safety UX and trust controls: first-use warning modal; discovered hosts default to `Untrusted`; per-host trust allowlist persisted in settings.
- Add guardrail (default on): `Never send raw event message to untrusted hosts`.

Acceptance criteria:
1. LAN discovery requires explicit user action and consent.
2. No event payload is sent during discovery; only probe requests are used.
3. Untrusted/trusted state is enforced before inference calls.

### Milestone 4 - LLM-Assisted Analysis UX
- Add `Analyze with Local LLM` action on selected event and filtered set summary.
- Add prompt templates: single-event explanation, root-cause hypotheses, remediation checklist, and suggested search queries.
- Include response provenance in UI: provider, model, host, timestamp, trusted/untrusted status.
- Add export option including prompt + response metadata.

Acceptance criteria:
1. User can run one-click analysis from selected event.
2. Response metadata and provenance are visible and exportable.
3. Prompt-only path remains available when no provider is selected/reachable.

### Milestone 5 - Device/Hardware Log Expansion (Post-v0.2)
- Add additional collectors while preserving normalized schema.
- Linux sources: `journalctl -k`, `dmesg`.
- Windows sources: additional hardware/device-relevant channels.
- macOS sources: hardware/system diagnostics-related unified log categories.
- Add source tags (`system`, `application`, `hardware`, `device`) for filtering and LLM prompt context.

Acceptance criteria:
1. New log sources are queryable without breaking existing filters/export.
2. LLM prompts include source tags and platform-specific context safely.

### Implementation Notes
- Add new settings file for LLM configuration and trusted LAN hosts (under app data dir).
- Add diagnostics entries for provider detection results, LAN scan start/end and host counts, and blocked/untrusted inference attempts.
- Keep network operations in backend (Rust) and expose typed Tauri commands to frontend.

### Test Matrix for User-Owned Devices
- Windows 11: verify installer + portable launch, local Ollama and LM Studio detection.
- macOS (latest): verify app launch, codesign/notarization path, local provider detection.
- Garuda Linux: verify AppImage + AUR install path, `journalctl` permissions behavior, local and optional LAN provider discovery.

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

## Platform Validation Template (Live Data Only)

Use this template when validating on each machine (Windows/macOS/Garuda). Do not use imported or dummy data for this pass.

### Validation Record
- Date:
- Operator:
- Machine label:
- OS + version:
- Repo commit (`git rev-parse --short HEAD`):
- Branch:

### Preflight Environment Check
1. Run `npm install`.
2. Run `npm run build`.
3. Run `npm run tauri info`.
4. Record any missing toolchain/runtime dependencies.

Result:
- Build status:
- Tauri info status:
- Notes:

### Live Log Readiness Check (No Dummy Data)
1. Launch app with `npm run tauri dev`.
2. Use host collectors only (`Refresh Logs` and/or `Load Events`).
3. Confirm non-zero live events are collected from host OS.
4. Confirm filtering and sorting operate on live events.
5. Confirm no JSON/CSV import is required to test baseline behavior.

Result:
- Live event collection status:
- Approx live events visible:
- Collector warnings/errors:
- Notes:

### Core Functional Validation
1. Refresh collection succeeds and updates data window.
2. Date-range `Load Events` succeeds with expected status messages.
3. Crash import command runs and returns host crash metadata (or clear zero-result behavior).
4. Export filtered events to CSV and JSON succeeds.
5. Google search action and prompt-copy action work from selected event.

Result:
- Refresh:
- Range load:
- Crash import:
- Export CSV/JSON:
- Search + prompt:
- Notes:

### Packaging Validation
1. Run `npm run tauri build`.
2. Confirm artifacts exist for platform packaging format(s).
3. Install and launch packaged app.
4. Confirm uninstall path works.

Result:
- Bundle build status:
- Artifact paths:
- Install/launch status:
- Uninstall status:
- Notes:

### Forward Readiness Check (Planned Functionality)

#### Local LLM Provider Readiness
1. Verify localhost reachability checks:
   - Ollama candidate endpoint: `http://127.0.0.1:11434/api/tags`
   - LM Studio candidate endpoint: `http://127.0.0.1:1234/v1/models`
2. Record whether either service is running on this machine.
3. Record expected default provider choice for this machine.

Result:
- Ollama reachable:
- LM Studio reachable:
- Preferred provider:
- Notes:

#### LAN Discovery Readiness
1. Confirm whether LAN scanning is allowed in your environment.
2. Confirm user-warning requirement is understood for unknown hosts and sensitive data.
3. Note any firewall, VLAN, or policy constraints that would affect discovery.

Result:
- LAN scan allowed:
- Network constraints:
- Risk notes:

### Overall Status
- Platform status: `pass` | `pass-with-caveats` | `fail`
- Blockers:
- Recommended next actions:
- Owner:
