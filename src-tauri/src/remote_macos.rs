use crate::logs::{CollectionResult, NormalizedEvent, SupportedOs};
use crate::settings::{RemoteConnectionProfile, RemoteProviderAccount};
use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::{Command, Stdio};
use std::time::Duration;

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

#[derive(Debug, Clone)]
struct ManagedMacDevice {
    device_id: String,
    resolved_name: String,
    summary_lines: Vec<String>,
}

pub fn test_remote_macos_connection(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
) -> RemoteConnectionTestResult {
    match profile.protocol.to_ascii_lowercase().as_str() {
        "jamf" => test_jamf_connection(profile, provider_account, provider_secret),
        "intune" => test_intune_connection(profile, provider_account, provider_secret),
        _ => test_macos_ssh_connection(profile),
    }
}

pub fn collect_remote_macos_events_via_provider(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
) -> CollectionResult {
    match profile.protocol.to_ascii_lowercase().as_str() {
        "jamf" => collect_jamf_inventory_events(profile, provider_account, provider_secret, max_events),
        "intune" => collect_intune_inventory_events(profile, provider_account, provider_secret, max_events),
        _ => CollectionResult::default(),
    }
}

fn test_macos_ssh_connection(profile: &RemoteConnectionProfile) -> RemoteConnectionTestResult {
    if profile.auth_type.eq_ignore_ascii_case("password") {
        return RemoteConnectionTestResult {
            ok: false,
            protocol: "ssh".to_string(),
            host: profile.host.clone(),
            status: "collection unsupported".to_string(),
            message: "Remote macOS SSH password authentication is not implemented. Use SSH key-based auth or a managed-provider path instead.".to_string(),
            warnings: Vec::new(),
            collection_mode: "unsupported".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        };
    }

    let mut ssh_args = vec![
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=no".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
    ];
    if let Some(key_path) = &profile.ssh_key_path {
        if !key_path.trim().is_empty() {
            ssh_args.push("-i".to_string());
            ssh_args.push(key_path.trim().to_string());
        }
    }
    let user_host = if profile.username.trim().is_empty() {
        profile.host.trim().to_string()
    } else {
        format!("{}@{}", profile.username.trim(), profile.host.trim())
    };
    ssh_args.push(user_host);
    ssh_args.push("log show --last 1m --style ndjson >/dev/null".to_string());

    let output = Command::new("ssh")
        .args(&ssh_args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(output) if output.status.success() => RemoteConnectionTestResult {
            ok: true,
            protocol: "ssh".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!("SSH connection to {} succeeded and `log show` is readable for this account.", profile.host),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let lower = stderr.to_ascii_lowercase();
            let (status, message) = if lower.contains("permission denied") || lower.contains("authentication failed") {
                ("auth failed", format!("SSH authentication failed for {}. {}", profile.host, summarize(stderr.as_str())))
            } else if lower.contains("connection refused") {
                ("collection unsupported", format!("SSH appears disabled or unreachable on {}. {}", profile.host, summarize(stderr.as_str())))
            } else if lower.contains("timed out") || lower.contains("no route") || lower.contains("could not resolve hostname") {
                ("device not found", format!("SSH could not reach {}. {}", profile.host, summarize(stderr.as_str())))
            } else if lower.contains("not permitted") || lower.contains("not authorized") || lower.contains("permission") {
                ("collection unsupported", format!("SSH connected to {}, but the account could not read macOS logs. {}", profile.host, summarize(stderr.as_str())))
            } else {
                ("collection unsupported", format!("SSH test against {} failed. {}", profile.host, summarize(stderr.as_str())))
            };
            RemoteConnectionTestResult {
                ok: false,
                protocol: "ssh".to_string(),
                host: profile.host.clone(),
                status: status.to_string(),
                message,
                warnings: Vec::new(),
                collection_mode: "direct".to_string(),
                provider_device_id: None,
                provider_resolved_name: None,
                provider_last_resolved_at: None,
            }
        }
        Err(error) => RemoteConnectionTestResult {
            ok: false,
            protocol: "ssh".to_string(),
            host: profile.host.clone(),
            status: "collection unsupported".to_string(),
            message: format!("Failed to launch SSH client for {}: {}", profile.host, error),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
    }
}

fn test_jamf_connection(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
) -> RemoteConnectionTestResult {
    let Some(account) = provider_account else {
        return provider_missing("jamf", profile, "Jamf Pro account is not configured.");
    };
    if !account.enabled {
        return provider_missing("jamf", profile, "Jamf Pro account exists but is disabled.");
    }
    let Some(token) = provider_secret else {
        return provider_missing("jamf", profile, "Jamf Pro API token is not configured in the OS keychain.");
    };
    let Some(client) = provider_client() else {
        return provider_missing("jamf", profile, "Unable to create HTTP client for Jamf Pro.");
    };

    let version_url = format!("{}/api/v1/jamf-pro-version", account.base_url.trim_end_matches('/'));
    let version_response = client
        .get(version_url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .send();

    let Ok(version_response) = version_response else {
        return provider_missing("jamf", profile, "Jamf Pro could not be reached with the configured base URL/token.");
    };
    if !version_response.status().is_success() {
        return provider_missing(
            "jamf",
            profile,
            format!("Jamf Pro API authentication failed with HTTP {}.", version_response.status().as_u16()).as_str(),
        );
    }

    match resolve_jamf_device(&client, account, token, profile) {
        Ok(device) => RemoteConnectionTestResult {
            ok: true,
            protocol: "jamf".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!(
                "Jamf Pro authenticated successfully and resolved '{}' to managed device '{}'.",
                profile.host, device.resolved_name
            ),
            warnings: vec![
                "Managed-provider collection currently returns inventory-backed troubleshooting evidence for macOS targets.".to_string(),
            ],
            collection_mode: "managed".to_string(),
            provider_device_id: Some(device.device_id),
            provider_resolved_name: Some(device.resolved_name),
            provider_last_resolved_at: Some(Utc::now().to_rfc3339()),
        },
        Err(error) => provider_missing("jamf", profile, error.as_str()),
    }
}

fn test_intune_connection(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
) -> RemoteConnectionTestResult {
    let Some(account) = provider_account else {
        return provider_missing("intune", profile, "Microsoft Intune account is not configured.");
    };
    if !account.enabled {
        return provider_missing("intune", profile, "Microsoft Intune account exists but is disabled.");
    }
    let Some(token) = provider_secret else {
        return provider_missing("intune", profile, "Microsoft Intune API token is not configured in the OS keychain.");
    };
    let Some(client) = provider_client() else {
        return provider_missing("intune", profile, "Unable to create HTTP client for Microsoft Intune.");
    };

    match resolve_intune_device(&client, account, token, profile) {
        Ok(device) => RemoteConnectionTestResult {
            ok: true,
            protocol: "intune".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!(
                "Microsoft Intune authenticated successfully and resolved '{}' to managed device '{}'.",
                profile.host, device.resolved_name
            ),
            warnings: vec![
                "Intune collection is asynchronous in practice; Hermes treats it as a managed polling path rather than a live SSH session.".to_string(),
                "Managed-provider collection currently returns inventory-backed troubleshooting evidence for macOS targets.".to_string(),
            ],
            collection_mode: "async-managed".to_string(),
            provider_device_id: Some(device.device_id),
            provider_resolved_name: Some(device.resolved_name),
            provider_last_resolved_at: Some(Utc::now().to_rfc3339()),
        },
        Err(error) => provider_missing("intune", profile, error.as_str()),
    }
}

fn collect_jamf_inventory_events(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    max_events: Option<u32>,
) -> CollectionResult {
    collect_managed_inventory_events(
        "jamf",
        profile,
        provider_account,
        provider_secret,
        max_events,
        |client, account, token, target| resolve_jamf_device(client, account, token, target),
    )
}

fn collect_intune_inventory_events(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    max_events: Option<u32>,
) -> CollectionResult {
    collect_managed_inventory_events(
        "intune",
        profile,
        provider_account,
        provider_secret,
        max_events,
        |client, account, token, target| resolve_intune_device(client, account, token, target),
    )
}

fn collect_managed_inventory_events<F>(
    provider: &str,
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    max_events: Option<u32>,
    resolver: F,
) -> CollectionResult
where
    F: Fn(&Client, &RemoteProviderAccount, &str, &RemoteConnectionProfile) -> Result<ManagedMacDevice, String>,
{
    let mut result = CollectionResult::default();
    let Some(account) = provider_account else {
        result
            .errors
            .push(format!("{} provider account is not configured.", provider_display_name(provider)));
        return result;
    };
    if !account.enabled {
        result
            .errors
            .push(format!("{} provider account is disabled.", provider_display_name(provider)));
        return result;
    }
    let Some(secret) = provider_secret else {
        result.errors.push(format!(
            "{} provider API token is not configured in the OS keychain.",
            provider_display_name(provider)
        ));
        return result;
    };
    let Some(client) = provider_client() else {
        result
            .errors
            .push(format!("Unable to create HTTP client for {}.", provider_display_name(provider)));
        return result;
    };

    let device = match resolver(&client, account, secret, profile) {
        Ok(device) => device,
        Err(error) => {
            result.errors.push(error);
            return result;
        }
    };

    let max = max_events.unwrap_or(2000).clamp(1, 10000) as usize;
    for (index, line) in device.summary_lines.iter().take(max).enumerate() {
        let mut event = NormalizedEvent::new(
            SupportedOs::Macos,
            "managed-device",
            if index == 0 { "system" } else { "application" },
            provider_display_name(provider),
            None,
            "information",
            line.as_str(),
            profile.host.as_str(),
        );
        event.timestamp = Utc::now().to_rfc3339();
        event.assign_stable_id();
        result.events.push(event);
    }

    result.warnings.push(format!(
        "{} collection currently returns managed-device troubleshooting evidence for '{}' rather than a remote unified-log slice.",
        provider_display_name(provider),
        device.resolved_name
    ));
    result
}

fn resolve_jamf_device(
    client: &Client,
    account: &RemoteProviderAccount,
    token: &str,
    profile: &RemoteConnectionProfile,
) -> Result<ManagedMacDevice, String> {
    let mut url = reqwest::Url::parse(
        format!("{}/api/v1/computers-inventory", account.base_url.trim_end_matches('/')).as_str(),
    )
    .map_err(|error| format!("Invalid Jamf Pro URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("section", "GENERAL");
        query.append_pair("section", "HARDWARE");
        query.append_pair("section", "OPERATING_SYSTEM");
        query.append_pair("page", "0");
        query.append_pair("page-size", "10");
        query.append_pair("filter", format!("general.name==\"{}\"", profile.host.trim()).as_str());
    }
    let response = client
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|error| format!("Jamf Pro device lookup failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Jamf Pro device lookup failed with HTTP {}.",
            response.status().as_u16()
        ));
    }

    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Jamf Pro returned invalid JSON: {error}"))?;
    let results = payload
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if results.is_empty() {
        return Err(format!(
            "Jamf Pro did not find a managed Mac named '{}'.",
            profile.host.trim()
        ));
    }
    if results.len() > 1 {
        let candidates = results
            .iter()
            .take(5)
            .map(jamf_candidate_label)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Jamf Pro found multiple managed Macs named '{}'. Candidates: {}",
            profile.host.trim(),
            candidates
        ));
    }

    let device = &results[0];
    let device_id = value_string(device, &["id", "computerId"]).unwrap_or_else(|| "unknown".to_string());
    let resolved_name = value_string(device, &["general.name", "name"]).unwrap_or_else(|| profile.host.clone());
    let os_version = value_string(device, &["operatingSystem.version", "operatingSystem.versionString"]);
    let build = value_string(device, &["operatingSystem.build"]);
    let model = value_string(device, &["hardware.modelIdentifier", "hardware.model"]);
    let serial = value_string(device, &["hardware.serialNumber"]);
    let last_check_in = value_string(device, &["general.lastContactTime", "general.lastEnrollment"]);

    let mut summary_lines = vec![format!(
        "Jamf Pro resolved '{}' to managed Mac '{}' (device ID {}).",
        profile.host, resolved_name, device_id
    )];
    if let Some(version) = os_version {
        summary_lines.push(format!("macOS version reported by Jamf Pro: {}{}.", version, build.as_ref().map(|item| format!(" (build {})", item)).unwrap_or_default()));
    }
    if let Some(model) = model {
        summary_lines.push(format!("Hardware model reported by Jamf Pro: {}{}.", model, serial.as_ref().map(|item| format!(" / serial {}", item)).unwrap_or_default()));
    }
    if let Some(last_check_in) = last_check_in {
        summary_lines.push(format!("Last management contact reported by Jamf Pro: {last_check_in}."));
    }

    Ok(ManagedMacDevice {
        device_id,
        resolved_name,
        summary_lines,
    })
}

fn resolve_intune_device(
    client: &Client,
    account: &RemoteProviderAccount,
    token: &str,
    profile: &RemoteConnectionProfile,
) -> Result<ManagedMacDevice, String> {
    let base_url = if account.base_url.trim().is_empty() {
        "https://graph.microsoft.com".to_string()
    } else {
        account.base_url.trim_end_matches('/').to_string()
    };
    let mut url = reqwest::Url::parse(format!("{}/beta/deviceManagement/managedDevices", base_url).as_str())
        .map_err(|error| format!("Invalid Intune/Graph URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "$filter",
            format!("operatingSystem eq 'macOS' and deviceName eq '{}'", profile.host.trim()).as_str(),
        );
        query.append_pair(
            "$select",
            "id,deviceName,operatingSystem,osVersion,model,serialNumber,complianceState,lastSyncDateTime",
        );
        query.append_pair("$top", "10");
    }
    let response = client
        .get(url)
        .header(AUTHORIZATION, format!("Bearer {token}"))
        .header(CONTENT_TYPE, "application/json")
        .send()
        .map_err(|error| format!("Microsoft Intune device lookup failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Microsoft Intune device lookup failed with HTTP {}.",
            response.status().as_u16()
        ));
    }
    let payload = response
        .json::<Value>()
        .map_err(|error| format!("Microsoft Intune returned invalid JSON: {error}"))?;
    let results = payload
        .get("value")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if results.is_empty() {
        return Err(format!(
            "Microsoft Intune did not find a managed Mac named '{}'.",
            profile.host.trim()
        ));
    }
    if results.len() > 1 {
        let candidates = results
            .iter()
            .take(5)
            .map(intune_candidate_label)
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "Microsoft Intune found multiple managed Macs named '{}'. Candidates: {}",
            profile.host.trim(),
            candidates
        ));
    }

    let device = &results[0];
    let device_id = value_string(device, &["id"]).unwrap_or_else(|| "unknown".to_string());
    let resolved_name = value_string(device, &["deviceName"]).unwrap_or_else(|| profile.host.clone());
    let os_version = value_string(device, &["osVersion"]);
    let model = value_string(device, &["model"]);
    let serial = value_string(device, &["serialNumber"]);
    let compliance = value_string(device, &["complianceState"]);
    let last_sync = value_string(device, &["lastSyncDateTime"]);

    let mut summary_lines = vec![format!(
        "Microsoft Intune resolved '{}' to managed Mac '{}' (device ID {}).",
        profile.host, resolved_name, device_id
    )];
    if let Some(version) = os_version {
        summary_lines.push(format!("macOS version reported by Intune: {version}."));
    }
    if let Some(model) = model {
        summary_lines.push(format!("Hardware model reported by Intune: {}{}.", model, serial.as_ref().map(|item| format!(" / serial {}", item)).unwrap_or_default()));
    }
    if let Some(compliance) = compliance {
        summary_lines.push(format!("Compliance state reported by Intune: {compliance}."));
    }
    if let Some(last_sync) = last_sync {
        summary_lines.push(format!("Last Intune sync time: {last_sync}."));
    }

    Ok(ManagedMacDevice {
        device_id,
        resolved_name,
        summary_lines,
    })
}

fn provider_missing(provider: &str, profile: &RemoteConnectionProfile, message: &str) -> RemoteConnectionTestResult {
    RemoteConnectionTestResult {
        ok: false,
        protocol: provider.to_string(),
        host: profile.host.clone(),
        status: if message.contains("multiple") {
            "device ambiguous".to_string()
        } else if message.contains("did not find") {
            "device not found".to_string()
        } else if message.contains("disabled") || message.contains("token") || message.contains("authentication") {
            "auth failed".to_string()
        } else {
            "collection unsupported".to_string()
        },
        message: message.to_string(),
        warnings: Vec::new(),
        collection_mode: if provider == "intune" {
            "async-managed".to_string()
        } else {
            "managed".to_string()
        },
        provider_device_id: None,
        provider_resolved_name: None,
        provider_last_resolved_at: None,
    }
}

fn provider_client() -> Option<Client> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()
}

fn provider_display_name(provider: &str) -> &'static str {
    match provider {
        "jamf" => "Jamf Pro",
        "intune" => "Microsoft Intune",
        _ => "Managed macOS provider",
    }
}

fn value_string(value: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut resolved = true;
        for part in path.split('.') {
            let Some(next) = current.get(part) else {
                resolved = false;
                break;
            };
            current = next;
        }
        if !resolved {
            continue;
        }
        if let Some(as_str) = current.as_str() {
            let trimmed = as_str.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        } else if current.is_number() || current.is_boolean() {
            return Some(current.to_string());
        }
    }
    None
}

fn jamf_candidate_label(value: &Value) -> String {
    let name = value_string(value, &["general.name", "name"]).unwrap_or_else(|| "unknown".to_string());
    let serial = value_string(value, &["hardware.serialNumber"]).unwrap_or_else(|| "serial unavailable".to_string());
    format!("{name} ({serial})")
}

fn intune_candidate_label(value: &Value) -> String {
    let name = value_string(value, &["deviceName"]).unwrap_or_else(|| "unknown".to_string());
    let serial = value_string(value, &["serialNumber"]).unwrap_or_else(|| "serial unavailable".to_string());
    format!("{name} ({serial})")
}

fn summarize(text: &str) -> String {
    let trimmed = text.trim().replace('\n', " ");
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= 220 {
        trimmed
    } else {
        format!("{}...", &trimmed[..220])
    }
}
