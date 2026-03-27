use crate::logs::NormalizedEvent;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
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
    pub source_host: String,
    pub imported: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinidumpAnalysisResult {
    pub ok: bool,
    pub crash_id: String,
    pub crash_type: String,
    pub source: String,
    pub dump_path: Option<String>,
    pub dump_exists: bool,
    pub dump_kind: String,
    pub dump_size_bytes: Option<u64>,
    pub dump_modified_at: Option<String>,
    pub header_signature: Option<String>,
    pub header_version: Option<String>,
    pub header_stream_count: Option<u32>,
    pub header_timestamp: Option<String>,
    pub bugcheck_code: Option<String>,
    pub bugcheck_parameters: Vec<String>,
    pub suspected_module: Option<String>,
    pub likely_cause_category: String,
    pub confidence: u8,
    pub summary: String,
    pub crash_details: Vec<String>,
    pub likely_cause: String,
    pub verify_first: Vec<String>,
    pub escalate_if: Vec<String>,
    pub warnings: Vec<String>,
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone)]
struct DumpHeaderInfo {
    signature: String,
    version: String,
    stream_count: u32,
    timestamp: Option<String>,
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
        source_host: &str,
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
            source_host: source_host.to_string(),
            imported,
        }
    }
}

pub fn analyze_windows_minidump(
    crash: &CrashRecord,
    related_events: &[NormalizedEvent],
) -> Result<MinidumpAnalysisResult, String> {
    let dump_kind = if crash.source.eq_ignore_ascii_case("KernelDump")
        || crash.crash_type.eq_ignore_ascii_case("Kernel Memory Dump")
    {
        "kernel_dump".to_string()
    } else if crash.source.eq_ignore_ascii_case("Minidump")
        || crash.crash_type.eq_ignore_ascii_case("Minidump")
    {
        "minidump".to_string()
    } else {
        "unsupported".to_string()
    };

    if !crash.os.eq_ignore_ascii_case("windows") || dump_kind == "unsupported" {
        return Ok(unavailable_minidump_analysis(
            crash,
            dump_kind,
            "Selected crash is not a supported Windows dump-backed crash.".to_string(),
        ));
    }

    let Some(raw_path) = crash.raw_path.as_ref() else {
        return Ok(unavailable_minidump_analysis(
            crash,
            dump_kind,
            "Crash record does not include a dump file path.".to_string(),
        ));
    };

    let path = PathBuf::from(raw_path);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Ok(unavailable_minidump_analysis(
                crash,
                dump_kind,
                format!("Dump file is unavailable: {error}"),
            ))
        }
    };

    let mut warnings = Vec::new();
    let header = match read_dump_header(path.as_path()) {
        Ok(info) => Some(info),
        Err(error) => {
            warnings.push(error);
            None
        }
    };

    let bugcheck_code = crash
        .code
        .clone()
        .or_else(|| infer_bugcheck_code(related_events));
    let bugcheck_parameters = infer_bugcheck_parameters(related_events);
    let suspected_module = crash
        .suspected_component
        .clone()
        .or_else(|| infer_suspected_module(related_events));
    let likely_cause_category =
        infer_likely_cause_category(bugcheck_code.as_deref(), suspected_module.as_deref(), related_events);
    let likely_cause = build_likely_cause_text(
        likely_cause_category.as_str(),
        suspected_module.as_deref(),
        bugcheck_code.as_deref(),
        related_events,
    );
    let confidence = estimate_confidence(
        bugcheck_code.as_deref(),
        suspected_module.as_deref(),
        header.is_some(),
        related_events,
    );
    let dump_modified_at = metadata.modified().ok().map(system_time_to_rfc3339);
    let header_timestamp = header.as_ref().and_then(|info| info.timestamp.clone());
    let summary = build_minidump_summary(
        crash,
        dump_kind.as_str(),
        bugcheck_code.as_deref(),
        suspected_module.as_deref(),
        likely_cause_category.as_str(),
        related_events.len(),
    );
    let crash_details = build_crash_details(
        crash,
        raw_path,
        dump_kind.as_str(),
        metadata.len(),
        dump_modified_at.as_deref(),
        header.as_ref(),
        bugcheck_code.as_deref(),
        bugcheck_parameters.as_slice(),
    );
    let verify_first = build_verify_first(
        likely_cause_category.as_str(),
        suspected_module.as_deref(),
        bugcheck_code.as_deref(),
        raw_path,
    );
    let escalate_if = build_escalate_if(
        likely_cause_category.as_str(),
        bugcheck_code.as_deref(),
        suspected_module.as_deref(),
    );

    Ok(MinidumpAnalysisResult {
        ok: true,
        crash_id: crash.id.clone(),
        crash_type: crash.crash_type.clone(),
        source: crash.source.clone(),
        dump_path: Some(raw_path.clone()),
        dump_exists: true,
        dump_kind,
        dump_size_bytes: Some(metadata.len()),
        dump_modified_at,
        header_signature: header.as_ref().map(|info| info.signature.clone()),
        header_version: header.as_ref().map(|info| info.version.clone()),
        header_stream_count: header.as_ref().map(|info| info.stream_count),
        header_timestamp,
        bugcheck_code,
        bugcheck_parameters,
        suspected_module,
        likely_cause_category,
        confidence,
        summary,
        crash_details,
        likely_cause,
        verify_first,
        escalate_if,
        warnings,
        unavailable_reason: None,
    })
}

fn unavailable_minidump_analysis(
    crash: &CrashRecord,
    dump_kind: String,
    reason: String,
) -> MinidumpAnalysisResult {
    MinidumpAnalysisResult {
        ok: false,
        crash_id: crash.id.clone(),
        crash_type: crash.crash_type.clone(),
        source: crash.source.clone(),
        dump_path: crash.raw_path.clone(),
        dump_exists: false,
        dump_kind,
        dump_size_bytes: None,
        dump_modified_at: None,
        header_signature: None,
        header_version: None,
        header_stream_count: None,
        header_timestamp: None,
        bugcheck_code: crash.code.clone(),
        bugcheck_parameters: Vec::new(),
        suspected_module: crash.suspected_component.clone(),
        likely_cause_category: "unknown".to_string(),
        confidence: 10,
        summary: "Minidump analysis is unavailable for the selected crash.".to_string(),
        crash_details: vec![
            format!("Crash type: {}", crash.crash_type),
            format!("Source: {}", crash.source),
            format!("Timestamp: {}", crash.timestamp),
        ],
        likely_cause: "Hermes could not inspect the dump artifact, so only crash metadata is available.".to_string(),
        verify_first: vec![
            "Confirm the dump path still exists and is readable on the local machine.".to_string(),
            "Load related pre-crash logs to recover supporting context.".to_string(),
        ],
        escalate_if: vec![
            "The system continues to crash and the dump file cannot be accessed.".to_string(),
            "Support needs kernel-level evidence that Hermes cannot recover from metadata alone.".to_string(),
        ],
        warnings: Vec::new(),
        unavailable_reason: Some(reason),
    }
}

fn read_dump_header(path: &Path) -> Result<DumpHeaderInfo, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("Failed to open dump header: {error}"))?;
    let mut buffer = [0u8; 32];
    use std::io::Read;
    file.read_exact(&mut buffer)
        .map_err(|error| format!("Failed to read dump header: {error}"))?;

    let signature = String::from_utf8_lossy(&buffer[0..4]).to_string();
    if signature != "MDMP" {
        return Err("Dump header signature is not MDMP; treating file as metadata-only.".to_string());
    }

    let version = u32::from_le_bytes(buffer[4..8].try_into().unwrap_or([0; 4]));
    let stream_count = u32::from_le_bytes(buffer[8..12].try_into().unwrap_or([0; 4]));
    let timestamp_raw = u32::from_le_bytes(buffer[20..24].try_into().unwrap_or([0; 4]));
    let timestamp = if timestamp_raw == 0 {
        None
    } else {
        DateTime::<Utc>::from_timestamp(timestamp_raw as i64, 0).map(|value| value.to_rfc3339())
    };

    Ok(DumpHeaderInfo {
        signature,
        version: format!("0x{version:08X}"),
        stream_count,
        timestamp,
    })
}

fn infer_bugcheck_code(events: &[NormalizedEvent]) -> Option<String> {
    for event in events {
        let lower = event.message.to_ascii_lowercase();
        if lower.contains("bugcheck") || lower.contains("stop code") {
            if let Some(code) = first_hex_token(event.message.as_str()) {
                return Some(code);
            }
        }
    }
    None
}

fn infer_bugcheck_parameters(events: &[NormalizedEvent]) -> Vec<String> {
    for event in events {
        let lower = event.message.to_ascii_lowercase();
        if !(lower.contains("bugcheck") || lower.contains("parameter")) {
            continue;
        }
        let tokens = collect_hex_tokens(event.message.as_str(), 4);
        if !tokens.is_empty() {
            return tokens;
        }
    }
    Vec::new()
}

fn infer_suspected_module(events: &[NormalizedEvent]) -> Option<String> {
    for event in events {
        if let Some(module) = extract_module_candidate(event.message.as_str()) {
            return Some(module);
        }
    }
    None
}

fn extract_module_candidate(message: &str) -> Option<String> {
    for token in message.split(|ch: char| ch.is_whitespace() || matches!(ch, ',' | ';' | '(' | ')' | '[' | ']' | '"' | '\'')) {
        let trimmed = token.trim_matches(|ch: char| matches!(ch, '.' | ':' | '\\' | '/'));
        let lower = trimmed.to_ascii_lowercase();
        if lower.ends_with(".sys") || lower.ends_with(".dll") || lower.ends_with(".exe") {
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn infer_likely_cause_category(
    bugcheck_code: Option<&str>,
    suspected_module: Option<&str>,
    events: &[NormalizedEvent],
) -> String {
    let module_lower = suspected_module.unwrap_or_default().to_ascii_lowercase();
    if module_lower.contains("stor") || module_lower.contains("nvme") || module_lower.contains("disk") {
        return "storage".to_string();
    }
    if module_lower.contains("nvlddmkm")
        || module_lower.contains("amdkmdag")
        || module_lower.contains("igdkmd")
        || module_lower.contains("intel")
    {
        return "driver".to_string();
    }
    if module_lower.contains("crowdstrike")
        || module_lower.contains("sentinel")
        || module_lower.contains("defender")
        || module_lower.contains("edr")
    {
        return "security software".to_string();
    }

    let code_lower = bugcheck_code.unwrap_or_default().to_ascii_lowercase();
    if code_lower.contains("0x1a") || code_lower.contains("memory_management") {
        return "memory".to_string();
    }
    if code_lower.contains("0x7a") || code_lower.contains("0x7b") || code_lower.contains("0xf4") {
        return "storage".to_string();
    }

    for event in events {
        let lower = format!("{} {}", event.provider, event.message).to_ascii_lowercase();
        if lower.contains("disk") || lower.contains("storport") || lower.contains("ntfs") || lower.contains("nvme") {
            return "storage".to_string();
        }
        if lower.contains("memory") || lower.contains("ram") || lower.contains("pagefile") {
            return "memory".to_string();
        }
        if lower.contains("firmware") || lower.contains("acpi") || lower.contains("bios") || lower.contains("pluton") {
            return "firmware".to_string();
        }
        if lower.contains("driver") || lower.contains(".sys") || lower.contains("wudfrd") {
            return "driver".to_string();
        }
        if lower.contains("defender") || lower.contains("endpoint") || lower.contains("security") {
            return "security software".to_string();
        }
    }

    "unknown".to_string()
}

fn build_likely_cause_text(
    category: &str,
    suspected_module: Option<&str>,
    bugcheck_code: Option<&str>,
    events: &[NormalizedEvent],
) -> String {
    let module_text = suspected_module
        .map(|value| format!(" Possible suspect module: {value}."))
        .unwrap_or_default();
    let code_text = bugcheck_code
        .map(|value| format!(" Observed bugcheck code: {value}."))
        .unwrap_or_default();
    let context_text = if events.is_empty() {
        " No related event evidence is currently loaded.".to_string()
    } else {
        format!(" Hermes correlated {} nearby event(s) for context.", events.len())
    };

    format!(
        "Likely cause category: {}.{}{}{}",
        title_case_label(category),
        code_text,
        module_text,
        context_text
    )
}

fn estimate_confidence(
    bugcheck_code: Option<&str>,
    suspected_module: Option<&str>,
    has_header: bool,
    events: &[NormalizedEvent],
) -> u8 {
    let mut confidence = 30u8;
    if bugcheck_code.is_some() {
        confidence = confidence.saturating_add(20);
    }
    if suspected_module.is_some() {
        confidence = confidence.saturating_add(20);
    }
    if has_header {
        confidence = confidence.saturating_add(10);
    }
    if !events.is_empty() {
        confidence = confidence.saturating_add(15);
    }
    confidence.min(95)
}

fn build_minidump_summary(
    crash: &CrashRecord,
    dump_kind: &str,
    bugcheck_code: Option<&str>,
    suspected_module: Option<&str>,
    likely_cause_category: &str,
    related_count: usize,
) -> String {
    let dump_label = if dump_kind == "kernel_dump" {
        "kernel dump"
    } else {
        "minidump"
    };
    let code_text = bugcheck_code.unwrap_or("not recovered");
    let module_text = suspected_module.unwrap_or("no specific module identified");
    format!(
        "Hermes found a Windows {dump_label} for the selected crash. Bugcheck code: {code_text}. Likely cause category: {}. Suspect: {module_text}. Related evidence count: {related_count}. Crash summary: {}.",
        title_case_label(likely_cause_category),
        crash.summary
    )
}

fn build_crash_details(
    crash: &CrashRecord,
    raw_path: &str,
    dump_kind: &str,
    dump_size: u64,
    dump_modified_at: Option<&str>,
    header: Option<&DumpHeaderInfo>,
    bugcheck_code: Option<&str>,
    bugcheck_parameters: &[String],
) -> Vec<String> {
    let mut details = vec![
        format!("Crash timestamp: {}", crash.timestamp),
        format!("Crash type: {}", crash.crash_type),
        format!("Dump kind: {}", title_case_label(dump_kind)),
        format!("Dump path: {raw_path}"),
        format!("Dump size: {} bytes", dump_size),
    ];
    if let Some(value) = dump_modified_at {
        details.push(format!("Dump modified: {value}"));
    }
    if let Some(value) = bugcheck_code {
        details.push(format!("Bugcheck code: {value}"));
    }
    if !bugcheck_parameters.is_empty() {
        details.push(format!("Bugcheck parameters: {}", bugcheck_parameters.join(", ")));
    }
    if let Some(info) = header {
        details.push(format!("Header signature: {}", info.signature));
        details.push(format!("Header version: {}", info.version));
        details.push(format!("Header stream count: {}", info.stream_count));
        if let Some(value) = &info.timestamp {
            details.push(format!("Header timestamp: {value}"));
        }
    }
    details
}

fn build_verify_first(
    category: &str,
    suspected_module: Option<&str>,
    bugcheck_code: Option<&str>,
    _raw_path: &str,
) -> Vec<String> {
    let mut steps = vec![
        "If Hermes already loaded pre-crash evidence, review the strongest warning/error events there first. Only fall back to System/WER crash logs if the needed event IDs are not yet loaded in Hermes.".to_string(),
    ];
    if let Some(value) = bugcheck_code {
        steps.push(format!("Search internal KB/vendor guidance for bugcheck code {value} before making changes."));
    }
    if let Some(value) = suspected_module {
        steps.push(format!("Verify the file version, signer, and recent update or rollout history for suspected module/driver '{value}' before making changes."));
    } else if category == "storage" {
        steps.push("Check disk/NVMe/NTFS controller health and firmware before replacing software.".to_string());
    } else if category == "memory" {
        steps.push("Run safe memory diagnostics and confirm recent BIOS/XMP/overclock changes.".to_string());
    } else if category == "security software" {
        steps.push("Check recent EDR/AV updates, policy changes, or driver components loaded at boot.".to_string());
    }
    steps
}

fn build_escalate_if(
    category: &str,
    bugcheck_code: Option<&str>,
    suspected_module: Option<&str>,
) -> Vec<String> {
    let mut items = vec![
        "The system is repeatedly crashing after version, signer, and recent update-history verification for the suspected driver path.".to_string(),
        "Support needs WinDbg or other symbol-backed stack analysis to confirm whether the failure stays within the current working hypothesis.".to_string(),
    ];
    if let Some(value) = suspected_module {
        items.push(format!("The suspected module '{value}' belongs to a critical platform, storage, or security component."));
    }
    if let Some(value) = bugcheck_code {
        items.push(format!("Bugcheck {value} maps to known data-loss, memory-corruption, or storage-integrity risk."));
    }
    if category == "firmware" {
        items.push("Firmware or BIOS evidence points to platform instability that requires engineering validation.".to_string());
    }
    items
}

fn first_hex_token(input: &str) -> Option<String> {
    collect_hex_tokens(input, 1).into_iter().next()
}

fn collect_hex_tokens(input: &str, limit: usize) -> Vec<String> {
    let mut tokens = Vec::new();
    for raw in input.split(|ch: char| !ch.is_ascii_hexdigit() && ch != 'x' && ch != 'X') {
        let trimmed = raw.trim();
        if trimmed.len() < 3 {
            continue;
        }
        let candidate = if trimmed.starts_with("0x") || trimmed.starts_with("0X") {
            trimmed.to_string()
        } else if trimmed.chars().all(|ch| ch.is_ascii_hexdigit()) && trimmed.len() >= 4 {
            format!("0x{trimmed}")
        } else {
            continue;
        };
        if !tokens.contains(&candidate) {
            tokens.push(candidate);
        }
        if tokens.len() >= limit {
            break;
        }
    }
    tokens
}

fn title_case_label(value: &str) -> String {
    value
        .split(['_', '-', ' '])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_ascii_uppercase(), chars.as_str()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn import_host_crashes(limit: usize) -> Result<Vec<CrashRecord>, String> {
    let capped = limit.clamp(1, 2000);

    #[cfg(target_os = "windows")]
    {
        return Ok(import_windows_crashes(capped));
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(import_macos_crashes(capped));
    }

    #[cfg(target_os = "linux")]
    {
        return Ok(import_linux_crashes(capped));
    }

    #[allow(unreachable_code)]
    Ok(Vec::new())
}

fn build_imported_crash(
    os: &str,
    source: &str,
    crash_type: &str,
    code: Option<&str>,
    summary: &str,
    suspected_component: Option<&str>,
    raw_path: Option<&Path>,
    timestamp: String,
) -> CrashRecord {
    let raw_path_value = raw_path.map(|path| path.to_string_lossy().to_string());
    let seed = format!(
        "{os}|{source}|{crash_type}|{}",
        raw_path_value.as_deref().unwrap_or(summary)
    );

    let mut crash = CrashRecord::new(
        os,
        source,
        crash_type,
        code,
        summary,
        suspected_component,
        raw_path_value.as_deref(),
        "localhost",
        true,
    );
    crash.id = stable_id(seed.as_str());
    crash.timestamp = timestamp;
    crash
}

fn stable_id(seed: &str) -> String {
    let mut hasher = DefaultHasher::new();
    seed.hash(&mut hasher);
    format!("imported-{:016x}", hasher.finish())
}

fn file_timestamp(path: &Path) -> String {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(system_time_to_rfc3339)
        .unwrap_or_else(|_| Utc::now().to_rfc3339())
}

fn system_time_to_rfc3339(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339()
}

fn scan_files<F>(roots: &[PathBuf], matcher: F, max_scan: usize) -> Vec<PathBuf>
where
    F: Fn(&Path) -> bool,
{
    let mut stack = roots.to_vec();
    let mut matches: Vec<(PathBuf, SystemTime)> = Vec::new();

    while let Some(path) = stack.pop() {
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };

        if meta.is_dir() {
            let Ok(entries) = fs::read_dir(&path) else {
                continue;
            };
            for entry in entries.flatten() {
                stack.push(entry.path());
            }
            continue;
        }

        if !meta.is_file() || !matcher(&path) {
            continue;
        }

        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        matches.push((path, modified));
    }

    matches.sort_by(|left, right| right.1.cmp(&left.1));
    matches.truncate(max_scan);
    matches.into_iter().map(|entry| entry.0).collect()
}

fn read_lines_limited(path: &Path, max_lines: usize, max_bytes: usize) -> Vec<String> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);

    let mut lines = Vec::new();
    let mut seen = 0usize;
    for line in reader.lines().take(max_lines) {
        let Ok(line) = line else {
            continue;
        };
        seen += line.len();
        lines.push(line);
        if seen >= max_bytes {
            break;
        }
    }
    lines
}

fn trim_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string()
}

fn basename(path: &str) -> Option<&str> {
    Path::new(path).file_name().and_then(|name| name.to_str())
}

fn dedupe_and_limit(mut crashes: Vec<CrashRecord>, limit: usize) -> Vec<CrashRecord> {
    let mut seen = HashSet::new();
    crashes.retain(|crash| seen.insert(crash.id.clone()));
    crashes.sort_by(|left, right| right.timestamp.cmp(&left.timestamp));
    crashes.truncate(limit);
    crashes
}

#[cfg(target_os = "windows")]
fn import_windows_crashes(limit: usize) -> Vec<CrashRecord> {
    let mut crashes = Vec::new();

    let mut wer_roots = vec![
        PathBuf::from(r"C:\ProgramData\Microsoft\Windows\WER\ReportArchive"),
        PathBuf::from(r"C:\ProgramData\Microsoft\Windows\WER\ReportQueue"),
    ];
    if let Some(program_data) = std::env::var_os("ProgramData") {
        let base = PathBuf::from(program_data).join("Microsoft").join("Windows").join("WER");
        wer_roots.push(base.join("ReportArchive"));
        wer_roots.push(base.join("ReportQueue"));
    }

    let wer_files = scan_files(
        &wer_roots,
        |path| path.extension().and_then(|ext| ext.to_str()).map(|ext| ext.eq_ignore_ascii_case("wer")).unwrap_or(false),
        limit.saturating_mul(4),
    );
    for file in wer_files {
        crashes.push(parse_windows_wer(file.as_path()));
    }

    let dump_files = scan_files(
        &[PathBuf::from(r"C:\Windows\Minidump"), PathBuf::from(r"C:\Windows")],
        |path| {
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
            name.eq_ignore_ascii_case("MEMORY.DMP")
                || path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("dmp"))
                    .unwrap_or(false)
        },
        limit.saturating_mul(4),
    );
    for file in dump_files {
        crashes.push(parse_windows_dump(file.as_path()));
    }

    dedupe_and_limit(crashes, limit)
}

#[cfg(target_os = "windows")]
fn parse_windows_wer(path: &Path) -> CrashRecord {
    let mut fields = HashMap::new();
    for line in read_lines_limited(path, 600, 512 * 1024) {
        if let Some((key, value)) = line.split_once('=') {
            fields.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    let crash_type = pick_map_value(
        &fields,
        &["FriendlyEventName", "ProblemType", "Sig[0].Value", "EventType"],
    )
    .unwrap_or("Crash Report");
    let code = pick_map_value(
        &fields,
        &["BugcheckCode", "ExceptionCode", "Sig[8].Value", "Sig[9].Value", "Sig[1].Value"],
    );
    let app = pick_map_value(&fields, &["AppName", "FaultModuleName", "Fault Module Name", "AppPath"]);
    let summary = match (app, pick_map_value(&fields, &["Description", "ProblemSignatures"])) {
        (Some(app), _) => format!("{crash_type}: {app}"),
        (None, Some(desc)) => format!("{crash_type}: {desc}"),
        _ => format!("{crash_type}: {}", trim_file_name(path)),
    };

    build_imported_crash(
        "windows",
        "WER",
        crash_type,
        code,
        summary.as_str(),
        app.and_then(basename).or(app),
        Some(path),
        file_timestamp(path),
    )
}

#[cfg(target_os = "windows")]
fn parse_windows_dump(path: &Path) -> CrashRecord {
    let file_name = trim_file_name(path);
    let is_kernel = file_name.eq_ignore_ascii_case("MEMORY.DMP");
    let crash_type = if is_kernel { "Kernel Memory Dump" } else { "Minidump" };
    let summary = format!("{crash_type}: {file_name}");
    build_imported_crash(
        "windows",
        if is_kernel { "KernelDump" } else { "Minidump" },
        crash_type,
        None,
        summary.as_str(),
        None,
        Some(path),
        file_timestamp(path),
    )
}

#[cfg(target_os = "macos")]
fn import_macos_crashes(limit: usize) -> Vec<CrashRecord> {
    let mut roots = vec![PathBuf::from("/Library/Logs/DiagnosticReports")];
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Library").join("Logs").join("DiagnosticReports"));
    }

    let files = scan_files(
        &roots,
        |path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "crash" | "panic" | "ips"))
                .unwrap_or(false)
        },
        limit.saturating_mul(4),
    );

    let crashes = files
        .into_iter()
        .map(|path| parse_macos_report(path.as_path()))
        .collect::<Vec<_>>();
    dedupe_and_limit(crashes, limit)
}

#[cfg(target_os = "macos")]
fn parse_macos_report(path: &Path) -> CrashRecord {
    let lines = read_lines_limited(path, 300, 256 * 1024);
    let process = find_prefixed_value(&lines, &["Process:", "Path:", "Identifier:"]);
    let exception = find_prefixed_value(&lines, &["Exception Type:", "panicString:", "Exception Codes:"]);

    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let crash_type = match extension.as_str() {
        "panic" => "Kernel Panic",
        "ips" => "Crash Report",
        _ => "Application Crash",
    };
    let summary = if let Some(process) = process {
        format!("{crash_type}: {process}")
    } else {
        format!("{crash_type}: {}", trim_file_name(path))
    };

    build_imported_crash(
        "macos",
        "DiagnosticReports",
        crash_type,
        exception,
        summary.as_str(),
        process.and_then(basename).or(process),
        Some(path),
        file_timestamp(path),
    )
}

#[cfg(target_os = "linux")]
fn import_linux_crashes(limit: usize) -> Vec<CrashRecord> {
    let roots = vec![PathBuf::from("/var/crash"), PathBuf::from("/var/lib/systemd/coredump")];
    let files = scan_files(
        &roots,
        |path| {
            let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default();
            let name = path.file_name().and_then(|value| value.to_str()).unwrap_or_default();
            ext.eq_ignore_ascii_case("crash")
                || ext.eq_ignore_ascii_case("dmp")
                || name.starts_with("core")
        },
        limit.saturating_mul(4),
    );

    let crashes = files
        .into_iter()
        .map(|path| parse_linux_report(path.as_path()))
        .collect::<Vec<_>>();
    dedupe_and_limit(crashes, limit)
}

#[cfg(target_os = "linux")]
fn parse_linux_report(path: &Path) -> CrashRecord {
    let ext = path.extension().and_then(|value| value.to_str()).unwrap_or_default();

    if ext.eq_ignore_ascii_case("crash") {
        let mut fields = HashMap::new();
        for line in read_lines_limited(path, 400, 256 * 1024) {
            if let Some((key, value)) = line.split_once(':') {
                fields.insert(key.trim().to_string(), value.trim().to_string());
            }
        }

        let crash_type = pick_map_value(&fields, &["ProblemType"]).unwrap_or("Crash");
        let code = pick_map_value(&fields, &["Signal", "SignalName", "CrashCounter"]);
        let executable = pick_map_value(&fields, &["ExecutablePath", "ProcCmdline"]);
        let summary = pick_map_value(&fields, &["Title"])
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                if let Some(exec) = executable {
                    format!("{crash_type}: {}", basename(exec).unwrap_or(exec))
                } else {
                    format!("{crash_type}: {}", trim_file_name(path))
                }
            });

        return build_imported_crash(
            "linux",
            "apport",
            crash_type,
            code,
            summary.as_str(),
            executable.and_then(basename).or(executable),
            Some(path),
            file_timestamp(path),
        );
    }

    let file_name = trim_file_name(path);
    let guessed_process = file_name.split('.').nth(1);
    build_imported_crash(
        "linux",
        "systemd-coredump",
        "Core Dump",
        None,
        format!("Core dump: {file_name}").as_str(),
        guessed_process,
        Some(path),
        file_timestamp(path),
    )
}

fn pick_map_value<'a>(map: &'a HashMap<String, String>, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(value) = map.get(*key) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn find_prefixed_value<'a>(lines: &'a [String], prefixes: &[&str]) -> Option<&'a str> {
    for line in lines {
        for prefix in prefixes {
            if let Some(value) = line.strip_prefix(prefix) {
                let value = value.trim();
                if !value.is_empty() {
                    return Some(value);
                }
            }
        }
    }
    None
}

/// Infer signal from Linux log events (e.g., SIGSEGV, SIGABRT)
fn infer_signal_from_events(events: &[NormalizedEvent]) -> Option<String> {
    for event in events {
        let message = event.message.as_str();
        if message.contains("SIGSEGV") || message.contains("signal 11") {
            return Some("SIGSEGV".to_string());
        } else if message.contains("SIGABRT") || message.contains("signal 6") {
            return Some("SIGABRT".to_string());
        } else if message.contains("SIGBUS") || message.contains("signal 7") {
            return Some("SIGBUS".to_string());
        } else if message.contains("SIGFPE") || message.contains("signal 8") {
            return Some("SIGFPE".to_string());
        }
    }
    None
}

/// Analyze Linux minidump/core dump crashes
pub fn analyze_linux_minidump(
    crash: &CrashRecord,
    related_events: &[NormalizedEvent],
) -> Result<MinidumpAnalysisResult, String> {
    // For Linux, we support Core Dumps (application crashes)
    let dump_kind = if crash.source.eq_ignore_ascii_case("CoreDump")
        || crash.crash_type.eq_ignore_ascii_case("Core Dump")
    {
        "core_dump".to_string()
    } else {
        "unsupported".to_string()
    };

    if !crash.os.eq_ignore_ascii_case("linux") || dump_kind == "unsupported" {
        return Ok(unavailable_minidump_analysis(
            crash,
            dump_kind,
            "Selected crash is not a supported Linux core dump.".to_string(),
        ));
    }

    let warnings = Vec::new();
    let dump_path = crash.raw_path.clone();

    // Determine if the dump file exists and get metadata
    let (dump_exists, metadata_opt, unavailable_reason) = match &dump_path {
        Some(raw_path) => {
            let path = PathBuf::from(raw_path);
            match fs::metadata(&path) {
                Ok(metadata) => (true, Some(metadata), None),
                Err(error) => (
                    false,
                    None,
                    Some(format!("Dump file is unavailable: {error}")),
                ),
            }
        }
        None => (
            false,
            None,
            Some("Crash record does not include a dump file path.".to_string()),
        ),
    };

    // Infer signal from events if not already in the crash record
    let signal_code = crash
        .code
        .clone()
        .or_else(|| infer_signal_from_events(related_events));

    // For Linux, we can't read ELF core dump headers like Windows minidumps,
    // but we can still provide analysis based on logs and metadata
    let suspected_component = crash
        .suspected_component
        .clone()
        .or_else(|| infer_suspected_module(related_events));

    let likely_cause_category =
        infer_likely_cause_category(signal_code.as_deref(), suspected_component.as_deref(), related_events);
    let likely_cause = build_likely_cause_text(
        likely_cause_category.as_str(),
        suspected_component.as_deref(),
        signal_code.as_deref(),
        related_events,
    );

    // Linux core dumps typically have lower confidence without detailed analysis tools
    let confidence = estimate_confidence(
        signal_code.as_deref(),
        suspected_component.as_deref(),
        false, // No header info for ELF core dumps
        related_events,
    );

    let dump_modified_at = metadata_opt
        .as_ref()
        .and_then(|m| m.modified().ok())
        .map(system_time_to_rfc3339);

    // Build summary based on whether we have the dump file
    let summary = if !dump_exists && unavailable_reason.is_some() {
        format!(
            "Linux core dump analysis is partially available. {}",
            unavailable_reason.as_ref().unwrap()
        )
    } else {
        build_minidump_summary(
            crash,
            dump_kind.as_str(),
            signal_code.as_deref(),
            suspected_component.as_deref(),
            likely_cause_category.as_str(),
            related_events.len(),
        )
    };

    // Build crash details based on available information
    let mut crash_details = vec![
        format!("Crash type: {}", crash.crash_type),
        format!("Source: {}", crash.source),
        format!("Timestamp: {}", crash.timestamp),
    ];

    if dump_exists {
        if let Some(metadata) = &metadata_opt {
            crash_details.push(format!("Dump size: {} bytes", metadata.len()));
        }
    } else if let Some(reason) = &unavailable_reason {
        crash_details.push(format!("Dump unavailable: {reason}"));
    }

    // Add signal and component info if available
    if let Some(signal) = &signal_code {
        crash_details.push(format!("Signal code: {signal}"));
    }
    if let Some(component) = &suspected_component {
        crash_details.push(format!("Suspected component: {component}"));
    }

    // Build verify and escalate suggestions
    let mut verify_first = vec![
        "Review related system logs for pre-crash conditions.".to_string(),
    ];
    if !dump_exists {
        verify_first.push("Confirm the dump path exists and is readable on the local machine.".to_string());
    }

    let mut escalate_if = vec![
        "The system continues to crash with similar signals.".to_string(),
    ];
    if !dump_exists {
        escalate_if.push("Support needs access to the core dump file for detailed analysis.".to_string());
    }

    Ok(MinidumpAnalysisResult {
        ok: true,
        crash_id: crash.id.clone(),
        crash_type: crash.crash_type.clone(),
        source: crash.source.clone(),
        dump_path,
        dump_exists,
        dump_kind,
        dump_size_bytes: metadata_opt.as_ref().map(|m| m.len()),
        dump_modified_at,
        header_signature: None, // ELF core dumps don't have the same structure
        header_version: None,
        header_stream_count: None,
        header_timestamp: None,
        bugcheck_code: signal_code,
        bugcheck_parameters: Vec::new(),
        suspected_module: suspected_component,
        likely_cause_category,
        confidence,
        summary,
        crash_details,
        likely_cause,
        verify_first,
        escalate_if,
        warnings,
        unavailable_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_first_hex_token() {
        assert_eq!(first_hex_token("BugCheck 0xC0000005"), Some("0xC0000005".to_string()));
        assert_eq!(first_hex_token("Stop code: 0xA"), Some("0xA".to_string()));
        assert_eq!(first_hex_token("No hex here!"), None);
    }

    #[test]
    fn test_infer_bugcheck_code() {
        let events = vec![
            NormalizedEvent {
                id: "1".to_string(),
                timestamp: "2024-03-27T10:00:05Z".to_string(),
                os: "windows".to_string(),
                log_name: "system".to_string(),
                category: "bugcheck".to_string(),
                provider: "kernel".to_string(),
                event_id: Some(100),
                severity: "info".to_string(),
                message: "BugCheck 0xC0000005, ...".to_string(),
                source_host: "host-001".to_string(),
                imported: true,
            },
        ];

        let code = infer_bugcheck_code(&events);
        assert_eq!(code, Some("0xC0000005".to_string()));
    }

    #[test]
    fn test_infer_module_name() {
        let events = vec![
            NormalizedEvent {
                id: "1".to_string(),
                timestamp: "2024-03-27T10:00:05Z".to_string(),
                os: "windows".to_string(),
                log_name: "system".to_string(),
                category: "bugcheck".to_string(),
                provider: "kernel".to_string(),
                event_id: Some(100),
                severity: "info".to_string(),
                message: "Probably caused by : nvlddmkm.sys".to_string(),
                source_host: "host-001".to_string(),
                imported: true,
            },
        ];

        let module = infer_suspected_module(&events);
        assert_eq!(module, Some("nvlddmkm.sys".to_string()));
    }

    #[test]
    fn test_analyze_linux_minidump_with_core_dump() {
        let crash = CrashRecord {
            id: "crash-001".to_string(),
            timestamp: "2024-03-27T10:00:00Z".to_string(),
            os: "linux".to_string(),
            source: "CoreDump".to_string(),
            crash_type: "Core Dump".to_string(),
            code: Some("SIGSEGV".to_string()),
            summary: "Segmentation fault".to_string(),
            suspected_component: Some("libfoo.so".to_string()),
            raw_path: Some("/var/crash/core.123456".to_string()),
            source_host: "host-001".to_string(),
            imported: true,
        };

        let related_events = vec![
            NormalizedEvent {
                id: "event-001".to_string(),
                timestamp: "2024-03-27T10:00:05Z".to_string(),
                os: "linux".to_string(),
                log_name: "system".to_string(),
                category: "process".to_string(),
                provider: "kernel".to_string(),
                event_id: Some(100),
                severity: "info".to_string(),
                message: "Process 123456 received signal SIGSEGV from application libfoo.so".to_string(),
                source_host: "host-001".to_string(),
                imported: true,
            }
        ];

        let result = analyze_linux_minidump(&crash, &related_events).unwrap();

        assert!(result.ok);
        assert_eq!(result.crash_id, "crash-001");
        assert_eq!(result.source, "CoreDump");
    }

    #[test]
    fn test_analyze_linux_minidump_without_dump_file() {
        let crash = CrashRecord {
            id: "crash-002".to_string(),
            timestamp: "2024-03-27T10:00:00Z".to_string(),
            os: "linux".to_string(),
            source: "CoreDump".to_string(),
            crash_type: "Core Dump".to_string(),
            code: Some("SIGABRT".to_string()),
            summary: "Abnormal termination".to_string(),
            suspected_component: None,
            raw_path: None, // No dump file path
            source_host: "host-001".to_string(),
            imported: true,
        };

        let related_events = vec![];

        let result = analyze_linux_minidump(&crash, &related_events).unwrap();

        assert!(result.ok);
        assert_eq!(result.crash_id, "crash-002");
    }

    #[test]
    fn test_infer_signal_from_events() {
        let events = vec![
            NormalizedEvent {
                id: "event-001".to_string(),
                timestamp: "2024-03-27T10:00:05Z".to_string(),
                os: "linux".to_string(),
                log_name: "system".to_string(),
                category: "process".to_string(),
                provider: "kernel".to_string(),
                event_id: Some(100),
                severity: "info".to_string(),
                message: "Process 123456 received signal SIGSEGV from application libfoo.so".to_string(),
                source_host: "host-001".to_string(),
                imported: true,
            },
            NormalizedEvent {
                id: "event-002".to_string(),
                timestamp: "2024-03-27T10:00:06Z".to_string(),
                os: "linux".to_string(),
                log_name: "system".to_string(),
                category: "process".to_string(),
                provider: "kernel".to_string(),
                event_id: Some(101),
                severity: "info".to_string(),
                message: "Application crashed with signal 11".to_string(),
                source_host: "host-001".to_string(),
                imported: true,
            }
        ];

        let signal = infer_signal_from_events(&events);
        assert!(signal.is_some());
    }
}
