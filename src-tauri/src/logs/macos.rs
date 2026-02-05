use super::{NormalizedEvent, SupportedOs};
use chrono::{DateTime, Utc};

pub fn collect_events_range(
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    _max_events: Option<u32>,
) -> Vec<NormalizedEvent> {
    // TODO: Unified Logging range query.
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
