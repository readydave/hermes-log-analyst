use chrono::{Local, Utc};
use dirs::data_local_dir;
use serde::Serialize;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

const APP_DIR_NAME: &str = "hermes-log-analyst";
const LOG_DIR_NAME: &str = "logs";
const LOG_FILE_PREFIX: &str = "diagnostics";
const LOG_FILE_EXTENSION: &str = "log";
const LOG_RETENTION_DAYS: u64 = 7;

#[derive(Serialize)]
struct LogEntry<'a> {
    timestamp: String,
    level: &'a str,
    subsystem: &'a str,
    message: &'a str,
}

struct LoggerState {
    logs_dir: PathBuf,
    date_key: String,
    file: File,
}

static LOGGER: OnceLock<Mutex<LoggerState>> = OnceLock::new();

pub fn init_logging() -> Result<PathBuf, String> {
    if let Some(logger) = LOGGER.get() {
        if let Ok(state) = logger.lock() {
            return Ok(state.logs_dir.clone());
        }
    }

    let logs_dir = resolve_logs_dir()?;
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("Failed to create diagnostics log directory: {error}"))?;
    prune_old_logs(&logs_dir);
    let (date_key, file) = open_log_file(&logs_dir)?;
    let state = LoggerState {
        logs_dir: logs_dir.clone(),
        date_key,
        file,
    };

    let _ = LOGGER.set(Mutex::new(state));
    info(
        "startup",
        format!("Diagnostics logging initialized at {}", logs_dir.display()),
    );
    Ok(logs_dir)
}

pub fn info(subsystem: &str, message: impl AsRef<str>) {
    write_entry("info", subsystem, message.as_ref());
}

pub fn warn(subsystem: &str, message: impl AsRef<str>) {
    write_entry("warn", subsystem, message.as_ref());
}

pub fn error(subsystem: &str, message: impl AsRef<str>) {
    write_entry("error", subsystem, message.as_ref());
}

fn write_entry(level: &str, subsystem: &str, message: &str) {
    let timestamp = Utc::now().to_rfc3339();
    let record = LogEntry {
        timestamp,
        level,
        subsystem,
        message,
    };

    let Ok(line) = serde_json::to_string(&record) else {
        eprintln!("[{level}] [{subsystem}] {message}");
        return;
    };

    if let Some(logger) = LOGGER.get() {
        if let Ok(mut state) = logger.lock() {
            rotate_if_needed(&mut state);
            if writeln!(state.file, "{line}").is_ok() {
                return;
            }
        }
    }

    eprintln!("[{level}] [{subsystem}] {message}");
}

fn rotate_if_needed(state: &mut LoggerState) {
    let current_date = Local::now().format("%Y-%m-%d").to_string();
    if current_date == state.date_key {
        return;
    }

    if let Ok((date_key, file)) = open_log_file(&state.logs_dir) {
        state.date_key = date_key;
        state.file = file;
        prune_old_logs(&state.logs_dir);
    }
}

fn open_log_file(logs_dir: &PathBuf) -> Result<(String, File), String> {
    let date_key = Local::now().format("%Y-%m-%d").to_string();
    let filename = format!("{LOG_FILE_PREFIX}-{date_key}.{LOG_FILE_EXTENSION}");
    let path = logs_dir.join(filename);
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Failed to open diagnostics log file: {error}"))?;

    Ok((date_key, file))
}

fn resolve_logs_dir() -> Result<PathBuf, String> {
    let mut base = data_local_dir().ok_or("Unable to resolve local data directory")?;
    base.push(APP_DIR_NAME);
    base.push(LOG_DIR_NAME);
    Ok(base)
}

fn prune_old_logs(logs_dir: &PathBuf) {
    let retention = Duration::from_secs(LOG_RETENTION_DAYS * 24 * 60 * 60);
    let cutoff = SystemTime::now()
        .checked_sub(retention)
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let Ok(entries) = fs::read_dir(logs_dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_log_file = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| ext.eq_ignore_ascii_case(LOG_FILE_EXTENSION))
            .unwrap_or(false);
        if !is_log_file {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if modified >= cutoff {
            continue;
        }

        if let Err(error) = fs::remove_file(&path) {
            eprintln!(
                "[warn] [diagnostics] Failed to prune old log file {}: {}",
                path.display(),
                error
            );
        }
    }
}
