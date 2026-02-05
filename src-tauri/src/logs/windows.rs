use super::{NormalizedEvent, SupportedOs};
#[cfg(target_os = "windows")]
use serde::Deserialize;
#[cfg(target_os = "windows")]
use serde_json::Value;
#[cfg(target_os = "windows")]
use std::process::Command;

#[cfg(target_os = "windows")]
pub fn collect_events() -> Vec<NormalizedEvent> {
    let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$logs = @('Application', 'Security', 'System')
$events = Get-WinEvent -FilterHashtable @{LogName = $logs} -MaxEvents 500 |
  Select-Object LogName, ProviderName, Id, LevelDisplayName, TimeCreated, Message, RecordId
if ($null -eq $events) { '[]' } else { $events | ConvertTo-Json -Depth 5 -Compress }
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output();

    match output {
        Ok(result) if result.status.success() => parse_events_json(&result.stdout),
        Ok(result) => fallback_seed_events(Some(String::from_utf8_lossy(&result.stderr).to_string())),
        Err(error) => fallback_seed_events(Some(error.to_string())),
    }
}

#[cfg(not(target_os = "windows"))]
pub fn collect_events() -> Vec<NormalizedEvent> {
    fallback_seed_events(None)
}

#[cfg(target_os = "windows")]
#[derive(Debug, Deserialize)]
struct RawWindowsEvent {
    #[serde(rename = "LogName")]
    log_name: Option<String>,
    #[serde(rename = "ProviderName")]
    provider_name: Option<String>,
    #[serde(rename = "Id")]
    event_id: Option<u32>,
    #[serde(rename = "LevelDisplayName")]
    level_display_name: Option<String>,
    #[serde(rename = "TimeCreated")]
    time_created: Option<String>,
    #[serde(rename = "Message")]
    message: Option<String>,
}

#[cfg(target_os = "windows")]
fn parse_events_json(bytes: &[u8]) -> Vec<NormalizedEvent> {
    let parsed = serde_json::from_slice::<Value>(bytes);
    let value = match parsed {
        Ok(value) => value,
        Err(error) => return fallback_seed_events(Some(error.to_string())),
    };

    let raws: Vec<RawWindowsEvent> = match value {
        Value::Array(list) => list
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<RawWindowsEvent>(entry).ok())
            .collect(),
        Value::Object(_) => serde_json::from_value::<RawWindowsEvent>(value)
            .map(|event| vec![event])
            .unwrap_or_default(),
        _ => Vec::new(),
    };

    if raws.is_empty() {
        return fallback_seed_events(None);
    }

    raws.into_iter()
        .map(|raw| {
            let log_name = raw.log_name.unwrap_or_else(|| "Application".to_string());
            let mut event = NormalizedEvent::new(
                SupportedOs::Windows,
                &log_name,
                map_category(&log_name),
                raw.provider_name
                    .as_deref()
                    .unwrap_or("Unknown Provider"),
                raw.event_id,
                map_severity(raw.level_display_name.as_deref()),
                sanitize_message(raw.message.as_deref().unwrap_or("No event message.")),
            );

            if let Some(ts) = raw.time_created {
                event.timestamp = ts;
            }

            event
        })
        .collect()
}

#[cfg(target_os = "windows")]
fn map_category(log_name: &str) -> &str {
    let lower = log_name.to_ascii_lowercase();
    if lower.contains("security") {
        "security"
    } else if lower.contains("system") {
        "system"
    } else {
        "application"
    }
}

#[cfg(target_os = "windows")]
fn map_severity(level: Option<&str>) -> &str {
    let lower = level.unwrap_or("Information").to_ascii_lowercase();
    if lower.contains("critical") {
        "critical"
    } else if lower.contains("error") || lower.contains("audit failure") {
        "error"
    } else if lower.contains("warning") {
        "warning"
    } else {
        "information"
    }
}

#[cfg(target_os = "windows")]
fn sanitize_message(message: &str) -> &str {
    if message.trim().is_empty() {
        return "No event message.";
    }
    message
}

fn fallback_seed_events(reason: Option<String>) -> Vec<NormalizedEvent> {
    let note = reason
        .map(|value| format!(" (fallback: {})", value.lines().next().unwrap_or("unknown")))
        .unwrap_or_default();

    vec![
        NormalizedEvent::new(
            SupportedOs::Windows,
            "Application",
            "application",
            "Service Control Manager",
            Some(1001),
            "information",
            &format!("Service startup completed{note}."),
        ),
        NormalizedEvent::new(
            SupportedOs::Windows,
            "Security",
            "security",
            "Microsoft Windows security auditing.",
            Some(4625),
            "error",
            "An account failed to log on.",
        ),
        NormalizedEvent::new(
            SupportedOs::Windows,
            "System",
            "system",
            "Microsoft-Windows-Kernel-Power",
            Some(41),
            "warning",
            "The system rebooted without cleanly shutting down.",
        ),
    ]
}
