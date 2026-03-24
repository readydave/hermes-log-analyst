use super::{CollectionEstimate, CollectionResult, NormalizedEvent, SupportedOs};
use crate::settings::RemoteConnectionProfile;
use chrono::{DateTime, Local, Utc};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

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
        "show".to_string(),
        "--style".to_string(),
        "json".to_string(),
    ];
    if let Some(value) = start {
        args.push("--start".to_string());
        args.push(format_log_time(value));
    }
    if let Some(value) = end {
        args.push("--end".to_string());
        args.push(format_log_time(value));
    }

    let mut command = if request_elevation {
        let mut cmd = Command::new("osascript");
        let shell_args: Vec<String> = args.iter().map(|s| shell_quote(s)).collect();
        let script = format!(
            "do shell script \"log {}\" with administrator privileges",
            shell_args.join(" ")
        );
        cmd.arg("-e").arg(script);
        cmd
    } else {
        let mut cmd = Command::new("log");
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
                .push(format!("Failed to run macOS log collector: {error}"));
            return result;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            result
                .errors
                .push("macOS log collector did not expose stdout.".to_string());
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
        if let Some(event) = parse_log_line(line.as_str()) {
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
            "Encountered {read_failures} macOS log stdout read failure(s)."
        ));
    }
    if parse_failures > 0 {
        result.warnings.push(format!(
            "Skipped {parse_failures} non-JSON or malformed macOS log entries."
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
                    "macOS log collection requires elevated access.".to_string()
                } else {
                    format!("macOS log collection requires elevated access. {stderr_summary}")
                }
            } else if stderr_summary.is_empty() {
                format!("macOS log collector exited with status {status}.")
            } else {
                format!("macOS log collector exited with status {status}. {stderr_summary}")
            };
            if result.events.is_empty() {
                result.errors.push(message);
            } else {
                result.warnings.push(message);
            }
            result
        }
        Err(error) => {
            let message = format!("Failed to wait for macOS log collector process: {error}");
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
        "show".to_string(),
        "--style".to_string(),
        "json".to_string(),
    ];
    if let Some(value) = start {
        args.push("--start".to_string());
        args.push(format_log_time(value));
    }
    if let Some(value) = end {
        args.push("--end".to_string());
        args.push(format_log_time(value));
    }

    let mut command = if request_elevation {
        let mut cmd = Command::new("osascript");
        let shell_args: Vec<String> = args.iter().map(|s| shell_quote(s)).collect();
        let script = format!(
            "do shell script \"log {}\" with administrator privileges",
            shell_args.join(" ")
        );
        cmd.arg("-e").arg(script);
        cmd
    } else {
        let mut cmd = Command::new("log");
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
                .push(format!("Failed to run macOS log estimate: {error}"));
            return estimate;
        }
    };

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            estimate
                .errors
                .push("macOS log estimate did not expose stdout.".to_string());
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
            "Encountered {read_failures} macOS log estimate stdout read failure(s)."
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
                    "macOS log estimate requires elevated access.".to_string()
                } else {
                    format!("macOS log estimate requires elevated access. {stderr_summary}")
                }
            } else if stderr_summary.is_empty() {
                format!("macOS log estimate exited with status {status}.")
            } else {
                format!("macOS log estimate exited with status {status}. {stderr_summary}")
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
                .push(format!("Failed to wait for macOS log estimate process: {error}"));
            estimate
        }
    }
}

fn format_log_time(value: DateTime<Utc>) -> String {
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
        "not authorized",
        "not permitted",
        "operation not permitted",
        "permission denied",
        "access denied",
        "administrator privileges",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
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
    let severity =
        map_severity(get_string(&value, "messageType").or_else(|| get_string(&value, "level")));
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
        "localhost",
    );

    if let Some(timestamp) = get_string(&value, "timestamp") {
        event.timestamp = timestamp.to_string();
    }

    event.assign_stable_id();

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


pub fn collect_remote_macos_events(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    _channels: Option<&[String]>,
) -> CollectionResult {
    let mut args = vec!["show".to_string(), "--style".to_string(), "ndjson".to_string()];
    
    if let Some(start_time) = start {
        args.push("--start".to_string());
        args.push(format!(r#""{}""#, format_log_time(start_time)));
    }
    
    if let Some(end_time) = end {
        args.push("--end".to_string());
        args.push(format!(r#""{}""#, format_log_time(end_time)));
    }
    
    let remote_cmd = format!("log {}", args.join(" "));

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
    ssh_args.push(remote_cmd);

    let mut command = std::process::Command::new("ssh");
    command.args(&ssh_args);
    command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());

    let mut result = CollectionResult::default();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            result.errors.push(format!("Failed to spawn ssh for macOS host {}: {}", profile.host, error));
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
        
        if let Some(mut event) = parse_log_line(line.as_str()) {
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
        result.warnings.push(format!("Skipped {parse_failures} non-JSON or malformed macOS entries remotely."));
    }

    let _ = child.wait();
    result
}
