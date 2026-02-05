mod crash;
mod db;
mod logs;
mod settings;

use crash::{build_sample_crash, CrashRecord};
use db::{
    correlate_crash_events, get_crashes as read_crashes, get_local_events as read_local_events,
    save_crashes, save_local_events,
};
use logs::{collect_host_events, detect_host_os, NormalizedEvent};
use settings::{load_export_dir, load_theme, save_export_dir, save_theme};
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager};

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
        let version = run_command("sw_vers", &["-productVersion"]).unwrap_or_else(|| "Unknown".to_string());
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
            if let Some(line) = content.lines().find(|line| line.starts_with("PRETTY_NAME=")) {
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
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() || value.len() > 300 {
        return None;
    }
    Some(value)
}

#[tauri::command]
fn refresh_local_events() -> Result<usize, String> {
    let events = collect_host_events();
    save_local_events(&events)?;
    Ok(events.len())
}

#[tauri::command]
fn get_local_events(limit: Option<u32>) -> Result<Vec<NormalizedEvent>, String> {
    let limit = limit.unwrap_or(2000).min(10000);
    read_local_events(limit)
}

#[tauri::command]
fn create_sample_crash() -> Result<CrashRecord, String> {
    let os = detect_host_os().to_string();
    let crash = build_sample_crash(os.as_str());
    save_crashes(std::slice::from_ref(&crash))?;
    Ok(crash)
}

#[tauri::command]
fn get_crashes(limit: Option<u32>) -> Result<Vec<CrashRecord>, String> {
    let limit = limit.unwrap_or(250).min(5000);
    read_crashes(limit)
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

    webbrowser::open(url.as_str())
        .map(|_| ())
        .map_err(|e| format!("Failed to open URL: {e}"))
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
    save_export_dir(Some(value.as_str()))?;
    Ok(Some(value))
}

#[tauri::command]
fn set_export_directory(path: Option<String>) -> Result<(), String> {
    save_export_dir(path.as_deref())
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
        _ => return Err("Unsupported export format.".to_string()),
    };

    let base_dir = load_export_dir()
        .map(PathBuf::from)
        .or_else(dirs::download_dir)
        .ok_or("Unable to resolve export directory.")?;

    if !base_dir.exists() || !base_dir.is_dir() {
        return Err("Configured export directory is invalid.".to_string());
    }

    let safe_name = sanitize_filename(filename.as_str(), extension);
    let output_path = base_dir.join(safe_name);

    let payload = if extension == "json" {
        serde_json::to_string_pretty(&events).map_err(|e| format!("Failed to serialize JSON: {e}"))?
    } else {
        build_csv(&events)
    };

    std::fs::write(&output_path, payload).map_err(|e| format!("Failed to write export file: {e}"))?;
    Ok(output_path.to_string_lossy().to_string())
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
    let _ = save_theme(theme);

    let native_theme = match theme {
        "light" => Some(tauri::Theme::Light),
        "dark" => Some(tauri::Theme::Dark),
        _ => None,
    };

    for window in app.webview_windows().values() {
        let _ = window.set_theme(native_theme);
        let _ = window.emit("hla://theme-changed", theme);
    }
    let _ = app.emit("hla://theme-changed", theme);
}

fn setup_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let theme_submenu = SubmenuBuilder::new(app, "Theme")
        .text("theme_system", "System")
        .text("theme_light", "Light")
        .text("theme_dark", "Dark")
        .build()?;

    let tools_submenu = SubmenuBuilder::new(app, "Tools")
        .item(&theme_submenu)
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

    if !clean.to_ascii_lowercase().ends_with(&format!(".{extension}")) {
        clean.push('.');
        clean.push_str(extension);
    }

    clean
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn build_csv(events: &[NormalizedEvent]) -> String {
    let mut lines = Vec::with_capacity(events.len() + 1);
    lines.push("timestamp,os,logName,category,provider,eventId,severity,message,source".to_string());

    for event in events {
        let row = [
            csv_escape(event.timestamp.as_str()),
            csv_escape(event.os.as_str()),
            csv_escape(event.log_name.as_str()),
            csv_escape(event.category.as_str()),
            csv_escape(event.provider.as_str()),
            csv_escape(event.event_id.map(|id| id.to_string()).unwrap_or_default().as_str()),
            csv_escape(event.severity.as_str()),
            csv_escape(event.message.as_str()),
            csv_escape(if event.imported { "Imported" } else { "Live/Local" }),
        ]
        .join(",");
        lines.push(row);
    }

    lines.join("\n")
}

fn main() {
    tauri::Builder::default()
        .setup(setup_menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "theme_system" => apply_theme(app, "system"),
            "theme_light" => apply_theme(app, "light"),
            "theme_dark" => apply_theme(app, "dark"),
            "app_exit" => app.exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            host_os,
            host_os_version,
            refresh_local_events,
            get_local_events,
            create_sample_crash,
            get_crashes,
            get_crash_related_events,
            open_external_url,
            get_export_directory,
            choose_export_directory,
            set_export_directory,
            export_events,
            quit_app,
            set_app_theme,
            get_saved_theme
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
