use super::{CollectionEstimate, CollectionResult, NormalizedEvent, SupportedOs};
use crate::remote_windows::{
    build_summary_events, parse_remote_summary_json, summary_hints_from_events,
};
use crate::settings::RemoteConnectionProfile;
#[cfg(target_os = "windows")]
use chrono::SecondsFormat;
use chrono::{DateTime, Utc};
#[cfg(target_os = "windows")]
use serde_json::Value;

#[cfg(target_os = "windows")]
use std::ffi::OsStr;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use std::ptr::{null, null_mut};

#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ACCESS_DENIED, ERROR_INSUFFICIENT_BUFFER, ERROR_NO_MORE_ITEMS,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::EventLog::{
    EvtClose, EvtFormatMessage, EvtFormatMessageEvent, EvtNext, EvtOpenPublisherMetadata, EvtQuery,
    EvtQueryChannelPath, EvtRender, EvtRenderEventXml, EVT_HANDLE,
};

#[cfg(target_os = "windows")]
const DEFAULT_CHANNELS: [&str; 3] = ["Application", "System", "Security"];
#[cfg(target_os = "windows")]
const ESTIMATE_SAMPLE_LIMIT: usize = 200;

#[cfg(target_os = "windows")]
struct EvtHandle(EVT_HANDLE);

#[cfg(target_os = "windows")]
impl Drop for EvtHandle {
    fn drop(&mut self) {
        unsafe {
            if self.0 != 0 {
                EvtClose(self.0);
            }
        }
    }
}

#[cfg(target_os = "windows")]
pub fn collect_events_range_with_channels(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    channels: Option<&[String]>,
) -> CollectionResult {
    let max = max_events.unwrap_or(2000).min(10000) as usize;
    if max == 0 {
        return CollectionResult::default();
    }

    let selected_channels = normalize_channels(channels);
    collect_with_wevtapi(start, end, max, selected_channels.as_slice())
}

#[cfg(target_os = "windows")]
pub fn estimate_events_range_with_channels(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    channels: Option<&[String]>,
) -> CollectionEstimate {
    let selected_channels = normalize_channels(channels);
    estimate_with_wevtapi(start, end, selected_channels.as_slice())
}

#[cfg(not(target_os = "windows"))]
pub fn collect_events_range_with_channels(
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    _max_events: Option<u32>,
    _channels: Option<&[String]>,
) -> CollectionResult {
    CollectionResult::default()
}

#[cfg(not(target_os = "windows"))]
pub fn estimate_events_range_with_channels(
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    _channels: Option<&[String]>,
) -> CollectionEstimate {
    CollectionEstimate::default()
}

#[cfg(not(target_os = "windows"))]
pub fn collect_remote_windows_events(
    _profile: &RemoteConnectionProfile,
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    _max_events: Option<u32>,
    _channels: Option<&[String]>,
) -> CollectionResult {
    CollectionResult::default()
}

#[cfg(target_os = "windows")]
fn collect_with_wevtapi(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max: usize,
    channels: &[&'static str],
) -> CollectionResult {
    let query = build_time_query(start, end);
    let mut result = CollectionResult::default();

    for channel in channels {
        let remaining = max.saturating_sub(result.events.len());
        match collect_channel_events(*channel, query.as_deref(), remaining) {
            Ok(mut channel_events) => {
                result.events.append(&mut channel_events);
            }
            Err(error) => {
                if error.to_ascii_lowercase().contains("access denied") {
                    result.warnings.push(error);
                } else {
                    result.errors.push(error);
                }
            }
        }
    }

    if result.events.is_empty() && !result.warnings.is_empty() && result.errors.is_empty() {
        result.errors.push(
            "Collector could not read any requested Windows channels. Check channel permissions."
                .to_string(),
        );
    }

    result
}

#[cfg(target_os = "windows")]
fn estimate_with_wevtapi(
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    channels: &[&'static str],
) -> CollectionEstimate {
    let query = build_time_query(start, end);
    let mut result = CollectionEstimate::default();

    for channel in channels {
        match estimate_channel_events(*channel, query.as_deref()) {
            Ok(channel_estimate) => {
                result.estimated_count += channel_estimate.count;
                result.estimated_bytes += channel_estimate.estimated_bytes();
            }
            Err(error) => {
                if error.to_ascii_lowercase().contains("access denied") {
                    result.warnings.push(error);
                } else {
                    result.errors.push(error);
                }
            }
        }
    }

    result
}

#[cfg(target_os = "windows")]
#[derive(Default)]
struct ChannelEstimate {
    count: usize,
    sampled_bytes: usize,
    sampled_count: usize,
}

#[cfg(target_os = "windows")]
impl ChannelEstimate {
    fn estimated_bytes(&self) -> usize {
        if self.count == 0 {
            return 0;
        }
        if self.sampled_count == 0 {
            return self.count * 512;
        }
        let average_bytes = (self.sampled_bytes / self.sampled_count).max(128);
        average_bytes * self.count
    }
}

#[cfg(target_os = "windows")]
fn collect_channel_events(
    channel: &str,
    query: Option<&str>,
    max: usize,
) -> Result<Vec<NormalizedEvent>, String> {
    let query = query.unwrap_or("*");
    let channel_w = to_wide(channel);
    let query_w = to_wide(query);
    let handle = unsafe { EvtQuery(0, channel_w.as_ptr(), query_w.as_ptr(), EvtQueryChannelPath) };
    if handle == 0 {
        let error = last_error();
        if error == ERROR_ACCESS_DENIED {
            return Err(format!(
                "Access denied reading Windows '{channel}' channel (win32 {error})."
            ));
        }
        return Err(format!("EvtQuery failed for {channel}: win32 {error}"));
    }

    let _query_handle = EvtHandle(handle);
    let mut events = Vec::new();

    if max == 0 {
        return Ok(events);
    }

    let mut handles = vec![0 as EVT_HANDLE; 16];

    loop {
        let mut returned: u32 = 0;
        let ok = unsafe {
            EvtNext(
                handle,
                handles.len() as u32,
                handles.as_mut_ptr(),
                0,
                0,
                &mut returned,
            )
        };
        if ok == 0 {
            let error = last_error();
            if error == ERROR_NO_MORE_ITEMS {
                break;
            }
            return Err(format!("EvtNext failed for {channel}: win32 {error}"));
        }

        for idx in 0..returned as usize {
            let event_handle = handles[idx];
            if event_handle == 0 {
                continue;
            }
            let rendered = render_event(event_handle, channel);
            unsafe {
                EvtClose(event_handle);
            }
            if let Some(event) = rendered {
                events.push(event);
                if events.len() >= max {
                    for rest in handles
                        .iter()
                        .skip(idx + 1)
                        .take(returned as usize - idx - 1)
                    {
                        if *rest != 0 {
                            unsafe { EvtClose(*rest) };
                        }
                    }
                    return Ok(events);
                }
            }
        }
    }

    Ok(events)
}

#[cfg(target_os = "windows")]
fn estimate_channel_events(channel: &str, query: Option<&str>) -> Result<ChannelEstimate, String> {
    let query = query.unwrap_or("*");
    let channel_w = to_wide(channel);
    let query_w = to_wide(query);
    let handle = unsafe { EvtQuery(0, channel_w.as_ptr(), query_w.as_ptr(), EvtQueryChannelPath) };
    if handle == 0 {
        let error = last_error();
        if error == ERROR_ACCESS_DENIED {
            return Err(format!(
                "Access denied reading Windows '{channel}' channel (win32 {error})."
            ));
        }
        return Err(format!("EvtQuery failed for {channel}: win32 {error}"));
    }

    let _query_handle = EvtHandle(handle);
    let mut estimate = ChannelEstimate::default();
    let mut handles = vec![0 as EVT_HANDLE; 32];

    loop {
        let mut returned: u32 = 0;
        let ok = unsafe {
            EvtNext(
                handle,
                handles.len() as u32,
                handles.as_mut_ptr(),
                0,
                0,
                &mut returned,
            )
        };
        if ok == 0 {
            let error = last_error();
            if error == ERROR_NO_MORE_ITEMS {
                break;
            }
            return Err(format!("EvtNext failed for {channel}: win32 {error}"));
        }

        for idx in 0..returned as usize {
            let event_handle = handles[idx];
            if event_handle == 0 {
                continue;
            }

            estimate.count += 1;
            if estimate.sampled_count < ESTIMATE_SAMPLE_LIMIT {
                if let Some(xml) = render_event_xml(event_handle) {
                    estimate.sampled_bytes += xml.len();
                    estimate.sampled_count += 1;
                }
            }

            unsafe {
                EvtClose(event_handle);
            }
        }
    }

    Ok(estimate)
}

#[cfg(target_os = "windows")]
fn render_event(handle: EVT_HANDLE, fallback_channel: &str) -> Option<NormalizedEvent> {
    let xml = render_event_xml(handle)?;
    let provider = extract_xml_attr(&xml, "Provider", "Name")
        .unwrap_or_else(|| "Unknown Provider".to_string());
    let log_name =
        extract_xml_tag_value(&xml, "Channel").unwrap_or_else(|| fallback_channel.to_string());
    let event_id =
        extract_xml_tag_value(&xml, "EventID").and_then(|value| value.parse::<u32>().ok());
    let level = extract_xml_tag_value(&xml, "Level").and_then(|value| value.parse::<u32>().ok());
    let severity = map_severity(level);
    let category = map_category(&log_name);
    let message = format_event_message(handle, provider.as_str())
        .or_else(|| extract_event_data(&xml))
        .unwrap_or_else(|| "No event message.".to_string());

    let mut event = NormalizedEvent::new(
        SupportedOs::Windows,
        log_name.as_str(),
        category,
        provider.as_str(),
        event_id,
        severity,
        sanitize_message(message.as_str()),
        "localhost",
    );

    if let Some(timestamp) = extract_xml_attr(&xml, "TimeCreated", "SystemTime") {
        event.timestamp = timestamp;
    }

    event.assign_stable_id();

    Some(event)
}

#[cfg(target_os = "windows")]
fn render_event_xml(handle: EVT_HANDLE) -> Option<String> {
    unsafe {
        let mut buffer_used: u32 = 0;
        let mut property_count: u32 = 0;
        let ok = EvtRender(
            0,
            handle,
            EvtRenderEventXml,
            0,
            null_mut(),
            &mut buffer_used,
            &mut property_count,
        );
        let error = if ok == 0 { last_error() } else { 0 };
        if ok == 0 && error != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        if buffer_used == 0 {
            return None;
        }

        let mut buffer: Vec<u16> = vec![0; (buffer_used as usize / 2) + 1];
        let ok = EvtRender(
            0,
            handle,
            EvtRenderEventXml,
            (buffer.len() * 2) as u32,
            buffer.as_mut_ptr().cast(),
            &mut buffer_used,
            &mut property_count,
        );
        if ok == 0 {
            return None;
        }

        Some(wide_to_string(buffer.as_slice()))
    }
}

#[cfg(target_os = "windows")]
fn format_event_message(handle: EVT_HANDLE, provider: &str) -> Option<String> {
    let provider_w = to_wide(provider);
    let meta_handle = unsafe { EvtOpenPublisherMetadata(0, provider_w.as_ptr(), null(), 0, 0) };
    if meta_handle == 0 {
        return None;
    }
    let _meta = EvtHandle(meta_handle);

    unsafe {
        let mut buffer_used: u32 = 0;
        let ok = EvtFormatMessage(
            meta_handle,
            handle,
            0,
            0,
            null(),
            EvtFormatMessageEvent,
            0,
            null_mut(),
            &mut buffer_used,
        );
        let error = if ok == 0 { last_error() } else { 0 };
        if ok == 0 && error != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        if buffer_used == 0 {
            return None;
        }

        let mut buffer: Vec<u16> = vec![0; buffer_used as usize];
        let ok = EvtFormatMessage(
            meta_handle,
            handle,
            0,
            0,
            null(),
            EvtFormatMessageEvent,
            buffer_used,
            buffer.as_mut_ptr(),
            &mut buffer_used,
        );
        if ok == 0 {
            return None;
        }

        let message = wide_to_string(buffer.as_slice());
        if message.trim().is_empty() {
            None
        } else {
            Some(message.trim().to_string())
        }
    }
}

#[cfg(target_os = "windows")]
fn build_time_query(start: Option<DateTime<Utc>>, end: Option<DateTime<Utc>>) -> Option<String> {
    if start.is_none() && end.is_none() {
        return None;
    }

    let mut clauses = Vec::new();
    if let Some(value) = start {
        clauses.push(format!(
            "@SystemTime >= '{}'",
            value.to_rfc3339_opts(SecondsFormat::Millis, true)
        ));
    }
    if let Some(value) = end {
        clauses.push(format!(
            "@SystemTime <= '{}'",
            value.to_rfc3339_opts(SecondsFormat::Millis, true)
        ));
    }

    let filter = clauses.join(" and ");
    Some(format!("*[System[TimeCreated[{filter}]]]"))
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
fn map_severity(level: Option<u32>) -> &'static str {
    match level {
        Some(1) => "critical",
        Some(2) => "error",
        Some(3) => "warning",
        _ => "information",
    }
}

#[cfg(target_os = "windows")]
fn sanitize_message(message: &str) -> &str {
    if message.trim().is_empty() {
        return "No event message.";
    }
    message
}

#[cfg(target_os = "windows")]
fn extract_xml_attr(xml: &str, element: &str, attr: &str) -> Option<String> {
    let tag = format!("<{element}");
    let start = xml.find(&tag)?;
    let rest = &xml[start..];
    let end = rest.find('>')?;
    let segment = &rest[..end];
    extract_segment_attr(segment, attr)
}

#[cfg(target_os = "windows")]
fn normalize_channels(channels: Option<&[String]>) -> Vec<&'static str> {
    let mut selected = Vec::new();
    if let Some(values) = channels {
        for value in values {
            let normalized = match value.trim().to_ascii_lowercase().as_str() {
                "application" => Some("Application"),
                "system" => Some("System"),
                "security" => Some("Security"),
                _ => None,
            };
            if let Some(channel) = normalized {
                if !selected.contains(&channel) {
                    selected.push(channel);
                }
            }
        }
    }

    if selected.is_empty() {
        DEFAULT_CHANNELS.to_vec()
    } else {
        selected
    }
}

#[cfg(target_os = "windows")]
fn extract_xml_tag_value(xml: &str, tag: &str) -> Option<String> {
    let start = xml.find(&format!("<{tag}"))?;
    let rest = &xml[start..];
    let content_start = rest.find('>')? + start + 1;
    let content_end = xml[content_start..].find(&format!("</{tag}>"))? + content_start;
    Some(xml[content_start..content_end].trim().to_string())
}

#[cfg(target_os = "windows")]
fn extract_event_data(xml: &str) -> Option<String> {
    let start = xml.find("<EventData")?;
    let rest = &xml[start..];
    let data_start = rest.find('>')? + start + 1;
    let data_end = xml[data_start..].find("</EventData>")? + data_start;
    let segment = &xml[data_start..data_end];

    let mut cursor = segment;
    let mut pairs = Vec::new();
    loop {
        let tag_start = match cursor.find("<Data") {
            Some(value) => value,
            None => break,
        };
        let after_tag = cursor[tag_start..].find('>')? + tag_start;
        let tag_body = &cursor[tag_start..after_tag];
        let name = extract_segment_attr(tag_body, "Name").unwrap_or_else(|| "Data".to_string());
        let value_start = after_tag + 1;
        let value_end = match cursor[value_start..].find("</Data>") {
            Some(value) => value + value_start,
            None => break,
        };
        let value = cursor[value_start..value_end].trim().to_string();
        if !value.is_empty() {
            pairs.push(format!("{name}={value}"));
        }
        cursor = &cursor[value_end + "</Data>".len()..];
    }

    if pairs.is_empty() {
        None
    } else {
        Some(format!("Data: {}", pairs.join(", ")))
    }
}

#[cfg(target_os = "windows")]
fn normalize_remote_windows_channels(channels: Option<&[String]>) -> Vec<String> {
    normalize_channels(channels)
        .into_iter()
        .map(|value| value.to_string())
        .collect()
}

#[cfg(target_os = "windows")]
fn build_winrm_collection_script(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max: u32,
    channels: &[String],
) -> Option<String> {
    let log_names = channels
        .iter()
        .map(|channel| format!("'{}'", channel.replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    let start_value = start
        .map(|value| format!("[datetime]'{}'", value.to_rfc3339()))
        .unwrap_or_else(|| "$null".to_string());
    let end_value = end
        .map(|value| format!("[datetime]'{}'", value.to_rfc3339()))
        .unwrap_or_else(|| "$null".to_string());

    let script_block = format!(
        r#"$Max = {max};
$LogNames = @({log_names});
$Start = {start_value};
$End = {end_value};
$PerLogMax = [Math]::Max([int][Math]::Ceiling($Max / [Math]::Max($LogNames.Count, 1)), 1);
$Warnings = @();
$Collected = foreach ($log in $LogNames) {{
  $fh = @{{ LogName = $log }};
  if ($Start) {{ $fh.StartTime = $Start }}
  if ($End) {{ $fh.EndTime = $End }}
  try {{
    Get-WinEvent -FilterHashtable $fh -MaxEvents $PerLogMax -ErrorAction Stop |
      Select-Object Id, LogName, ProviderName, LevelDisplayName, Message, TimeCreated
  }} catch {{
    $Warnings += "Windows '$($log)' channel: $($_.Exception.Message)"
  }}
}};
$Events = @($Collected | Sort-Object TimeCreated -Descending | Select-Object -First $Max | ForEach-Object {{
  [PSCustomObject]@{{
    Id = $_.Id
    LogName = $_.LogName
    ProviderName = $_.ProviderName
    LevelDisplayName = $_.LevelDisplayName
    Message = $_.Message
    TimeCreated = if ($_.TimeCreated) {{ $_.TimeCreated.ToString('o') }} else {{ $null }}
  }}
}});
$os = $null;
$cs = $null;
$hotfixes = @();
try {{ $os = Get-WmiObject -Class Win32_OperatingSystem -ErrorAction Stop }} catch {{}}
try {{ $cs = Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop }} catch {{}}
try {{ $hotfixes = @(Get-HotFix | Sort-Object InstalledOn -Descending | Select-Object -First 3 HotFixID, InstalledOn) }} catch {{}}
$summary = if ($os -or $cs) {{
  [PSCustomObject]@{{
    HostName = if ($os) {{ $os.CSName }} else {{ $env:COMPUTERNAME }}
    DomainOrWorkgroup = if ($cs) {{ $cs.Domain }} else {{ $null }}
    OSCaption = if ($os) {{ $os.Caption }} else {{ $null }}
    OSVersion = if ($os) {{ $os.Version }} else {{ $null }}
    BuildNumber = if ($os) {{ $os.BuildNumber }} else {{ $null }}
    Manufacturer = if ($cs) {{ $cs.Manufacturer }} else {{ $null }}
    Model = if ($cs) {{ $cs.Model }} else {{ $null }}
    LastBoot = if ($os -and $os.LastBootUpTime) {{ ([Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime)).ToString('o') }} else {{ $null }}
    UptimeSeconds = if ($os -and $os.LastBootUpTime) {{ [int64](([datetime]::UtcNow) - [Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime).ToUniversalTime()).TotalSeconds }} else {{ $null }}
    RecentHotfixes = $hotfixes
  }}
}} else {{ $null }};
[PSCustomObject]@{{
  events = $Events
  warnings = $Warnings
  summary = $summary
}} | ConvertTo-Json -Depth 6 -Compress"#,
    );

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

    Some(format!(
        "{}$sb = [scriptblock]::Create('{}'); Invoke-Command -ComputerName '{}' {} -ScriptBlock $sb",
        cred_setup,
        script_block.replace('\'', "''"),
        profile.host.replace('\'', "''"),
        cred_arg
    ))
}

#[cfg(target_os = "windows")]
fn build_rpc_wevtutil_args(
    profile: &RemoteConnectionProfile,
    channel: &str,
    query: Option<&str>,
    limit: usize,
) -> Option<Vec<String>> {
    let mut args = vec![
        "qe".to_string(),
        channel.to_string(),
        format!("/r:{}", profile.host.trim()),
        "/rd:true".to_string(),
        "/f:xml".to_string(),
        format!("/c:{limit}"),
    ];
    if let Some(query) = query {
        args.push(format!("/q:{query}"));
    }
    if profile.auth_type.eq_ignore_ascii_case("password") && !profile.username.trim().is_empty() {
        let secret = crate::settings::get_remote_profile_secret(profile.id.as_str())
            .ok()
            .flatten()?;
        args.push(format!("/u:{}", profile.username.trim()));
        args.push(format!("/p:{secret}"));
    }
    Some(args)
}

#[cfg(target_os = "windows")]
fn build_rpc_wmi_summary_script(profile: &RemoteConnectionProfile) -> Option<String> {
    let mut credential_setup = String::new();
    let mut credential_arg = String::new();
    if profile.auth_type.eq_ignore_ascii_case("password") && !profile.username.trim().is_empty() {
        let secret = crate::settings::get_remote_profile_secret(profile.id.as_str())
            .ok()
            .flatten()?;
        credential_setup = format!(
            "$SecPwd = ConvertTo-SecureString '{}' -AsPlainText -Force; $Cred = New-Object System.Management.Automation.PSCredential ('{}', $SecPwd); ",
            secret.replace('\'', "''"),
            profile.username.trim().replace('\'', "''")
        );
        credential_arg = "-Credential $Cred ".to_string();
    }

    Some(format!(
        "{}$os = Get-WmiObject -Class Win32_OperatingSystem -ComputerName '{}' {}-ErrorAction Stop; \
$cs = Get-WmiObject -Class Win32_ComputerSystem -ComputerName '{}' {}-ErrorAction Stop; \
$hotfixes = @(); try {{ $hotfixes = @(Get-WmiObject -Class Win32_QuickFixEngineering -ComputerName '{}' {}-ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 3 HotFixID, InstalledOn) }} catch {{}}; \
[PSCustomObject]@{{ \
HostName = $os.CSName; \
DomainOrWorkgroup = $cs.Domain; \
OSCaption = $os.Caption; \
OSVersion = $os.Version; \
BuildNumber = $os.BuildNumber; \
Manufacturer = $cs.Manufacturer; \
Model = $cs.Model; \
LastBoot = if ($os.LastBootUpTime) {{ ([Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime)).ToString('o') }} else {{ $null }}; \
UptimeSeconds = if ($os.LastBootUpTime) {{ [int64](([datetime]::UtcNow) - [Management.ManagementDateTimeConverter]::ToDateTime($os.LastBootUpTime).ToUniversalTime()).TotalSeconds }} else {{ $null }}; \
RecentHotfixes = $hotfixes \
}} | ConvertTo-Json -Depth 5 -Compress",
        credential_setup,
        profile.host.replace('\'', "''"),
        credential_arg,
        profile.host.replace('\'', "''"),
        credential_arg,
        profile.host.replace('\'', "''"),
        credential_arg
    ))
}

#[cfg(target_os = "windows")]
fn parse_winrm_warning_list(value: &Value) -> Vec<String> {
    value
        .get("warnings")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(Value::as_str)
                .map(|entry| entry.trim().to_string())
                .filter(|entry| !entry.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn parse_winrm_events(value: &Value, source_host: &str) -> Vec<NormalizedEvent> {
    let events_value = value.get("events").unwrap_or(value);
    let items = match events_value {
        Value::Array(entries) => entries.clone(),
        Value::Object(_) => vec![events_value.clone()],
        _ => Vec::new(),
    };

    let mut events = Vec::new();
    for item in items {
        let log_name = item
            .get("LogName")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let provider = item
            .get("ProviderName")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let message = item
            .get("Message")
            .and_then(Value::as_str)
            .unwrap_or("No event message.");
        let level = item
            .get("LevelDisplayName")
            .and_then(Value::as_str)
            .unwrap_or("Information");
        let event_id = item
            .get("Id")
            .and_then(Value::as_u64)
            .map(|value| value as u32);
        let time = item
            .get("TimeCreated")
            .and_then(Value::as_str)
            .unwrap_or("");
        let severity = match level.to_ascii_lowercase().as_str() {
            "critical" => "critical",
            "error" => "error",
            "warning" => "warning",
            _ => "information",
        };

        let mut event = NormalizedEvent::new(
            SupportedOs::Windows,
            log_name,
            map_category(log_name),
            provider,
            event_id,
            severity,
            sanitize_message(message),
            source_host,
        );
        if !time.is_empty() {
            event.timestamp = time.to_string();
        }
        event.assign_stable_id();
        events.push(event);
    }
    events
}

#[cfg(target_os = "windows")]
fn extract_remote_event_fragments(xml: &str) -> Vec<String> {
    let mut cursor = xml;
    let mut fragments = Vec::new();
    while let Some(start) = cursor.find("<Event") {
        let after_start = &cursor[start..];
        let Some(end) = after_start.find("</Event>") else {
            break;
        };
        let fragment_end = start + end + "</Event>".len();
        fragments.push(cursor[start..fragment_end].to_string());
        cursor = &cursor[fragment_end..];
    }
    fragments
}

#[cfg(target_os = "windows")]
fn render_remote_xml_fragment(
    xml: &str,
    fallback_channel: &str,
    source_host: &str,
) -> Option<NormalizedEvent> {
    let provider =
        extract_xml_attr(xml, "Provider", "Name").unwrap_or_else(|| "Unknown Provider".to_string());
    let log_name =
        extract_xml_tag_value(xml, "Channel").unwrap_or_else(|| fallback_channel.to_string());
    let event_id =
        extract_xml_tag_value(xml, "EventID").and_then(|value| value.parse::<u32>().ok());
    let level = extract_xml_tag_value(xml, "Level").and_then(|value| value.parse::<u32>().ok());
    let severity = map_severity(level);
    let category = map_category(&log_name);
    let message = extract_event_data(xml).unwrap_or_else(|| {
        "Rendered Windows message unavailable over RPC/DCOM collection.".to_string()
    });

    let mut event = NormalizedEvent::new(
        SupportedOs::Windows,
        log_name.as_str(),
        category,
        provider.as_str(),
        event_id,
        severity,
        sanitize_message(message.as_str()),
        source_host,
    );
    if let Some(timestamp) = extract_xml_attr(xml, "TimeCreated", "SystemTime") {
        event.timestamp = timestamp;
    }
    event.assign_stable_id();
    Some(event)
}

#[cfg(target_os = "windows")]
fn sort_and_cap_remote_events(events: &mut Vec<NormalizedEvent>, max: usize) {
    events.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    events.truncate(max);
}

#[cfg(target_os = "windows")]
fn extract_segment_attr(segment: &str, attr: &str) -> Option<String> {
    let double = format!("{attr}=\"");
    if let Some(start) = segment.find(&double) {
        let value_start = start + double.len();
        let value_end = segment[value_start..].find('"')? + value_start;
        return Some(segment[value_start..value_end].to_string());
    }

    let single = format!("{attr}='");
    if let Some(start) = segment.find(&single) {
        let value_start = start + single.len();
        let value_end = segment[value_start..].find('\'')? + value_start;
        return Some(segment[value_start..value_end].to_string());
    }

    None
}

#[cfg(target_os = "windows")]
fn to_wide(value: &str) -> Vec<u16> {
    OsStr::new(value)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

#[cfg(target_os = "windows")]
fn wide_to_string(value: &[u16]) -> String {
    let end = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

#[cfg(target_os = "windows")]
fn last_error() -> u32 {
    unsafe { GetLastError() }
}

#[cfg(target_os = "windows")]
pub fn collect_remote_windows_events(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    channels: Option<&[String]>,
) -> CollectionResult {
    if profile.protocol.eq_ignore_ascii_case("rpc") {
        collect_remote_windows_events_rpc(profile, start, end, max_events, channels)
    } else {
        collect_remote_windows_events_winrm(profile, start, end, max_events, channels)
    }
}

#[cfg(target_os = "windows")]
fn collect_remote_windows_events_winrm(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    channels: Option<&[String]>,
) -> CollectionResult {
    let mut result = CollectionResult::default();
    let max = max_events.unwrap_or(2000).clamp(1, 20000);
    let selected_channels = normalize_remote_windows_channels(channels);
    let Some(wrapper_script) =
        build_winrm_collection_script(profile, start, end, max, selected_channels.as_slice())
    else {
        result
            .errors
            .push(format!("WinRM password authentication for {} requires a stored remote secret in the OS keychain.", profile.host));
        return result;
    };

    let output = match std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(wrapper_script)
        .output()
    {
        Ok(out) => out,
        Err(error) => {
            result.errors.push(format!(
                "Failed to execute PowerShell for WinRM collection: {error}"
            ));
            return result;
        }
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if err.to_ascii_lowercase().contains("access is denied") {
            result.warnings.push(format!(
                "WinRM reached {}, but the account was denied access. {}",
                profile.host, err
            ));
        } else {
            result
                .errors
                .push(format!("WinRM error on {}: {}", profile.host, err));
        }
        return result;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        return result;
    }

    let Ok(parsed) = serde_json::from_str::<Value>(stdout.as_str()) else {
        result
            .errors
            .push("Failed to parse WinRM JSON output.".to_string());
        return result;
    };

    for warning in parse_winrm_warning_list(&parsed) {
        if warning.to_ascii_lowercase().contains("access is denied")
            || warning.to_ascii_lowercase().contains("access denied")
        {
            result.warnings.push(warning);
        } else {
            result.errors.push(warning);
        }
    }

    for event in parse_winrm_events(&parsed, profile.host.as_str()) {
        result.events.push(event);
    }

    if let Some(summary) = parsed
        .get("summary")
        .and_then(|value| parse_remote_summary_json(value.to_string().as_str()))
    {
        let hints = summary_hints_from_events(result.events.as_slice());
        result.events.extend(build_summary_events(
            &summary,
            profile.host.as_str(),
            "WinRM",
            hints.as_slice(),
        ));
    }

    sort_and_cap_remote_events(&mut result.events, max as usize);
    result
}

#[cfg(target_os = "windows")]
fn collect_remote_windows_events_rpc(
    profile: &RemoteConnectionProfile,
    start: Option<DateTime<Utc>>,
    end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    channels: Option<&[String]>,
) -> CollectionResult {
    let mut result = CollectionResult::default();
    let max = max_events.unwrap_or(2000).clamp(1, 20000) as usize;
    let selected_channels = normalize_remote_windows_channels(channels);
    let per_channel_max =
        ((max + selected_channels.len().saturating_sub(1)) / selected_channels.len().max(1)).max(1);
    let query = build_time_query(start, end);

    for channel in selected_channels {
        let Some(args) =
            build_rpc_wevtutil_args(profile, channel.as_str(), query.as_deref(), per_channel_max)
        else {
            result.errors.push(format!(
                "RPC/DCOM password authentication for {} requires a stored remote secret in the OS keychain.",
                profile.host
            ));
            return result;
        };
        let output = match std::process::Command::new("wevtutil").args(&args).output() {
            Ok(output) => output,
            Err(error) => {
                result.errors.push(format!(
                    "Failed to execute wevtutil for {}: {}",
                    channel, error
                ));
                continue;
            }
        };
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if stderr.to_ascii_lowercase().contains("access is denied")
                || stderr.to_ascii_lowercase().contains("0x5")
            {
                result.warnings.push(format!(
                    "Access denied reading Windows '{}' channel on {} via RPC/DCOM. {}",
                    channel, profile.host, stderr
                ));
            } else {
                result.errors.push(format!(
                    "RPC/DCOM query failed for Windows '{}' channel on {}. {}",
                    channel, profile.host, stderr
                ));
            }
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for fragment in extract_remote_event_fragments(stdout.as_ref()) {
            if let Some(event) = render_remote_xml_fragment(
                fragment.as_str(),
                channel.as_str(),
                profile.host.as_str(),
            ) {
                result.events.push(event);
            }
        }
    }

    if let Some(summary_script) = build_rpc_wmi_summary_script(profile) {
        match std::process::Command::new("powershell")
            .arg("-NoProfile")
            .arg("-NonInteractive")
            .arg("-Command")
            .arg(summary_script)
            .output()
        {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if let Some(summary) = parse_remote_summary_json(stdout.as_str()) {
                    let hints = summary_hints_from_events(result.events.as_slice());
                    result.events.extend(build_summary_events(
                        &summary,
                        profile.host.as_str(),
                        "RPC/DCOM",
                        hints.as_slice(),
                    ));
                }
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                result.warnings.push(format!(
                    "RPC/DCOM collected Event Logs from {}, but WMI summary access failed. {}",
                    profile.host, stderr
                ));
            }
            Err(error) => {
                result.warnings.push(format!(
                    "RPC/DCOM collected Event Logs from {}, but PowerShell WMI summary could not start: {}",
                    profile.host, error
                ));
            }
        }
    } else {
        result.warnings.push(format!(
            "RPC/DCOM summary collection for {} requires a stored password secret when explicit credentials are selected.",
            profile.host
        ));
    }

    sort_and_cap_remote_events(&mut result.events, max);
    result
}
