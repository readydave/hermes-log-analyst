use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashRecord {
    pub id: String,
    pub timestamp: String,
    pub os: String,
    pub source: String,
    pub crash_type: String,
    pub code: Option<String>,
    pub summary: String,
    pub suspected_component: Option<String>,
    pub raw_path: Option<String>,
    pub imported: bool,
}

impl CrashRecord {
    pub fn new(
        os: &str,
        source: &str,
        crash_type: &str,
        code: Option<&str>,
        summary: &str,
        suspected_component: Option<&str>,
        raw_path: Option<&str>,
        imported: bool,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now().to_rfc3339(),
            os: os.to_string(),
            source: source.to_string(),
            crash_type: crash_type.to_string(),
            code: code.map(ToString::to_string),
            summary: summary.to_string(),
            suspected_component: suspected_component.map(ToString::to_string),
            raw_path: raw_path.map(ToString::to_string),
            imported,
        }
    }
}

pub fn build_sample_crash(os: &str) -> CrashRecord {
    match os {
        "windows" => CrashRecord::new(
            "windows",
            "WER",
            "BSOD",
            Some("0x0000009F"),
            "Bugcheck indicates DRIVER_POWER_STATE_FAILURE during resume.",
            Some("nvlddmkm.sys"),
            Some("C:\\Windows\\Minidump\\sample.dmp"),
            false,
        ),
        "macos" => CrashRecord::new(
            "macos",
            "DiagnosticReports",
            "Kernel Panic",
            Some("panic(cpu 0 caller 0xffff...)"),
            "Kernel panic appears related to GPU watchdog timeout.",
            Some("AppleGPUWrangler"),
            Some("/Library/Logs/DiagnosticReports/Kernel_sample.panic"),
            false,
        ),
        _ => CrashRecord::new(
            "linux",
            "kdump",
            "Kernel Panic",
            Some("kernel panic - not syncing"),
            "Kernel panic likely triggered by filesystem I/O timeout.",
            Some("ext4"),
            Some("/var/crash/vmcore"),
            false,
        ),
    }
}
