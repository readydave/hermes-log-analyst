use dirs::data_local_dir;
use std::fs;
use std::path::PathBuf;

const THEME_FILE: &str = "theme.txt";
const EXPORT_DIR_FILE: &str = "export_dir.txt";
const INGEST_DAYS_FILE: &str = "ingest_window_days.txt";
const DEFAULT_INGEST_DAYS: u32 = 7;

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
    raw.trim().parse::<u32>().ok().filter(|value| *value > 0 && *value <= 365).unwrap_or(DEFAULT_INGEST_DAYS)
}
