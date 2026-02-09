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
