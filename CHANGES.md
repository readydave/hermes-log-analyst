# Local Working-Tree Changes

This file summarizes the uncommitted changes currently present in this Linux clone relative to `origin/main` / `63ac164`.

## Verified Application Changes

### 1. Linux core-dump analysis is now wired through the crash workflow

Files:
- `src-tauri/src/crash.rs`
- `src-tauri/src/main.rs`
- `src/App.tsx`
- `src/lib/llmPrompt.ts`
- `src/lib/crashAnalysis.ts`
- `src/lib/crashAnalysis.test.ts`

What changed:
- Added backend analysis support for Linux `Core Dump` crash records.
- Routed `analyze_minidump` to the Linux analyzer when the selected crash is on Linux.
- Updated the frontend so dump analysis is available for:
  - Windows `Minidump`
  - Windows `KernelDump`
  - Linux `Core Dump`
- Generalized crash-analysis and crash-RCA copy so Linux dump sessions do not fall back to Windows-only wording.
- Added frontend test coverage around Linux dump-backed crash recognition and Linux RCA prompt normalization.

Verification:
- `cargo test` passes.
- `npm run test` passes.
- `npm run build` passes.

Notes:
- This is still metadata/evidence analysis, not full debugger-backed symbolication.
- macOS crash import remains metadata-only.

### 2. Default LLM profile selection is now honored at the point of use

Files:
- `src/App.tsx`
- `src/lib/llmProfiles.ts`
- `src/lib/llmProfiles.test.ts`
- `package.json`
- `package-lock.json`

What changed:
- Added a shared helper for selecting the saved default runnable LLM profile.
- Send-to-LLM and crash-RCA windows now preselect the saved default compatible profile instead of a narrower local-only subset.
- First-use analysis now runs a quick connection preflight before the actual request.
- The preflight blocks analysis early when:
  - the selected profile is unreachable
  - the endpoint is reachable but no model is configured or discoverable
- Manual `Test Connection` now satisfies the same preflight cache until the profile materially changes.

Verification:
- `npm run test` passes.
- `npm run build` passes.

### 3. Remote-host settings and remote collector diagnostics were hardened

Files:
- `src/App.tsx`
- `src/lib/backend.ts`
- `src-tauri/src/settings.rs`
- `src-tauri/src/logs/linux.rs`
- `src-tauri/src/logs/macos.rs`
- `src-tauri/src/logs/windows.rs`

What changed:
- Fixed remote settings save/load field mismatches (`sshKeyPath` / `authType` vs old snake_case payloads).
- Added compatibility aliases and sanitization for older saved remote settings.
- Remote-host Settings now auto-select the first saved profile on load instead of showing an empty editor.
- Remote Linux/macOS SSH collectors now capture stderr and report permission/auth problems explicitly.
- Unsupported Linux/macOS SSH password auth now fails with a direct message instead of looking like a zero-event success.
- WinRM password mode now reports when no stored remote secret exists.

Verification:
- `cargo test` passes.
- `npm run build` passes.

Important limitation still present:
- Remote connectivity is not fully complete yet:
  - no dedicated `Test Remote Connection` button
  - remote exact-range `Load Events` is not fully target-aware
  - remote crash import is still local-only
  - WinRM/password frontend secret UX is still missing
  - Linux/macOS SSH password auth is still not implemented

## Documentation Changes

Files:
- `README.md`
- `HANDOFF.md`
- `CHANGELOG.md`

What changed:
- Updated docs to reflect the current verified state of:
  - Linux crash analysis
  - default LLM preflight behavior
  - remote-host save/load fixes
  - current remote-host limitations and remaining parity work for macOS, Windows, and Linux
- Added explicit remote-connectivity follow-up items so the next session can continue from the real current state.

## Local Artifacts Present In This Clone

These are not product changes:
- `src-tauri/hermes.db`: local runtime artifact
- `src-tauri/gen/schemas/linux-schema.json`: generated Tauri schema file created on this Linux machine
