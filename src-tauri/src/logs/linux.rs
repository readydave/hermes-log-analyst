use super::{CollectionEstimate, CollectionResult, NormalizedEvent, SupportedOs};
use crate::settings::RemoteConnectionProfile;
use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};

pub fn collect_events_range(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    request_elevation: bool,
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

    let mut command = if request_elevation {
        let mut cmd = Command::new("pkexec");
        cmd.arg("journalctl").args(args);
        cmd
    } else {
        let mut cmd = Command::new("journalctl");
        cmd.args(args);
        cmd
    };

    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

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

    let stderr_text = {
        let mut text = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    };

    match child.wait() {
        Ok(status) if status.success() => result,
        Ok(status) => {
            let stderr_summary = summarize_stderr(stderr_text.as_str());
            let message = if stderr_looks_like_permission_issue(stderr_text.as_str()) {
                if stderr_summary.is_empty() {
                    "journalctl requires elevated access or journal-reader privileges.".to_string()
                } else {
                    format!("journalctl requires elevated access or journal-reader privileges. {stderr_summary}")
                }
            } else if stderr_summary.is_empty() {
                format!("journalctl exited with status {status}.")
            } else {
                format!("journalctl exited with status {status}. {stderr_summary}")
            };
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

pub fn estimate_events_range(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    request_elevation: bool,
) -> CollectionEstimate {
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

    let mut command = if request_elevation {
        let mut cmd = Command::new("pkexec");
        cmd.arg("journalctl").args(args);
        cmd
    } else {
        let mut cmd = Command::new("journalctl");
        cmd.args(args);
        cmd
    };

    command.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut estimate = CollectionEstimate::default();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            estimate
                .errors
                .push(format!("Failed to run journalctl estimate: {error}"));
            return estimate;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            estimate
                .errors
                .push("journalctl estimate did not expose stdout.".to_string());
            return estimate;
        }
    };

    let reader = BufReader::new(stdout);
    let mut read_failures = 0usize;
    for line in reader.lines() {
        match line {
            Ok(line) => {
                if line.trim().is_empty() {
                    continue;
                }
                estimate.estimated_count += 1;
                estimate.estimated_bytes += line.len();
            }
            Err(_) => read_failures += 1,
        }
    }

    if read_failures > 0 {
        estimate.warnings.push(format!(
            "Encountered {read_failures} journalctl estimate stdout read failure(s)."
        ));
    }

    let stderr_text = {
        let mut text = String::new();
        if let Some(mut stderr) = child.stderr.take() {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    };

    match child.wait() {
        Ok(status) if status.success() => estimate,
        Ok(status) => {
            let stderr_summary = summarize_stderr(stderr_text.as_str());
            let message = if stderr_looks_like_permission_issue(stderr_text.as_str()) {
                if stderr_summary.is_empty() {
                    "journalctl estimate requires elevated access or journal-reader privileges."
                        .to_string()
                } else {
                    format!(
                        "journalctl estimate requires elevated access or journal-reader privileges. {stderr_summary}"
                    )
                }
            } else if stderr_summary.is_empty() {
                format!("journalctl estimate exited with status {status}.")
            } else {
                format!("journalctl estimate exited with status {status}. {stderr_summary}")
            };

            if stderr_looks_like_permission_issue(stderr_text.as_str()) {
                estimate.warnings.push(message);
            } else {
                estimate.errors.push(message);
            }
            estimate
        }
        Err(error) => {
            estimate
                .errors
                .push(format!("Failed to wait for journalctl estimate process: {error}"));
            estimate
        }
    }
}

fn format_journal_time(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn summarize_stderr(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let single_line = trimmed.replace('\n', " ");
    if single_line.len() <= 220 {
        single_line
    } else {
        format!("{}...", &single_line[..220])
    }
}

fn stderr_looks_like_permission_issue(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    [
        "permission denied",
        "not permitted",
        "operation not permitted",
        "access denied",
        "authentication failed",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
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
        "localhost",
    );

    if let Some(timestamp) = parse_journal_timestamp(&value) {
        event.timestamp = timestamp;
    }

    event.assign_stable_id();

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


pub fn collect_remote_linux_events(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    _channels: Option<&[String]>,
) -> CollectionResult {
    let mut args = vec!["-o".to_string(), "json".to_string()];
    
    if let Some(start_time) = start {
        args.push("--since".to_string());
        args.push(format_journal_time(start_time));
    }
    
    if let Some(end_time) = end {
        args.push("--until".to_string());
        args.push(format_journal_time(end_time));
    }
    
    // Remote SSH fetching typically won't allow interactive sudo easily without setup.
    // If request_elevation is true (from ingest profile, passed via channels/etc conceptually), 
    // it's tricky. For now, rely on standard journalctl access or passwordless sudo on the remote host.
    
    let journal_cmd = format!("journalctl {}", args.join(" "));

    let mut ssh_args = vec![
        "-o".to_string(), "BatchMode=yes".to_string(),
        "-o".to_string(), "StrictHostKeyChecking=no".to_string()
    ];

    if let Some(key_path) = &profile.ssh_key_path {
        if !key_path.is_empty() {
            ssh_args.push("-i".to_string());
            ssh_args.push(key_path.to_string());
        }
    }

    let user_host = if profile.username.is_empty() {
        profile.host.clone()
    } else {
        format!("{}@{}", profile.username, profile.host)
    };
    ssh_args.push(user_host);
    ssh_args.push(journal_cmd);

    let mut command = std::process::Command::new("ssh");
    command.args(&ssh_args);
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());

    let mut result = CollectionResult::default();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.errors.push(format!("Failed to spawn ssh for Linux host {}: {}", profile.host, error));
            return result;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            result.errors.push(format!("ssh did not expose stdout for {}", profile.host));
            return result;
        }
    };

    let max = max_events.unwrap_or(2000) as usize;
    let reader = std::io::BufReader::new(stdout);
    let mut parse_failures = 0usize;
    let mut read_failures = 0usize;

    for line in std::io::BufRead::lines(reader) {
        let Ok(line) = line else {
            read_failures += 1;
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        
        // Use local parser but update source_host
        if let Some(mut event) = parse_journal_line(line.as_str()) {
            event.source_host = profile.host.clone();
            event.assign_stable_id();
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
        result.warnings.push(format!("Encountered {read_failures} ssh stdout read failure(s)."));
    }
    if parse_failures > 0 {
        result.warnings.push(format!("Skipped {parse_failures} non-JSON or malformed journal entries remotely."));
    }

    match child.wait() {
        Ok(status) if status.success() => result,
        Ok(status) => {
            let message = format!("ssh exited with status {}", status);
            // Ignore 255 if events populated (batchmode disconnect)
            if !status.success() && result.events.is_empty() {
                result.errors.push(message);
            }
            result
        }
        Err(_error) => result,
    }
}
