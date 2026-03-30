use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionTestResult {
    pub ok: bool,
    pub protocol: String,
    pub host: String,
    pub status: String,
    pub message: String,
    pub warnings: Vec<String>,
    pub collection_mode: String,
    pub provider_device_id: Option<String>,
    pub provider_resolved_name: Option<String>,
    pub provider_last_resolved_at: Option<String>,
}
