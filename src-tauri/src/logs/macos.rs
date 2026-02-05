use super::{NormalizedEvent, SupportedOs};

pub fn collect_events() -> Vec<NormalizedEvent> {
    // TODO: Replace seeded events with Unified Logging live stream parser.
    vec![
        NormalizedEvent::new(
            SupportedOs::Macos,
            "system",
            "system",
            "kernel",
            None,
            "warning",
            "Previous shutdown cause indicates power interruption.",
        ),
        NormalizedEvent::new(
            SupportedOs::Macos,
            "security",
            "security",
            "securityd",
            None,
            "error",
            "Code signing check failed for process.",
        ),
        NormalizedEvent::new(
            SupportedOs::Macos,
            "application",
            "application",
            "launchd",
            None,
            "information",
            "Agent loaded successfully.",
        ),
    ]
}
