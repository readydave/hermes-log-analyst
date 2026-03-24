pub mod linux;
pub mod macos;
pub mod windows;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportedOs {
    Windows,
    Linux,
    Macos,
}

impl std::fmt::Display for SupportedOs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            SupportedOs::Windows => "windows",
            SupportedOs::Linux => "linux",
            SupportedOs::Macos => "macos",
        };
        write!(f, "{value}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NormalizedEvent {
    pub id: String,
    pub timestamp: String,
    pub os: String,
    pub log_name: String,
    pub category: String,
    pub provider: String,
    pub event_id: Option<u32>,
    pub severity: String,
    pub message: String,
    pub source_host: String,
    pub imported: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionResult {
    pub events: Vec<NormalizedEvent>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionEstimate {
    pub estimated_count: usize,
    pub estimated_bytes: usize,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl NormalizedEvent {
    pub fn new(
        os: SupportedOs,
        log_name: &str,
        category: &str,
        provider: &str,
        event_id: Option<u32>,
        severity: &str,
        message: &str,
        source_host: &str,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            os: os.to_string(),
            log_name: log_name.to_string(),
            category: category.to_string(),
            provider: provider.to_string(),
            event_id,
            severity: severity.to_string(),
            message: message.to_string(),
            source_host: source_host.to_string(),
            imported: false,
        }
    }

    pub fn assign_stable_id(&mut self) {
        let identity = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.os,
            self.source_host,
            self.log_name,
            self.timestamp,
            self.provider,
            self.event_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
            self.severity,
            self.category,
            self.message
        );
        self.id = stable_event_id(identity.as_str());
    }
}

fn stable_event_id(identity: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in identity.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("evt-{hash:016x}")
}

pub fn detect_host_os() -> SupportedOs {
    #[cfg(target_os = "windows")]
    {
        SupportedOs::Windows
    }

    #[cfg(target_os = "macos")]
    {
        SupportedOs::Macos
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        SupportedOs::Linux
    }
}

pub fn collect_host_events_range_with_windows_channels(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    windows_channels: Option<&[String]>,
    request_elevation: bool,
) -> CollectionResult {
    match detect_host_os() {
        SupportedOs::Windows => {
            windows::collect_events_range_with_channels(start, end, max_events, windows_channels)
        }
        SupportedOs::Linux => linux::collect_events_range(start, end, max_events, request_elevation),
        SupportedOs::Macos => macos::collect_events_range(start, end, max_events, request_elevation),
    }
}

pub fn estimate_host_events_range_with_windows_channels(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    windows_channels: Option<&[String]>,
    request_elevation: bool,
) -> CollectionEstimate {
    match detect_host_os() {
        SupportedOs::Windows => windows::estimate_events_range_with_channels(start, end, windows_channels),
        SupportedOs::Linux => linux::estimate_events_range(start, end, request_elevation),
        SupportedOs::Macos => macos::estimate_events_range(start, end, request_elevation),
    }
}
