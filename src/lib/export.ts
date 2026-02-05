import type { NormalizedEvent } from "../types/events";

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function exportAsJson(events: NormalizedEvent[], filename: string): void {
  download(filename, JSON.stringify(events, null, 2), "application/json");
}

function escapeCsv(value: unknown): string {
  const text = String(value ?? "");
  if (text.includes(",") || text.includes("\"") || text.includes("\n")) {
    return `"${text.replaceAll("\"", "\"\"")}"`;
  }
  return text;
}

export function exportAsCsv(events: NormalizedEvent[], filename: string): void {
  const headers = ["timestamp", "os", "logName", "category", "provider", "eventId", "severity", "message"];
  const lines = [headers.join(",")];

  for (const event of events) {
    lines.push([
      escapeCsv(event.timestamp),
      escapeCsv(event.os),
      escapeCsv(event.logName),
      escapeCsv(event.category),
      escapeCsv(event.provider),
      escapeCsv(event.eventId),
      escapeCsv(event.severity),
      escapeCsv(event.message)
    ].join(","));
  }

  download(filename, lines.join("\n"), "text/csv");
}
