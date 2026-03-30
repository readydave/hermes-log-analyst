# Changes Summary

This file is a lightweight merged-state summary. The canonical product history is in `CHANGELOG.md`, and implementation/validation details live in `HANDOFF.md`.

## Current merged highlights

### Crash analysis
- Windows minidump/kernel-dump triage is implemented.
- Linux core-dump triage is implemented.
- Crash RCA flows into the LLM workflow with operator-facing guidance and confidence rationale.

### LLM workflow
- Saved default LLM profiles are honored at point of use.
- First-use analysis performs a connection preflight.
- Detected provider/model selection prefers active/available models where supported.

### Remote connectivity
- Linux remote collection: `SSH`
- macOS remote collection:
  - `SSH`
  - `Jamf Pro`
  - `Intune`
- Windows remote collection:
  - `WinRM`
  - `Remote Event Log (RPC/DCOM)`
  - `Intune`
- Remote profile/provider secrets are stored in the OS keychain.
- Remote profile `Test Connection` is implemented for supported transports/providers.

### Remaining gaps
- Remote exact-range `Load Events` is still not fully target-aware.
- Remote crash import is still local-only.
- Jamf/Intune macOS and Intune Windows paths currently return managed-device troubleshooting evidence rather than true live log collection parity.
- Linux/macOS SSH password auth is still not implemented.
