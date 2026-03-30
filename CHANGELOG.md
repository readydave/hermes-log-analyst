# Changelog

All notable product-facing changes to Hermes Log Analyst are documented in this file.

This changelog is intentionally sanitized. It excludes machine names, user-specific paths, IP addresses, validation operator details, and other environment-specific notes. Internal handoff and validation records remain in `HANDOFF.md`.

The project does not currently publish formal version tags for each change group below, so entries are organized by date and representative commit.

## 2026-03-30

### Added
- Windows remote-host protocol expansion in Settings with profile-level support for `WinRM`, `Remote Event Log (RPC/DCOM)`, and `Intune`.
- macOS remote-host protocol expansion in Settings with profile-level support for `SSH`, `Jamf Pro`, and `Intune`.
- Separate managed-provider account settings for Jamf Pro and Microsoft Intune with OS-keychain-backed token storage.
- Real `Test Connection` support for remote profiles:
  - Windows WinRM live transport/log-read smoke test
  - Windows RPC/DCOM Event Log + WMI summary smoke test
  - Windows Intune authentication + device resolution test
  - macOS SSH transport/log-read smoke test
  - Jamf Pro authentication + device resolution test
  - Intune authentication + device resolution test
- Cached managed-device metadata on remote host profiles:
  - provider device ID
  - resolved device name
  - last resolved timestamp

### Changed
- `Refresh Logs` now adapts its operator messaging for managed macOS targets instead of implying every remote connection behaves like a live SSH session.
- `Refresh Logs` now adapts operator messaging for Windows direct transports (`WinRM`, `RPC/DCOM`) and Windows Intune managed collection.
- Remote settings now persist both host profiles and provider-account metadata in a sanitized backend shape while keeping provider secrets out of settings files.

### Fixed
- Windows remote-host settings now have a first-class per-profile keychain password workflow for `WinRM` and `RPC/DCOM`.
- Windows WinRM remote collection now honors time range, channel selection, max-event caps, singleton responses, and appends compact remote system-summary events.
- Windows RPC/DCOM remote collection now provides a first non-WinRM fallback using remote Event Log queries plus WMI/DCOM system-summary metadata.
- macOS remote-connection setup no longer forces operators into SSH-only workflows when a managed-device path is more appropriate.
- Remote configuration now has a first-class path for validating provider-backed macOS profiles before attempting collection.

## 2026-03-27

### Added
- Linux core-dump analysis path in the crash workflow, including RCA packet generation that uses Linux-appropriate dump guidance instead of Windows-only wording.

### Changed
- The crash-analysis panel now appears for Linux core dumps as well as Windows minidumps/kernel dumps.
- Detected LLM model chips now visually highlight the preferred/active model in Settings.
- Send-to-LLM and crash-RCA windows now prefer the saved default compatible profile instead of a narrower local-only subset.

### Fixed
- Non-Windows builds now provide a defined fallback for the remote Windows collector symbol.
- Preferred-model unit tests now match the production `first().cloned()` behavior instead of asserting an empty-string sentinel.
- First-use LLM analysis now performs a connection preflight and fails early when the selected default profile is unreachable or has no configured/detectable model.
- Remote host settings now save with the correct frontend/backend field names, and the Settings editor auto-selects the first saved remote profile on load.
- Remote Linux/macOS collectors now surface SSH stderr and unsupported auth-path problems as explicit errors instead of silent zero-event results.

## 2026-03-11

### Added
- Remote host log collection capabilities via SSH (Linux & macOS targets) and WinRM PowerShell remoting (Windows targets).
- Frontend Settings "Remote Hosts" management tab for configuring target OS identity, protocol, and authentication parameters.
- Target Selection dropdowns across all frontend Data views and ingestion controls, allowing operators to seamlessly switch contextual views between `localhost` and explicitly registered remote servers.
- Secure OS keychain bindings on the local backend to safely map credentials/passwords for WinRM authentication and automated SSH workflows without resorting to plaintext configurations.
- Schema tracking on the local SQLite tier mapping each log event and crash metric precisely to its original `source_host`.

## 2026-03-10

Representative commits:
- `d3ff18a` `feat: implemented cross-platform privilege elevation and fixed Windows security log collection`
- `589a8e1` `Add analytics dashboard and document connectivity stabilization`
- `2fb7fd9` `Polish LLM analysis workflow and update Windows handoff`

### Added
- Home dashboard analytics for:
  - event activity timeline
  - severity distribution
  - top providers
  - top log types
  - top Windows Event IDs
  - noisy/repeating sources
- Click-through drilldowns from dashboard metrics into the `Events` tab with matching filters.
- Selected-event `Raw` and `Parsed` message views for structured payload inspection.
- Ops Summary export in the `Export` tab with:
  - plain text output
  - HTML output suitable for print/PDF workflows
- Expanded LLM analysis workflow with:
  - cleaner guide-oriented response presentation
  - copy/export actions for analysis output
  - improved sharing/reporting flow for event context and analysis results
- Cross-platform privilege-elevation support in the desktop backend:
  - Windows elevated restart flow
  - macOS elevation via native scripting prompt
  - Linux elevation via PolicyKit-based path

### Changed
- Windows restricted-channel handling now reports permission-related collection warnings more clearly, especially around Security log access.
- LLM analysis UX was refined toward safer sharing and easier operator consumption.
- Connectivity stabilization was elevated to an explicit near-term product priority.

### Fixed
- Windows Event Log collection now handles restricted-channel access failures more predictably.
- Selected-event review and export workflows are better aligned with troubleshooting/report generation use cases.

## 2026-03-03

Representative commit:
- `962eefd` `Expand help docs and improve LLM analysis UX with safer sharing`

### Added
- A substantially expanded in-app Help experience covering major screens and workflows.
- Stronger LLM analysis sharing/report controls aimed at safer copy/export behavior.

### Changed
- Help content moved closer to a guided product manual instead of a minimal reference page.
- LLM analysis presentation was refined for operator readability.

## 2026-02-28

Representative commits:
- `b1f9dc4` `Add LLM provider settings and local/LAN discovery foundation`
- `2a20810` `Include configured Windows channels in export log type options`

### Added
- LLM provider settings foundation for:
  - local providers (`ollama`, `lmstudio`)
  - cloud providers (`openai`, `gemini`, `claude`, `perplexity`)
  - generic OpenAI-compatible endpoints
- Local provider detection for Ollama and LM Studio.
- Optional LAN discovery foundation for local-network provider scanning.

### Changed
- Export log-type options on Windows now include configured ingest channels even when those channels are not currently represented in the in-memory event list.
- Date input layout was standardized across major workflows for more consistent filtering/export behavior.

## 2026-02-27

Representative commits:
- `3bf3dd7` `Refactor workspace tabs and add guided export workflow`
- `64f8b30` `Standardize date input layout and expand LLM roadmap`
- `d558277` `Add v0.2 roadmap template and fix bundle icons`

### Added
- Tabbed workspace structure with dedicated areas for:
  - Home
  - Events
  - Crashes
  - Data
  - Import
  - Export
  - Settings
  - Help
- Guided export workflow with:
  - export scope selection
  - custom filter controls
  - desktop save-dialog path selection
  - preview explanations for zero-result exports
- Auto-load support for date ranges outside current local cache coverage.
- Crash investigation flow that can auto-load the needed pre-crash date range.
- `Copy Event Text` action for selected events.
- Runtime launch hardening for Linux desktop sessions.

### Changed
- Export moved from immediate header actions to a dedicated guided `Export` workflow.
- Import moved into its own dedicated workspace tab.
- Help became accessible from the application menu and workspace flow.
- Browser launch behavior on Linux was adjusted to better respect the desktop default browser.

### Fixed
- Bundle icon packaging issues were corrected for the current Tauri build setup.
- Date input alignment was normalized across Events, Export, and Data views.

## 2026-02-12

Representative commit:
- `8f046e0` `Harden security: CSV injection, CSP, parser robustness, and toolchain updates`

### Changed
- CSV export now neutralizes spreadsheet-formula-prefixed cells more defensively.
- Tauri CSP moved from an open/null configuration to an explicit configuration.
- CSV import parsing was upgraded to handle quoted fields and escaped quotes more reliably.
- Frontend toolchain dependencies were updated to address audit findings.

### Fixed
- Import/export robustness issues caused by naive CSV parsing behavior.

## 2026-02-09

Representative commits:
- `46a0c83` `Improve memory usage with event caps and table virtualization`
- `f839831` `Add diagnostics logging with retention and surfaced collector warnings`
- `a6fe2f8` `Add ingest profile settings, range load workflow, and log-type filtering`
- `da441ba` `Add metadata-first host crash importers across Windows/macOS/Linux`
- `dd92864` `Complete handoff objective #1 and fix Windows build baseline`

### Added
- Native cross-platform host log collectors for Windows, Linux, and macOS.
- Metadata-first host crash importers across supported operating systems.
- Ingest profile settings for startup sync behavior, event caps, and Windows channel selection.
- Date-range loading workflow in the Data view.
- Log-type filtering and broader event triage controls.
- Diagnostics logging with daily log files and retention pruning.
- Surfaced collector warnings for partial-success sync/backfill operations.

### Changed
- Startup defaults shifted toward safer local-cache-first behavior instead of aggressive auto-sync.
- Event-table rendering moved to a virtualized approach to reduce UI load for larger result sets.
- In-memory event caps were introduced for stability.

### Fixed
- Windows desktop build baseline issues affecting the local development path.
