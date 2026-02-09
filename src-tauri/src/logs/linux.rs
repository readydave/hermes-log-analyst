use super::{CollectionResult, NormalizedEvent, SupportedOs};
use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

pub fn collect_events_range(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
) -> CollectionResult {
    let max = max_events.unwrap_or(2000).min(10000) as usize;
    if max == 0 {
        return CollectionResult::default();
    }

    let mut args = vec![
        "--no-pager".to_string(),
        "-o".to_string(),
        "json".to_string(),
    ];
    if let Some(value) = start {
        args.push("--since".to_string());
        args.push(format_journal_time(value));
    }
    if let Some(value) = end {
        args.push("--until".to_string());
        args.push(format_journal_time(value));
    }
    args.push("-n".to_string());
    args.push(max.to_string());

    let mut command = Command::new("journalctl");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    let mut result = CollectionResult::default();

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result
                .errors
                .push(format!("Failed to run journalctl: {error}"));
            return result;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            result
                .errors
                .push("journalctl did not expose stdout.".to_string());
            return result;
        }
    };

    let reader = BufReader::new(stdout);
    let mut parse_failures = 0usize;
    let mut read_failures = 0usize;

    for line in reader.lines() {
        let Ok(line) = line else {
            read_failures += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(event) = parse_journal_line(line.as_str()) {
            result.events.push(event);
            if result.events.len() >= max {
                let _ = child.kill();
                break;
            }
        } else {
            parse_failures += 1;
        }
    }

    if read_failures > 0 {
        result.warnings.push(format!(
            "Encountered {read_failures} journalctl stdout read failure(s)."
        ));
    }
    if parse_failures > 0 {
        result.warnings.push(format!(
            "Skipped {parse_failures} non-JSON or malformed journal entries."
        ));
    }

    match child.wait() {
        Ok(status) if status.success() => result,
        Ok(status) => {
            let message = format!("journalctl exited with status {status}.");
            if result.events.is_empty() {
                result.errors.push(message);
            } else {
                result.warnings.push(message);
            }
            result
        }
        Err(error) => {
            let message = format!("Failed to wait for journalctl process: {error}");
            if result.events.is_empty() {
                result.errors.push(message);
            } else {
                result.warnings.push(message);
            }
            result
        }
    }
}

fn format_journal_time(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn parse_journal_line(line: &str) -> Option<NormalizedEvent> {
    let value: Value = serde_json::from_str(line).ok()?;
    let message = get_string(&value, "MESSAGE").unwrap_or("No log message.");
    let identifier = get_string(&value, "SYSLOG_IDENTIFIER");
    let comm = get_string(&value, "_COMM");
    let unit = get_string(&value, "_SYSTEMD_UNIT");
    let transport = get_string(&value, "_TRANSPORT");

    let log_name = pick_value(&[identifier, comm, unit, transport]).unwrap_or("journal");
    let provider = pick_value(&[comm, identifier, get_string(&value, "_EXE")]).unwrap_or("unknown");
    let category = map_category(&[identifier, comm, unit, transport, Some(provider)]);
    let severity = map_severity(
        get_string(&value, "PRIORITY").or_else(|| get_string(&value, "SYSLOG_PRIORITY")),
    );

    let mut event = NormalizedEvent::new(
        SupportedOs::Linux,
        log_name,
        category,
        provider,
        None,
        severity,
        sanitize_message(message),
    );

    if let Some(timestamp) = parse_journal_timestamp(&value) {
        event.timestamp = timestamp;
    }

    Some(event)
}

fn parse_journal_timestamp(value: &Value) -> Option<String> {
    let raw = value
        .get("__REALTIME_TIMESTAMP")
        .or_else(|| value.get("_SOURCE_REALTIME_TIMESTAMP"))?;

    let micros = match raw {
        Value::String(value) => value.parse::<i64>().ok()?,
        Value::Number(value) => value.as_i64()?,
        _ => return None,
    };

    let secs = micros / 1_000_000;
    let nanos = ((micros % 1_000_000) * 1000) as u32;
    Utc.timestamp_opt(secs, nanos)
        .single()
        .map(|dt| dt.to_rfc3339())
}

fn map_severity(priority: Option<&str>) -> &'static str {
    let parsed = priority.and_then(|value| value.parse::<u8>().ok());
    match parsed {
        Some(0 | 1 | 2) => "critical",
        Some(3) => "error",
        Some(4) => "warning",
        Some(_) => "information",
        None => "information",
    }
}

fn map_category(values: &[Option<&str>]) -> &'static str {
    let mut combined = String::new();
    for value in values {
        if let Some(value) = value {
            combined.push_str(value);
            combined.push(' ');
        }
    }

    let lower = combined.to_ascii_lowercase();
    if lower.contains("audit") {
        "audit"
    } else if lower.contains("auth")
        || lower.contains("ssh")
        || lower.contains("sudo")
        || lower.contains("security")
    {
        "security"
    } else if lower.contains("kernel")
        || lower.contains("systemd")
        || lower.contains("dbus")
        || lower.contains("udev")
    {
        "system"
    } else {
        "application"
    }
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

fn sanitize_message(message: &str) -> &str {
    if message.trim().is_empty() {
        return "No log message.";
    }
    message
}
