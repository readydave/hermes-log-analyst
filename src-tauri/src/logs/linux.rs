use super::{NormalizedEvent, SupportedOs};

pub fn collect_events() -> Vec<NormalizedEvent> {
    // TODO: Replace seeded events with journald/syslog live readers.
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
