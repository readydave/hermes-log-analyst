use crate::logs::{CollectionResult, NormalizedEvent, SupportedOs};
use crate::remote_common::RemoteConnectionTestResult;
use crate::settings::{RemoteConnectionProfile, RemoteProviderAccount};
use chrono::{DateTime, Utc};
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde_json::Value;
use std::process::Command;
use std::time::Duration;

#[derive(Debug, Clone)]
struct ManagedWindowsDevice {
    device_id: String,
    resolved_name: String,
    summary_lines: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct RemoteWindowsSummary {
    host_name: String,
    domain_or_workgroup: Option<String>,
    os_caption: Option<String>,
    os_version: Option<String>,
    os_build: Option<String>,
    manufacturer: Option<String>,
    model: Option<String>,
    last_boot: Option<String>,
    uptime_hint: Option<String>,
    recent_hotfixes: Vec<String>,
}

pub fn test_remote_windows_connection(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
) -> RemoteConnectionTestResult {
    match profile.protocol.to_ascii_lowercase().as_str() {
        "rpc" => test_rpc_connection(profile),
        "intune" => test_intune_connection(profile, provider_account, provider_secret),
        _ => test_winrm_connection(profile),
    }
}

pub fn collect_remote_windows_events_via_provider(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
) -> CollectionResult {
    match profile.protocol.to_ascii_lowercase().as_str() {
        "intune" => {
            collect_intune_inventory_events(profile, provider_account, provider_secret, max_events)
        }
        _ => CollectionResult::default(),
    }
}

fn test_winrm_connection(profile: &RemoteConnectionProfile) -> RemoteConnectionTestResult {
    let Some(wrapper_script) = build_winrm_test_script(profile) else {
        return RemoteConnectionTestResult {
            ok: false,
            protocol: "winrm".to_string(),
            host: profile.host.clone(),
            status: "auth failed".to_string(),
            message: "WinRM password authentication requires a stored secret in the OS keychain."
                .to_string(),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        };
    };

    match Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(wrapper_script)
        .output()
    {
        Ok(output) if output.status.success() => RemoteConnectionTestResult {
            ok: true,
            protocol: "winrm".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!(
                "WinRM connection to {} succeeded and the remote host returned Event Log plus system-summary metadata.",
                profile.host
            ),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let (status, message) = classify_winrm_error(profile.host.as_str(), stderr.as_str());
            RemoteConnectionTestResult {
                ok: false,
                protocol: "winrm".to_string(),
                host: profile.host.clone(),
                status,
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
            protocol: "winrm".to_string(),
            host: profile.host.clone(),
            status: "collection unsupported".to_string(),
            message: format!("Failed to launch PowerShell for WinRM test: {error}"),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
    }
}

fn test_rpc_connection(profile: &RemoteConnectionProfile) -> RemoteConnectionTestResult {
    let Some((wevtutil_args, wmi_script)) = build_rpc_test_commands(profile) else {
        return RemoteConnectionTestResult {
            ok: false,
            protocol: "rpc".to_string(),
            host: profile.host.clone(),
            status: "auth failed".to_string(),
            message:
                "RPC/DCOM password authentication requires a stored secret in the OS keychain."
                    .to_string(),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        };
    };

    let event_output = Command::new("wevtutil").args(&wevtutil_args).output();
    let Ok(event_output) = event_output else {
        return RemoteConnectionTestResult {
            ok: false,
            protocol: "rpc".to_string(),
            host: profile.host.clone(),
            status: "collection unsupported".to_string(),
            message: "Failed to launch wevtutil for RPC/DCOM test.".to_string(),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        };
    };
    if !event_output.status.success() {
        let stderr = String::from_utf8_lossy(&event_output.stderr)
            .trim()
            .to_string();
        let (status, message) =
            classify_rpc_error(profile.host.as_str(), stderr.as_str(), "Event Log");
        return RemoteConnectionTestResult {
            ok: false,
            protocol: "rpc".to_string(),
            host: profile.host.clone(),
            status,
            message,
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        };
    }

    let wmi_output = Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(wmi_script)
        .output();
    match wmi_output {
        Ok(output) if output.status.success() => RemoteConnectionTestResult {
            ok: true,
            protocol: "rpc".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!(
                "RPC/DCOM connection to {} succeeded and the remote host returned Event Log plus WMI summary data.",
                profile.host
            ),
            warnings: vec![
                "RPC/DCOM depends on Remote Event Log Management and WMI/DCOM firewall access on the remote host.".to_string(),
            ],
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let (status, message) = classify_rpc_error(profile.host.as_str(), stderr.as_str(), "WMI/DCOM");
            RemoteConnectionTestResult {
                ok: false,
                protocol: "rpc".to_string(),
                host: profile.host.clone(),
                status,
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
            protocol: "rpc".to_string(),
            host: profile.host.clone(),
            status: "collection unsupported".to_string(),
            message: format!("Failed to launch PowerShell for WMI/DCOM test: {error}"),
            warnings: Vec::new(),
            collection_mode: "direct".to_string(),
            provider_device_id: None,
            provider_resolved_name: None,
            provider_last_resolved_at: None,
        },
    }
}

fn test_intune_connection(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
) -> RemoteConnectionTestResult {
    let Some(account) = provider_account else {
        return provider_missing(
            "intune",
            profile,
            "Microsoft Intune account is not configured.",
        );
    };
    if !account.enabled {
        return provider_missing(
            "intune",
            profile,
            "Microsoft Intune account exists but is disabled.",
        );
    }
    let Some(token) = provider_secret else {
        return provider_missing(
            "intune",
            profile,
            "Microsoft Intune API token is not configured in the OS keychain.",
        );
    };
    let Some(client) = provider_client() else {
        return provider_missing(
            "intune",
            profile,
            "Unable to create HTTP client for Microsoft Intune.",
        );
    };

    match resolve_intune_windows_device(&client, account, token, profile) {
        Ok(device) => RemoteConnectionTestResult {
            ok: true,
            protocol: "intune".to_string(),
            host: profile.host.clone(),
            status: "ready".to_string(),
            message: format!(
                "Microsoft Intune authenticated successfully and resolved '{}' to managed Windows device '{}'.",
                profile.host, device.resolved_name
            ),
            warnings: vec![
                "Windows Intune collection is asynchronous in practice; Hermes treats it as a managed polling path rather than a live remote shell.".to_string(),
                "Managed-provider collection currently returns inventory-backed Windows troubleshooting evidence.".to_string(),
            ],
            collection_mode: "async-managed".to_string(),
            provider_device_id: Some(device.device_id),
            provider_resolved_name: Some(device.resolved_name),
            provider_last_resolved_at: Some(Utc::now().to_rfc3339()),
        },
        Err(error) => provider_missing("intune", profile, error.as_str()),
    }
}

fn collect_intune_inventory_events(
    profile: &RemoteConnectionProfile,
    provider_account: Option<&RemoteProviderAccount>,
    provider_secret: Option<&str>,
    max_events: Option<u32>,
) -> CollectionResult {
    let Some(account) = provider_account else {
        return collection_error("Microsoft Intune account is not configured.");
    };
    if !account.enabled {
        return collection_error("Microsoft Intune account exists but is disabled.");
    }
    let Some(token) = provider_secret else {
        return collection_error(
            "Microsoft Intune API token is not configured in the OS keychain.",
        );
    };
    let Some(client) = provider_client() else {
        return collection_error("Unable to create HTTP client for Microsoft Intune.");
    };

    let limit = max_events.unwrap_or(50).max(1) as usize;
    match resolve_intune_windows_device(&client, account, token, profile) {
        Ok(device) => {
            let mut result = CollectionResult::default();
            let provider = "Microsoft Intune";
            for line in device.summary_lines.iter().take(limit.max(1)) {
                let mut event = NormalizedEvent::new(
                    SupportedOs::Windows,
                    "Managed Device",
                    "system",
                    provider,
                    None,
                    "information",
                    line.as_str(),
                    profile.host.as_str(),
                );
                event.assign_stable_id();
                result.events.push(event);
            }
            result.warnings.push(
                "Windows Intune collection currently returns inventory-backed troubleshooting evidence rather than live Event Log transport.".to_string(),
            );
            result
        }
        Err(error) => collection_error(error.as_str()),
    }
}

pub fn build_summary_events(
    summary: &RemoteWindowsSummary,
    source_host: &str,
    transport_label: &str,
    event_hints: &[String],
) -> Vec<NormalizedEvent> {
    let mut lines = vec![format!(
        "Windows remote system summary collected via {} for '{}'.",
        transport_label, source_host
    )];
    if !summary.host_name.is_empty() {
        lines.push(format!("Hostname: {}.", summary.host_name));
    }
    if let Some(value) = &summary.domain_or_workgroup {
        lines.push(format!("Domain/Workgroup: {value}."));
    }
    if let Some(caption) = &summary.os_caption {
        let mut label = caption.clone();
        if let Some(version) = &summary.os_version {
            label.push_str(format!(" {}", version).as_str());
        }
        if let Some(build) = &summary.os_build {
            label.push_str(format!(" (build {build})").as_str());
        }
        lines.push(format!("OS: {label}."));
    }
    if summary.manufacturer.is_some() || summary.model.is_some() {
        let manufacturer = summary
            .manufacturer
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());
        let model = summary
            .model
            .clone()
            .unwrap_or_else(|| "Unknown".to_string());
        lines.push(format!("Hardware: {manufacturer} / {model}."));
    }
    if let Some(value) = &summary.last_boot {
        lines.push(format!("Last boot: {value}."));
    }
    if let Some(value) = &summary.uptime_hint {
        lines.push(format!("Approximate uptime: {value}."));
    }
    if !summary.recent_hotfixes.is_empty() {
        lines.push(format!(
            "Recent hotfixes: {}.",
            summary.recent_hotfixes.join(", ")
        ));
    }
    if !event_hints.is_empty() {
        lines.push(format!(
            "Crash/WER hints in current collection: {}.",
            event_hints.join("; ")
        ));
    }

    let mut event = NormalizedEvent::new(
        SupportedOs::Windows,
        "SystemSummary",
        "system",
        "Hermes Remote Summary",
        None,
        "information",
        lines.join(" ").as_str(),
        source_host,
    );
    event.assign_stable_id();
    vec![event]
}

pub fn parse_remote_summary_json(payload: &str) -> Option<RemoteWindowsSummary> {
    let parsed: Value = serde_json::from_str(payload).ok()?;
    Some(parse_summary_value(&parsed))
}

fn parse_summary_value(value: &Value) -> RemoteWindowsSummary {
    let host_name = value_string(value, &["HostName", "hostName", "CSName"]).unwrap_or_default();
    let uptime_seconds = value
        .get("UptimeSeconds")
        .and_then(Value::as_i64)
        .or_else(|| value.get("uptimeSeconds").and_then(Value::as_i64));

    RemoteWindowsSummary {
        host_name,
        domain_or_workgroup: value_string(value, &["DomainOrWorkgroup", "domainOrWorkgroup"]),
        os_caption: value_string(value, &["OSCaption", "osCaption"]),
        os_version: value_string(value, &["OSVersion", "osVersion"]),
        os_build: value_string(value, &["BuildNumber", "buildNumber"]),
        manufacturer: value_string(value, &["Manufacturer", "manufacturer"]),
        model: value_string(value, &["Model", "model"]),
        last_boot: value_string(value, &["LastBoot", "lastBoot"]),
        uptime_hint: uptime_seconds.map(format_duration_hint),
        recent_hotfixes: parse_hotfixes(value),
    }
}

fn parse_hotfixes(value: &Value) -> Vec<String> {
    let mut hotfixes = Vec::new();
    let entries = value
        .get("RecentHotfixes")
        .and_then(Value::as_array)
        .or_else(|| value.get("recentHotfixes").and_then(Value::as_array));
    if let Some(entries) = entries {
        for entry in entries.iter().take(5) {
            let id = value_string(entry, &["HotFixID", "hotFixId", "id"]).unwrap_or_default();
            let installed =
                value_string(entry, &["InstalledOn", "installedOn"]).unwrap_or_default();
            let normalized = if installed.is_empty() {
                id
            } else {
                format!("{id} ({installed})")
            };
            let trimmed = normalized.trim();
            if !trimmed.is_empty() {
                hotfixes.push(trimmed.to_string());
            }
        }
    }
    hotfixes
}

fn parse_event_hint_messages(events: &[NormalizedEvent]) -> Vec<String> {
    let mut hints = Vec::new();
    for event in events {
        if event
            .provider
            .eq_ignore_ascii_case("Microsoft-Windows-WER-SystemErrorReporting")
            || event
                .provider
                .eq_ignore_ascii_case("Windows Error Reporting")
            || event.event_id == Some(1001)
            || (event
                .provider
                .eq_ignore_ascii_case("Microsoft-Windows-Kernel-Power")
                && event.event_id == Some(41))
        {
            let hint = format!(
                "{} Event {} ({})",
                event.provider,
                event.event_id.unwrap_or_default(),
                event.severity
            );
            if !hints.contains(&hint) {
                hints.push(hint);
            }
        }
        if hints.len() >= 3 {
            break;
        }
    }
    hints
}

pub fn summary_hints_from_events(events: &[NormalizedEvent]) -> Vec<String> {
    parse_event_hint_messages(events)
}

fn build_winrm_test_script(profile: &RemoteConnectionProfile) -> Option<String> {
    let mut cred_setup = String::new();
    let mut cred_arg = String::new();
    if profile.auth_type.eq_ignore_ascii_case("password") && !profile.username.trim().is_empty() {
        let secret = crate::settings::get_remote_profile_secret(profile.id.as_str())
            .ok()
            .flatten()?;
        cred_setup = format!(
            "$SecPwd = ConvertTo-SecureString '{}' -AsPlainText -Force; $Cred = New-Object System.Management.Automation.PSCredential ('{}', $SecPwd); ",
            secret.replace('\'', "''"),
            profile.username.trim().replace('\'', "''")
        );
        cred_arg = "-Credential $Cred".to_string();
    }

    let inner = r#"
$event = Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction Stop | Select-Object -First 1
$os = Get-WmiObject -Class Win32_OperatingSystem -ErrorAction Stop
[PSCustomObject]@{
  EventId = $event.Id
  HostName = $env:COMPUTERNAME
  Version = $os.Version
} | ConvertTo-Json -Compress
"#;
    Some(format!(
        "{}$sb = [scriptblock]::Create('{}'); Invoke-Command -ComputerName '{}' {} -ScriptBlock $sb",
        cred_setup,
        inner.replace('\'', "''"),
        profile.host.replace('\'', "''"),
        cred_arg
    ))
}

fn build_rpc_test_commands(profile: &RemoteConnectionProfile) -> Option<(Vec<String>, String)> {
    let mut args = vec![
        "qe".to_string(),
        "System".to_string(),
        format!("/r:{}", profile.host.trim()),
        "/rd:true".to_string(),
        "/f:xml".to_string(),
        "/c:1".to_string(),
    ];
    let mut credential_clause = String::new();
    if profile.auth_type.eq_ignore_ascii_case("password") && !profile.username.trim().is_empty() {
        let secret = crate::settings::get_remote_profile_secret(profile.id.as_str())
            .ok()
            .flatten()?;
        args.push(format!("/u:{}", profile.username.trim()));
        args.push(format!("/p:{secret}"));
        credential_clause = format!(
            "$SecPwd = ConvertTo-SecureString '{}' -AsPlainText -Force; $Cred = New-Object Management.Automation.PSCredential ('{}', $SecPwd); ",
            secret.replace('\'', "''"),
            profile.username.trim().replace('\'', "''")
        );
    }

    let wmi_script = format!(
        "{}$os = Get-WmiObject -Class Win32_OperatingSystem -ComputerName '{}' {}-ErrorAction Stop; $cs = Get-WmiObject -Class Win32_ComputerSystem -ComputerName '{}' {}-ErrorAction Stop; [PSCustomObject]@{{ HostName = $os.CSName; Version = $os.Version; Model = $cs.Model }} | ConvertTo-Json -Compress",
        credential_clause,
        profile.host.replace('\'', "''"),
        if credential_clause.is_empty() { "" } else { "-Credential $Cred " },
        profile.host.replace('\'', "''"),
        if credential_clause.is_empty() { "" } else { "-Credential $Cred " },
    );
    Some((args, wmi_script))
}

fn provider_client() -> Option<Client> {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()
}

fn resolve_intune_windows_device(
    client: &Client,
    account: &RemoteProviderAccount,
    token: &str,
    profile: &RemoteConnectionProfile,
) -> Result<ManagedWindowsDevice, String> {
    let base_url = if account.base_url.trim().is_empty() {
        "https://graph.microsoft.com".to_string()
    } else {
        account.base_url.trim_end_matches('/').to_string()
    };
    let mut url =
        reqwest::Url::parse(format!("{}/beta/deviceManagement/managedDevices", base_url).as_str())
            .map_err(|error| format!("Invalid Intune/Graph URL: {error}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "$filter",
            format!(
                "operatingSystem eq 'Windows' and deviceName eq '{}'",
                profile.host.trim()
            )
            .as_str(),
        );
        query.append_pair(
            "$select",
            "id,deviceName,operatingSystem,osVersion,model,manufacturer,serialNumber,complianceState,lastSyncDateTime",
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
            "Microsoft Intune did not find a managed Windows device named '{}'.",
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
            "Microsoft Intune found multiple managed Windows devices named '{}'. Candidates: {}",
            profile.host.trim(),
            candidates
        ));
    }

    let device = &results[0];
    let device_id = value_string(device, &["id"]).unwrap_or_else(|| "unknown".to_string());
    let resolved_name =
        value_string(device, &["deviceName"]).unwrap_or_else(|| profile.host.clone());
    let os_version = value_string(device, &["osVersion"]);
    let model = value_string(device, &["model"]);
    let manufacturer = value_string(device, &["manufacturer"]);
    let serial = value_string(device, &["serialNumber"]);
    let compliance = value_string(device, &["complianceState"]);
    let last_sync = value_string(device, &["lastSyncDateTime"]);

    let mut summary_lines = vec![format!(
        "Microsoft Intune resolved '{}' to managed Windows device '{}' (device ID {}).",
        profile.host, resolved_name, device_id
    )];
    if let Some(version) = os_version {
        summary_lines.push(format!("Windows version reported by Intune: {version}."));
    }
    if manufacturer.is_some() || model.is_some() {
        summary_lines.push(format!(
            "Hardware reported by Intune: {} / {}{}.",
            manufacturer.unwrap_or_else(|| "Unknown".to_string()),
            model.unwrap_or_else(|| "Unknown".to_string()),
            serial
                .as_ref()
                .map(|value| format!(" / serial {value}"))
                .unwrap_or_default()
        ));
    }
    if let Some(compliance) = compliance {
        summary_lines.push(format!(
            "Compliance state reported by Intune: {compliance}."
        ));
    }
    if let Some(last_sync) = last_sync {
        summary_lines.push(format!("Last Intune sync time: {last_sync}."));
    }

    Ok(ManagedWindowsDevice {
        device_id,
        resolved_name,
        summary_lines,
    })
}

fn collection_error(message: &str) -> CollectionResult {
    let mut result = CollectionResult::default();
    result.errors.push(message.to_string());
    result
}

fn provider_missing(
    provider: &str,
    profile: &RemoteConnectionProfile,
    message: &str,
) -> RemoteConnectionTestResult {
    RemoteConnectionTestResult {
        ok: false,
        protocol: provider.to_string(),
        host: profile.host.clone(),
        status: if message.contains("multiple") {
            "device ambiguous".to_string()
        } else if message.contains("did not find") {
            "device not found".to_string()
        } else if message.contains("disabled")
            || message.contains("token")
            || message.contains("authentication")
        {
            "auth failed".to_string()
        } else {
            "collection unsupported".to_string()
        },
        message: message.to_string(),
        warnings: Vec::new(),
        collection_mode: "async-managed".to_string(),
        provider_device_id: None,
        provider_resolved_name: None,
        provider_last_resolved_at: None,
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

fn intune_candidate_label(value: &Value) -> String {
    let name = value_string(value, &["deviceName"]).unwrap_or_else(|| "unknown".to_string());
    let serial =
        value_string(value, &["serialNumber"]).unwrap_or_else(|| "serial unavailable".to_string());
    format!("{name} ({serial})")
}

fn classify_winrm_error(host: &str, stderr: &str) -> (String, String) {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("logon failure")
        || lower.contains("unknown user name or bad password")
        || lower.contains("user name or password is incorrect")
        || lower.contains("0x8007052e")
    {
        return (
            "auth failed".to_string(),
            format!(
                "WinRM authentication failed for {host}. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("access is denied") || lower.contains("0x80070005") {
        return (
            "access denied".to_string(),
            format!(
                "WinRM connected to {host}, but the account was denied access. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("winrm cannot complete the operation")
        || lower.contains("the client cannot connect")
        || lower.contains("ws-management service")
        || lower.contains("the connection to the remote host was refused")
    {
        return (
            "winrm unavailable".to_string(),
            format!(
                "WinRM does not appear available on {host}. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("no such host is known")
        || lower.contains("could not resolve")
        || lower.contains("network path was not found")
        || lower.contains("name resolution")
    {
        return (
            "host unreachable".to_string(),
            format!(
                "Hermes could not resolve or reach {host} over WinRM. {}",
                summarize(stderr)
            ),
        );
    }
    (
        "collection unsupported".to_string(),
        format!("WinRM test against {host} failed. {}", summarize(stderr)),
    )
}

fn classify_rpc_error(host: &str, stderr: &str, phase: &str) -> (String, String) {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("rpc server is unavailable") || lower.contains("0x800706ba") {
        return (
            "rpc unavailable".to_string(),
            format!(
                "RPC/DCOM could not reach {host} during {phase} access. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("access is denied") || lower.contains("0x80070005") {
        return (
            "access denied".to_string(),
            format!(
                "RPC/DCOM reached {host}, but {phase} access was denied. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("logon failure")
        || lower.contains("unknown user name or bad password")
        || lower.contains("0x8007052e")
    {
        return (
            "auth failed".to_string(),
            format!(
                "RPC/DCOM authentication failed for {host}. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("network path was not found")
        || lower.contains("no such host is known")
        || lower.contains("could not resolve")
    {
        return (
            "host unreachable".to_string(),
            format!(
                "Hermes could not resolve or reach {host} over RPC/DCOM. {}",
                summarize(stderr)
            ),
        );
    }
    if lower.contains("firewall") || lower.contains("dcom") || lower.contains("remote event log") {
        return (
            "firewall blocked".to_string(),
            format!(
                "RPC/DCOM access to {host} appears blocked. {}",
                summarize(stderr)
            ),
        );
    }
    (
        "collection unsupported".to_string(),
        format!(
            "RPC/DCOM {phase} test against {host} failed. {}",
            summarize(stderr)
        ),
    )
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

fn format_duration_hint(total_seconds: i64) -> String {
    if total_seconds <= 0 {
        return "unknown".to_string();
    }
    let days = total_seconds / 86_400;
    let hours = (total_seconds % 86_400) / 3_600;
    let minutes = (total_seconds % 3_600) / 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if parts.is_empty() {
        parts.push(format!("{total_seconds}s"));
    }
    parts.join(" ")
}
