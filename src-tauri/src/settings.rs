use dirs::data_local_dir;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use uuid::Uuid;

const THEME_FILE: &str = "theme.txt";
const EXPORT_DIR_FILE: &str = "export_dir.txt";
const INGEST_DAYS_FILE: &str = "ingest_window_days.txt";
const INGEST_PROFILE_FILE: &str = "ingest_profile.json";
const LLM_SETTINGS_FILE: &str = "llm_settings.json";
const REMOTE_SETTINGS_FILE: &str = "remote_settings.json";
const DEFAULT_INGEST_DAYS: u32 = 7;
const DEFAULT_MAX_EVENTS_PER_SYNC: u32 = 2000;
const MIN_MAX_EVENTS_PER_SYNC: u32 = 100;
const MAX_MAX_EVENTS_PER_SYNC: u32 = 20000;
const DEFAULT_WINDOWS_CHANNELS: [&str; 3] = ["Application", "System", "Security"];
const DEFAULT_LLM_PROFILE_PROVIDER: &str = "ollama";
const DEFAULT_LLM_PROFILE_SCOPE: &str = "local";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConnectionProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub scope: String,
    pub base_url: String,
    pub model: String,
    pub enabled: bool,
    pub api_key_configured: bool,
}

impl LlmConnectionProfile {
    fn ollama_local_default() -> Self {
        Self {
            id: "profile-ollama-local".to_string(),
            name: "Ollama Local".to_string(),
            provider: "ollama".to_string(),
            scope: "local".to_string(),
            base_url: "http://127.0.0.1:11434".to_string(),
            model: String::new(),
            enabled: true,
            api_key_configured: false,
        }
    }
}

impl Default for LlmSettings {
    fn default() -> Self {
        Self {
            allow_lan_discovery: false,
            never_send_raw_event_to_untrusted: true,
            trusted_hosts: Vec::new(),
            profiles: vec![LlmConnectionProfile::ollama_local_default()],
            default_profile_id: "profile-ollama-local".to_string(),
            backup_profile_id: String::new(),
            preferred_lan_interface_id: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettings {
    pub allow_lan_discovery: bool,
    pub never_send_raw_event_to_untrusted: bool,
    pub trusted_hosts: Vec<String>,
    pub profiles: Vec<LlmConnectionProfile>,
    pub default_profile_id: String,
    pub backup_profile_id: String,
    #[serde(default)]
    pub preferred_lan_interface_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestProfile {
    pub auto_sync_on_startup: bool,
    pub max_events_per_sync: u32,
    pub windows_channels: Vec<String>,
    #[serde(default)]
    pub request_elevation: bool,
}

impl Default for IngestProfile {
    fn default() -> Self {
        Self {
            auto_sync_on_startup: false,
            max_events_per_sync: DEFAULT_MAX_EVENTS_PER_SYNC,
            windows_channels: DEFAULT_WINDOWS_CHANNELS
                .iter()
                .map(|value| value.to_string())
                .collect(),
            request_elevation: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub os: String,
    pub protocol: String,
    pub username: String,
    #[serde(alias = "ssh_key_path")]
    pub ssh_key_path: Option<String>,
    #[serde(alias = "auth_type")]
    pub auth_type: String, // "key_only" or "password"
    #[serde(default)]
    pub provider_device_id: Option<String>,
    #[serde(default)]
    pub provider_last_resolved_name: Option<String>,
    #[serde(default)]
    pub provider_last_resolved_at: Option<String>,
    #[serde(default)]
    pub secret_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProviderAccount {
    pub id: String,
    pub provider: String,
    pub name: String,
    pub enabled: bool,
    pub base_url: String,
    #[serde(default)]
    pub tenant_id: String,
    #[serde(default)]
    pub api_token_configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSettings {
    pub profiles: Vec<RemoteConnectionProfile>,
    #[serde(default)]
    pub provider_accounts: Vec<RemoteProviderAccount>,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            provider_accounts: vec![
                RemoteProviderAccount {
                    id: "provider-jamf".to_string(),
                    provider: "jamf".to_string(),
                    name: "Jamf Pro".to_string(),
                    enabled: false,
                    base_url: String::new(),
                    tenant_id: String::new(),
                    api_token_configured: false,
                },
                RemoteProviderAccount {
                    id: "provider-intune".to_string(),
                    provider: "intune".to_string(),
                    name: "Microsoft Intune".to_string(),
                    enabled: false,
                    base_url: "https://graph.microsoft.com".to_string(),
                    tenant_id: String::new(),
                    api_token_configured: false,
                },
            ],
        }
    }
}

fn sanitize_remote_auth_type(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "password" => "password".to_string(),
        "key_only" | "key" | "" => "key".to_string(),
        _ => "key".to_string(),
    }
}

fn sanitize_remote_protocol(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "winrm" => "winrm".to_string(),
        "rpc" => "rpc".to_string(),
        "jamf" => "jamf".to_string(),
        "intune" => "intune".to_string(),
        _ => "ssh".to_string(),
    }
}

fn sanitize_remote_os(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "windows" => "windows".to_string(),
        "macos" => "macos".to_string(),
        _ => "linux".to_string(),
    }
}

fn sanitize_remote_settings(settings: RemoteSettings) -> RemoteSettings {
    let mut seen_ids = HashSet::new();
    let profiles = settings
        .profiles
        .into_iter()
        .filter_map(|mut profile| {
            let id = profile.id.trim().to_string();
            if id.is_empty() || !seen_ids.insert(id.to_ascii_lowercase()) {
                return None;
            }

            profile.id = id;
            profile.name = if profile.name.trim().is_empty() {
                "Remote Host".to_string()
            } else {
                profile.name.trim().to_string()
            };
            profile.host = profile.host.trim().to_string();
            profile.os = sanitize_remote_os(profile.os.as_str());
            profile.protocol = sanitize_remote_protocol(profile.protocol.as_str());
            profile.username = profile.username.trim().to_string();
            profile.auth_type = sanitize_remote_auth_type(profile.auth_type.as_str());
            profile.ssh_key_path = profile
                .ssh_key_path
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            profile.provider_device_id = profile
                .provider_device_id
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            profile.provider_last_resolved_name = profile
                .provider_last_resolved_name
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            profile.provider_last_resolved_at = profile
                .provider_last_resolved_at
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty());
            profile.secret_configured = false;
            Some(profile)
        })
        .collect();

    let mut seen_provider_ids = HashSet::new();
    let mut provider_accounts = settings
        .provider_accounts
        .into_iter()
        .filter_map(|mut account| {
            let normalized_provider = match account.provider.trim().to_ascii_lowercase().as_str() {
                "jamf" => "jamf".to_string(),
                "intune" => "intune".to_string(),
                _ => return None,
            };
            let id = if account.id.trim().is_empty() {
                format!("provider-{normalized_provider}")
            } else {
                account.id.trim().to_string()
            };
            if !seen_provider_ids.insert(id.to_ascii_lowercase()) {
                return None;
            }

            account.id = id;
            account.provider = normalized_provider.clone();
            account.name = if account.name.trim().is_empty() {
                match normalized_provider.as_str() {
                    "jamf" => "Jamf Pro".to_string(),
                    "intune" => "Microsoft Intune".to_string(),
                    _ => "Remote Provider".to_string(),
                }
            } else {
                account.name.trim().to_string()
            };
            account.base_url = account.base_url.trim().trim_end_matches('/').to_string();
            if normalized_provider == "intune" && account.base_url.is_empty() {
                account.base_url = "https://graph.microsoft.com".to_string();
            }
            account.tenant_id = account.tenant_id.trim().to_string();
            Some(account)
        })
        .collect::<Vec<_>>();

    for default_account in RemoteSettings::default().provider_accounts {
        if !provider_accounts
            .iter()
            .any(|account| account.provider == default_account.provider)
        {
            provider_accounts.push(default_account);
        }
    }

    provider_accounts.sort_by(|left, right| left.provider.cmp(&right.provider));

    RemoteSettings {
        profiles,
        provider_accounts,
    }
}

fn settings_dir() -> Result<PathBuf, String> {
    let mut base = data_local_dir().ok_or("Unable to resolve local data directory")?;
    base.push("hermes-log-analyst");
    fs::create_dir_all(&base).map_err(|e| format!("Failed to create settings directory: {e}"))?;
    Ok(base)
}

fn theme_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(THEME_FILE);
    Ok(dir)
}

fn export_dir_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(EXPORT_DIR_FILE);
    Ok(dir)
}

fn ingest_days_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(INGEST_DAYS_FILE);
    Ok(dir)
}

fn ingest_profile_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(INGEST_PROFILE_FILE);
    Ok(dir)
}

fn llm_settings_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(LLM_SETTINGS_FILE);
    Ok(dir)
}

fn remote_settings_path() -> Result<PathBuf, String> {
    let mut dir = settings_dir()?;
    dir.push(REMOTE_SETTINGS_FILE);
    Ok(dir)
}

pub fn save_theme(theme: &str) -> Result<(), String> {
    if theme != "system" && theme != "light" && theme != "dark" {
        return Err("Invalid theme value".to_string());
    }

    let path = theme_path()?;
    fs::write(path, theme.as_bytes()).map_err(|e| format!("Failed to save theme: {e}"))?;
    Ok(())
}

pub fn load_theme() -> Option<String> {
    let path = theme_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let value = raw.trim().to_string();
    if value == "system" || value == "light" || value == "dark" {
        Some(value)
    } else {
        None
    }
}

pub fn save_export_dir(path: Option<&str>) -> Result<(), String> {
    let storage_path = export_dir_path()?;

    match path {
        Some(value) if !value.trim().is_empty() => {
            let candidate = PathBuf::from(value.trim());
            if !candidate.exists() {
                return Err("Export directory does not exist.".to_string());
            }
            if !candidate.is_dir() {
                return Err("Export path must be a directory.".to_string());
            }
            fs::write(storage_path, candidate.to_string_lossy().as_bytes())
                .map_err(|e| format!("Failed to save export directory: {e}"))?;
        }
        _ => {
            if storage_path.exists() {
                fs::remove_file(storage_path)
                    .map_err(|e| format!("Failed to clear export directory: {e}"))?;
            }
        }
    }

    Ok(())
}

pub fn load_export_dir() -> Option<String> {
    let path = export_dir_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let value = raw.trim().to_string();
    if value.is_empty() {
        return None;
    }

    let dir = PathBuf::from(&value);
    if dir.exists() && dir.is_dir() {
        Some(value)
    } else {
        None
    }
}

pub fn save_ingest_window_days(days: u32) -> Result<(), String> {
    if days == 0 || days > 365 {
        return Err("Ingest window must be between 1 and 365 days.".to_string());
    }

    let path = ingest_days_path()?;
    fs::write(path, days.to_string().as_bytes())
        .map_err(|e| format!("Failed to save ingest window: {e}"))?;
    Ok(())
}

pub fn load_ingest_window_days() -> u32 {
    let path = ingest_days_path();
    if path.is_err() {
        return DEFAULT_INGEST_DAYS;
    }
    let Ok(path) = path else {
        return DEFAULT_INGEST_DAYS;
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return DEFAULT_INGEST_DAYS;
    };
    raw.trim()
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0 && *value <= 365)
        .unwrap_or(DEFAULT_INGEST_DAYS)
}

fn normalize_windows_channel(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "application" => Some("Application"),
        "system" => Some("System"),
        "security" => Some("Security"),
        _ => None,
    }
}

fn sanitize_ingest_profile(profile: IngestProfile) -> IngestProfile {
    let mut channels = Vec::new();
    for value in profile.windows_channels {
        if let Some(normalized) = normalize_windows_channel(value.as_str()) {
            if !channels
                .iter()
                .any(|entry: &String| entry.eq_ignore_ascii_case(normalized))
            {
                channels.push(normalized.to_string());
            }
        }
    }

    IngestProfile {
        auto_sync_on_startup: profile.auto_sync_on_startup,
        max_events_per_sync: profile
            .max_events_per_sync
            .clamp(MIN_MAX_EVENTS_PER_SYNC, MAX_MAX_EVENTS_PER_SYNC),
        windows_channels: channels,
        request_elevation: profile.request_elevation,
    }
}

pub fn load_ingest_profile() -> IngestProfile {
    let path_result = ingest_profile_path();
    if path_result.is_err() {
        return IngestProfile::default();
    }
    let path = path_result.unwrap();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return IngestProfile::default();
    };
    let Ok(parsed) = serde_json::from_str::<IngestProfile>(raw.as_str()) else {
        return IngestProfile::default();
    };
    sanitize_ingest_profile(parsed)
}

pub fn save_ingest_profile(profile: IngestProfile) -> Result<IngestProfile, String> {
    let sanitized = sanitize_ingest_profile(profile);
    let path = ingest_profile_path()?;
    let payload = serde_json::to_string_pretty(&sanitized)
        .map_err(|error| format!("Failed to serialize ingest profile: {error}"))?;
    fs::write(path, payload.as_bytes())
        .map_err(|error| format!("Failed to save ingest profile: {error}"))?;
    Ok(sanitized)
}

pub fn load_remote_settings() -> RemoteSettings {
    let path = remote_settings_path();
    if path.is_err() {
        return RemoteSettings::default();
    }
    let Ok(path) = path else {
        return RemoteSettings::default();
    };
    let Ok(raw) = fs::read_to_string(&path) else {
        return RemoteSettings::default();
    };
    let Ok(parsed) = serde_json::from_str::<RemoteSettings>(raw.as_str()) else {
        return RemoteSettings::default();
    };
    sanitize_remote_settings(parsed)
}

pub fn save_remote_settings(settings: RemoteSettings) -> Result<RemoteSettings, String> {
    let sanitized = sanitize_remote_settings(settings);
    let path = remote_settings_path()?;
    let payload = serde_json::to_string_pretty(&sanitized)
        .map_err(|error| format!("Failed to serialize remote settings: {error}"))?;
    fs::write(path, payload.as_bytes())
        .map_err(|error| format!("Failed to save remote settings: {error}"))?;
    Ok(sanitized)
}

fn sanitize_trusted_hosts(values: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut hosts = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            hosts.push(trimmed.to_string());
        }
    }
    hosts
}

fn sanitize_provider_id(value: &str) -> String {
    let key = value.trim().to_ascii_lowercase();
    match key.as_str() {
        "ollama" | "lmstudio" | "openai" | "gemini" | "claude" | "perplexity" => key,
        "openai_compatible" | "openai-compatible" | "generic" => "openai_compatible".to_string(),
        _ => DEFAULT_LLM_PROFILE_PROVIDER.to_string(),
    }
}

fn default_scope_for_provider(provider: &str) -> &'static str {
    match provider {
        "ollama" | "lmstudio" => "local",
        "openai_compatible" => "generic",
        "openai" | "gemini" | "claude" | "perplexity" => "cloud",
        _ => DEFAULT_LLM_PROFILE_SCOPE,
    }
}

fn sanitize_scope(value: &str, provider: &str) -> String {
    let scope = value.trim().to_ascii_lowercase();
    match scope.as_str() {
        "local" | "lan" | "cloud" | "generic" => scope,
        _ => default_scope_for_provider(provider).to_string(),
    }
}

fn default_base_url_for_provider(provider: &str) -> &'static str {
    match provider {
        "ollama" => "http://127.0.0.1:11434",
        "lmstudio" => "http://127.0.0.1:1234",
        "openai" => "https://api.openai.com/v1",
        "gemini" => "https://generativelanguage.googleapis.com/v1beta",
        "claude" => "https://api.anthropic.com/v1",
        "perplexity" => "https://api.perplexity.ai",
        _ => "",
    }
}

fn default_profile_name(provider: &str, scope: &str) -> String {
    let provider_name = match provider {
        "ollama" => "Ollama",
        "lmstudio" => "LM Studio",
        "openai" => "OpenAI",
        "gemini" => "Gemini",
        "claude" => "Claude",
        "perplexity" => "Perplexity",
        _ => "OpenAI-Compatible",
    };
    let scope_name = match scope {
        "local" => "Local",
        "lan" => "LAN",
        "cloud" => "Cloud",
        _ => "Generic",
    };
    format!("{provider_name} {scope_name}")
}

fn sanitize_profile(
    mut profile: LlmConnectionProfile,
    used_ids: &mut HashSet<String>,
) -> LlmConnectionProfile {
    let provider = sanitize_provider_id(profile.provider.as_str());
    let scope = sanitize_scope(profile.scope.as_str(), provider.as_str());
    let mut id = profile.id.trim().to_string();
    if id.is_empty() {
        id = format!("profile-{}", Uuid::new_v4());
    }

    let base_key = id.to_ascii_lowercase();
    let mut unique_key = base_key.clone();
    let mut suffix = 2_u32;
    while used_ids.contains(unique_key.as_str()) {
        let candidate = format!("{id}-{suffix}");
        unique_key = candidate.to_ascii_lowercase();
        id = candidate;
        suffix += 1;
    }
    used_ids.insert(unique_key);

    profile.id = id;
    profile.provider = provider;
    profile.scope = scope;
    profile.name = profile.name.trim().to_string();
    if profile.name.is_empty() {
        profile.name = default_profile_name(profile.provider.as_str(), profile.scope.as_str());
    }
    profile.base_url = profile.base_url.trim().to_string();
    if profile.base_url.is_empty() {
        profile.base_url = default_base_url_for_provider(profile.provider.as_str()).to_string();
    }
    profile.model = profile.model.trim().to_string();
    profile
}

fn profile_exists(profile_id: &str, profiles: &[LlmConnectionProfile]) -> bool {
    profiles.iter().any(|profile| profile.id == profile_id)
}

fn sanitize_llm_settings(settings: LlmSettings) -> LlmSettings {
    let mut used_ids = HashSet::new();
    let mut profiles = settings
        .profiles
        .into_iter()
        .map(|profile| sanitize_profile(profile, &mut used_ids))
        .collect::<Vec<_>>();
    if profiles.is_empty() {
        profiles.push(LlmConnectionProfile::ollama_local_default());
    }

    let fallback_default_id = profiles[0].id.clone();
    let default_profile_id =
        if profile_exists(settings.default_profile_id.trim(), profiles.as_slice()) {
            settings.default_profile_id.trim().to_string()
        } else {
            fallback_default_id
        };

    let backup_candidate = settings.backup_profile_id.trim();
    let backup_profile_id =
        if backup_candidate.is_empty() || backup_candidate == default_profile_id.as_str() {
            String::new()
        } else if profile_exists(backup_candidate, profiles.as_slice()) {
            backup_candidate.to_string()
        } else {
            String::new()
        };

    LlmSettings {
        allow_lan_discovery: settings.allow_lan_discovery,
        never_send_raw_event_to_untrusted: settings.never_send_raw_event_to_untrusted,
        trusted_hosts: sanitize_trusted_hosts(settings.trusted_hosts),
        profiles,
        default_profile_id,
        backup_profile_id,
        preferred_lan_interface_id: settings.preferred_lan_interface_id.trim().to_string(),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLlmProviderSettings {
    enabled: bool,
    base_url: String,
    api_key: String,
    model: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyLlmSettings {
    preferred_provider: String,
    allow_lan_discovery: bool,
    never_send_raw_event_to_untrusted: bool,
    trusted_hosts: Vec<String>,
    ollama: LegacyLlmProviderSettings,
    lmstudio: LegacyLlmProviderSettings,
    openai: LegacyLlmProviderSettings,
    gemini: LegacyLlmProviderSettings,
    claude: LegacyLlmProviderSettings,
    perplexity: LegacyLlmProviderSettings,
    openai_compatible: LegacyLlmProviderSettings,
}

#[derive(Debug, Clone)]
pub struct LlmApiKeyMigration {
    pub profile_id: String,
    pub api_key: String,
}

#[derive(Debug, Clone)]
pub struct LlmSettingsLoadResult {
    pub settings: LlmSettings,
    pub migrated_api_keys: Vec<LlmApiKeyMigration>,
    pub migrated_from_legacy: bool,
}

fn legacy_profile(
    provider: &str,
    name: &str,
    scope: &str,
    legacy: LegacyLlmProviderSettings,
) -> Option<(LlmConnectionProfile, Option<LlmApiKeyMigration>)> {
    let base_url = legacy.base_url.trim().to_string();
    let model = legacy.model.trim().to_string();
    let api_key = legacy.api_key.trim().to_string();
    let include = legacy.enabled
        || !base_url.is_empty()
        || !model.is_empty()
        || !api_key.is_empty()
        || provider == "ollama";
    if !include {
        return None;
    }

    let id = format!("profile-{provider}-{scope}");
    let profile = LlmConnectionProfile {
        id: id.clone(),
        name: name.to_string(),
        provider: provider.to_string(),
        scope: scope.to_string(),
        base_url,
        model,
        enabled: legacy.enabled,
        api_key_configured: !api_key.is_empty(),
    };
    let migration = if api_key.is_empty() {
        None
    } else {
        Some(LlmApiKeyMigration {
            profile_id: id,
            api_key,
        })
    };

    Some((profile, migration))
}

fn load_legacy_llm_settings(raw: &str) -> Option<LlmSettingsLoadResult> {
    let parsed = serde_json::from_str::<LegacyLlmSettings>(raw).ok()?;
    let mut profiles = Vec::new();
    let mut migrated_api_keys = Vec::new();

    let candidates = [
        legacy_profile("ollama", "Ollama Local", "local", parsed.ollama),
        legacy_profile("lmstudio", "LM Studio Local", "local", parsed.lmstudio),
        legacy_profile("openai", "OpenAI Cloud", "cloud", parsed.openai),
        legacy_profile("gemini", "Gemini Cloud", "cloud", parsed.gemini),
        legacy_profile("claude", "Claude Cloud", "cloud", parsed.claude),
        legacy_profile("perplexity", "Perplexity Cloud", "cloud", parsed.perplexity),
        legacy_profile(
            "openai_compatible",
            "OpenAI-Compatible Generic",
            "generic",
            parsed.openai_compatible,
        ),
    ];

    for candidate in candidates {
        let Some((profile, migration)) = candidate else {
            continue;
        };
        profiles.push(profile);
        if let Some(secret) = migration {
            migrated_api_keys.push(secret);
        }
    }

    if profiles.is_empty() {
        profiles.push(LlmConnectionProfile::ollama_local_default());
    }

    let preferred_provider = sanitize_provider_id(parsed.preferred_provider.as_str());
    let default_profile_id = profiles
        .iter()
        .find(|profile| profile.provider == preferred_provider)
        .map(|profile| profile.id.clone())
        .unwrap_or_else(|| profiles[0].id.clone());

    let settings = sanitize_llm_settings(LlmSettings {
        allow_lan_discovery: parsed.allow_lan_discovery,
        never_send_raw_event_to_untrusted: parsed.never_send_raw_event_to_untrusted,
        trusted_hosts: parsed.trusted_hosts,
        profiles,
        default_profile_id,
        backup_profile_id: String::new(),
        preferred_lan_interface_id: String::new(),
    });

    Some(LlmSettingsLoadResult {
        settings,
        migrated_api_keys,
        migrated_from_legacy: true,
    })
}

pub fn load_llm_settings_with_migration() -> LlmSettingsLoadResult {
    let Ok(path) = llm_settings_path() else {
        return LlmSettingsLoadResult {
            settings: LlmSettings::default(),
            migrated_api_keys: Vec::new(),
            migrated_from_legacy: false,
        };
    };
    let Ok(raw) = fs::read_to_string(path) else {
        return LlmSettingsLoadResult {
            settings: LlmSettings::default(),
            migrated_api_keys: Vec::new(),
            migrated_from_legacy: false,
        };
    };
    if let Ok(parsed) = serde_json::from_str::<LlmSettings>(raw.as_str()) {
        return LlmSettingsLoadResult {
            settings: sanitize_llm_settings(parsed),
            migrated_api_keys: Vec::new(),
            migrated_from_legacy: false,
        };
    }
    load_legacy_llm_settings(raw.as_str()).unwrap_or(LlmSettingsLoadResult {
        settings: LlmSettings::default(),
        migrated_api_keys: Vec::new(),
        migrated_from_legacy: false,
    })
}

pub fn save_llm_settings(settings: LlmSettings) -> Result<LlmSettings, String> {
    let sanitized = sanitize_llm_settings(settings);
    let path = llm_settings_path()?;
    let payload = serde_json::to_string_pretty(&sanitized)
        .map_err(|error| format!("Failed to serialize LLM settings: {error}"))?;
    fs::write(path, payload.as_bytes())
        .map_err(|error| format!("Failed to save LLM settings: {error}"))?;
    Ok(sanitized)
}

const REMOTE_HOST_KEYCHAIN_SERVICE: &str = "hermes-log-analyst-remote-hosts";
const REMOTE_PROVIDER_KEYCHAIN_SERVICE: &str = "hermes-log-analyst-remote-providers";

pub fn set_remote_profile_secret(profile_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(REMOTE_HOST_KEYCHAIN_SERVICE, profile_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    entry
        .set_password(secret)
        .map_err(|error| format!("Unable to save secret in OS keychain: {error}"))
}

pub fn clear_remote_profile_secret(profile_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(REMOTE_HOST_KEYCHAIN_SERVICE, profile_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Unable to clear secret from OS keychain: {error}")),
    }
}

pub fn get_remote_profile_secret(profile_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(REMOTE_HOST_KEYCHAIN_SERVICE, profile_id)
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
        Err(error) => Err(format!("Unable to read secret from OS keychain: {error}")),
    }
}

pub fn set_remote_provider_secret(provider_id: &str, secret: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(REMOTE_PROVIDER_KEYCHAIN_SERVICE, provider_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    entry
        .set_password(secret)
        .map_err(|error| format!("Unable to save secret in OS keychain: {error}"))
}

pub fn clear_remote_provider_secret(provider_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(REMOTE_PROVIDER_KEYCHAIN_SERVICE, provider_id)
        .map_err(|error| format!("Unable to open OS keychain entry: {error}"))?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Unable to clear secret from OS keychain: {error}")),
    }
}

pub fn get_remote_provider_secret(provider_id: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(REMOTE_PROVIDER_KEYCHAIN_SERVICE, provider_id)
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
        Err(error) => Err(format!("Unable to read secret from OS keychain: {error}")),
    }
}
