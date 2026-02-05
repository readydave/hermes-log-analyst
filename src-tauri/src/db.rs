use crate::{crash::CrashRecord, logs::NormalizedEvent};
use dirs::data_local_dir;
use rusqlite::{params, Connection, Row};
use std::fs;
use std::path::PathBuf;

fn db_path() -> Result<PathBuf, String> {
    let mut base = data_local_dir().ok_or("Unable to resolve local data directory")?;
    base.push("hermes-log-analyst");
    fs::create_dir_all(&base).map_err(|e| format!("Failed to create app data directory: {e}"))?;
    base.push("events.db");
    Ok(base)
}

fn open_connection() -> Result<Connection, String> {
    let path = db_path()?;
    let conn = Connection::open(path).map_err(|e| format!("Failed to open SQLite database: {e}"))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            os TEXT NOT NULL,
            log_name TEXT NOT NULL,
            category TEXT NOT NULL,
            provider TEXT NOT NULL,
            event_id INTEGER,
            severity TEXT NOT NULL,
            message TEXT NOT NULL,
            imported INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);
        CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);

        CREATE TABLE IF NOT EXISTS crashes (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            os TEXT NOT NULL,
            source TEXT NOT NULL,
            crash_type TEXT NOT NULL,
            code TEXT,
            summary TEXT NOT NULL,
            suspected_component TEXT,
            raw_path TEXT,
            imported INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_crashes_timestamp ON crashes(timestamp);
        CREATE INDEX IF NOT EXISTS idx_crashes_os ON crashes(os);
        ",
    )
    .map_err(|e| format!("Failed to create schema: {e}"))?;

    Ok(())
}

fn row_to_event(row: &Row<'_>) -> rusqlite::Result<NormalizedEvent> {
    Ok(NormalizedEvent {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        os: row.get(2)?,
        log_name: row.get(3)?,
        category: row.get(4)?,
        provider: row.get(5)?,
        event_id: row.get(6)?,
        severity: row.get(7)?,
        message: row.get(8)?,
        imported: row.get::<_, i64>(9)? != 0,
    })
}

fn row_to_crash(row: &Row<'_>) -> rusqlite::Result<CrashRecord> {
    Ok(CrashRecord {
        id: row.get(0)?,
        timestamp: row.get(1)?,
        os: row.get(2)?,
        source: row.get(3)?,
        crash_type: row.get(4)?,
        code: row.get(5)?,
        summary: row.get(6)?,
        suspected_component: row.get(7)?,
        raw_path: row.get(8)?,
        imported: row.get::<_, i64>(9)? != 0,
    })
}

pub fn save_local_events(events: &[NormalizedEvent]) -> Result<(), String> {
    let mut conn = open_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start DB transaction: {e}"))?;

    for event in events {
        tx.execute(
            "
            INSERT INTO events (id, timestamp, os, log_name, category, provider, event_id, severity, message, imported)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)
            ON CONFLICT(id) DO UPDATE SET
                timestamp=excluded.timestamp,
                os=excluded.os,
                log_name=excluded.log_name,
                category=excluded.category,
                provider=excluded.provider,
                event_id=excluded.event_id,
                severity=excluded.severity,
                message=excluded.message
            ",
            params![
                event.id,
                event.timestamp,
                event.os,
                event.log_name,
                event.category,
                event.provider,
                event.event_id,
                event.severity,
                event.message,
            ],
        )
        .map_err(|e| format!("Failed to upsert event: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {e}"))?;

    Ok(())
}

pub fn get_local_events(limit: u32) -> Result<Vec<NormalizedEvent>, String> {
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, imported
            FROM events
            ORDER BY timestamp DESC
            LIMIT ?1
            ",
        )
        .map_err(|e| format!("Failed to prepare query: {e}"))?;

    let rows = stmt
        .query_map([limit], row_to_event)
        .map_err(|e| format!("Failed to execute query: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Failed to parse DB row: {e}"))?);
    }

    Ok(events)
}

pub fn save_crashes(crashes: &[CrashRecord]) -> Result<(), String> {
    let mut conn = open_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start DB transaction: {e}"))?;

    for crash in crashes {
        tx.execute(
            "
            INSERT INTO crashes (id, timestamp, os, source, crash_type, code, summary, suspected_component, raw_path, imported)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                timestamp=excluded.timestamp,
                os=excluded.os,
                source=excluded.source,
                crash_type=excluded.crash_type,
                code=excluded.code,
                summary=excluded.summary,
                suspected_component=excluded.suspected_component,
                raw_path=excluded.raw_path,
                imported=excluded.imported
            ",
            params![
                crash.id,
                crash.timestamp,
                crash.os,
                crash.source,
                crash.crash_type,
                crash.code,
                crash.summary,
                crash.suspected_component,
                crash.raw_path,
                if crash.imported { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("Failed to upsert crash: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit crash transaction: {e}"))?;

    Ok(())
}

pub fn get_crashes(limit: u32) -> Result<Vec<CrashRecord>, String> {
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, timestamp, os, source, crash_type, code, summary, suspected_component, raw_path, imported
            FROM crashes
            ORDER BY timestamp DESC
            LIMIT ?1
            ",
        )
        .map_err(|e| format!("Failed to prepare crash query: {e}"))?;

    let rows = stmt
        .query_map([limit], row_to_crash)
        .map_err(|e| format!("Failed to execute crash query: {e}"))?;

    let mut crashes = Vec::new();
    for row in rows {
        crashes.push(row.map_err(|e| format!("Failed to parse crash row: {e}"))?);
    }

    Ok(crashes)
}

pub fn prune_events_before(cutoff: &str) -> Result<usize, String> {
    let conn = open_connection()?;
    let deleted = conn
        .execute(
            "DELETE FROM events WHERE julianday(timestamp) < julianday(?1)",
            [cutoff],
        )
        .map_err(|e| format!("Failed to prune events: {e}"))?;
    Ok(deleted)
}

pub fn correlate_crash_events(
    crash_id: &str,
    window_minutes: i64,
    limit: u32,
) -> Result<Vec<NormalizedEvent>, String> {
    let conn = open_connection()?;
    let mut stmt = conn
        .prepare(
            "
            SELECT e.id, e.timestamp, e.os, e.log_name, e.category, e.provider, e.event_id, e.severity, e.message, e.imported
            FROM events e
            JOIN crashes c ON c.id = ?1
            WHERE e.os = c.os
              AND ABS((julianday(e.timestamp) - julianday(c.timestamp)) * 24 * 60) <= ?2
            ORDER BY ABS((julianday(e.timestamp) - julianday(c.timestamp)) * 24 * 60) ASC, e.timestamp DESC
            LIMIT ?3
            ",
        )
        .map_err(|e| format!("Failed to prepare correlation query: {e}"))?;

    let rows = stmt
        .query_map(params![crash_id, window_minutes, limit], row_to_event)
        .map_err(|e| format!("Failed to execute correlation query: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Failed to parse correlated event row: {e}"))?);
    }

    Ok(events)
}
