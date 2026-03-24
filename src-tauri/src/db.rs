use crate::{crash::CrashRecord, logs::NormalizedEvent};
use dirs::data_local_dir;
use rusqlite::{params, Connection, Row};
use std::fs;
use std::path::PathBuf;
use std::collections::HashSet;

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

fn dedupe_events(events: Vec<NormalizedEvent>) -> Vec<NormalizedEvent> {
    let mut seen = HashSet::new();
    let mut deduped = Vec::with_capacity(events.len());
    for event in events {
        let identity = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            event.os,
            event.source_host,
            event.log_name,
            event.timestamp,
            event.provider,
            event.event_id
                .map(|value| value.to_string())
                .unwrap_or_default(),
            event.severity,
            event.category,
            event.message
        );
        if seen.insert(identity) {
            deduped.push(event);
        }
    }
    deduped
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
            source_host TEXT NOT NULL DEFAULT 'localhost',
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
            source_host TEXT NOT NULL DEFAULT 'localhost',
            imported INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_crashes_timestamp ON crashes(timestamp);
        CREATE INDEX IF NOT EXISTS idx_crashes_os ON crashes(os);
        ",
    )
    .map_err(|e| format!("Failed to create schema: {e}"))?;

    // Migration for existing tables (ignore errors if column already exists)
    let _ = conn.execute("ALTER TABLE events ADD COLUMN source_host TEXT NOT NULL DEFAULT 'localhost'", []);
    let _ = conn.execute("ALTER TABLE crashes ADD COLUMN source_host TEXT NOT NULL DEFAULT 'localhost'", []);
    
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
        source_host: row.get(9)?,
        imported: row.get::<_, i64>(10)? != 0,
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
        source_host: row.get(9)?,
        imported: row.get::<_, i64>(10)? != 0,
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
            INSERT INTO events (id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)
            ON CONFLICT(id) DO UPDATE SET
                timestamp=excluded.timestamp,
                os=excluded.os,
                log_name=excluded.log_name,
                category=excluded.category,
                provider=excluded.provider,
                event_id=excluded.event_id,
                severity=excluded.severity,
                message=excluded.message,
                source_host=excluded.source_host
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
                event.source_host,
            ],
        )
        .map_err(|e| format!("Failed to upsert event: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit transaction: {e}"))?;

    Ok(())
}

pub fn get_local_events(limit: u32, host: Option<&str>) -> Result<Vec<NormalizedEvent>, String> {
    let conn = open_connection()?;
    
    let query = if host.is_some() {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events WHERE source_host = ?1 ORDER BY timestamp DESC LIMIT ?2"
    } else {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events ORDER BY timestamp DESC LIMIT ?1"
    };

    let mut stmt = conn.prepare(query).map_err(|e| format!("Failed to prepare query: {e}"))?;

    let rows = if let Some(h) = host {
        stmt.query_map(params![h, limit], row_to_event)
    } else {
        stmt.query_map(params![limit], row_to_event)
    }.map_err(|e| format!("Failed to execute query: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Failed to parse DB row: {e}"))?);
    }

    Ok(events)
}

pub fn get_local_events_range(from: &str, to: &str, limit: u32, host: Option<&str>) -> Result<Vec<NormalizedEvent>, String> {
    let conn = open_connection()?;
    
    let query = if host.is_some() {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events WHERE julianday(timestamp) >= julianday(?1) AND julianday(timestamp) <= julianday(?2) AND source_host = ?3 ORDER BY timestamp DESC LIMIT ?4"
    } else {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events WHERE julianday(timestamp) >= julianday(?1) AND julianday(timestamp) <= julianday(?2) ORDER BY timestamp DESC LIMIT ?3"
    };

    let mut stmt = conn.prepare(query).map_err(|e| format!("Failed to prepare range query: {e}"))?;

    let rows = if let Some(h) = host {
        stmt.query_map(params![from, to, h, limit], row_to_event)
    } else {
        stmt.query_map(params![from, to, limit], row_to_event)
    }.map_err(|e| format!("Failed to execute range query: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Failed to parse range row: {e}"))?);
    }

    Ok(dedupe_events(events))
}

pub fn get_local_events_window(
    from: &str,
    to: &str,
    limit: u32,
    host: Option<&str>,
) -> Result<Vec<NormalizedEvent>, String> {
    let conn = open_connection()?;

    let query = if host.is_some() {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events WHERE julianday(timestamp) >= julianday(?1) AND julianday(timestamp) <= julianday(?2) AND source_host = ?3 ORDER BY timestamp DESC LIMIT ?4"
    } else {
        "SELECT id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host, imported FROM events WHERE julianday(timestamp) >= julianday(?1) AND julianday(timestamp) <= julianday(?2) ORDER BY timestamp DESC LIMIT ?3"
    };

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("Failed to prepare window query: {e}"))?;

    let rows = if let Some(h) = host {
        stmt.query_map(params![from, to, h, limit], row_to_event)
    } else {
        stmt.query_map(params![from, to, limit], row_to_event)
    }
    .map_err(|e| format!("Failed to execute window query: {e}"))?;

    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(|e| format!("Failed to parse window row: {e}"))?);
    }

    Ok(dedupe_events(events))
}

pub fn save_crashes(crashes: &[CrashRecord]) -> Result<(), String> {
    let mut conn = open_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start DB transaction: {e}"))?;

    for crash in crashes {
        tx.execute(
            "
            INSERT INTO crashes (id, timestamp, os, source, crash_type, code, summary, suspected_component, raw_path, source_host, imported)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                timestamp=excluded.timestamp,
                os=excluded.os,
                source=excluded.source,
                crash_type=excluded.crash_type,
                code=excluded.code,
                summary=excluded.summary,
                suspected_component=excluded.suspected_component,
                raw_path=excluded.raw_path,
                source_host=excluded.source_host,
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
                crash.source_host,
                if crash.imported { 1 } else { 0 },
            ],
        )
        .map_err(|e| format!("Failed to upsert crash: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit crash transaction: {e}"))?;

    Ok(())
}

pub fn get_crashes(limit: u32, host: Option<&str>) -> Result<Vec<CrashRecord>, String> {
    let conn = open_connection()?;
    
    let query = if host.is_some() {
        "SELECT id, timestamp, os, source, crash_type, code, summary, suspected_component, raw_path, source_host, imported FROM crashes WHERE source_host = ?1 ORDER BY timestamp DESC LIMIT ?2"
    } else {
        "SELECT id, timestamp, os, source, crash_type, code, summary, suspected_component, raw_path, source_host, imported FROM crashes ORDER BY timestamp DESC LIMIT ?1"
    };

    let mut stmt = conn.prepare(query).map_err(|e| format!("Failed to prepare crash query: {e}"))?;

    let rows = if let Some(h) = host {
        stmt.query_map(params![h, limit], row_to_crash)
    } else {
        stmt.query_map(params![limit], row_to_crash)
    }.map_err(|e| format!("Failed to execute crash query: {e}"))?;

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

pub fn prune_events_outside(start: &str, end: &str) -> Result<usize, String> {
    let conn = open_connection()?;
    let deleted = conn
        .execute(
            "
            DELETE FROM events
            WHERE julianday(timestamp) < julianday(?1)
               OR julianday(timestamp) > julianday(?2)
            ",
            params![start, end],
        )
        .map_err(|e| format!("Failed to prune events outside range: {e}"))?;
    Ok(deleted)
}

pub fn cleanup_duplicate_events() -> Result<usize, String> {
    let mut conn = open_connection()?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to start duplicate cleanup transaction: {e}"))?;

    let mut stmt = tx
        .prepare(
            "
            SELECT rowid, id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host
            FROM events
            ORDER BY
                timestamp DESC,
                CASE WHEN id LIKE 'evt-%' THEN 0 ELSE 1 END,
                rowid DESC
            ",
        )
        .map_err(|e| format!("Failed to prepare duplicate cleanup query: {e}"))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<u32>>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(|e| format!("Failed to execute duplicate cleanup query: {e}"))?;

    let mut seen = HashSet::new();
    let mut rowids_to_delete = Vec::new();

    for row in rows {
        let (rowid, _id, timestamp, os, log_name, category, provider, event_id, severity, message, source_host) =
            row.map_err(|e| format!("Failed to parse duplicate cleanup row: {e}"))?;
        let identity = format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}",
            os,
            source_host,
            log_name,
            timestamp,
            provider,
            event_id.map(|value| value.to_string()).unwrap_or_default(),
            severity,
            category,
            message
        );
        if !seen.insert(identity) {
            rowids_to_delete.push(rowid);
        }
    }

    drop(stmt);

    for rowid in &rowids_to_delete {
        tx.execute("DELETE FROM events WHERE rowid = ?1", params![rowid])
            .map_err(|e| format!("Failed to delete duplicate event row: {e}"))?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit duplicate cleanup transaction: {e}"))?;

    Ok(rowids_to_delete.len())
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
            SELECT e.id, e.timestamp, e.os, e.log_name, e.category, e.provider, e.event_id, e.severity, e.message, e.source_host, e.imported
            FROM events e
            JOIN crashes c ON c.id = ?1
            WHERE e.os = c.os
              AND e.source_host = c.source_host
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

    Ok(dedupe_events(events))
}
