# Hermes Log Analyst - Handoff

## Repo
- Path (Linux): `/home/dave/scripts/hermes-log-analyst`
- Path (Windows): `C:\Code\hermes`
- Branch: `main`
- Stack: React + TypeScript + Tailwind (Vite), Rust + Tauri, SQLite
- Status date: `2026-02-27`

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

### Milestone 2 - LLM Provider Layer (Local + Cloud + Generic)
- Add provider abstraction in backend/frontend with provider ids:
  - local: `ollama`, `lmstudio`
  - cloud: `openai`, `gemini`, `claude`, `perplexity`
  - generic: `openai_compatible` (free-form base URL + key + model mapping)
- Support common provider actions: list models, test connection, submit prompt, return response.
- Add localhost auto-detection on startup/manual refresh:
  - Ollama probe: `http://127.0.0.1:11434/api/tags`
  - LM Studio probe (OpenAI-compatible): `http://127.0.0.1:1234/v1/models`
- Add provider settings UI for preferred provider, model, endpoint (when applicable), timeout, max tokens, and temperature.
- Keep fallback mode: "Prompt only (no model call)".
- Add built-in prompt templates with OS-aware variants for Windows, Linux, and macOS.

Acceptance criteria:
1. App can detect and connect to Ollama and LM Studio when running locally.
2. App can connect to OpenAI, Gemini, Claude, Perplexity, and a generic OpenAI-compatible endpoint using saved credentials.
3. User can choose provider/model and run log-entry lookup from selected event with OS-aware prompt templates.
4. Connection failures are surfaced as actionable warnings and diagnostics log entries.

### Milestone 3 - LAN Discovery (Optional, Security-First)
- Add a separate opt-in action: `Discover providers on LAN`.
- Default behavior: LAN scanning disabled; localhost detection always allowed.
- Scan strategy: determine local subnet(s) from active interfaces, then probe RFC1918 hosts on configured ports (`11434`, `1234` by default) using lightweight health/model endpoint checks only.
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
- Store provider secrets per platform-secure mechanism where possible (OS credential vault/keychain); avoid plaintext API keys in app settings files.
- Add diagnostics entries for provider detection results, LAN scan start/end and host counts, and blocked/untrusted inference attempts.
- Keep network operations in backend (Rust) and expose typed Tauri commands to frontend.

### Test Matrix for User-Owned Devices
- Windows 11: verify installer + portable launch, local Ollama/LM Studio detection, and at least one cloud provider + generic endpoint connectivity.
- macOS (latest): verify app launch, codesign/notarization path, local provider detection, and at least one cloud provider + generic endpoint connectivity.
- Garuda Linux: verify AppImage + AUR install path, `journalctl` permissions behavior, local/LAN provider discovery, and at least one cloud provider + generic endpoint connectivity.

## Future State Backlog
- Remote machine log access:
  - connect to remote hosts for targeted investigation
  - avoid full log downloads unless explicitly requested
  - preserve local-first security defaults and explicit consent prompts for remote access

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

## Platform Validation Result - Garuda Linux (Live Data Only)

### Validation Record
- Date: 2026-02-27
- Operator: dave
- Machine label: daddslinux
- OS + version: Garuda Linux (KDE on Wayland)
- Repo commit (`git rev-parse --short HEAD`): `d558277`
- Branch: `main`

### Preflight Environment Check
1. `npm install` -> success (`added 142 packages`), but reported `1 high severity vulnerability`.
2. `npm run build` -> success (`vite v7.3.1`, built dist assets).
3. `npm run tauri info` -> success (Tauri/Rust/WebKit detected on this host).
4. Missing toolchain/runtime dependencies observed during validation:
   - `dpkg-deb` not installed (`/bin/bash: line 1: dpkg-deb: command not found`).
   - No passwordless sudo for package install/uninstall checks (`sudo -n true` exit code `1`).

Result:
- Build status: `pass` (`npm run build` succeeded).
- Tauri info status: `pass`.
- Notes: Preflight passed, but packaging/install tooling is incomplete for full local install/uninstall verification.

### Live Log Readiness Check (No Dummy Data)
1. `npm run tauri dev` (Wayland default) compiled but app terminated with `Gdk-Message ... Error 71 (Protocol error) dispatching to Wayland display`.
2. `env GDK_BACKEND=x11 npm run tauri dev` ran long enough for startup sync.
3. Host-data evidence:
   - `~/.local/share/hermes-log-analyst/events.db` created.
   - `sqlite3 ... "select count(*) from events;"` -> `4000`.
   - `sqlite3 ... "select sum(imported) from events;"` -> `0` (no imported/dummy data).
4. Live collector-equivalent range command checks:
   - `journalctl --since "2026-02-20 ..." --until "2026-02-27 ..." -o json -n 2000 | wc -l` -> `2000`.
   - `journalctl --since "2026-02-26 00:00:00" --until "2026-02-27 23:59:59" -o json -n 2000 | wc -l` -> `2000`.
5. Sorting/filterability evidence on live DB:
   - `select severity,count(*) ...` -> `information 3624`, `warning 360`, `critical 16`.
   - `select ... order by timestamp desc limit 3` returned latest-first rows.

Result:
- Live event collection status: `pass-with-caveat` (works with `GDK_BACKEND=x11`; Wayland launch unstable).
- Approx live events visible: `4000` in local SQLite cache.
- Collector warnings/errors: No collector warning/error entries observed in diagnostics; startup diagnostics entries present.
- Notes: No JSON/CSV import used; all validation data came from host `journalctl` and app startup sync.

### Core Functional Validation
1. Refresh collection succeeds and updates data window.
2. Date-range `Load Events` succeeds with expected status messages.
3. Crash import command runs and returns host crash metadata (or clear zero-result behavior).
4. Export filtered events to CSV and JSON succeeds.
5. Google search action and prompt-copy action work from selected event.

Result:
- Refresh: `partial-pass` (startup auto-sync populated DB; GUI confirmation of data-window text not captured due unstable GUI automation).
- Range load: `partial-pass` (range collector command path validated via live `journalctl` output; GUI status text `Data loaded and ready...` not directly observed).
- Crash import: `partial-pass` (host crash artifacts exist: `/var/lib/systemd/coredump` count `25`; direct button-command invocation not reliably automated in this session).
- Export CSV/JSON: `blocked` (top-bar export button clicks could not be deterministically automated under current Wayland/X11 bridge behavior).
- Search + prompt: `blocked` (requires deterministic row selection + action-click/clipboard checks; GUI automation unreliable here).
- Notes: Blockers are UI automation/display-environment constraints, not imported-data constraints.

### Packaging Validation
1. `npm run tauri build`.
2. Confirm artifacts exist.
3. Install and launch packaged app.
4. Confirm uninstall path.

Result:
- Bundle build status: `partial-pass`.
  - `.deb` and `.rpm` built.
  - AppImage bundling failed.
- Artifact paths:
  - `src-tauri/target/release/bundle/deb/Hermes Log Analyst_0.1.0_amd64.deb`
  - `src-tauri/target/release/bundle/rpm/Hermes Log Analyst-0.1.0-1.x86_64.rpm`
  - `src-tauri/target/release/bundle/appimage/Hermes Log Analyst.AppDir/` (AppImage final file not produced)
- Install/launch status:
  - Launch test of release binary: `timeout 15 env GDK_BACKEND=x11 ./src-tauri/target/release/hermes-log-analyst` -> process stayed up until timeout (exit `124`), emitted `Failed to create GBM buffer ...` warning.
  - Package install test: `blocked` (no passwordless sudo; cannot perform system install/uninstall in this run).
- Uninstall status: `blocked` (install step blocked).
- Notes:
  - AppImage blocker: linuxdeploy strip errors on RELR sections, e.g. `unknown type [0x13] section '.relr.dyn'`, ending with `failed to bundle project 'failed to run .../linuxdeploy-x86_64.AppImage'`.

### Forward Readiness Check (Planned Functionality)

#### Local LLM Provider Readiness
Result:
- Ollama reachable: `yes` (`curl http://127.0.0.1:11434/api/tags` -> `HTTP 200`; model list returned including `gemma3:latest`).
- LM Studio reachable: `no` (`curl http://127.0.0.1:1234/v1/models` -> connection refused / `HTTP 000`).
- Preferred provider: `ollama` (only reachable provider on this machine).
- Notes: `ss -ltnp` showed listener on `127.0.0.1:11434` and none on `1234`.

#### LAN Discovery Readiness
Result:
- LAN scan allowed: `not policy-confirmed` (technical path exists; policy confirmation not available in this shell session).
- Network constraints:
  - Active interface: `enp26s0 192.168.10.50/24`.
  - `firewalld` not running.
  - `nft list ruleset` requires root (`Operation not permitted`), so effective nftables policy not fully visible here.
- Risk notes: Treat unknown LAN hosts as untrusted by default; require explicit user consent and warning before discovery/inference as planned.

### Overall Status
- Platform status: `pass-with-caveats`
- Blockers:
  - Wayland path unstable for this app run (`Gdk-Message ... Protocol error`); required `GDK_BACKEND=x11` workaround.
  - AppImage packaging failed due linuxdeploy strip/RELR incompatibility.
  - Deterministic GUI action automation (export/search/prompt) not reliable in this session.
  - Install/uninstall verification blocked by lack of elevated install permissions.
- Recommended next actions:
  - Fix AppImage build by updating/overriding linuxdeploy toolchain (or disabling problematic strip step for RELR-enabled libs).
  - Add headless/integration command harness for `refresh_local_events`, `sync_local_events_range`, `import_host_crashes`, and `export_events` to validate core functions without fragile GUI automation.
  - Re-run GUI-only checks in an interactive desktop session (manual operator pass) after display/backend stabilization.
- Owner: dave

## Changelog - 2026-02-27 (Commit `3bf3dd7`)
- Runtime launch hardening:
  - Added `scripts/tauri-runner.mjs` and switched `npm run tauri` to use it.
  - Runner clears inherited `LD_LIBRARY_PATH` and sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux when unset.
  - Backend also applies Linux startup default for `WEBKIT_DISABLE_DMABUF_RENDERER` with diagnostics logging.
- Browser launch behavior fix:
  - `open_external_url` now prefers `xdg-open` on Linux and strips `BROWSER` from child env to honor desktop default browser associations.
- Workspace/navigation restructure:
  - Added tabbed workspace flow with dedicated `Home`, `Events`, `Crashes`, `Data`, `Import`, `Export`, `Settings`, and closable `Help` tab.
  - Added Tools menu Help entry (`Tools -> Help`) that opens/targets Help sections.
  - Removed top-bar `Export Logs` and moved import workflow out of the header into its own `Import` tab.
- Export redesign:
  - Replaced immediate header JSON/CSV exports with guided `Export` tab workflow.
  - Export scope options: current loaded list or custom filtered host-OS subset.
  - Custom export filters: date range, severity, log type, category, provider/source contains.
  - Format options expanded to `JSON`, `CSV`, and `TXT`.
  - Added backend save-dialog command `export_events_with_dialog`; exports now prompt user for destination filename/path.
  - Added timestamped suggested filenames with short type tags.
  - Added explicit preview diagnostics explaining why preview is `0` (date coverage, log type/category/source/severity mismatch).
- Crash/date-range usability:
  - Added one-click "Auto-Load Filter Range" action when active date filters exceed local cache coverage.
  - Crash pre-window investigation auto-loads required range when crash timestamp lies outside current local cache.
  - Crash results messaging clarifies strict pre-crash mode vs correlated fallback mode.
- Event actions:
  - Added `Copy Event Text` action in selected-event footer.
- Security/reliability:
  - Frontend `ExportFormat` expanded to include `txt`; browser fallback supports text export.
  - Dependency audit resolved via `npm audit fix` (Rollup updated to `4.59.0`; audit now zero vulnerabilities).
  - Validation re-run: `npm run build` pass, `cargo check` pass (existing non-blocking warnings only).
- UI consistency:
  - standardized `From/To` date input alignment across Events, Export, and Data tabs.

## Windows Revalidation Handoff (After Pulling `3bf3dd7`)
1. Sync code on Windows machine:
   - `git checkout main`
   - `git pull origin main`
2. Preflight:
   - `npm install`
   - `npm run build`
   - `npm run tauri info`
3. Launch:
   - `npm run tauri dev`
4. Functional pass (live host data only):
   - Refresh logs and confirm non-zero local events.
   - Events tab: apply older date range outside current coverage and click `Auto-Load Filter Range`; verify range load status and table population behavior.
   - Crashes tab: import host crashes, select crash, click `Investigate Pre-Crash`, verify strict pre-crash results or explicit correlated fallback notice.
   - Export tab:
     - test `Current loaded list` export (JSON and CSV).
     - test `Custom filtered export` with date/log type/category/severity/source.
     - verify preview explanation text when results are zero.
     - verify save dialog appears and chosen path is used.
   - Import tab: import a known prior JSON/CSV export and verify import status + event count update.
   - Selected event footer: verify `Copy Event Text`, `Search Google`, `Copy LLM Prompt`, and single-event export actions.
5. Browser behavior check:
   - Click `Search Google` from selected event and confirm it opens Windows default browser.
6. Packaging pass (if toolchain available):
   - `npm run tauri build`
   - record produced artifacts (`msi/nsis/exe`) and install/uninstall results.

Expected notes to capture in Windows retest:
- Whether pre-crash strict window returns rows for known crash windows.
- Whether export save dialog path selection is intuitive for IT users.
- Any dark-mode readability regressions still present in input/select/date controls.
