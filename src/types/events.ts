export type SupportedOs = "windows" | "linux" | "macos";
export type ThemeMode = "system" | "light" | "dark";
export type ExportFormat = "json" | "csv" | "txt";

export type EventSeverity =
  | "information"
  | "warning"
  | "error"
  | "critical";

export type EventCategory =
  | "application"
  | "security"
  | "system"
  | "audit"
  | "other";

export interface NormalizedEvent {
  id: string;
  timestamp: string;
  os: SupportedOs;
  logName: string;
  category: EventCategory;
  provider: string;
  eventId?: number;
  severity: EventSeverity;
  message: string;
  raw?: unknown;
  imported?: boolean;
}

export interface CrashRecord {
  id: string;
  timestamp: string;
  os: SupportedOs;
  source: string;
  crashType: string;
  code?: string;
  summary: string;
  suspectedComponent?: string;
  rawPath?: string;
  imported?: boolean;
}

export interface EventFilters {
  text: string;
  severities: Record<EventSeverity, boolean>;
  logType: string;
  category: "all" | EventCategory;
  eventId: string;
  source: string;
  dateFrom: string;
  dateTo: string;
}
