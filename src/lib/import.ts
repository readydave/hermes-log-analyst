import type { NormalizedEvent, SupportedOs } from "../types/events";

export async function importSessionEvents(file: File, hostOs: SupportedOs): Promise<NormalizedEvent[]> {
  const content = await file.text();

  if (file.name.toLowerCase().endsWith(".json")) {
    return parseJson(content, hostOs);
  }

  if (file.name.toLowerCase().endsWith(".csv")) {
    return parseCsv(content, hostOs);
  }

  throw new Error("Unsupported import type. Use JSON or CSV exports.");
}

function parseJson(content: string, hostOs: SupportedOs): NormalizedEvent[] {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) throw new Error("Expected a JSON array of events.");

  return parsed.map((raw, index) => ({
    id: crypto.randomUUID(),
    timestamp: String(raw.timestamp ?? new Date().toISOString()),
    os: normalizeOs(String(raw.os ?? hostOs)),
    logName: String(raw.logName ?? "Imported"),
    category: normalizeCategory(String(raw.category ?? "other")),
    provider: String(raw.provider ?? "import"),
    eventId: Number.isFinite(Number(raw.eventId)) ? Number(raw.eventId) : undefined,
    severity: normalizeSeverity(String(raw.severity ?? "information")),
    message: String(raw.message ?? `Imported event ${index + 1}`),
    raw,
    imported: true
  }));
}

function parseCsv(content: string, hostOs: SupportedOs): NormalizedEvent[] {
  const lines = content.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());

  return lines.slice(1).map((line, index) => {
    const cells = line.split(",");
    const row = Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));

    return {
      id: crypto.randomUUID(),
      timestamp: String(row.timestamp || new Date().toISOString()),
      os: normalizeOs(String(row.os || hostOs)),
      logName: String(row.logname || "Imported"),
      category: normalizeCategory(String(row.category || "other")),
      provider: String(row.provider || "import"),
      eventId: Number.isFinite(Number(row.eventid)) ? Number(row.eventid) : undefined,
      severity: normalizeSeverity(String(row.severity || "information")),
      message: String(row.message || `Imported event ${index + 1}`),
      raw: row,
      imported: true
    };
  });
}

function normalizeSeverity(value: string): NormalizedEvent["severity"] {
  const key = value.toLowerCase();
  if (key.includes("crit")) return "critical";
  if (key.includes("err")) return "error";
  if (key.includes("warn")) return "warning";
  return "information";
}

function normalizeCategory(value: string): NormalizedEvent["category"] {
  const key = value.toLowerCase();
  if (key.includes("app")) return "application";
  if (key.includes("sec") || key.includes("auth")) return "security";
  if (key.includes("sys") || key.includes("kernel")) return "system";
  if (key.includes("audit")) return "audit";
  return "other";
}

function normalizeOs(value: string): SupportedOs {
  const key = value.toLowerCase();
  if (key.includes("win")) return "windows";
  if (key.includes("lin")) return "linux";
  if (key.includes("mac") || key.includes("darwin")) return "macos";
  return "linux";
}
