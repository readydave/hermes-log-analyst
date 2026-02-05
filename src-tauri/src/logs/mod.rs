mod linux;
mod macos;
mod windows;

use chrono::Utc;
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
    pub imported: bool,
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
            imported: false,
        }
    }
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

pub fn collect_host_events() -> Vec<NormalizedEvent> {
    match detect_host_os() {
        SupportedOs::Windows => windows::collect_events(),
        SupportedOs::Linux => linux::collect_events(),
        SupportedOs::Macos => macos::collect_events(),
    }
}
