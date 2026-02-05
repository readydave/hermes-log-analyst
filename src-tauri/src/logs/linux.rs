use super::{NormalizedEvent, SupportedOs};
use chrono::{DateTime, Utc};

pub fn collect_events_range(
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    _max_events: Option<u32>,
) -> Vec<NormalizedEvent> {
    // TODO: journald/syslog range query.
    vec![
        NormalizedEvent::new(
            SupportedOs::Linux,
            "syslog",
            "system",
            "kernel",
            Some(41),
            "warning",
            "Watchdog detected delayed IO response.",
        ),
        NormalizedEvent::new(
            SupportedOs::Linux,
            "auth.log",
            "security",
            "sshd",
            None,
            "error",
            "Failed password for invalid user.",
        ),
        NormalizedEvent::new(
            SupportedOs::Linux,
            "application",
            "application",
            "systemd",
            None,
            "information",
            "Unit started successfully.",
        ),
    ]
}
