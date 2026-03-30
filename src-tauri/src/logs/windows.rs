use super::{CollectionEstimate, CollectionResult, NormalizedEvent, SupportedOs};
use crate::settings::RemoteConnectionProfile;
#[cfg(target_os = "windows")]
use chrono::SecondsFormat;
use chrono::{DateTime, Utc};

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
    _start: Option<DateTime<Utc>>,
    _end: Option<DateTime<Utc>>,
    max_events: Option<u32>,
    channels: Option<&[String]>,
) -> CollectionResult {
    let mut result = CollectionResult::default();
    let max = max_events.unwrap_or(2000);
    
    let default_channels = vec!["Application".to_string(), "System".to_string(), "Security".to_string()];
    let channel_list = channels
        .map(|c| c.to_vec())
        .unwrap_or(default_channels)
        .iter()
        .map(|c| format!("'{}'", c))
        .collect::<Vec<_>>()
        .join(",");

    // A simpler filter payload using XPath could be used, but since we map heavily, simple parameters work.
    let script_block = format!(
        r#"$Max = {};
          $LogNames = @({});
          $Events = Get-WinEvent -LogName $LogNames -MaxEvents $Max -ErrorAction SilentlyContinue;
          $Result = @();
          foreach ($e in $Events) {{
             $Result += [PSCustomObject]@{{
                 Id = $e.Id
                 LogName = $e.LogName
                 ProviderName = $e.ProviderName
                 LevelDisplayName = $e.LevelDisplayName
                 Message = $e.Message
                 TimeCreated = $e.TimeCreated.ToString('o')
             }}
          }}
          $Result | ConvertTo-Json -Depth 2 -Compress"#,
        max,
        channel_list
    );

    // If we need explicit password, we'd build a PSCredential here. 
    // For now, assume domain auth context (No explicit password flag needed, just ComputerName) unless specified.
let mut cred_setup = String::new();
    let mut cred_arg = String::new();
    
    if profile.auth_type == "password" && !profile.username.is_empty() {
        if let Ok(Some(secret)) = crate::settings::get_remote_profile_secret(&profile.id) {
            cred_setup = format!(
                "$SecPwd = ConvertTo-SecureString '{}' -AsPlainText -Force; $Cred = New-Object System.Management.Automation.PSCredential ('{}', $SecPwd); ",
                secret.replace("'", "''"),
                profile.username.replace("'", "''")
            );
            cred_arg = "-Credential $Cred".to_string();
        } else {
            result.errors.push(format!(
                "WinRM password authentication for {} requires a stored remote secret, but no secret is configured in the OS keychain.",
                profile.host
            ));
            return result;
        }
    }

    let wrapper_script = format!(
        "{}$sb = [scriptblock]::Create('{}'); Invoke-Command -ComputerName '{}' {} -ScriptBlock $sb",
        cred_setup,
        script_block.replace("'", "''"),
        profile.host.replace("'", "''"),
        cred_arg
    );

    let output = match std::process::Command::new("powershell")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-Command")
        .arg(&wrapper_script)
        .output() 
    {
        Ok(out) => out,
        Err(e) => {
            result.errors.push(format!("Failed to execute powershell: {}", e));
            return result;
        }
    };

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        if err.to_ascii_lowercase().contains("access is denied") {
            result.warnings.push(format!("Access Denied connecting to {}. Verify credentials/WinRM.", profile.host));
        } else {
            result.errors.push(format!("WinRM error on {}: {}", profile.host, err));
        }
        return result;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return result; // No events
    }

    match serde_json::from_str::<serde_json::Value>(&stdout) {
        Ok(serde_json::Value::Array(arr)) => {
            for item in arr {
                let log_name = item.get("LogName").and_then(|v| v.as_str()).unwrap_or("unknown");
                let provider = item.get("ProviderName").and_then(|v| v.as_str()).unwrap_or("unknown");
                let message = item.get("Message").and_then(|v| v.as_str()).unwrap_or("No message.");
                let level = item.get("LevelDisplayName").and_then(|v| v.as_str()).unwrap_or("Information");
                let event_id = item.get("Id").and_then(|v| v.as_u64()).map(|v| v as u32);
                let time = item.get("TimeCreated").and_then(|v| v.as_str()).unwrap_or("");

                let severity = match level.to_ascii_lowercase().as_str() {
                    "error" | "critical" => "Error",
                    "warning" => "Warning",
                    "verbose" => "Information",
                    _ => "Information",
                };
                
                let mut ev = NormalizedEvent::new(
                    SupportedOs::Windows,
                    log_name,
                    map_category(log_name),
                    provider,
                    event_id,
                    severity,
                    sanitize_message(message),
                    &profile.host,
                );
                
                if !time.is_empty() {
                    ev.timestamp = time.to_string();
                }

                ev.assign_stable_id();

                result.events.push(ev);
            }
        }
        Ok(_) => {
            // Unlikely, but if only one event matches, it might return a single object, not array.
            result.warnings.push("Only one event matched. Need to handle singleton parsing.".to_string());
        }
        Err(e) => {
            result.errors.push(format!("Failed to parse WinRM json output: {}", e));
        }
    }

    result
}
