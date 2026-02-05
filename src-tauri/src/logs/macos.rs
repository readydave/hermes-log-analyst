use super::{NormalizedEvent, SupportedOs};
use chrono::{DateTime, Local, Utc};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

pub fn collect_events_range(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
) -> Vec<NormalizedEvent> {
    let max = max_events.unwrap_or(2000).min(10000) as usize;
    if max == 0 {
        return Vec::new();
    }

    let mut args = vec!["show".to_string(), "--style".to_string(), "json".to_string()];
    if let Some(value) = start {
        args.push("--start".to_string());
        args.push(format_log_time(value));
    }
    if let Some(value) = end {
        args.push("--end".to_string());
        args.push(format_log_time(value));
    }

    let mut command = Command::new("log");
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::null());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return fallback_seed_events(Some(error.to_string())),
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return fallback_seed_events(Some("log show stdout unavailable".to_string())),
    };

    let reader = BufReader::new(stdout);
    let mut events = Vec::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue; };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(event) = parse_log_line(line.as_str()) {
            events.push(event);
            if events.len() >= max {
                let _ = child.kill();
                break;
            }
        }
    }

    let status = child.wait();
    match status {
        Ok(status) if status.success() => events,
        Ok(_) if events.is_empty() => fallback_seed_events(Some("log show failed".to_string())),
        Err(error) if events.is_empty() => fallback_seed_events(Some(error.to_string())),
        _ => events,
    }
}

fn format_log_time(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn parse_log_line(line: &str) -> Option<NormalizedEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    let message = extract_message(&value).unwrap_or("No log message.");
    let subsystem = get_string(&value, "subsystem");
    let category = get_string(&value, "category");
    let process = get_string(&value, "process");
    let sender = get_string(&value, "sender");

    let log_name = pick_value(&[subsystem, category, process, sender]).unwrap_or("system");
    let provider = pick_value(&[process, sender, subsystem]).unwrap_or("unknown");
    let severity = map_severity(
        get_string(&value, "messageType").or_else(|| get_string(&value, "level")),
    );
    let event_id = value
        .get("eventID")
        .and_then(|entry| entry.as_u64())
        .and_then(|entry| u32::try_from(entry).ok());

    let mut event = NormalizedEvent::new(
        SupportedOs::Macos,
        log_name,
        map_category(category, subsystem, provider),
        provider,
        event_id,
        severity,
        sanitize_message(message),
    );

    if let Some(timestamp) = get_string(&value, "timestamp") {
        event.timestamp = timestamp.to_string();
    }

    Some(event)
}

fn extract_message(value: &Value) -> Option<&str> {
    get_string(value, "eventMessage")
        .or_else(|| get_string(value, "message"))
        .or_else(|| get_string(value, "formattedMessage"))
}

fn get_string<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(|entry| entry.as_str())
}

fn pick_value<'a>(values: &[Option<&'a str>]) -> Option<&'a str> {
    values
        .iter()
        .copied()
        .flatten()
        .find(|value| !value.trim().is_empty())
}

fn map_category(category: Option<&str>, subsystem: Option<&str>, provider: &str) -> &'static str {
    let mut combined = String::new();
    for value in [category, subsystem, Some(provider)] {
        if let Some(value) = value {
            combined.push_str(value);
            combined.push(' ');
        }
    }

    let lower = combined.to_ascii_lowercase();
    if lower.contains("audit") {
        "audit"
    } else if lower.contains("auth") || lower.contains("security") {
        "security"
    } else if lower.contains("kernel") || lower.contains("system") {
        "system"
    } else {
        "application"
    }
}

fn map_severity(level: Option<&str>) -> &'static str {
    let lower = level.unwrap_or("default").to_ascii_lowercase();
    if lower.contains("fault") || lower.contains("critical") {
        "critical"
    } else if lower.contains("error") {
        "error"
    } else if lower.contains("warn") {
        "warning"
    } else {
        "information"
    }
}

fn sanitize_message(message: &str) -> &str {
    if message.trim().is_empty() {
        return "No log message.";
    }
    message
}

fn fallback_seed_events(reason: Option<String>) -> Vec<NormalizedEvent> {
    let note = reason
        .map(|value| format!(" (fallback: {})", value.lines().next().unwrap_or("unknown")))
        .unwrap_or_default();

    vec![
        NormalizedEvent::new(
            SupportedOs::Macos,
            "system",
            "system",
            "kernel",
            None,
            "warning",
            &format!("Previous shutdown cause indicates power interruption{note}."),
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
