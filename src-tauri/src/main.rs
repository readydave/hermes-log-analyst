mod crash;
mod db;
mod diagnostics;
mod llm;
mod logs;
mod settings;

use chrono::{DateTime, Local, NaiveDate, TimeZone, Utc};
use crash::{
    analyze_windows_minidump, import_host_crashes as collect_host_crashes, CrashRecord,
    MinidumpAnalysisResult,
};
use db::{
    cleanup_duplicate_events, correlate_crash_events,
    get_crash_by_id, get_crashes as read_crashes, get_local_events as read_local_events,
    get_local_events_range as read_local_events_range,
    get_local_events_window as read_local_events_window, prune_events_before,
    prune_events_outside, save_crashes, save_local_events,
};
use logs::{
    collect_host_events_range_with_windows_channels, detect_host_os,
    estimate_host_events_range_with_windows_channels, CollectionEstimate, CollectionResult,
    NormalizedEvent,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use settings::{
    load_export_dir, load_ingest_profile, load_ingest_window_days, load_llm_settings_with_migration,
    load_theme, save_export_dir, save_ingest_profile, save_ingest_window_days, save_llm_settings,
    save_theme, IngestProfile, LlmConnectionProfile, LlmSettings,
};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

const LLM_KEYCHAIN_SERVICE: &str = "hermes-log-analyst.llm";

#[tauri::command]
fn host_os() -> String {
    detect_host_os().to_string()
}

#[tauri::command]
fn host_os_version() -> String {
    detect_host_os_version()
}

fn detect_host_os_version() -> String {
    #[cfg(target_os = "macos")]
    {
        let name = run_command("sw_vers", &["-productName"]).unwrap_or_else(|| "macOS".to_string());
        let version =
            run_command("sw_vers", &["-productVersion"]).unwrap_or_else(|| "Unknown".to_string());
        return format!("{name} {version}");
    }

    #[cfg(target_os = "windows")]
    {
        let ps = run_command(
            "powershell",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty Caption) + ' ' + (Get-CimInstance Win32_OperatingSystem | Select-Object -ExpandProperty Version)",
            ],
        );
        return ps.unwrap_or_else(|| "Windows (version unavailable)".to_string());
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
            if let Some(line) = content
                .lines()
                .find(|line| line.starts_with("PRETTY_NAME="))
            {
                let value = line
                    .trim_start_matches("PRETTY_NAME=")
                    .trim_matches('"')
                    .trim()
                    .to_string();
                if !value.is_empty() {
                    return value;
                }
            }
        }

        let kernel = run_command("uname", &["-r"]).unwrap_or_else(|| "unknown-kernel".to_string());
        format!("Linux ({kernel})")
    }
}

fn run_command(binary: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(binary).args(args).output().ok()?;
    if !output.status.success() {
        diagnostics::warn(
            "runtime",
            format!("Command '{binary}' exited unsuccessfully while resolving host metadata."),
        );
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() || value.len() > 300 {
        return None;
    }
    Some(value)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncOperationResult {
    collected: usize,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventLoadEstimateResult {
    window_start: String,
    window_end: String,
    estimated_count: usize,
    estimated_bytes: usize,
    warnings: Vec<String>,
}

fn summarize_messages(messages: &[String], max_count: usize) -> String {
    if messages.is_empty() {
        return String::new();
    }

    let mut summary = messages
        .iter()
        .take(max_count)
        .cloned()
        .collect::<Vec<_>>()
        .join(" ");

    if messages.len() > max_count {
        let extra = messages.len() - max_count;
        let suffix = format!(" (+{extra} more; see diagnostics logs)");
        summary.push_str(suffix.as_str());
    }

    summary
}

fn report_collection_outcome(
    context: &str,
    outcome: &CollectionResult,
) -> Result<SyncOperationResult, String> {
    for warning in &outcome.warnings {
        diagnostics::warn("collector", format!("{context}: {warning}"));
    }
    for error in &outcome.errors {
        diagnostics::error("collector", format!("{context}: {error}"));
    }

    if outcome.events.is_empty() && !outcome.errors.is_empty() {
        return Err(format!(
            "{context} failed before any events were collected. {}",
            summarize_messages(&outcome.errors, 2)
        ));
    }

    let mut warnings = outcome.warnings.clone();
    if !outcome.errors.is_empty() {
        warnings.push(format!(
            "Collector reported recoverable errors. {}",
            summarize_messages(&outcome.errors, 2)
        ));
    }

    Ok(SyncOperationResult {
        collected: outcome.events.len(),
        warnings,
    })
}

fn report_collection_estimate(
    context: &str,
    window_start: &DateTime<Utc>,
    window_end: &DateTime<Utc>,
    estimate: &CollectionEstimate,
) -> Result<EventLoadEstimateResult, String> {
    for warning in &estimate.warnings {
        diagnostics::warn("collector", format!("{context}: {warning}"));
    }
    for error in &estimate.errors {
        diagnostics::error("collector", format!("{context}: {error}"));
    }

    if estimate.estimated_count == 0 && !estimate.errors.is_empty() {
        return Err(format!(
            "{context} failed before any estimate was produced. {}",
            summarize_messages(&estimate.errors, 2)
        ));
    }

    let mut warnings = estimate.warnings.clone();
    if !estimate.errors.is_empty() {
        warnings.push(format!(
            "Estimate reported recoverable errors. {}",
            summarize_messages(&estimate.errors, 2)
        ));
    }

    Ok(EventLoadEstimateResult {
        window_start: window_start.to_rfc3339(),
        window_end: window_end.to_rfc3339(),
        estimated_count: estimate.estimated_count,
        estimated_bytes: estimate.estimated_bytes,
        warnings,
    })
}


fn command_error(subsystem: &str, context: &str, error: impl AsRef<str>) -> String {
    let message = error.as_ref().to_string();
    diagnostics::error(subsystem, format!("{context}: {message}"));
    message
}

fn set_profile_keychain_secret(profile_id: &str, api_key: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(LLM_KEYCHAIN_SERVICE, profile_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    entry
        .set_password(api_key)
        .map_err(|error| format!("Unable to save API key in OS keychain: {error}"))
}

fn clear_profile_keychain_secret(profile_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(LLM_KEYCHAIN_SERVICE, profile_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Unable to clear API key from OS keychain: {error}")),
    }
}

fn get_profile_keychain_secret(profile_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(LLM_KEYCHAIN_SERVICE, profile_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    match entry.get_password() {
        Ok(value) => {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed))
            }
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Unable to read API key from OS keychain: {error}")),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmConnectionTestResult {
    ok: bool,
    provider: String,
    base_url: String,
    status_code: Option<u16>,
    message: String,
    detected_models: Vec<String>,
}

fn normalize_base_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn parse_model_ids(value: &Value) -> Vec<String> {
    let mut models = Vec::new();

    if let Some(entries) = value.get("models").and_then(Value::as_array) {
        for entry in entries {
            if let Some(name) = entry
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| entry.get("model").and_then(Value::as_str))
            {
                let model = name.trim();
                if !model.is_empty() && !models.iter().any(|item: &String| item == model) {
                    models.push(model.to_string());
                }
            }
        }
    }

    if let Some(entries) = value.get("data").and_then(Value::as_array) {
        for entry in entries {
            if let Some(name) = entry
                .get("id")
                .and_then(Value::as_str)
                .or_else(|| entry.get("model").and_then(Value::as_str))
            {
                let model = name.trim();
                if !model.is_empty() && !models.iter().any(|item: &String| item == model) {
                    models.push(model.to_string());
                }
            }
        }
    }

    models.sort();
    models
}

fn summarize_http_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let condensed = trimmed.replace('\n', " ");
    if condensed.len() <= 240 {
        condensed
    } else {
        format!("{}...", &condensed[..240])
    }
}

fn default_test_result(profile: &LlmConnectionProfile) -> LlmConnectionTestResult {
    LlmConnectionTestResult {
        ok: false,
        provider: profile.provider.clone(),
        base_url: normalize_base_url(profile.base_url.as_str()),
        status_code: None,
        message: "Connection not tested.".to_string(),
        detected_models: Vec::new(),
    }
}

fn test_ollama_connection(
    client: &reqwest::blocking::Client,
    base_url: &str,
) -> LlmConnectionTestResult {
    let endpoint = join_url(base_url, "/api/tags");
    match client.get(endpoint).send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            if !(200..300).contains(&status) {
                return LlmConnectionTestResult {
                    ok: false,
                    provider: "ollama".to_string(),
                    base_url: base_url.to_string(),
                    status_code: Some(status),
                    message: format!("Ollama endpoint responded with HTTP {status}."),
                    detected_models: Vec::new(),
                };
            }
            let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
            let models = parse_model_ids(&parsed);
            LlmConnectionTestResult {
                ok: true,
                provider: "ollama".to_string(),
                base_url: base_url.to_string(),
                status_code: Some(status),
                message: if models.is_empty() {
                    "Connected to Ollama, but no local models were reported.".to_string()
                } else {
                    format!("Connected to Ollama. Found {} model(s).", models.len())
                },
                detected_models: models,
            }
        }
        Err(error) => LlmConnectionTestResult {
            ok: false,
            provider: "ollama".to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: format!("Failed to connect to Ollama endpoint: {error}"),
            detected_models: Vec::new(),
        },
    }
}

fn test_openai_compatible_connection(
    provider: &str,
    client: &reqwest::blocking::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> LlmConnectionTestResult {
    let endpoint = openai_models_endpoint(base_url);
    let mut request = client.get(endpoint);
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(key);
    }

    match request.send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            if !(200..300).contains(&status) {
                let auth_hint = if status == 401 || status == 403 {
                    " Check API key and permissions."
                } else {
                    ""
                };
                return LlmConnectionTestResult {
                    ok: false,
                    provider: provider.to_string(),
                    base_url: base_url.to_string(),
                    status_code: Some(status),
                    message: format!(
                        "{provider} endpoint responded with HTTP {status}.{auth_hint}",
                        provider = provider
                    ),
                    detected_models: Vec::new(),
                };
            }
            let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
            let models = parse_model_ids(&parsed);
            LlmConnectionTestResult {
                ok: true,
                provider: provider.to_string(),
                base_url: base_url.to_string(),
                status_code: Some(status),
                message: if models.is_empty() {
                    format!("Connected to {provider}. No models were returned.", provider = provider)
                } else {
                    format!(
                        "Connected to {provider}. Found {} model(s).",
                        models.len(),
                        provider = provider
                    )
                },
                detected_models: models,
            }
        }
        Err(error) => LlmConnectionTestResult {
            ok: false,
            provider: provider.to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: format!("Failed to connect to {provider} endpoint: {error}", provider = provider),
            detected_models: Vec::new(),
        },
    }
}

fn test_gemini_connection(
    client: &reqwest::blocking::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> LlmConnectionTestResult {
    let Some(key) = api_key.filter(|value| !value.trim().is_empty()) else {
        return LlmConnectionTestResult {
            ok: false,
            provider: "gemini".to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: "Gemini API key is not configured in keychain.".to_string(),
            detected_models: Vec::new(),
        };
    };

    let endpoint = join_url(base_url, "/models");
    match client.get(endpoint).query(&[("key", key)]).send() {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            if !(200..300).contains(&status) {
                return LlmConnectionTestResult {
                    ok: false,
                    provider: "gemini".to_string(),
                    base_url: base_url.to_string(),
                    status_code: Some(status),
                    message: format!("Gemini endpoint responded with HTTP {status}."),
                    detected_models: Vec::new(),
                };
            }
            let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
            let models = parse_model_ids(&parsed);
            LlmConnectionTestResult {
                ok: true,
                provider: "gemini".to_string(),
                base_url: base_url.to_string(),
                status_code: Some(status),
                message: if models.is_empty() {
                    "Connected to Gemini. No models were returned.".to_string()
                } else {
                    format!("Connected to Gemini. Found {} model(s).", models.len())
                },
                detected_models: models,
            }
        }
        Err(error) => LlmConnectionTestResult {
            ok: false,
            provider: "gemini".to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: format!("Failed to connect to Gemini endpoint: {error}"),
            detected_models: Vec::new(),
        },
    }
}

fn test_claude_connection(
    client: &reqwest::blocking::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> LlmConnectionTestResult {
    let Some(key) = api_key.filter(|value| !value.trim().is_empty()) else {
        return LlmConnectionTestResult {
            ok: false,
            provider: "claude".to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: "Claude API key is not configured in keychain.".to_string(),
            detected_models: Vec::new(),
        };
    };

    let endpoint = join_url(base_url, "/models");
    match client
        .get(endpoint)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
    {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response.text().unwrap_or_default();
            if !(200..300).contains(&status) {
                return LlmConnectionTestResult {
                    ok: false,
                    provider: "claude".to_string(),
                    base_url: base_url.to_string(),
                    status_code: Some(status),
                    message: format!("Claude endpoint responded with HTTP {status}."),
                    detected_models: Vec::new(),
                };
            }
            let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
            let models = parse_model_ids(&parsed);
            LlmConnectionTestResult {
                ok: true,
                provider: "claude".to_string(),
                base_url: base_url.to_string(),
                status_code: Some(status),
                message: if models.is_empty() {
                    "Connected to Claude. No models were returned.".to_string()
                } else {
                    format!("Connected to Claude. Found {} model(s).", models.len())
                },
                detected_models: models,
            }
        }
        Err(error) => LlmConnectionTestResult {
            ok: false,
            provider: "claude".to_string(),
            base_url: base_url.to_string(),
            status_code: None,
            message: format!("Failed to connect to Claude endpoint: {error}"),
            detected_models: Vec::new(),
        },
    }
}

fn test_llm_profile_connection_sync(
    profile: LlmConnectionProfile,
    api_key: Option<String>,
) -> LlmConnectionTestResult {
    let mut result = default_test_result(&profile);
    let base_url = normalize_base_url(profile.base_url.as_str());
    if base_url.is_empty() {
        result.message = "Base URL is required.".to_string();
        return result;
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            result.message = format!("Failed to initialize HTTP client: {error}");
            return result;
        }
    };

    let provider = profile.provider.trim().to_ascii_lowercase();
    match provider.as_str() {
        "ollama" => test_ollama_connection(&client, base_url.as_str()),
        "lmstudio" => test_openai_compatible_connection(
            "lmstudio",
            &client,
            base_url.as_str(),
            api_key.as_deref(),
        ),
        "openai" => test_openai_compatible_connection(
            "openai",
            &client,
            base_url.as_str(),
            api_key.as_deref(),
        ),
        "perplexity" => test_openai_compatible_connection(
            "perplexity",
            &client,
            base_url.as_str(),
            api_key.as_deref(),
        ),
        "openai_compatible" => test_openai_compatible_connection(
            "openai_compatible",
            &client,
            base_url.as_str(),
            api_key.as_deref(),
        ),
        "gemini" => test_gemini_connection(&client, base_url.as_str(), api_key.as_deref()),
        "claude" => test_claude_connection(&client, base_url.as_str(), api_key.as_deref()),
        _ => LlmConnectionTestResult {
            ok: false,
            provider,
            base_url,
            status_code: None,
            message: "Unsupported provider type.".to_string(),
            detected_models: Vec::new(),
        },
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmAnalysisResult {
    ok: bool,
    profile_id: String,
    profile_name: String,
    provider: String,
    base_url: String,
    model: String,
    response: String,
    fallback_used: bool,
    warning: Option<String>,
}

fn provider_is_valid(provider: &str) -> bool {
    matches!(provider, "ollama" | "lmstudio" | "openai_compatible" | "openai" | "gemini" | "claude" | "perplexity")
}

fn openai_models_endpoint(base_url: &str) -> String {
    let base = normalize_base_url(base_url);
    if base.ends_with("/v1") || base.ends_with("/v1beta") {
        join_url(base.as_str(), "/models")
    } else {
        join_url(base.as_str(), "/v1/models")
    }
}

fn openai_chat_endpoint(base_url: &str) -> String {
    let base = normalize_base_url(base_url);
    if base.ends_with("/v1") || base.ends_with("/v1beta") {
        join_url(base.as_str(), "/chat/completions")
    } else {
        join_url(base.as_str(), "/v1/chat/completions")
    }
}

fn fetch_ollama_models(client: &reqwest::blocking::Client, base_url: &str) -> Result<Vec<String>, String> {
    let endpoint = join_url(base_url, "/api/tags");
    let response = client
        .get(endpoint)
        .send()
        .map_err(|error| format!("Failed requesting Ollama model list: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Ollama model list request failed (HTTP {}).", status.as_u16()));
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    Ok(parse_model_ids(&parsed))
}

fn fetch_openai_compatible_models(
    provider: &str,
    client: &reqwest::blocking::Client,
    base_url: &str,
    api_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let endpoint = openai_models_endpoint(base_url);
    let mut request = client.get(endpoint);
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .map_err(|error| format!("Failed requesting {provider} model list: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "{provider} model list request failed (HTTP {}).",
            status.as_u16()
        ));
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    Ok(parse_model_ids(&parsed))
}

fn resolve_model_for_profile(
    profile: &LlmConnectionProfile,
    client: &reqwest::blocking::Client,
    api_key: Option<&str>,
) -> Result<String, String> {
    let configured = profile.model.trim();
    if !configured.is_empty() {
        return Ok(configured.to_string());
    }

    let provider = profile.provider.trim().to_ascii_lowercase();
    let discovered = match provider.as_str() {
        "ollama" => fetch_ollama_models(client, profile.base_url.as_str())?,
        "lmstudio" | "openai_compatible" => fetch_openai_compatible_models(
            provider.as_str(),
            client,
            profile.base_url.as_str(),
            api_key,
        )?,
        _ => Vec::new(),
    };

    discovered
        .into_iter()
        .next()
        .ok_or_else(|| "No model is configured and none were discovered on the endpoint.".to_string())
}

fn parse_chat_completion_text(payload: &Value) -> Option<String> {
    if let Some(content) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
    {
        let text = content.trim();
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }

    if let Some(parts) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
    {
        let mut collected = Vec::new();
        for part in parts {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                let trimmed = text.trim();
                if !trimmed.is_empty() {
                    collected.push(trimmed.to_string());
                }
            }
        }
        if !collected.is_empty() {
            return Some(collected.join("\n"));
        }
    }

    if let Some(text) = payload.get("response").and_then(Value::as_str) {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn run_ollama_analysis(
    client: &reqwest::blocking::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let endpoint = join_url(base_url, "/api/generate");
    let payload = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false
    });
    let response = client
        .post(endpoint)
        .json(&payload)
        .send()
        .map_err(|error| format!("Failed sending prompt to Ollama: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        let summary = summarize_http_body(body.as_str());
        return Err(if summary.is_empty() {
            format!("Ollama analysis request failed (HTTP {}).", status.as_u16())
        } else {
            format!(
                "Ollama analysis request failed (HTTP {}). {}",
                status.as_u16(),
                summary
            )
        });
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    parse_chat_completion_text(&parsed)
        .ok_or_else(|| "Ollama response did not include generated text.".to_string())
}

fn run_openai_compatible_analysis(
    provider: &str,
    client: &reqwest::blocking::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: Option<&str>,
) -> Result<String, String> {
    let endpoint = openai_chat_endpoint(base_url);
    let payload = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.2,
        "stream": false
    });
    let mut request = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|value| !value.trim().is_empty()) {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .map_err(|error| format!("Failed sending prompt to {provider}: {error}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        let summary = summarize_http_body(body.as_str());
        return Err(if summary.is_empty() {
            format!(
                "{provider} analysis request failed (HTTP {}).",
                status.as_u16()
            )
        } else {
            format!(
                "{provider} analysis request failed (HTTP {}). {}",
                status.as_u16(),
                summary
            )
        });
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    parse_chat_completion_text(&parsed).ok_or_else(|| {
        format!(
            "{provider} response did not include assistant text.",
            provider = provider
        )
    })
}

fn run_gemini_analysis(
    client: &reqwest::blocking::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: Option<&str>,
) -> Result<String, String> {
    let Some(key) = api_key.filter(|value| !value.trim().is_empty()) else {
        return Err("Gemini API key is required.".to_string());
    };
    let path = format!("/models/{model}:generateContent");
    let endpoint = join_url(base_url, path.as_str());
    let payload = serde_json::json!({
        "contents": [{ "role": "user", "parts": [{ "text": prompt }] }],
        "generationConfig": { "temperature": 0.2 }
    });
    
    let response = client.post(endpoint).query(&[("key", key)]).json(&payload).send()
        .map_err(|e| format!("Failed sending prompt to Gemini: {e}"))?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Gemini analysis request failed (HTTP {}).", status.as_u16()));
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    
    parsed.get("candidates")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(Value::as_array)
        .and_then(|p| p.first())
        .and_then(|p| p.get("text"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| "Gemini response did not include generated text.".to_string())
}

fn run_claude_analysis(
    client: &reqwest::blocking::Client,
    base_url: &str,
    model: &str,
    prompt: &str,
    api_key: Option<&str>,
) -> Result<String, String> {
    let Some(key) = api_key.filter(|value| !value.trim().is_empty()) else {
        return Err("Claude API key is required.".to_string());
    };
    let endpoint = join_url(base_url, "/messages");
    let payload = serde_json::json!({
        "model": model,
        "max_tokens": 1024,
        "temperature": 0.2,
        "messages": [{ "role": "user", "content": prompt }]
    });
    
    let response = client.post(endpoint)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .map_err(|e| format!("Failed sending prompt to Claude: {e}"))?;
    
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Claude analysis request failed (HTTP {}).", status.as_u16()));
    }
    let parsed: Value = serde_json::from_str(body.as_str()).unwrap_or(Value::Null);
    
    parsed.get("content")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("text"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| "Claude response did not include generated text.".to_string())
}

fn profile_warning_for_settings(profile: &LlmConnectionProfile, settings: &LlmSettings) -> Option<String> {
    if !settings.never_send_raw_event_to_untrusted {
        return None;
    }
    if profile.scope.trim().eq_ignore_ascii_case("local") {
        return None;
    }
    let parsed = reqwest::Url::parse(profile.base_url.as_str()).ok()?;
    let host = parsed.host_str()?.trim();
    if host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1" {
        return None;
    }
    if settings
        .trusted_hosts
        .iter()
        .any(|entry| entry.eq_ignore_ascii_case(host))
    {
        return None;
    }

    Some(format!(
        "Target host '{host}' is not listed in trusted LAN hosts. Prompt content is still redacted.",
        host = host
    ))
}

fn analysis_timeout_for_profile(profile: &LlmConnectionProfile) -> Duration {
    let provider = profile.provider.trim().to_ascii_lowercase();
    let scope = profile.scope.trim().to_ascii_lowercase();

    if provider == "ollama" || provider == "lmstudio" || scope == "local" || scope == "lan" {
        Duration::from_secs(600)
    } else {
        Duration::from_secs(90)
    }
}

fn run_profile_analysis(
    profile: &LlmConnectionProfile,
    prompt: &str,
    api_key: Option<&str>,
) -> Result<(String, String), String> {
    let provider = profile.provider.trim().to_ascii_lowercase();
    if !provider_is_valid(provider.as_str()) {
        return Err("Selected profile is not configured as a compatible provider.".to_string());
    }
    let base_url = normalize_base_url(profile.base_url.as_str());
    if base_url.is_empty() {
        return Err("Base URL is required for local LLM analysis.".to_string());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(analysis_timeout_for_profile(profile))
        .build()
        .map_err(|error| format!("Failed to initialize HTTP client: {error}"))?;
    let model = resolve_model_for_profile(profile, &client, api_key)?;
    let response = match provider.as_str() {
        "ollama" => run_ollama_analysis(&client, base_url.as_str(), model.as_str(), prompt)?,
        "lmstudio" | "openai_compatible" | "openai" | "perplexity" => run_openai_compatible_analysis(
            provider.as_str(),
            &client,
            base_url.as_str(),
            model.as_str(),
            prompt,
            api_key,
        )?,
        "gemini" => run_gemini_analysis(&client, base_url.as_str(), model.as_str(), prompt, api_key)?,
        "claude" => run_claude_analysis(&client, base_url.as_str(), model.as_str(), prompt, api_key)?,
        _ => {
            return Err("Selected profile is not configured as a compatible provider.".to_string());
        }
    };

    Ok((model, response))
}

fn find_profile_by_id<'a>(settings: &'a LlmSettings, profile_id: &str) -> Option<&'a LlmConnectionProfile> {
    settings
        .profiles
        .iter()
        .find(|profile| profile.id.eq_ignore_ascii_case(profile_id))
}

fn push_unique_profile(candidates: &mut Vec<LlmConnectionProfile>, profile: &LlmConnectionProfile) {
    if !candidates
        .iter()
        .any(|entry: &LlmConnectionProfile| entry.id == profile.id)
    {
        candidates.push(profile.clone());
    }
}

fn candidate_profiles_for_analysis(
    settings: &LlmSettings,
    requested_profile_id: Option<&str>,
) -> Result<Vec<LlmConnectionProfile>, String> {
    let mut candidates = Vec::new();

    if let Some(requested) = requested_profile_id {
        let Some(profile) = find_profile_by_id(settings, requested) else {
            return Err("Requested LLM profile was not found.".to_string());
        };
        push_unique_profile(&mut candidates, profile);
    } else if !settings.default_profile_id.trim().is_empty() {
        if let Some(default_profile) = find_profile_by_id(settings, settings.default_profile_id.as_str()) {
            push_unique_profile(&mut candidates, default_profile);
        }
    }

    if !settings.backup_profile_id.trim().is_empty() {
        if let Some(backup_profile) = find_profile_by_id(settings, settings.backup_profile_id.as_str()) {
            push_unique_profile(&mut candidates, backup_profile);
        }
    }

    if candidates.is_empty() {
        for profile in &settings.profiles {
            if profile.enabled && provider_is_valid(profile.provider.as_str()) {
                push_unique_profile(&mut candidates, profile);
            }
        }
    }

    if candidates.is_empty() {
        return Err("No compatible LLM profiles are configured.".to_string());
    }

    Ok(candidates)
}

fn analyze_with_local_llm_sync(
    settings: LlmSettings,
    prompt: String,
    requested_profile_id: Option<String>,
) -> Result<LlmAnalysisResult, String> {
    let trimmed_prompt = prompt.trim().to_string();
    if trimmed_prompt.is_empty() {
        return Err("Prompt is empty.".to_string());
    }
    if trimmed_prompt.len() > 80_000 {
        return Err("Prompt is too large (max 80,000 characters).".to_string());
    }

    let candidates = candidate_profiles_for_analysis(
        &settings,
        requested_profile_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )?;

    let mut errors = Vec::new();
    for (index, profile) in candidates.iter().enumerate() {
        if !profile.enabled {
            errors.push(format!("Profile '{}' is disabled.", profile.name));
            continue;
        }

        let provider = profile.provider.trim().to_ascii_lowercase();
        if !provider_is_valid(provider.as_str()) {
            errors.push(format!(
                "Profile '{}' provider '{}' is not compatible.",
                profile.name, profile.provider
            ));
            continue;
        }

        let api_key = get_profile_keychain_secret(profile.id.as_str())?;
        match run_profile_analysis(profile, trimmed_prompt.as_str(), api_key.as_deref()) {
            Ok((model, response)) => {
                return Ok(LlmAnalysisResult {
                    ok: true,
                    profile_id: profile.id.clone(),
                    profile_name: profile.name.clone(),
                    provider,
                    base_url: normalize_base_url(profile.base_url.as_str()),
                    model,
                    response,
                    fallback_used: index > 0,
                    warning: profile_warning_for_settings(profile, &settings),
                });
            }
            Err(error) => {
                errors.push(format!("{}: {error}", profile.name));
            }
        }
    }

    Err(format!(
        "Local LLM analysis failed for all candidate profiles. {}",
        errors.join(" | ")
    ))
}


fn resolve_target_profile(target_id: Option<&str>) -> Option<crate::settings::RemoteConnectionProfile> {
    let id = target_id?;
    if id == "localhost" || id.trim().is_empty() {
        return None;
    }
    let settings = crate::settings::load_remote_settings();
    settings.profiles.into_iter().find(|p| p.id == id)
}

#[tauri::command]
async fn refresh_local_events(target_id: Option<String>) -> Result<SyncOperationResult, String> {
    let days = load_ingest_window_days();
    let profile = load_ingest_profile();
    let now = Utc::now();
    let start = now - chrono::Duration::days(days as i64);
    let start_str = start.to_rfc3339();

    let target = target_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let remote_profile = resolve_target_profile(target.as_deref());
        
        let outcome = if let Some(remote) = remote_profile {
            match remote.os.to_lowercase().as_str() {
                "windows" => crate::logs::windows::collect_remote_windows_events(&remote, Some(start), Some(now), Some(profile.max_events_per_sync), Some(profile.windows_channels.as_slice())),
                "linux" => crate::logs::linux::collect_remote_linux_events(&remote, Some(start), Some(now), Some(profile.max_events_per_sync), Some(profile.windows_channels.as_slice())),
                "macos" => crate::logs::macos::collect_remote_macos_events(&remote, Some(start), Some(now), Some(profile.max_events_per_sync), Some(profile.windows_channels.as_slice())),
                _ => crate::logs::CollectionResult::default()
            }
        } else {
            collect_host_events_range_with_windows_channels(
                Some(start),
                Some(now),
                Some(profile.max_events_per_sync),
                Some(profile.windows_channels.as_slice()),
                profile.request_elevation,
            )
        };
        let report = report_collection_outcome("Refresh collection", &outcome)?;
        save_local_events(outcome.events.as_slice())
            .map_err(|error| command_error("storage", "Failed to save refreshed events", error))?;
        if let Err(error) = prune_events_before(start_str.as_str()) {
            diagnostics::warn("storage", format!("Prune after refresh failed: {error}"));
        }
        Ok::<SyncOperationResult, String>(report)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join refresh collection task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
async fn estimate_refresh_local_events() -> Result<EventLoadEstimateResult, String> {
    let days = load_ingest_window_days();
    let profile = load_ingest_profile();
    let now = Utc::now();
    let start = now - chrono::Duration::days(days as i64);

    tauri::async_runtime::spawn_blocking(move || {
        let estimate = estimate_host_events_range_with_windows_channels(
            Some(start),
            Some(now),
            Some(profile.windows_channels.as_slice()),
            profile.request_elevation,
        );
        report_collection_estimate("Refresh estimate", &start, &now, &estimate)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join refresh estimate task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
fn get_local_events(target_id: Option<String>, limit: Option<u32>) -> Result<Vec<NormalizedEvent>, String> {
    let limit = limit.unwrap_or(10000).min(50000);
    let host = resolve_target_profile(target_id.as_deref()).map(|p| p.host).unwrap_or_else(|| "localhost".to_string());
    read_local_events(limit, Some(&host))
        .map_err(|error| command_error("storage", "Failed to read local events", error))
}

#[tauri::command]
fn get_local_events_range(
    target_id: Option<String>,
    from: String,
    to: String,
    limit: Option<u32>,
) -> Result<Vec<NormalizedEvent>, String> {
    let (start, end) = parse_local_date_range(from.as_str(), to.as_str())
        .map_err(|error| command_error("runtime", "Invalid local events range", error))?;
    let limit = limit.unwrap_or(10000).min(50000);
    let start_str = start.to_rfc3339();
    let end_str = end.to_rfc3339();
    let host = resolve_target_profile(target_id.as_deref()).map(|p| p.host).unwrap_or_else(|| "localhost".to_string());
    read_local_events_range(start_str.as_str(), end_str.as_str(), limit, Some(&host))
        .map_err(|error| command_error("storage", "Failed to read local events for range", error))
}

#[tauri::command]
fn get_local_events_window(
    target_id: Option<String>,
    start: String,
    end: String,
    limit: Option<u32>,
) -> Result<Vec<NormalizedEvent>, String> {
    let (start_value, end_value) = parse_timestamp_window(start.as_str(), end.as_str())
        .map_err(|error| command_error("runtime", "Invalid local events window", error))?;
    let limit = limit.unwrap_or(10000).min(50000);
    let start_str = start_value.to_rfc3339();
    let end_str = end_value.to_rfc3339();
    let host = resolve_target_profile(target_id.as_deref())
        .map(|p| p.host)
        .unwrap_or_else(|| "localhost".to_string());
    read_local_events_window(start_str.as_str(), end_str.as_str(), limit, Some(&host)).map_err(
        |error| command_error("storage", "Failed to read local events for window", error),
    )
}

#[tauri::command]
async fn import_host_crashes(_target_id: Option<String>, limit: Option<u32>) -> Result<usize, String> {
    let max = limit.unwrap_or(200).clamp(1, 2000) as usize;

    tauri::async_runtime::spawn_blocking(move || {
        let crashes = collect_host_crashes(max)
            .map_err(|error| command_error("collector", "Crash import failed", error))?;
        if crashes.is_empty() {
            return Ok::<usize, String>(0);
        }
        save_crashes(&crashes)
            .map_err(|error| command_error("storage", "Failed to save imported crashes", error))?;
        Ok(crashes.len())
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join crash import task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
fn get_crashes(target_id: Option<String>, limit: Option<u32>) -> Result<Vec<CrashRecord>, String> {
    let limit = limit.unwrap_or(250).min(5000);
    let host = resolve_target_profile(target_id.as_deref()).map(|p| p.host).unwrap_or_else(|| "localhost".to_string());
    read_crashes(limit, Some(&host)).map_err(|error| command_error("storage", "Failed to read crashes", error))
}

#[tauri::command]
fn analyze_minidump(
    crash_id: String,
    window_minutes: Option<i64>,
) -> Result<MinidumpAnalysisResult, String> {
    let crash = get_crash_by_id(crash_id.as_str())
        .map_err(|error| command_error("storage", "Failed to load crash for minidump analysis", error))?
        .ok_or_else(|| "Selected crash was not found.".to_string())?;
    let related = correlate_crash_events(crash_id.as_str(), window_minutes.unwrap_or(15).clamp(1, 180), 250)
        .map_err(|error| command_error("storage", "Failed to load related events for minidump analysis", error))?;
    analyze_windows_minidump(&crash, related.as_slice())
        .map_err(|error| command_error("crash", "Failed to analyze minidump", error))
}

#[tauri::command]
fn cleanup_local_duplicate_events() -> Result<usize, String> {
    cleanup_duplicate_events()
        .map_err(|error| command_error("storage", "Failed to clean up duplicate events", error))
}

#[tauri::command]
fn get_crash_related_events(
    crash_id: String,
    window_minutes: Option<i64>,
    limit: Option<u32>,
) -> Result<Vec<NormalizedEvent>, String> {
    let window = window_minutes.unwrap_or(15).clamp(1, 180);
    let max_events = limit.unwrap_or(200).min(2000);
    correlate_crash_events(crash_id.as_str(), window, max_events)
        .map_err(|error| command_error("storage", "Failed to correlate crash events", error))
}

#[tauri::command]
fn get_ingest_window_days() -> u32 {
    load_ingest_window_days()
}

#[tauri::command]
fn set_ingest_window_days(days: u32) -> Result<u32, String> {
    save_ingest_window_days(days)
        .map_err(|error| command_error("settings", "Failed to save ingest window", error))?;
    Ok(load_ingest_window_days())
}

#[tauri::command]
fn get_ingest_profile() -> IngestProfile {
    load_ingest_profile()
}

#[tauri::command]
fn set_ingest_profile(profile: IngestProfile) -> Result<IngestProfile, String> {
    save_ingest_profile(profile)
        .map_err(|error| command_error("settings", "Failed to save ingest profile", error))
}

#[tauri::command]
fn get_llm_settings() -> LlmSettings {
    let load_result = load_llm_settings_with_migration();
    if !load_result.migrated_api_keys.is_empty() {
        for secret in load_result.migrated_api_keys {
            match set_profile_keychain_secret(secret.profile_id.as_str(), secret.api_key.as_str()) {
                Ok(_) => {}
                Err(error) => diagnostics::warn(
                    "settings",
                    format!(
                        "Failed to migrate legacy API key for profile '{}': {error}",
                        secret.profile_id
                    ),
                ),
            }
        }
    }

    if load_result.migrated_from_legacy {
        if let Err(error) = save_llm_settings(load_result.settings.clone()) {
            diagnostics::warn(
                "settings",
                format!("Failed to persist migrated LLM profile settings: {error}"),
            );
        }
    }
    load_result.settings
}

#[tauri::command]
fn set_llm_settings(settings: LlmSettings) -> Result<LlmSettings, String> {
    save_llm_settings(settings)
        .map_err(|error| command_error("settings", "Failed to save LLM settings", error))
}

#[tauri::command]
fn set_llm_profile_api_key(profile_id: String, api_key: String) -> Result<LlmSettings, String> {
    let id = profile_id.trim().to_string();
    if id.is_empty() {
        return Err("Profile ID is required.".to_string());
    }
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("API key is empty. Use clear_llm_profile_api_key to remove keychain values.".to_string());
    }

    let mut settings = load_llm_settings_with_migration().settings;
    let Some(profile) = settings.profiles.iter_mut().find(|profile| profile.id == id) else {
        return Err("Unknown profile ID.".to_string());
    };
    set_profile_keychain_secret(id.as_str(), key.as_str())
        .map_err(|error| command_error("settings", "Failed to save profile API key", error))?;
    profile.api_key_configured = true;
    save_llm_settings(settings)
        .map_err(|error| command_error("settings", "Failed to persist profile key status", error))
}

#[tauri::command]
fn clear_llm_profile_api_key(profile_id: String) -> Result<LlmSettings, String> {
    let id = profile_id.trim().to_string();
    if id.is_empty() {
        return Err("Profile ID is required.".to_string());
    }

    let mut settings = load_llm_settings_with_migration().settings;
    let Some(profile) = settings.profiles.iter_mut().find(|profile| profile.id == id) else {
        return Err("Unknown profile ID.".to_string());
    };
    clear_profile_keychain_secret(id.as_str())
        .map_err(|error| command_error("settings", "Failed to clear profile API key", error))?;
    profile.api_key_configured = false;
    save_llm_settings(settings)
        .map_err(|error| command_error("settings", "Failed to persist profile key status", error))
}

#[tauri::command]
fn detect_local_llm_providers() -> Vec<llm::LlmEndpointCandidate> {
    llm::detect_local_providers()
}

#[tauri::command]
fn list_llm_network_interfaces(
    include_non_private: Option<bool>,
    include_loopback: Option<bool>,
) -> Vec<llm::LlmNetworkInterface> {
    llm::list_network_interfaces(
        include_non_private.unwrap_or(false),
        include_loopback.unwrap_or(false),
    )
}

#[tauri::command]
fn scan_lan_llm_providers(
    interface_id: Option<String>,
    max_hosts: Option<u32>,
) -> Vec<llm::LlmEndpointCandidate> {
    llm::scan_lan_providers(
        interface_id.as_deref(),
        max_hosts.unwrap_or(256).clamp(16, 2048) as usize,
    )
}

#[tauri::command]
async fn test_llm_profile_connection(
    profile: LlmConnectionProfile,
) -> Result<LlmConnectionTestResult, String> {
    let api_key = get_profile_keychain_secret(profile.id.as_str())
        .map_err(|error| command_error("settings", "Failed to read profile API key", error))?;
    tauri::async_runtime::spawn_blocking(move || test_llm_profile_connection_sync(profile, api_key))
        .await
        .map_err(|error| {
            command_error(
                "runtime",
                "Failed to join LLM profile connection test task",
                error.to_string(),
            )
        })
}

#[tauri::command]
async fn analyze_with_local_llm(
    prompt: String,
    profile_id: Option<String>,
) -> Result<LlmAnalysisResult, String> {
    let settings = load_llm_settings_with_migration().settings;
    let analysis = tauri::async_runtime::spawn_blocking(move || {
        analyze_with_local_llm_sync(settings, prompt, profile_id)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join local LLM analysis task",
            error.to_string(),
        )
    })?;

    analysis.map_err(|error| command_error("llm", "Local LLM analysis failed", error))
}

#[tauri::command]
fn open_path_in_shell(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path is required.".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err("Path does not exist.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        if target.is_file() {
            Command::new("explorer.exe")
                .arg(format!("/select,{}", target.display()))
                .spawn()
        } else {
            Command::new("explorer.exe").arg(&target).spawn()
        }
        .map_err(|error| command_error("runtime", "Failed to launch Windows shell", error.to_string()))?;
    }

    #[cfg(target_os = "macos")]
    {
        let status = if target.is_file() {
            Command::new("open").arg("-R").arg(&target).status()
        } else {
            Command::new("open").arg(&target).status()
        }
        .map_err(|error| command_error("runtime", "Failed to launch Finder", error.to_string()))?;

        if !status.success() {
            return Err("Finder could not open the requested path.".to_string());
        }
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        let open_target = if target.is_file() {
            target.parent().map(Path::to_path_buf).unwrap_or(target.clone())
        } else {
            target.clone()
        };
        let status = Command::new("xdg-open")
            .arg(open_target)
            .status()
            .map_err(|error| command_error("runtime", "Failed to launch file browser", error.to_string()))?;
        if !status.success() {
            return Err("File browser could not open the requested path.".to_string());
        }
    }

    Ok(())
}

#[tauri::command]
async fn backfill_local_events(from: String, to: String) -> Result<SyncOperationResult, String> {
    let (start, end) = parse_local_date_range(from.as_str(), to.as_str())
        .map_err(|error| command_error("runtime", "Invalid backfill range", error))?;
    let profile = load_ingest_profile();

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = collect_host_events_range_with_windows_channels(
            Some(start),
            Some(end),
            Some(profile.max_events_per_sync),
            Some(profile.windows_channels.as_slice()),
            profile.request_elevation,
        );
        let report = report_collection_outcome("Range backfill collection", &outcome)?;
        save_local_events(outcome.events.as_slice())
            .map_err(|error| command_error("storage", "Failed to save backfilled events", error))?;
        Ok::<SyncOperationResult, String>(report)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join backfill collection task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
async fn sync_local_events_range(
    from: String,
    to: String,
    replace_outside_range: Option<bool>,
) -> Result<SyncOperationResult, String> {
    let (start, end) = parse_local_date_range(from.as_str(), to.as_str())
        .map_err(|error| command_error("runtime", "Invalid sync range", error))?;
    let profile = load_ingest_profile();
    let start_str = start.to_rfc3339();
    let end_str = end.to_rfc3339();
    let replace = replace_outside_range.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = collect_host_events_range_with_windows_channels(
            Some(start),
            Some(end),
            Some(profile.max_events_per_sync),
            Some(profile.windows_channels.as_slice()),
            profile.request_elevation,
        );
        let report = report_collection_outcome("Range sync collection", &outcome)?;
        save_local_events(outcome.events.as_slice()).map_err(|error| {
            command_error("storage", "Failed to save range-synced events", error)
        })?;
        if replace {
            prune_events_outside(start_str.as_str(), end_str.as_str()).map_err(|error| {
                command_error("storage", "Failed to prune out-of-range events", error)
            })?;
        }
        Ok::<SyncOperationResult, String>(report)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join range sync task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
async fn sync_local_events_window(
    target_id: Option<String>,
    start: String,
    end: String,
) -> Result<SyncOperationResult, String> {
    let (start_value, end_value) = parse_timestamp_window(start.as_str(), end.as_str())
        .map_err(|error| command_error("runtime", "Invalid sync window", error))?;
    let profile = load_ingest_profile();
    let target = target_id.clone();
    let max_events = profile.max_events_per_sync.max(5000);

    tauri::async_runtime::spawn_blocking(move || {
        let remote_profile = resolve_target_profile(target.as_deref());

        let outcome = if let Some(remote) = remote_profile {
            match remote.os.to_lowercase().as_str() {
                "windows" => crate::logs::windows::collect_remote_windows_events(
                    &remote,
                    Some(start_value),
                    Some(end_value),
                    Some(max_events),
                    Some(profile.windows_channels.as_slice()),
                ),
                "linux" => crate::logs::linux::collect_remote_linux_events(
                    &remote,
                    Some(start_value),
                    Some(end_value),
                    Some(max_events),
                    Some(profile.windows_channels.as_slice()),
                ),
                "macos" => crate::logs::macos::collect_remote_macos_events(
                    &remote,
                    Some(start_value),
                    Some(end_value),
                    Some(max_events),
                    Some(profile.windows_channels.as_slice()),
                ),
                _ => crate::logs::CollectionResult::default(),
            }
        } else {
            collect_host_events_range_with_windows_channels(
                Some(start_value),
                Some(end_value),
                Some(max_events),
                Some(profile.windows_channels.as_slice()),
                profile.request_elevation,
            )
        };
        let report = report_collection_outcome("Crash window collection", &outcome)?;
        save_local_events(outcome.events.as_slice()).map_err(|error| {
            command_error("storage", "Failed to save crash-window events", error)
        })?;
        Ok::<SyncOperationResult, String>(report)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join crash window sync task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
async fn estimate_local_events_range(
    from: String,
    to: String,
) -> Result<EventLoadEstimateResult, String> {
    let (start, end) = parse_local_date_range(from.as_str(), to.as_str())
        .map_err(|error| command_error("runtime", "Invalid estimate range", error))?;
    let profile = load_ingest_profile();

    tauri::async_runtime::spawn_blocking(move || {
        let estimate = estimate_host_events_range_with_windows_channels(
            Some(start),
            Some(end),
            Some(profile.windows_channels.as_slice()),
            profile.request_elevation,
        );
        report_collection_estimate("Range estimate", &start, &end, &estimate)
    })
    .await
    .map_err(|error| {
        command_error(
            "runtime",
            "Failed to join range estimate task",
            error.to_string(),
        )
    })?
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if url.len() > 2048 {
        return Err("URL is too long.".to_string());
    }

    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("Only http/https URLs are allowed.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        // Prefer desktop association (xdg defaults) instead of inheriting a global
        // BROWSER override from shell/session environment.
        let spawn_result = Command::new("xdg-open")
            .arg(url.as_str())
            .env_remove("BROWSER")
            .spawn();

        match spawn_result {
            Ok(_) => return Ok(()),
            Err(error) => diagnostics::warn(
                "runtime",
                format!("xdg-open launch failed, falling back to webbrowser crate: {error}"),
            ),
        }
    }

    webbrowser::open(url.as_str())
        .map(|_| ())
        .map_err(|error| command_error("runtime", "Failed to open external URL", error.to_string()))
}

#[tauri::command]
fn get_export_directory() -> Option<String> {
    load_export_dir()
}

#[tauri::command]
fn choose_export_directory() -> Result<Option<String>, String> {
    let chosen = rfd::FileDialog::new().pick_folder();
    let Some(path) = chosen else {
        return Ok(None);
    };

    let value = path.to_string_lossy().to_string();
    save_export_dir(Some(value.as_str())).map_err(|error| {
        command_error(
            "settings",
            "Failed to persist chosen export directory",
            error,
        )
    })?;
    Ok(Some(value))
}

#[tauri::command]
fn set_export_directory(path: Option<String>) -> Result<(), String> {
    save_export_dir(path.as_deref())
        .map_err(|error| command_error("settings", "Failed to update export directory", error))
}

#[tauri::command]
fn export_events(
    format: String,
    filename: String,
    events: Vec<NormalizedEvent>,
) -> Result<String, String> {
    let output_format = format.to_ascii_lowercase();
    let extension = match output_format.as_str() {
        "json" => "json",
        "csv" => "csv",
        "txt" => "txt",
        _ => return Err("Unsupported export format.".to_string()),
    };

    let base_dir = load_export_dir()
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .ok_or_else(|| {
            command_error(
                "storage",
                "Unable to resolve export directory",
                "Unable to resolve export directory.",
            )
        })?;

    if !base_dir.exists() || !base_dir.is_dir() {
        return Err("Configured export directory is invalid.".to_string());
    }

    let safe_name = sanitize_filename(filename.as_str(), extension);
    let output_path = base_dir.join(safe_name);
    let payload = build_export_payload(extension, &events)?;

    std::fs::write(&output_path, payload).map_err(|error| {
        command_error("storage", "Failed to write export file", error.to_string())
    })?;
    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
fn export_events_with_dialog(
    format: String,
    suggested_filename: String,
    events: Vec<NormalizedEvent>,
) -> Result<Option<String>, String> {
    let output_format = format.to_ascii_lowercase();
    let (extension, filter_name): (&str, &str) = match output_format.as_str() {
        "json" => ("json", "JSON"),
        "csv" => ("csv", "CSV"),
        "txt" => ("txt", "Text"),
        _ => return Err("Unsupported export format.".to_string()),
    };

    let safe_name = sanitize_filename(suggested_filename.as_str(), extension);
    let mut dialog = rfd::FileDialog::new().set_file_name(safe_name.as_str());
    dialog = match extension {
        "json" => dialog.add_filter(filter_name, &["json"]),
        "csv" => dialog.add_filter(filter_name, &["csv"]),
        "txt" => dialog.add_filter(filter_name, &["txt"]),
        _ => dialog,
    };

    if let Some(base_dir) = load_export_dir()
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .filter(|path| path.exists() && path.is_dir())
    {
        dialog = dialog.set_directory(base_dir);
    }

    let Some(output_path) = dialog.save_file() else {
        return Ok(None);
    };

    let payload = build_export_payload(extension, &events)?;
    std::fs::write(&output_path, payload).map_err(|error| {
        command_error("storage", "Failed to write export file", error.to_string())
    })?;
    Ok(Some(output_path.to_string_lossy().to_string()))
}

#[tauri::command]
fn save_text_with_dialog(suggested_filename: String, text: String) -> Result<Option<String>, String> {
    let lower_name = suggested_filename.to_ascii_lowercase();
    let preferred_extension = if lower_name.ends_with(".md") {
        "md"
    } else if lower_name.ends_with(".html") || lower_name.ends_with(".htm") {
        "html"
    } else {
        "txt"
    };

    let safe_name = sanitize_filename(suggested_filename.as_str(), preferred_extension);
    let mut dialog = rfd::FileDialog::new()
        .set_file_name(safe_name.as_str())
        .add_filter("Text", &["txt"])
        .add_filter("Markdown", &["md"])
        .add_filter("HTML", &["html", "htm"]);

    if let Some(base_dir) = load_export_dir()
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .filter(|path| path.exists() && path.is_dir())
    {
        dialog = dialog.set_directory(base_dir);
    }

    let Some(output_path) = dialog.save_file() else {
        return Ok(None);
    };

    std::fs::write(&output_path, text).map_err(|error| {
        command_error(
            "storage",
            "Failed to write text export file",
            error.to_string(),
        )
    })?;
    Ok(Some(output_path.to_string_lossy().to_string()))
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_saved_theme() -> Option<String> {
    load_theme()
}

#[tauri::command]
fn set_app_theme(app: AppHandle, theme: String) {
    apply_theme(&app, theme.as_str());
}

fn apply_theme(app: &AppHandle, theme: &str) {
    if let Err(error) = save_theme(theme) {
        diagnostics::warn(
            "settings",
            format!("Failed to persist theme '{theme}': {error}"),
        );
    }

    let native_theme = match theme {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };

    for window in app.webview_windows().values() {
        if let Err(error) = window.set_theme(native_theme) {
            diagnostics::warn(
                "runtime",
                format!("Failed to apply native theme to window: {error}"),
            );
        }
        if let Err(error) = window.emit("hla://theme-changed", theme) {
            diagnostics::warn(
                "runtime",
                format!("Failed to emit theme change to window: {error}"),
            );
        }
    }
    if let Err(error) = app.emit("hla://theme-changed", theme) {
        diagnostics::warn(
            "runtime",
            format!("Failed to broadcast theme change: {error}"),
        );
    }
}

fn setup_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let theme_submenu = SubmenuBuilder::new(app, "Theme")
        .text("theme_system", "System")
        .text("theme_light", "Light")
        .text("theme_dark", "Dark")
        .build()?;

    let tools_submenu = SubmenuBuilder::new(app, "Tools")
        .item(&theme_submenu)
        .separator()
        .text("tools_help", "Help")
        .build()?;

    let app_submenu = SubmenuBuilder::new(app, "App")
        .separator()
        .text("app_exit", "Exit")
        .build()?;

    let menu = MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&tools_submenu)
        .build()?;
    app.set_menu(menu)?;
    if let Some(theme) = load_theme() {
        apply_theme(&app.handle(), theme.as_str());
    } else {
        apply_theme(&app.handle(), "system");
    }
    Ok(())
}

fn parse_local_date_range(from: &str, to: &str) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    let start_date = NaiveDate::parse_from_str(from, "%Y-%m-%d")
        .map_err(|_| "Invalid start date format (expected YYYY-MM-DD).")?;
    let end_date = NaiveDate::parse_from_str(to, "%Y-%m-%d")
        .map_err(|_| "Invalid end date format (expected YYYY-MM-DD).")?;

    let start_local = Local
        .from_local_datetime(
            &start_date
                .and_hms_opt(0, 0, 0)
                .ok_or("Invalid start time")?,
        )
        .single()
        .ok_or("Unable to interpret start date in local timezone.")?;
    let end_local = Local
        .from_local_datetime(&end_date.and_hms_opt(23, 59, 59).ok_or("Invalid end time")?)
        .single()
        .ok_or("Unable to interpret end date in local timezone.")?;

    let mut start = start_local.with_timezone(&Utc);
    let mut end = end_local.with_timezone(&Utc);
    if start > end {
        std::mem::swap(&mut start, &mut end);
    }

    let max_span = chrono::Duration::days(365);
    if end - start > max_span {
        return Err("Backfill range is too large (max 365 days).".to_string());
    }

    Ok((start, end))
}

fn parse_timestamp_window(
    start: &str,
    end: &str,
) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    let start_value = DateTime::parse_from_rfc3339(start)
        .map_err(|_| "Invalid start timestamp format (expected RFC3339).")?;
    let end_value = DateTime::parse_from_rfc3339(end)
        .map_err(|_| "Invalid end timestamp format (expected RFC3339).")?;

    let mut start_utc = start_value.with_timezone(&Utc);
    let mut end_utc = end_value.with_timezone(&Utc);
    if start_utc > end_utc {
        std::mem::swap(&mut start_utc, &mut end_utc);
    }

    let max_span = chrono::Duration::days(7);
    if end_utc - start_utc > max_span {
        return Err("Crash investigation window is too large (max 7 days).".to_string());
    }

    Ok((start_utc, end_utc))
}

#[cfg(target_os = "linux")]
fn configure_linux_runtime_defaults() {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("DESKTOP_SESSION"))
        .unwrap_or_else(|_| "unknown".to_string());
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_else(|_| "unknown".to_string());

    diagnostics::info(
        "startup",
        format!("Linux desktop/session detected: desktop='{desktop}', session='{session}'"),
    );

    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        diagnostics::info(
            "startup",
            "Enabled WEBKIT_DISABLE_DMABUF_RENDERER=1 for safer startup on KDE/GNOME Linux environments.",
        );
    } else {
        diagnostics::info(
            "startup",
            "WEBKIT_DISABLE_DMABUF_RENDERER already set in environment; keeping caller-provided value.",
        );
    }
}

#[cfg(not(target_os = "linux"))]
fn configure_linux_runtime_defaults() {}

#[tauri::command]
fn restart_elevated() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new("powershell")
            .arg("-Command")
            .arg("Start-Process")
            .arg("-FilePath")
            .arg(format!("'{}'", exe_path.display()))
            .arg("-Verb")
            .arg("RunAs")
            .spawn()
            .map_err(|e| e.to_string())?;

        std::process::exit(0);
    }

    #[cfg(target_os = "macos")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        let shell_path = exe_path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "do shell script quoted form of \"{}\" with administrator privileges",
            shell_path
        );

        std::process::Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map_err(|e| e.to_string())?;

        std::process::exit(0);
    }

    #[cfg(target_os = "linux")]
    {
        let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
        std::process::Command::new("pkexec")
            .arg(exe_path)
            .spawn()
            .map_err(|e| e.to_string())?;

        std::process::exit(0);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("Elevation restart is not supported on this platform.".to_string())
    }
}









#[tauri::command]
fn get_remote_settings() -> crate::settings::RemoteSettings {
    crate::settings::load_remote_settings()
}

#[tauri::command]
fn save_remote_settings(settings: crate::settings::RemoteSettings) -> Result<crate::settings::RemoteSettings, String> {
    crate::settings::save_remote_settings(settings)
}

#[tauri::command]
fn save_remote_profile_secret(profile_id: String, secret: String) -> Result<(), String> {
    crate::settings::set_remote_profile_secret(&profile_id, &secret)
}

#[tauri::command]
fn clear_remote_profile_secret(profile_id: String) -> Result<(), String> {
    crate::settings::clear_remote_profile_secret(&profile_id)
}

fn sanitize_filename(filename: &str, extension: &str) -> String {

    let raw_name = Path::new(filename)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("hermes-events");

    let mut clean = raw_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();

    if clean.is_empty() {
        clean = "hermes-events".to_string();
    }

    if !clean
        .to_ascii_lowercase()
        .ends_with(&format!(".{extension}"))
    {
        clean.push('.');
        clean.push_str(extension);
    }

    clean
}

fn csv_escape(value: &str) -> String {
    let text = csv_formula_safe(value);
    if text.contains(',') || text.contains('"') || text.contains('\n') || text.contains('\r') {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text
    }
}

fn csv_formula_safe(value: &str) -> String {
    let leading_trimmed = value.trim_start_matches([' ', '\t', '\r', '\n']);
    match leading_trimmed.chars().next() {
        Some('=') | Some('+') | Some('-') | Some('@') => format!("'{value}"),
        _ => value.to_string(),
    }
}

fn build_csv(events: &[NormalizedEvent]) -> String {
    let mut lines = Vec::with_capacity(events.len() + 1);
    lines
        .push("timestamp,os,logName,category,provider,eventId,severity,message,source".to_string());

    for event in events {
        let row = [
            csv_escape(event.timestamp.as_str()),
            csv_escape(event.os.as_str()),
            csv_escape(event.log_name.as_str()),
            csv_escape(event.category.as_str()),
            csv_escape(event.provider.as_str()),
            csv_escape(
                event
                    .event_id
                    .map(|id| id.to_string())
                    .unwrap_or_default()
                    .as_str(),
            ),
            csv_escape(event.severity.as_str()),
            csv_escape(event.message.as_str()),
            csv_escape(if event.imported {
                "Imported"
            } else {
                "Live/Local"
            }),
        ]
        .join(",");
        lines.push(row);
    }

    lines.join("\n")
}

fn build_plain_text(events: &[NormalizedEvent]) -> String {
    let mut lines = Vec::with_capacity(events.len() * 10);
    for event in events {
        lines.push(format!("Timestamp: {}", event.timestamp));
        lines.push(format!("OS: {}", event.os));
        lines.push(format!("Type: {} / {}", event.log_name, event.category));
        lines.push(format!("Provider: {}", event.provider));
        lines.push(format!(
            "Event ID: {}",
            event
                .event_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "-".to_string())
        ));
        lines.push(format!("Severity: {}", event.severity));
        lines.push(format!(
            "Source: {}",
            if event.imported {
                "Imported"
            } else {
                "Live/Local"
            }
        ));
        lines.push(format!("Message: {}", event.message));
        lines.push("---".to_string());
    }
    lines.join("\n")
}

fn build_export_payload(extension: &str, events: &[NormalizedEvent]) -> Result<String, String> {
    match extension {
        "json" => serde_json::to_string_pretty(events).map_err(|error| {
            command_error(
                "runtime",
                "Failed to serialize export JSON payload",
                error.to_string(),
            )
        }),
        "csv" => Ok(build_csv(events)),
        "txt" => Ok(build_plain_text(events)),
        _ => Err("Unsupported export format.".to_string()),
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        diagnostics::error("panic", format!("Unhandled panic: {info}"));
    }));

    match diagnostics::init_logging() {
        Ok(path) => diagnostics::info(
            "startup",
            format!("Diagnostics logs directory ready: {}", path.display()),
        ),
        Err(error) => {
            eprintln!("Failed to initialize diagnostics logging: {error}");
        }
    }

    diagnostics::info("startup", "Launching Hermes application");
    configure_linux_runtime_defaults();

    let builder = tauri::Builder::default()
        .setup(setup_menu)
        .on_menu_event(|app, event| {
            let menu_id = event.id().as_ref().to_string();
            diagnostics::info("runtime", format!("Menu event received: id='{menu_id}'"));
            match menu_id.as_str() {
                "theme_system" => apply_theme(app, "system"),
                "theme_light" => apply_theme(app, "light"),
                "theme_dark" => apply_theme(app, "dark"),
                "tools_help" | "help" => {
                if let Err(error) = app.emit("hla://open-help", "quick-start") {
                    diagnostics::warn("runtime", format!("Failed to emit app help-open event: {error}"));
                }
                for window in app.webview_windows().values() {
                    if let Err(error) = window.emit("hla://open-help", "quick-start") {
                        diagnostics::warn(
                            "runtime",
                            format!("Failed to emit help-open event to window: {error}"),
                        );
                    }
                    if let Err(error) = window.eval(
                        "window.dispatchEvent(new CustomEvent('hermes:open-help', { detail: 'quick-start' }));",
                    ) {
                        diagnostics::warn(
                            "runtime",
                            format!("Failed to dispatch DOM help-open event to window: {error}"),
                        );
                    }
                }
                }
                "app_exit" => app.exit(0),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            host_os,
            host_os_version,
            get_remote_settings,
            save_remote_settings,
            save_remote_profile_secret,
            clear_remote_profile_secret,
            open_external_url,
            restart_elevated,
            refresh_local_events,
            get_local_events,
            get_local_events_range,
            get_local_events_window,
            import_host_crashes,
            get_crashes,
            analyze_minidump,
            cleanup_local_duplicate_events,
            get_crash_related_events,
            get_ingest_window_days,
            set_ingest_window_days,
            get_ingest_profile,
            set_ingest_profile,
            get_llm_settings,
            set_llm_settings,
            set_llm_profile_api_key,
            clear_llm_profile_api_key,
            detect_local_llm_providers,
            list_llm_network_interfaces,
            scan_lan_llm_providers,
            test_llm_profile_connection,
            analyze_with_local_llm,
            open_path_in_shell,
            backfill_local_events,
            estimate_local_events_range,
            estimate_refresh_local_events,
            sync_local_events_range,
            sync_local_events_window,
            get_export_directory,
            choose_export_directory,
            set_export_directory,
            export_events,
            export_events_with_dialog,
            save_text_with_dialog,
            quit_app,
            set_app_theme,
            get_saved_theme
        ]);

    if let Err(error) = builder.run(tauri::generate_context!()) {
        diagnostics::error(
            "startup",
            format!("Error while running Tauri application: {error}"),
        );
        panic!("error while running tauri application: {error}");
    }
}
