import { useEffect, useMemo, useRef, useState } from "react";
import {
  importHostCrashes,
  exportEventsWithDialog,
  getCrashRelatedEvents,
  getCrashes,
  getHostOs,
  getHostOsVersion,
  getLocalEvents,
  getSavedTheme,
  getLocalEventsWindow,
  isTauriRuntime,
  openExternalUrl,
  quitApp,
  estimateRefreshLocalEvents,
  estimateLocalEventsRange,
  refreshLocalEvents,
  syncLocalEventsRange,
  syncLocalEventsWindow,
  getLocalEventsRange,
  getIngestProfile,
  getLlmSettings,
  setIngestProfile,
  setLlmSettings,
  setLlmProfileApiKey,
  clearLlmProfileApiKey,
  testLlmProfileConnection,
  analyzeWithLocalLlm,
  saveTextWithDialog,
  getIngestWindowDays,
  setIngestWindowDays,
  detectLocalLlmProviders,
  scanLanLlmProviders,
  listLlmNetworkInterfaces,
  getRemoteSettings,
  saveRemoteSettings,
  restartElevated
} from "./lib/backend";
import type {
  IngestProfile,
  LlmAnalysisResult,
  LlmConnectionProfile,
  LlmConnectionTestResult,
  LlmEndpointCandidate,
  LlmNetworkInterface,
  LlmSettings,
  EventLoadEstimate,
  SyncOperationResult,
  RemoteSettings,
  RemoteConnectionProfile
} from "./lib/backend";
import { exportAsCsv, exportAsJson, exportAsText } from "./lib/export";
import { applyFilters, defaultFilters } from "./lib/filters";
import { importSessionEvents } from "./lib/import";
import { buildGoogleQuery, buildLlmPrompt, redactSensitiveText } from "./lib/llmPrompt";
import { cn } from "./lib/cn";
import { Button } from "./components/Button";
import type {
  CrashRecord,
  EventCategory,
  EventFilters,
  EventSeverity,
  ExportFormat,
  NormalizedEvent,
  SupportedOs,
  ThemeMode
} from "./types/events";

const browserDefaultOs: SupportedOs = navigator.userAgent.includes("Windows")
  ? "windows"
  : navigator.userAgent.includes("Mac")
    ? "macos"
    : "linux";

const windowsChannelOptions = ["Application", "System", "Security"] as const;
const llmProviderOptions = [
  { id: "ollama", label: "Ollama (Local)" },
  { id: "lmstudio", label: "LM Studio (Local)" },
  { id: "openai", label: "OpenAI" },
  { id: "gemini", label: "Gemini" },
  { id: "claude", label: "Claude" },
  { id: "perplexity", label: "Perplexity" },
  { id: "openai_compatible", label: "OpenAI-Compatible (Generic)" }
] as const;
const llmScopeOptions = [
  { id: "local", label: "Local host" },
  { id: "lan", label: "LAN host" },
  { id: "cloud", label: "Cloud" },
  { id: "generic", label: "Generic" }
] as const;
const MAX_LOCAL_EVENTS_IN_MEMORY = 10000;
const MAX_IMPORTED_EVENTS_IN_MEMORY = 5000;
const LOCAL_FETCH_LIMIT = MAX_LOCAL_EVENTS_IN_MEMORY + 1;
const VIRTUAL_ROW_HEIGHT = 36;
const VIRTUAL_OVERSCAN_ROWS = 20;

function createDefaultFilters(): EventFilters {
  return {
    ...defaultFilters,
    severities: { ...defaultFilters.severities }
  };
}

function createDefaultLlmSettings(): LlmSettings {
  return {
    allowLanDiscovery: false,
    neverSendRawEventToUntrusted: true,
    trustedHosts: [],
    profiles: [
      {
        id: "profile-ollama-local",
        name: "Ollama Local",
        provider: "ollama",
        scope: "local",
        baseUrl: "http://127.0.0.1:11434",
        model: "",
        enabled: true,
        apiKeyConfigured: false
      }
    ],
    defaultProfileId: "profile-ollama-local",
    backupProfileId: "",
    preferredLanInterfaceId: ""
  };
}

function defaultBaseUrlForProvider(provider: string): string {
  switch (provider) {
    case "ollama":
      return "http://127.0.0.1:11434";
    case "lmstudio":
      return "http://127.0.0.1:1234";
    case "openai":
      return "https://api.openai.com/v1";
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta";
    case "claude":
      return "https://api.anthropic.com/v1";
    case "perplexity":
      return "https://api.perplexity.ai";
    default:
      return "";
  }
}

function defaultScopeForProvider(provider: string): "local" | "cloud" | "generic" {
  if (provider === "ollama" || provider === "lmstudio") return "local";
  if (provider === "openai_compatible") return "generic";
  return "cloud";
}

function providerLabel(providerId: string): string {
  const found = llmProviderOptions.find((option) => option.id === providerId);
  return found ? found.label : providerId;
}

function scopeLabel(scope: string): string {
  if (scope === "local") return "Local";
  if (scope === "lan") return "LAN";
  if (scope === "cloud") return "Cloud";
  if (scope === "generic") return "Generic";
  return scope || "Profile";
}

function defaultProfileName(provider: string, scope: string): string {
  return `${providerLabel(provider)} ${scopeLabel(scope)}`;
}

function newProfileId(): string {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `profile-${suffix}`;
}

type SortDirection = "asc" | "desc";
type SortColumn = "timestamp" | "type" | "provider" | "eventId" | "severity" | "message" | "source";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

type WorkspaceTab = "home" | "events" | "crashes" | "data" | "import" | "export" | "settings" | "help";
type ExportScope = "loaded" | "custom";
type LlmResponseViewMode = "guide" | "raw";
type MessageViewMode = "raw" | "parsed";
type LoadEstimateMode = "rolling-sync" | "range-load";
type HelpSectionId =
  | "quick-start"
  | "filters"
  | "ingest-vs-backfill"
  | "coverage-warning"
  | "crash-flow"
  | "export-prompt"
  | "settings-collection";

type HelpTopicId =
  | "getting-started"
  | "navigation"
  | "home"
  | "events"
  | "crashes"
  | "data"
  | "import"
  | "export"
  | "settings-llm"
  | "security"
  | "troubleshooting";

interface HelpTopicSection {
  id: string;
  title: string;
  paragraphs: string[];
  steps?: string[];
  tips?: string[];
}

interface HelpTopic {
  id: HelpTopicId;
  label: string;
  summary: string;
  sections: HelpTopicSection[];
}

interface WorkspaceTabDescriptor {
  id: Exclude<WorkspaceTab, "help">;
  label: string;
}

interface PendingLoadEstimate {
  mode: LoadEstimateMode;
  actionLabel: string;
  description: string;
  estimate: EventLoadEstimate;
  normalizedFrom: string;
  normalizedTo: string;
}

interface LlmGuardrailBlock {
  host: string;
  message: string;
}

const workspaceTabs: WorkspaceTabDescriptor[] = [
  { id: "home", label: "Home" },
  { id: "events", label: "Events" },
  { id: "crashes", label: "Crashes" },
  { id: "data", label: "Data" },
  { id: "import", label: "Import" },
  { id: "export", label: "Export" },
  { id: "settings", label: "Settings" }
];

interface ExportWizardFilters {
  dateFrom: string;
  dateTo: string;
  severities: Record<EventSeverity, boolean>;
  logType: string;
  category: "all" | EventCategory;
  source: string;
}

interface CountMetric {
  label: string;
  value: string;
  count: number;
}

interface TimelineMetric {
  label: string;
  date: string;
  count: number;
}

interface ParsedMessageField {
  key: string;
  value: string;
}

interface OpsSummaryReport {
  totalEvents: number;
  coverageLabel: string;
  severityCounts: CountMetric[];
  topProviders: CountMetric[];
  topLogTypes: CountMetric[];
  topEventIds: CountMetric[];
  noisySources: CountMetric[];
  timeline: TimelineMetric[];
  notableSpike: string;
  selectedEventFinding: string;
}

interface PrivilegedAccessWarning {
  requiresPrivilege: boolean;
  platform: SupportedOs;
  restrictedSources: string[];
  stillCollectedNonPrivilegedData: boolean;
  title: string;
  detail: string;
  rawMessage: string;
}

const defaultExportCategoriesByOs: Record<SupportedOs, EventCategory[]> = {
  windows: ["application", "system", "security", "audit", "other"],
  linux: ["application", "system", "security", "audit", "other"],
  macos: ["application", "system", "security", "audit", "other"]
};

function createDefaultExportFilters(): ExportWizardFilters {
  return {
    dateFrom: "",
    dateTo: "",
    severities: {
      information: true,
      warning: true,
      error: true,
      critical: true
    },
    logType: "all",
    category: "all",
    source: ""
  };
}

function isHelpSectionId(value: string): value is HelpSectionId {
  return (
    value === "quick-start" ||
    value === "filters" ||
    value === "ingest-vs-backfill" ||
    value === "coverage-warning" ||
    value === "crash-flow" ||
    value === "export-prompt" ||
    value === "settings-collection"
  );
}

const severityWeight: Record<NormalizedEvent["severity"], number> = {
  information: 1,
  warning: 2,
  error: 3,
  critical: 4
};

const sortLabels: Record<SortColumn, string> = {
  timestamp: "Time",
  type: "Type",
  provider: "Provider",
  eventId: "Event ID",
  severity: "Severity",
  message: "Message",
  source: "Source"
};

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base" });
}

function getSortValue(event: NormalizedEvent, column: SortColumn): string | number {
  switch (column) {
    case "timestamp":
      return Date.parse(event.timestamp) || 0;
    case "type":
      return `${event.logName} ${event.category}`;
    case "provider":
      return event.provider;
    case "eventId":
      return event.eventId ?? -1;
    case "severity":
      return severityWeight[event.severity];
    case "message":
      return event.message;
    case "source":
      return event.imported ? "Imported" : "Live/Local";
    default:
      return "";
  }
}

function sortEvents(events: NormalizedEvent[], sortState: SortState | null): NormalizedEvent[] {
  if (!sortState) return events;

  const direction = sortState.direction === "asc" ? 1 : -1;
  return [...events].sort((left, right) => {
    const a = getSortValue(left, sortState.column);
    const b = getSortValue(right, sortState.column);
    const result = compareValues(a, b);
    return result * direction;
  });
}

function severityTint(severity: NormalizedEvent["severity"]) {
  switch (severity) {
    case "warning":
      return "bg-[var(--sev-warning)]";
    case "error":
      return "bg-[var(--sev-error)]";
    case "critical":
      return "bg-[var(--sev-critical)]";
    default:
      return "bg-[var(--sev-info)]";
  }
}

const fieldLabelsByOs: Record<SupportedOs, { logName: string; provider: string; eventId?: string }> = {
  windows: {
    logName: "Log Name",
    provider: "Provider",
    eventId: "Event ID"
  },
  macos: {
    logName: "Subsystem",
    provider: "Process"
  },
  linux: {
    logName: "Unit/Identifier",
    provider: "Process"
  }
};

function formatSelectedSummary(event: NormalizedEvent): string {
  if (event.os === "windows" && event.eventId !== undefined) {
    return `${event.provider} / ${event.eventId}`;
  }
  return `${event.provider} / ${event.logName}`;
}

function parseLocalDateStart(value: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function parseLocalDateEnd(value: string): number | null {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
}

function formatLocalDate(value: number): string {
  return new Date(value).toLocaleDateString();
}

function normalizeDateRange(from: string, to: string): { from: string; to: string } {
  if (!from || !to) return { from, to };
  return from <= to ? { from, to } : { from: to, to: from };
}

function formatDateInputValue(timestamp: number): string {
  const value = new Date(timestamp);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMetricDateLabel(date: string): string {
  return new Date(`${date}T00:00:00`).toLocaleDateString();
}

function formatExportTimestamp(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function formatBytesApprox(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function classifyLoadImpact(estimatedCount: number, estimatedBytes: number): "Fast" | "Moderate" | "Heavy" {
  if (estimatedCount >= 25000 || estimatedBytes >= 20 * 1024 * 1024) return "Heavy";
  if (estimatedCount >= 5000 || estimatedBytes >= 5 * 1024 * 1024) return "Moderate";
  return "Fast";
}

function formatEstimateWindowLabel(estimate: EventLoadEstimate): string {
  const start = new Date(estimate.windowStart);
  const end = new Date(estimate.windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return "Window unavailable";
  }
  return `${start.toLocaleString()} to ${end.toLocaleString()}`;
}

function sanitizeFileTag(value: string, fallback: string): string {
  const normalized = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) return fallback;
  return normalized.slice(0, 24);
}

function blurDateInputIfComplete(target: HTMLInputElement): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(target.value)) return;
  window.requestAnimationFrame(() => target.blur());
}

function capEvents(events: NormalizedEvent[], max: number): { kept: NormalizedEvent[]; truncated: number } {
  if (events.length <= max) return { kept: events, truncated: 0 };
  return {
    kept: events.slice(0, max),
    truncated: events.length - max
  };
}

function rankMetrics(values: Map<string, number>, limit: number): CountMetric[] {
  return Array.from(values.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([label, count]) => ({
      label,
      value: label,
      count
    }));
}

function incrementMetric(map: Map<string, number>, label: string): void {
  map.set(label, (map.get(label) ?? 0) + 1);
}

function buildTimelineMetrics(events: NormalizedEvent[], limit = 10): TimelineMetric[] {
  const buckets = new Map<string, number>();
  for (const event of events) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) continue;
    const date = formatDateInputValue(time);
    buckets.set(date, (buckets.get(date) ?? 0) + 1);
  }
  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .slice(-limit)
    .map(([date, count]) => ({
      label: formatMetricDateLabel(date),
      date,
      count
    }));
}

function normalizeFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function flattenStructuredObject(value: unknown, prefix = "", depth = 0): ParsedMessageField[] {
  if (depth > 2 || value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [
      {
        key: prefix || "items",
        value: value.map((entry) => normalizeFieldValue(entry)).join(", ")
      }
    ];
  }
  if (typeof value !== "object") {
    if (!prefix) return [];
    return [{ key: prefix, value: normalizeFieldValue(value) }];
  }

  const fields: ParsedMessageField[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const nested = flattenStructuredObject(entry, nextKey, depth + 1);
      if (nested.length > 0) {
        fields.push(...nested);
        continue;
      }
    }
    const normalized = normalizeFieldValue(entry);
    if (!normalized) continue;
    fields.push({ key: nextKey, value: normalized });
  }
  return fields;
}

function parseStructuredMessage(event: NormalizedEvent | null): ParsedMessageField[] {
  if (!event) return [];

  if (event.raw && typeof event.raw === "object" && !Array.isArray(event.raw)) {
    const rawFields = flattenStructuredObject(event.raw);
    if (rawFields.length > 0) return rawFields.slice(0, 40);
  }

  const message = event.message.trim();
  if (!message) return [];

  if ((message.startsWith("{") && message.endsWith("}")) || (message.startsWith("[") && message.endsWith("]"))) {
    try {
      const parsed = JSON.parse(message);
      const jsonFields = flattenStructuredObject(parsed);
      if (jsonFields.length > 0) return jsonFields.slice(0, 40);
    } catch {
      // fall through to line/token parsing
    }
  }

  const tokenFields = new Map<string, string>();
  const keyValuePattern = /([A-Za-z0-9_.-]{2,})=(\"[^\"]+\"|'[^']+'|[^,\s;]+)/g;
  for (const match of message.matchAll(keyValuePattern)) {
    const key = match[1]?.trim();
    const value = match[2]?.trim().replace(/^['"]|['"]$/g, "");
    if (key && value) tokenFields.set(key, value);
  }
  if (tokenFields.size > 0) {
    return Array.from(tokenFields.entries())
      .slice(0, 40)
      .map(([key, value]) => ({ key, value }));
  }

  const lineFields: ParsedMessageField[] = [];
  for (const line of message.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (key.length < 2 || !value) continue;
    lineFields.push({ key, value });
  }
  return lineFields.slice(0, 40);
}

function buildOpsSummaryReport(
  events: NormalizedEvent[],
  scopeLabel: string,
  selectedEvent: NormalizedEvent | null
): OpsSummaryReport {
  const severityMap = new Map<string, number>();
  const providerMap = new Map<string, number>();
  const logTypeMap = new Map<string, number>();
  const eventIdMap = new Map<string, number>();
  const noisySourceMap = new Map<string, number>();

  for (const event of events) {
    incrementMetric(severityMap, event.severity);
    incrementMetric(providerMap, event.provider);
    incrementMetric(logTypeMap, event.logName);
    if (typeof event.eventId === "number") {
      incrementMetric(eventIdMap, String(event.eventId));
    }
    if (event.severity !== "information") {
      incrementMetric(noisySourceMap, `${event.provider} (${event.severity})`);
    }
  }

  const timeline = buildTimelineMetrics(events, 12);
  const averageCount =
    timeline.length > 0 ? timeline.reduce((sum, entry) => sum + entry.count, 0) / timeline.length : 0;
  const peak = timeline.reduce<TimelineMetric | null>(
    (best, entry) => (!best || entry.count > best.count ? entry : best),
    null
  );
  const notableSpike =
    peak && peak.count >= Math.max(10, Math.ceil(averageCount * 1.5))
      ? `Highest activity on ${peak.label} with ${peak.count.toLocaleString()} events.`
      : timeline.length > 0
        ? "No major spike detected in the current timeline."
        : "No timeline data available.";

  const inScopeSelected = selectedEvent ? events.some((event) => event.id === selectedEvent.id) : false;
  const selectedEventFinding =
    selectedEvent && inScopeSelected
      ? `${selectedEvent.provider} | ${selectedEvent.logName}${typeof selectedEvent.eventId === "number" ? ` | Event ID ${selectedEvent.eventId}` : ""} | ${selectedEvent.severity}`
      : "No selected event included in this summary scope.";

  return {
    totalEvents: events.length,
    coverageLabel: scopeLabel,
    severityCounts: rankMetrics(severityMap, 4),
    topProviders: rankMetrics(providerMap, 6),
    topLogTypes: rankMetrics(logTypeMap, 6),
    topEventIds: rankMetrics(eventIdMap, 6),
    noisySources: rankMetrics(noisySourceMap, 6),
    timeline,
    notableSpike,
    selectedEventFinding
  };
}

function formatMetricList(metrics: CountMetric[]): string {
  if (metrics.length === 0) return "- None";
  return metrics.map((metric) => `- ${metric.label}: ${metric.count.toLocaleString()}`).join("\n");
}

function formatTimelineList(metrics: TimelineMetric[]): string {
  if (metrics.length === 0) return "- None";
  return metrics.map((metric) => `- ${metric.label}: ${metric.count.toLocaleString()} events`).join("\n");
}

function buildOpsSummaryText(report: OpsSummaryReport): string {
  return [
    "Hermes Ops Summary",
    `Generated: ${new Date().toLocaleString()}`,
    `Scope: ${report.coverageLabel}`,
    `Total Events: ${report.totalEvents.toLocaleString()}`,
    "",
    "1) Severity Mix",
    formatMetricList(report.severityCounts),
    "",
    "2) Top Providers",
    formatMetricList(report.topProviders),
    "",
    "3) Top Log Types",
    formatMetricList(report.topLogTypes),
    "",
    "4) Top Event IDs",
    formatMetricList(report.topEventIds),
    "",
    "5) Noisy Sources",
    formatMetricList(report.noisySources),
    "",
    "6) Activity Timeline",
    formatTimelineList(report.timeline),
    "",
    "7) Notable Spike",
    report.notableSpike,
    "",
    "8) Selected Event Finding",
    report.selectedEventFinding
  ].join("\n");
}

function buildOpsSummaryHtml(report: OpsSummaryReport): string {
  const renderMetricItems = (items: Array<CountMetric | TimelineMetric>) =>
    items.length === 0
      ? "<li>None</li>"
      : items
          .map((item) =>
            "date" in item
              ? `<li>${escapeHtml(item.label)}: ${item.count.toLocaleString()} events</li>`
              : `<li>${escapeHtml(item.label)}: ${item.count.toLocaleString()}</li>`
          )
          .join("");
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<title>Hermes Ops Summary</title>",
    "<style>",
    "body{font-family:Segoe UI,Arial,sans-serif;line-height:1.45;color:#111827;margin:32px;}",
    "h1{margin:0 0 6px 0;font-size:24px;} h2{margin:18px 0 6px 0;font-size:16px;} ul{margin:6px 0 0 20px;}",
    ".meta{color:#4b5563;font-size:12px;margin-bottom:14px;} .card{border:1px solid #d1d5db;padding:12px 14px;border-radius:8px;margin-bottom:10px;}",
    "</style></head><body>",
    "<h1>Hermes Ops Summary</h1>",
    `<div class="meta">Generated: ${escapeHtml(new Date().toLocaleString())}<br/>Scope: ${escapeHtml(
      report.coverageLabel
    )}<br/>Total Events: ${report.totalEvents.toLocaleString()}</div>`,
    `<div class="card"><h2>1) Severity Mix</h2><ul>${renderMetricItems(report.severityCounts)}</ul></div>`,
    `<div class="card"><h2>2) Top Providers</h2><ul>${renderMetricItems(report.topProviders)}</ul></div>`,
    `<div class="card"><h2>3) Top Log Types</h2><ul>${renderMetricItems(report.topLogTypes)}</ul></div>`,
    `<div class="card"><h2>4) Top Event IDs</h2><ul>${renderMetricItems(report.topEventIds)}</ul></div>`,
    `<div class="card"><h2>5) Noisy Sources</h2><ul>${renderMetricItems(report.noisySources)}</ul></div>`,
    `<div class="card"><h2>6) Activity Timeline</h2><ul>${renderMetricItems(report.timeline)}</ul></div>`,
    `<div class="card"><h2>7) Notable Spike</h2><div>${escapeHtml(report.notableSpike)}</div></div>`,
    `<div class="card"><h2>8) Selected Event Finding</h2><div>${escapeHtml(report.selectedEventFinding)}</div></div>`,
    "</body></html>"
  ].join("");
}

function summarizeCollectorWarnings(warnings: string[]): string {
  const preview = warnings.slice(0, 2).join(" ");
  const suffix =
    warnings.length > 2 ? ` (+${warnings.length - 2} more; see diagnostics logs.)` : " (see diagnostics logs).";
  return `${preview}${suffix}`;
}

function classifyPrivilegedAccessWarning(
  platform: SupportedOs,
  warnings: string[],
  collected: number
): PrivilegedAccessWarning | null {
  if (warnings.length === 0) return null;

  const joined = warnings.join(" ");
  const lower = joined.toLowerCase();
  const stillCollectedNonPrivilegedData = collected > 0;

  if (platform === "windows") {
    const channelMatches = Array.from(joined.matchAll(/Windows '([^']+)' channel/gi));
    const restrictedSources = Array.from(
      new Set(
        channelMatches
          .map((match) => match[1]?.trim())
          .filter((value): value is string => Boolean(value))
      )
    );
    const requiresPrivilege =
      /access denied reading windows/i.test(joined) ||
      /check channel permissions/i.test(joined) ||
      restrictedSources.some((source) => source.toLowerCase() === "security");
    if (!requiresPrivilege) return null;

    const mentionsSecurity = restrictedSources.some((source) => source.toLowerCase() === "security");
    return {
      requiresPrivilege: true,
      platform,
      restrictedSources: restrictedSources.length > 0 ? restrictedSources : mentionsSecurity ? ["Security"] : ["restricted Windows logs"],
      stillCollectedNonPrivilegedData,
      title: mentionsSecurity
        ? "Security logs require Administrator rights."
        : "Some Windows event logs require Administrator rights.",
      detail: stillCollectedNonPrivilegedData
        ? "Accessible channels were still collected. Restart elevated to include the restricted Windows logs."
        : "The requested Windows logs could not be collected without Administrator rights.",
      rawMessage: summarizeCollectorWarnings(warnings)
    };
  }

  if (platform === "linux") {
    const requiresPrivilege =
      /journalctl requires elevated access/i.test(joined) ||
      /journal-reader privileges/i.test(joined) ||
      /permission denied/i.test(lower) ||
      /operation not permitted/i.test(lower) ||
      /access denied/i.test(lower);
    if (!requiresPrivilege) return null;

    return {
      requiresPrivilege: true,
      platform,
      restrictedSources: ["journal/system logs"],
      stillCollectedNonPrivilegedData,
      title: "Some journal/system logs require elevated access.",
      detail: stillCollectedNonPrivilegedData
        ? "Accessible logs were still collected. Restart elevated to include the restricted journal or system logs."
        : "The requested journal or system logs could not be collected without elevated access.",
      rawMessage: summarizeCollectorWarnings(warnings)
    };
  }

  if (platform === "macos") {
    const requiresPrivilege =
      /macos log collection requires elevated access/i.test(joined) ||
      /not authorized/i.test(lower) ||
      /permission denied/i.test(lower) ||
      /operation not permitted/i.test(lower) ||
      /administrator privileges/i.test(lower);
    if (!requiresPrivilege) return null;

    return {
      requiresPrivilege: true,
      platform,
      restrictedSources: ["system logs"],
      stillCollectedNonPrivilegedData,
      title: "Some system logs require elevated access.",
      detail: stillCollectedNonPrivilegedData
        ? "Accessible logs were still collected. Restart elevated to include the restricted macOS system logs."
        : "The requested macOS system logs could not be collected without elevated access.",
      rawMessage: summarizeCollectorWarnings(warnings)
    };
  }

  return null;
}

function buildEventContextText(
  event: NormalizedEvent,
  hostOsVersion: string,
  redact = true
): string {
  const safe = (value: string) => (redact ? redactSensitiveText(value) : value);
  return [
    `OS: ${safe(event.os)}`,
    `OS Version: ${safe(hostOsVersion || "Unknown")}`,
    `Timestamp: ${safe(event.timestamp)}`,
    `Type: ${safe(event.logName)} / ${safe(event.category)}`,
    `Provider: ${safe(event.provider)}`,
    `Event ID: ${event.eventId ?? "N/A"}`,
    `Severity: ${safe(event.severity)}`,
    `Message: ${safe(event.message)}`
  ].join("\n");
}

interface LlmAnalysisGuide {
  summary: string;
  likelyCauses: string[];
  riskLevel: string;
  securityImpact: string;
  verifyFirst: string[];
  remediationOptions: string[];
  escalateIf: string[];
  confidence: string;
  missingData: string[];
  cleanedRaw: string;
}

const llmGuideSectionMatchers: Array<{
  key:
    | "summary"
    | "likelyCauses"
    | "riskLevel"
    | "securityImpact"
    | "verifyFirst"
    | "remediationOptions"
    | "escalateIf"
    | "confidence"
    | "missingData";
  regex: RegExp;
}> = [
  { key: "summary", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?summary\b[:\-]*/i },
  { key: "likelyCauses", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?likely causes?\b[:\-]*/i },
  { key: "riskLevel", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?risk level\b[:\-]*/i },
  { key: "securityImpact", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?security impact\b[:\-]*/i },
  { key: "verifyFirst", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?verify first\b[:\-]*/i },
  { key: "remediationOptions", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?remediation options?\b[:\-]*/i },
  { key: "escalateIf", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?escalate if\b[:\-]*/i },
  { key: "confidence", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?confidence\b[:\-]*/i },
  { key: "missingData", regex: /^(?:#+\s*)?(?:\d+[.)]\s*)?missing data\b[:\-]*/i }
];

function stripLlmScratchpadNoise(raw: string): string {
  const noisyPrefix = /^(?:\*+\s*)?(?:wait|let'?s|lets|okay\b|i need to|i will|self-correction|rule \d+|date anomaly|security flag)\b/i;
  return raw
    .replace(/\r/g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      const normalized = trimmed.replace(/^[>\-*•\s]+/, "");
      return !noisyPrefix.test(normalized);
    })
    .join("\n")
    .trim();
}

function extractGuideItem(line: string): string {
  return line
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function parseLlmGuide(raw: string): LlmAnalysisGuide {
  const cleanedRaw = stripLlmScratchpadNoise(raw);
  const buckets = {
    summary: [] as string[],
    likelyCauses: [] as string[],
    riskLevel: [] as string[],
    securityImpact: [] as string[],
    verifyFirst: [] as string[],
    remediationOptions: [] as string[],
    escalateIf: [] as string[],
    confidence: [] as string[],
    missingData: [] as string[]
  };
  const preface: string[] = [];
  let currentKey: keyof typeof buckets | null = null;

  for (const sourceLine of cleanedRaw.split("\n")) {
    const line = sourceLine.trim();
    if (!line) continue;

    const matchedSection = llmGuideSectionMatchers.find((entry) => entry.regex.test(line));
    if (matchedSection) {
      currentKey = matchedSection.key;
      const remainder = extractGuideItem(line.replace(matchedSection.regex, "").trim());
      if (remainder) buckets[currentKey].push(remainder);
      continue;
    }

    const item = extractGuideItem(line);
    if (!item) continue;
    if (currentKey) {
      buckets[currentKey].push(item);
    } else {
      preface.push(item);
    }
  }

  const summary = buckets.summary[0] ?? preface[0] ?? "No summary returned.";
  const riskLevel = buckets.riskLevel[0] ?? "Not specified.";
  const securityImpact = buckets.securityImpact[0] ?? "Not specified.";
  const confidence = buckets.confidence[0] ?? "Not specified.";

  const likelyCauses = buckets.likelyCauses.slice(0, 3);
  const verifyFirst = buckets.verifyFirst.slice(0, 6);
  const remediationOptions = buckets.remediationOptions.slice(0, 6);
  const escalateIf = buckets.escalateIf.slice(0, 4);
  const missingData = buckets.missingData.slice(0, 6);

  return {
    summary,
    likelyCauses,
    riskLevel,
    securityImpact,
    verifyFirst,
    remediationOptions,
    escalateIf,
    confidence,
    missingData,
    cleanedRaw
  };
}

function formatGuideList(items: string[]): string {
  if (items.length === 0) return "- Not provided";
  return items.map((item) => `- ${item}`).join("\n");
}

function buildGuidePlainText(
  guide: LlmAnalysisGuide,
  result: LlmAnalysisResult
): string {
  return [
    "Hermes Troubleshooting Guide",
    `Generated: ${new Date().toLocaleString()}`,
    `Provider: ${result.profileName}`,
    `Model: ${result.model}`,
    "",
    "1) Summary",
    guide.summary,
    "",
    "2) Likely Causes",
    formatGuideList(guide.likelyCauses),
    "",
    "3) Risk Level",
    guide.riskLevel,
    "",
    "4) Security Impact",
    guide.securityImpact,
    "",
    "5) Verify First",
    formatGuideList(guide.verifyFirst),
    "",
    "6) Remediation Options",
    formatGuideList(guide.remediationOptions),
    "",
    "7) Escalate If",
    formatGuideList(guide.escalateIf),
    "",
    "8) Confidence",
    guide.confidence,
    "",
    "9) Missing Data",
    formatGuideList(guide.missingData)
  ].join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function buildGuideHtml(guide: LlmAnalysisGuide, result: LlmAnalysisResult): string {
  const list = (items: string[]) =>
    items.length === 0
      ? "<li>Not provided</li>"
      : items.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"/>",
    "<title>Hermes Troubleshooting Guide</title>",
    "<style>",
    "body{font-family:Segoe UI,Arial,sans-serif;line-height:1.45;color:#111827;margin:32px;}",
    "h1{margin:0 0 6px 0;font-size:24px;} h2{margin:18px 0 6px 0;font-size:16px;}",
    ".meta{color:#4b5563;font-size:12px;margin-bottom:14px;} ul{margin:6px 0 0 20px;}",
    ".card{border:1px solid #d1d5db;padding:12px 14px;border-radius:8px;margin-bottom:10px;}",
    "</style></head><body>",
    "<h1>Hermes Troubleshooting Guide</h1>",
    `<div class="meta">Generated: ${escapeHtml(new Date().toLocaleString())}<br/>Provider: ${escapeHtml(
      result.profileName
    )}<br/>Model: ${escapeHtml(result.model)}</div>`,
    `<div class="card"><h2>1) Summary</h2><div>${escapeHtml(guide.summary)}</div></div>`,
    `<div class="card"><h2>2) Likely Causes</h2><ul>${list(guide.likelyCauses)}</ul></div>`,
    `<div class="card"><h2>3) Risk Level</h2><div>${escapeHtml(guide.riskLevel)}</div></div>`,
    `<div class="card"><h2>4) Security Impact</h2><div>${escapeHtml(guide.securityImpact)}</div></div>`,
    `<div class="card"><h2>5) Verify First</h2><ul>${list(guide.verifyFirst)}</ul></div>`,
    `<div class="card"><h2>6) Remediation Options</h2><ul>${list(guide.remediationOptions)}</ul></div>`,
    `<div class="card"><h2>7) Escalate If</h2><ul>${list(guide.escalateIf)}</ul></div>`,
    `<div class="card"><h2>8) Confidence</h2><div>${escapeHtml(guide.confidence)}</div></div>`,
    `<div class="card"><h2>9) Missing Data</h2><ul>${list(guide.missingData)}</ul></div>`,
    "</body></html>"
  ].join("");
}

function renderInlineMarkdown(value: string, keyPrefix: string) {
  const segments = value.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return segments.map((segment, index) => {
    if (segment.startsWith("**") && segment.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-b-${index}`} className="font-semibold text-text">
          {segment.slice(2, -2)}
        </strong>
      );
    }
    if (segment.startsWith("`") && segment.endsWith("`")) {
      return (
        <code
          key={`${keyPrefix}-c-${index}`}
          className="rounded bg-black/10 px-1 py-0.5 font-mono text-[0.95em] text-text"
        >
          {segment.slice(1, -1)}
        </code>
      );
    }
    return <span key={`${keyPrefix}-t-${index}`}>{segment}</span>;
  });
}

function isMarkdownBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return (
    /^#{1,6}\s+/.test(trimmed) ||
    /^\d+\.\s+/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    trimmed.startsWith("```")
  );
}

function renderMarkdownPreview(markdown: string) {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const blocks: JSX.Element[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <pre
          key={`md-block-${key++}`}
          className="overflow-x-auto rounded-md border border-panel-border bg-[var(--field-bg)] px-3 py-2 font-mono text-xs text-text"
        >
          {codeLines.join("\n")}
        </pre>
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\.\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^\d+\.\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ol key={`md-block-${key++}`} className="ml-5 list-decimal space-y-1">
          {items.map((item, itemIndex) => (
            <li key={`md-li-${itemIndex}`} className="text-sm leading-6 text-text">
              {renderInlineMarkdown(item, `md-ol-${key}-${itemIndex}`)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ""));
        index += 1;
      }
      blocks.push(
        <ul key={`md-block-${key++}`} className="ml-5 list-disc space-y-1">
          {items.map((item, itemIndex) => (
            <li key={`md-li-${itemIndex}`} className="text-sm leading-6 text-text">
              {renderInlineMarkdown(item, `md-ul-${key}-${itemIndex}`)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2].trim();
      const headingClass =
        level <= 2
          ? "text-base font-semibold text-text"
          : level === 3
            ? "text-sm font-semibold text-text"
            : "text-sm font-semibold text-muted";
      blocks.push(
        <div key={`md-block-${key++}`} className={headingClass}>
          {renderInlineMarkdown(content, `md-head-${key}`)}
        </div>
      );
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      blocks.push(
        <blockquote
          key={`md-block-${key++}`}
          className="border-l-2 border-panel-border pl-3 text-sm italic leading-6 text-muted"
        >
          {renderInlineMarkdown(trimmed.replace(/^>\s?/, ""), `md-quote-${key}`)}
        </blockquote>
      );
      index += 1;
      continue;
    }

    const paragraphLines = [trimmed];
    index += 1;
    while (index < lines.length && !isMarkdownBlockBoundary(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }
    blocks.push(
      <p key={`md-block-${key++}`} className="text-sm leading-6 text-text">
        {renderInlineMarkdown(paragraphLines.join(" "), `md-p-${key}`)}
      </p>
    );
  }

  if (blocks.length === 0) {
    return <p className="text-sm text-muted">No response yet.</p>;
  }
  return <div className="space-y-2">{blocks}</div>;
}

function buildLlmShareBundle(
  eventContextRedacted: string,
  promptRedacted: string,
  result: LlmAnalysisResult
): string {
  return [
    "Hermes LLM Analysis Share",
    `Generated: ${new Date().toLocaleString()}`,
    "",
    "Event Context (redacted):",
    eventContextRedacted.trim() || "(no context)",
    "",
    "Prompt Used:",
    promptRedacted.trim() || "(no prompt)",
    "",
    `Analysis Response (${result.profileName} | ${result.model}):`,
    result.response.trim() || "(no response)"
  ].join("\n");
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [hostOs, setHostOs] = useState<SupportedOs>(browserDefaultOs);
  const [hostOsVersion, setHostOsVersion] = useState<string>("Unknown");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("home");
  const [targetHostId, setTargetHostId] = useState<string>("localhost");
  const [remoteSelectedId, setRemoteSelectedId] = useState<string>("");
  const [remoteSettings, setRemoteSettingsState] = useState<RemoteSettings>({ profiles: [] });
  useEffect(() => {
    if (isTauriRuntime()) {
      getRemoteSettings().then(setRemoteSettingsState).catch(console.error);
    }
  }, []);

  const [helpTabOpen, setHelpTabOpen] = useState(false);
  const [activeHelpTopic, setActiveHelpTopic] = useState<HelpTopicId>("getting-started");
  const [filterDraft, setFilterDraft] = useState<EventFilters>(createDefaultFilters);
  const [activeFilters, setActiveFilters] = useState<EventFilters>(createDefaultFilters);
  const [localEvents, setLocalEvents] = useState<NormalizedEvent[]>([]);
  const [importedEvents, setImportedEvents] = useState<NormalizedEvent[]>([]);
  const [crashes, setCrashes] = useState<CrashRecord[]>([]);
  const [selectedCrashId, setSelectedCrashId] = useState<string>("");
  const [correlatedEvents, setCorrelatedEvents] = useState<NormalizedEvent[]>([]);
  const [preCrashEvents, setPreCrashEvents] = useState<NormalizedEvent[]>([]);
  const [preCrashWindowMinutes, setPreCrashWindowMinutes] = useState<number>(15);
  const [preCrashFocusEnabled, setPreCrashFocusEnabled] = useState(false);
  const [selected, setSelected] = useState<NormalizedEvent | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [exportScope, setExportScope] = useState<ExportScope>("loaded");
  const [exportFormat, setExportFormat] = useState<ExportFormat>("json");
  const [exportFilters, setExportFilters] = useState<ExportWizardFilters>(createDefaultExportFilters);
  const [ingestWindowDays, setIngestWindowDaysState] = useState<number>(7);
  const [ingestProfile, setIngestProfileState] = useState<IngestProfile>({
    autoSyncOnStartup: false,
    maxEventsPerSync: 2000,
    windowsChannels: ["Application", "System", "Security"],
    requestElevation: false
  });
  const [llmSettings, setLlmSettingsState] = useState<LlmSettings>(createDefaultLlmSettings);
  const [llmSelectedProfileId, setLlmSelectedProfileId] = useState<string>("");
  const [llmApiKeyDraft, setLlmApiKeyDraft] = useState<string>("");
  const [llmCandidates, setLlmCandidates] = useState<LlmEndpointCandidate[]>([]);
  const [llmNetworks, setLlmNetworks] = useState<LlmNetworkInterface[]>([]);
  const [llmSelectedNetworkId, setLlmSelectedNetworkId] = useState<string>("");
  const [llmIncludeNonPrivateInterfaces, setLlmIncludeNonPrivateInterfaces] = useState(false);
  const [llmIncludeLoopbackInterfaces, setLlmIncludeLoopbackInterfaces] = useState(false);
  const [isDetectingNetworks, setIsDetectingNetworks] = useState(false);
  const [isScanningLan, setIsScanningLan] = useState(false);
  const [isTestingLlmProfile, setIsTestingLlmProfile] = useState(false);
  const [llmTestResult, setLlmTestResult] = useState<LlmConnectionTestResult | null>(null);
  const [backfillFrom, setBackfillFrom] = useState("");
  const [backfillTo, setBackfillTo] = useState("");
  const [pendingLoadEstimate, setPendingLoadEstimate] = useState<PendingLoadEstimate | null>(null);
  const [isEstimatingLoad, setIsEstimatingLoad] = useState(false);
  const [rangeViewActive, setRangeViewActive] = useState(false);
  const [rangeLoadMessage, setRangeLoadMessage] = useState<string>("");
  const [isRangeLoading, setIsRangeLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string>("");
  const [collectorWarning, setCollectorWarning] = useState<string>("");
  const [privilegedAccessWarning, setPrivilegedAccessWarning] = useState<PrivilegedAccessWarning | null>(null);
  const [isRestartingElevated, setIsRestartingElevated] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState<string>("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [copyEventTextStatus, setCopyEventTextStatus] = useState<"idle" | "copied">("idle");
  const [messageViewMode, setMessageViewMode] = useState<MessageViewMode>("raw");
  const [llmWindowOpen, setLlmWindowOpen] = useState(false);
  const [llmPromptDraft, setLlmPromptDraft] = useState("");
  const [llmPromptWasRedacted, setLlmPromptWasRedacted] = useState(false);
  const [llmPromptPreRedactionDraft, setLlmPromptPreRedactionDraft] = useState("");
  const [llmRunProfileId, setLlmRunProfileId] = useState("");
  const [llmRunResult, setLlmRunResult] = useState<LlmAnalysisResult | null>(null);
  const [llmRunError, setLlmRunError] = useState<string>("");
  const [llmGuardrailBlock, setLlmGuardrailBlock] = useState<LlmGuardrailBlock | null>(null);
  const [llmResponseViewMode, setLlmResponseViewMode] = useState<LlmResponseViewMode>("guide");
  const [isRunningLlmAnalysis, setIsRunningLlmAnalysis] = useState(false);
  const [exportStatus, setExportStatus] = useState<string>("");
  const tableContainerRef = useRef<HTMLElement | null>(null);
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(540);

  document.documentElement.dataset.theme = theme;

  const filtered = useMemo(
    () => [...applyFilters(importedEvents, activeFilters), ...applyFilters(localEvents, activeFilters)],
    [importedEvents, localEvents, activeFilters]
  );
  const allEvents = useMemo(() => [...importedEvents, ...localEvents], [importedEvents, localEvents]);
  const visibleEvents = useMemo(() => sortEvents(filtered, sortState), [filtered, sortState]);
  const crashVisibleEvents = useMemo(() => sortEvents(preCrashEvents, sortState), [preCrashEvents, sortState]);
  const correlatedVisibleEvents = useMemo(() => sortEvents(correlatedEvents, sortState), [correlatedEvents, sortState]);
  const useCrashCorrelatedFallback = useMemo(() => {
    return preCrashFocusEnabled && crashVisibleEvents.length === 0 && correlatedVisibleEvents.length > 0;
  }, [preCrashFocusEnabled, crashVisibleEvents.length, correlatedVisibleEvents.length]);
  const crashResultsModeLabel = useMemo(() => {
    if (!preCrashFocusEnabled) return "Pre-crash results: not started";
    if (useCrashCorrelatedFallback) return "Showing correlated fallback results (+/-15m window)";
    return `Showing strict pre-crash results (${preCrashWindowMinutes} min window)`;
  }, [preCrashFocusEnabled, preCrashWindowMinutes, useCrashCorrelatedFallback]);
  const tableEvents = useMemo(() => {
    if (activeTab === "crashes") {
      return useCrashCorrelatedFallback ? correlatedVisibleEvents : crashVisibleEvents;
    }
    return visibleEvents;
  }, [activeTab, crashVisibleEvents, correlatedVisibleEvents, useCrashCorrelatedFallback, visibleEvents]);
  const dashboardRecentEvents = useMemo(() => {
    return [...allEvents]
      .sort((left, right) => (Date.parse(right.timestamp) || 0) - (Date.parse(left.timestamp) || 0))
      .slice(0, 8);
  }, [allEvents]);
  const dashboardTimeline = useMemo(() => buildTimelineMetrics(allEvents, 10), [allEvents]);
  const dashboardSeverityMetrics = useMemo(() => {
    const values = new Map<string, number>();
    for (const event of allEvents) incrementMetric(values, event.severity);
    return rankMetrics(values, 4);
  }, [allEvents]);
  const dashboardProviderMetrics = useMemo(() => {
    const values = new Map<string, number>();
    for (const event of allEvents) incrementMetric(values, event.provider);
    return rankMetrics(values, 6);
  }, [allEvents]);
  const dashboardLogTypeMetrics = useMemo(() => {
    const values = new Map<string, number>();
    for (const event of allEvents) incrementMetric(values, event.logName);
    return rankMetrics(values, 6);
  }, [allEvents]);
  const dashboardEventIdMetrics = useMemo(() => {
    const values = new Map<string, number>();
    for (const event of allEvents) {
      if (typeof event.eventId === "number") incrementMetric(values, String(event.eventId));
    }
    return rankMetrics(values, 6);
  }, [allEvents]);
  const dashboardNoisySources = useMemo(() => {
    const values = new Map<string, number>();
    for (const event of allEvents) {
      if (event.severity === "information") continue;
      incrementMetric(values, `${event.provider} (${event.severity})`);
    }
    return rankMetrics(values, 6);
  }, [allEvents]);
  const hasWindowsEvents = useMemo(() => {
    if (localEvents.some((event) => event.os === "windows")) return true;
    return importedEvents.some((event) => event.os === "windows");
  }, [importedEvents, localEvents]);
  const logTypes = useMemo(() => {
    const values = new Set<string>();
    for (const event of localEvents) {
      if (event.logName.trim()) values.add(event.logName);
    }
    for (const event of importedEvents) {
      if (event.logName.trim()) values.add(event.logName);
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [importedEvents, localEvents]);
  const hostOsEventPool = useMemo(
    () => allEvents.filter((event) => event.os === hostOs),
    [allEvents, hostOs]
  );
  const llmSelectedProfile = useMemo(() => {
    if (llmSettings.profiles.length === 0) return null;
    const found = llmSettings.profiles.find((profile) => profile.id === llmSelectedProfileId);
    return found ?? llmSettings.profiles[0];
  }, [llmSelectedProfileId, llmSettings.profiles]);
  const llmLocalProfiles = useMemo(
    () =>
      llmSettings.profiles.filter((profile) =>
        profile.enabled &&
        (profile.provider === "ollama" ||
          profile.provider === "lmstudio" ||
          profile.provider === "openai_compatible")
      ),
    [llmSettings.profiles]
  );
  const selectedHelpTopic = useMemo(
    () => helpTopics.find((topic) => topic.id === activeHelpTopic) ?? helpTopics[0],
    [activeHelpTopic]
  );
  const selectedEventOriginalContext = useMemo(
    () => (selected ? buildEventContextText(selected, hostOsVersion, false) : ""),
    [hostOsVersion, selected]
  );
  const selectedEventRedactedContext = useMemo(
    () => redactSensitiveText(selectedEventOriginalContext),
    [selectedEventOriginalContext]
  );
  const selectedEventParsedFields = useMemo(() => parseStructuredMessage(selected), [selected]);
  const llmParsedGuide = useMemo(
    () => parseLlmGuide(llmRunResult?.response ?? ""),
    [llmRunResult?.response]
  );
  const exportCategoryOptions = useMemo(() => {
    const values = new Set<EventCategory>();
    for (const event of hostOsEventPool) {
      values.add(event.category);
    }
    if (values.size === 0) {
      return defaultExportCategoriesByOs[hostOs];
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [hostOs, hostOsEventPool]);
  const exportLogTypeOptions = useMemo(() => {
    const values = new Set<string>();
    for (const event of hostOsEventPool) {
      if (event.logName.trim()) values.add(event.logName);
    }
    // On Windows, include configured channels even when no rows are currently loaded
    // so custom export can explicitly target them and surface clear zero-match diagnostics.
    if (hostOs === "windows") {
      for (const channel of ingestProfile.windowsChannels) {
        const trimmed = channel.trim();
        if (trimmed) values.add(trimmed);
      }
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [hostOs, hostOsEventPool, ingestProfile.windowsChannels]);
  const customExportEvents = useMemo(() => {
    let start = parseLocalDateStart(exportFilters.dateFrom);
    let end = parseLocalDateEnd(exportFilters.dateTo);
    if (start !== null && end !== null && start > end) {
      const swapped = start;
      start = end;
      end = swapped;
    }

    return hostOsEventPool.filter((event) => {
      if (!exportFilters.severities[event.severity]) return false;
      if (exportFilters.logType !== "all" && event.logName !== exportFilters.logType) return false;
      if (exportFilters.category !== "all" && event.category !== exportFilters.category) return false;
      if (
        exportFilters.source.trim() &&
        !event.provider.toLowerCase().includes(exportFilters.source.toLowerCase())
      ) {
        return false;
      }

      const eventTime = Date.parse(event.timestamp);
      if (start !== null && eventTime < start) return false;
      if (end !== null && eventTime > end) return false;
      return true;
    });
  }, [exportFilters, hostOsEventPool]);
  const exportPreviewEvents = useMemo(() => {
    if (exportScope === "loaded") return allEvents;
    return customExportEvents;
  }, [allEvents, customExportEvents, exportScope]);
  const exportScopeLabel = useMemo(() => {
    if (exportScope === "loaded") {
      return `Current loaded list (${exportPreviewEvents.length.toLocaleString()} events)`;
    }
    return `Custom filtered export (${exportPreviewEvents.length.toLocaleString()} events)`;
  }, [exportPreviewEvents.length, exportScope]);
  const exportOpsSummary = useMemo(
    () => buildOpsSummaryReport(exportPreviewEvents, exportScopeLabel, selected),
    [exportPreviewEvents, exportScopeLabel, selected]
  );
  const currentTargetOs = useMemo<SupportedOs>(() => {
    if (targetHostId === "localhost") return hostOs;
    const selectedProfile = remoteSettings.profiles.find((profile) => profile.id === targetHostId);
    const remoteOs = selectedProfile?.os?.toLowerCase();
    return remoteOs === "windows" || remoteOs === "linux" || remoteOs === "macos" ? remoteOs : hostOs;
  }, [hostOs, remoteSettings.profiles, targetHostId]);
  const hostOsCoverage = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;
    for (const event of hostOsEventPool) {
      const value = Date.parse(event.timestamp);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
      count += 1;
    }
    if (count === 0) return null;
    return { start: min, end: max, count };
  }, [hostOsEventPool]);
  const exportPreviewExplanation = useMemo(() => {
    if (exportScope === "loaded") {
      if (allEvents.length === 0) {
        return "No events are currently loaded. Click Refresh Logs or import a file first.";
      }
      return `Exporting the current loaded list (${allEvents.length.toLocaleString()} events).`;
    }

    if (hostOsEventPool.length === 0) {
      return `No ${hostOs} events are loaded yet. Refresh logs first.`;
    }

    const enabledSeverities = (["information", "warning", "error", "critical"] as EventSeverity[]).filter(
      (level) => exportFilters.severities[level]
    );
    if (enabledSeverities.length === 0) {
      return "Custom export is empty because all severities are unchecked.";
    }

    const messages: string[] = [];
    let working = hostOsEventPool;

    let start = parseLocalDateStart(exportFilters.dateFrom);
    let end = parseLocalDateEnd(exportFilters.dateTo);
    if (start !== null && end !== null && start > end) {
      const swapped = start;
      start = end;
      end = swapped;
    }
    if (start !== null || end !== null) {
      const narrowed = working.filter((event) => {
        const eventTime = Date.parse(event.timestamp);
        if (start !== null && eventTime < start) return false;
        if (end !== null && eventTime > end) return false;
        return true;
      });
      if (narrowed.length === 0) {
        if (
          hostOsCoverage &&
          ((end !== null && end < hostOsCoverage.start) || (start !== null && start > hostOsCoverage.end))
        ) {
          messages.push(
            `Date range is outside loaded ${hostOs} coverage (${formatLocalDate(hostOsCoverage.start)} - ${formatLocalDate(hostOsCoverage.end)}).`
          );
        } else {
          messages.push("Date range filter currently matches no loaded events.");
        }
      }
      working = narrowed;
    }

    if (exportFilters.logType !== "all") {
      const narrowed = working.filter((event) => event.logName === exportFilters.logType);
      if (narrowed.length === 0) {
        messages.push(`Log type '${exportFilters.logType}' matches no events after prior filters.`);
      }
      working = narrowed;
    }

    if (exportFilters.category !== "all") {
      const narrowed = working.filter((event) => event.category === exportFilters.category);
      if (narrowed.length === 0) {
        messages.push(`Category '${exportFilters.category}' matches no events after prior filters.`);
      }
      working = narrowed;
    }

    if (exportFilters.source.trim()) {
      const query = exportFilters.source.toLowerCase();
      const narrowed = working.filter((event) => event.provider.toLowerCase().includes(query));
      if (narrowed.length === 0) {
        messages.push(`Provider/source filter '${exportFilters.source}' matches no events after prior filters.`);
      }
      working = narrowed;
    }

    {
      const narrowed = working.filter((event) => exportFilters.severities[event.severity]);
      if (narrowed.length === 0) {
        messages.push("Selected severities match no events after prior filters.");
      }
      working = narrowed;
    }

    if (working.length > 0) {
      return `Custom export ready: ${working.length.toLocaleString()} events match current filters.`;
    }
    if (messages.length > 0) {
      return `Custom export is empty. ${messages[0]}`;
    }
    return "Custom export is empty with the current filter combination.";
  }, [allEvents, exportFilters, exportScope, hostOs, hostOsCoverage, hostOsEventPool]);
  const hasPendingFilterChanges = useMemo(
    () => JSON.stringify(filterDraft) !== JSON.stringify(activeFilters),
    [filterDraft, activeFilters]
  );
  const localCoverage = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;

    for (const event of localEvents) {
      const time = Date.parse(event.timestamp);
      if (!Number.isFinite(time)) continue;
      if (time < min) min = time;
      if (time > max) max = time;
      count += 1;
    }

    if (count === 0) return null;
    return { start: min, end: max, count };
  }, [localEvents]);
  const localCoverageSummary = useMemo(() => {
    if (!localCoverage) {
      return "Local cache coverage: unavailable until logs are synced.";
    }
    return `Local cache coverage: ${formatLocalDate(localCoverage.start)} - ${formatLocalDate(localCoverage.end)} (${localCoverage.count.toLocaleString()} events).`;
  }, [localCoverage]);
  const activeDateCoverageWarning = useMemo(() => {
    if (!localCoverage) return "";

    let start = parseLocalDateStart(activeFilters.dateFrom);
    let end = parseLocalDateEnd(activeFilters.dateTo);
    if (start === null && end === null) return "";

    if (start !== null && end !== null && start > end) {
      const swapped = start;
      start = end;
      end = swapped;
    }

    const fullyOutside =
      (end !== null && end < localCoverage.start) ||
      (start !== null && start > localCoverage.end);
    if (fullyOutside) {
      return `Date filters are outside local cache coverage (${formatLocalDate(localCoverage.start)} - ${formatLocalDate(localCoverage.end)}). Filters only apply to loaded local data. Use Data Window -> Load Events (or increase Ingest Window days) to include older dates.`;
    }

    const startsBefore = start !== null && start < localCoverage.start;
    const endsAfter = end !== null && end > localCoverage.end;
    if (startsBefore || endsAfter) {
      return `Date filters extend beyond local cache coverage (${formatLocalDate(localCoverage.start)} - ${formatLocalDate(localCoverage.end)}). Results only include currently loaded local data. Use Data Window -> Load Events (or increase Ingest Window days) for full range coverage.`;
    }

    return "";
  }, [activeFilters.dateFrom, activeFilters.dateTo, localCoverage]);
  const coverageAutoLoadRange = useMemo(() => {
    const from = activeFilters.dateFrom || activeFilters.dateTo;
    const to = activeFilters.dateTo || activeFilters.dateFrom;
    if (!from || !to) return null;
    return normalizeDateRange(from, to);
  }, [activeFilters.dateFrom, activeFilters.dateTo]);
  const selectedCrash = useMemo(
    () => crashes.find((crash) => crash.id === selectedCrashId) ?? null,
    [crashes, selectedCrashId]
  );
  const selectedDetails = useMemo(() => {
    if (!selected) return [];
    const labels = fieldLabelsByOs[selected.os];
    const details = [
      { label: "OS", value: selected.os.toUpperCase() },
      { label: "Timestamp", value: new Date(selected.timestamp).toLocaleString() },
      { label: labels.logName, value: selected.logName },
      { label: "Category", value: selected.category },
      { label: labels.provider, value: selected.provider },
      { label: "Severity", value: selected.severity }
    ];

    if (selected.os === "windows") {
      details.splice(5, 0, {
        label: labels.eventId ?? "Event ID",
        value: selected.eventId?.toString() ?? "N/A"
      });
    }

    details.push({ label: "Source", value: selected.imported ? "Imported" : "Live/Local" });
    return details;
  }, [selected]);
  const tableColumnCount = hasWindowsEvents ? 7 : 6;
  const virtualRows = useMemo(() => {
    const total = tableEvents.length;
    if (total === 0) {
      return {
        slice: [] as NormalizedEvent[],
        topSpacer: 0,
        bottomSpacer: 0
      };
    }

    const viewportRows = Math.ceil(tableViewportHeight / VIRTUAL_ROW_HEIGHT);
    const start = Math.max(0, Math.floor(tableScrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_OVERSCAN_ROWS);
    const end = Math.min(total, start + viewportRows + VIRTUAL_OVERSCAN_ROWS * 2);
    return {
      slice: tableEvents.slice(start, end),
      topSpacer: start * VIRTUAL_ROW_HEIGHT,
      bottomSpacer: (total - end) * VIRTUAL_ROW_HEIGHT
    };
  }, [tableEvents, tableScrollTop, tableViewportHeight]);

  const panelClass = "rounded-2xl border border-panel-border bg-panel backdrop-blur-xl shadow-glass";
  const inputClass =
    "h-9 w-full rounded-lg border border-[var(--field-border)] bg-[var(--field-bg)] px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:cursor-not-allowed disabled:bg-[var(--field-bg-disabled)] disabled:text-muted";
  const selectClass = `${inputClass} appearance-none pr-8`;
  const isDevHostedRuntime =
    isTauriRuntime() &&
    typeof window !== "undefined" &&
    (window.location.protocol === "http:" || window.location.protocol === "https:");
  const filterGridClass = hasWindowsEvents
    ? "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_0.9fr_0.9fr_1fr]"
    : "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_0.9fr_0.9fr_1fr]";

  function applyCollectorWarnings(context: string, result: SyncOperationResult): void {
    if (result.warnings.length === 0) {
      setCollectorWarning("");
      setPrivilegedAccessWarning(null);
      return;
    }

    const privilegeWarning = classifyPrivilegedAccessWarning(currentTargetOs, result.warnings, result.collected);
    if (privilegeWarning) {
      setPrivilegedAccessWarning(privilegeWarning);
      setCollectorWarning("");
      return;
    }

    setPrivilegedAccessWarning(null);
    setCollectorWarning(`${context}: ${summarizeCollectorWarnings(result.warnings)}`);
  }

  function dismissCollectorWarning(): void {
    setCollectorWarning("");
    setPrivilegedAccessWarning(null);
  }

  async function restartElevatedNow(): Promise<void> {
    setLastError("");
    if (isDevHostedRuntime) {
      setLastError(
        "Restart with elevated access is disabled during `npm run tauri dev`. Start the dev session from an elevated terminal instead."
      );
      return;
    }
    setIsRestartingElevated(true);
    try {
      await restartElevated();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to restart with elevated access.");
    } finally {
      setIsRestartingElevated(false);
    }
  }

  async function disableSecurityCollectionNow(): Promise<void> {
    setLastError("");
    const nextChannels = ingestProfile.windowsChannels.filter((channel) => channel !== "Security");
    if (nextChannels.length === ingestProfile.windowsChannels.length) {
      dismissCollectorWarning();
      return;
    }

    try {
      const saved = await setIngestProfile({
        ...ingestProfile,
        windowsChannels: nextChannels.length > 0 ? nextChannels : ["Application"]
      });
      setIngestProfileState(saved);
      setExportStatus("Security log collection disabled.");
      window.setTimeout(() => setExportStatus(""), 2500);
      dismissCollectorWarning();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to disable Security log collection.");
    }
  }

  function applyLocalEventsCache(events: NormalizedEvent[], context: string): number {
    const capped = capEvents(events, MAX_LOCAL_EVENTS_IN_MEMORY);
    setLocalEvents(capped.kept);
    if (capped.truncated > 0) {
      setMemoryNotice(
        `${context}: showing ${MAX_LOCAL_EVENTS_IN_MEMORY.toLocaleString()} local events in memory; ${capped.truncated.toLocaleString()} more were omitted to keep RAM stable.`
      );
    } else {
      setMemoryNotice("");
    }
    return capped.truncated;
  }

  function updateTableViewportHeight(): void {
    const next = tableContainerRef.current?.clientHeight;
    if (!next || next <= 0) return;
    setTableViewportHeight(next);
  }

  useEffect(() => {
    void (async () => {
      const savedTheme = await getSavedTheme();
      if (savedTheme) {
        setTheme(savedTheme);
      }
      await initialize();
    })();
  }, []);

  useEffect(() => {
    if (hasWindowsEvents) return;
    setFilterDraft((prev) => (prev.eventId ? { ...prev, eventId: "" } : prev));
    setActiveFilters((prev) => (prev.eventId ? { ...prev, eventId: "" } : prev));
  }, [hasWindowsEvents]);

  useEffect(() => {
    setExportFilters((current) => {
      let next = current;
      if (current.logType !== "all" && !exportLogTypeOptions.includes(current.logType)) {
        next = { ...next, logType: "all" };
      }
      if (current.category !== "all" && !exportCategoryOptions.includes(current.category)) {
        next = { ...next, category: "all" };
      }
      return next;
    });
  }, [exportCategoryOptions, exportLogTypeOptions]);

  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    const onTheme = (mode: string) => {
      if (mode === "system" || mode === "light" || mode === "dark") {
        setTheme(mode);
      }
    };
    const onOpenHelp = (section?: string | null) => {
      if (section && isHelpSectionId(section)) {
        openHelpTab(section);
        return;
      }
      openHelpTab("quick-start");
    };
    const onOpenHelpDom = (event: Event) => {
      const custom = event as CustomEvent<string | null | undefined>;
      onOpenHelp(custom.detail);
    };

    window.addEventListener("hermes:open-help", onOpenHelpDom as EventListener);

    void (async () => {
      if (isTauriRuntime()) {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const offWindow = await getCurrentWindow().listen<string>("hla://theme-changed", (event) => {
            onTheme(event.payload);
          });
          unlisteners.push(offWindow);
        } catch {
          // Continue; app-level listeners below still provide theme/help events.
        }
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const offApp = await listen<string>("hla://theme-changed", (event) => {
          onTheme(event.payload);
        });
        unlisteners.push(offApp);
      } catch {
        // Ignore when Tauri event bridge is unavailable.
      }

      try {
        const { listen } = await import("@tauri-apps/api/event");
        const offHelp = await listen<string | null>("hla://open-help", (event) => {
          onOpenHelp(event.payload);
        });
        unlisteners.push(offHelp);
      } catch {
        // Ignore when Tauri event bridge is unavailable.
      }
    })();

    return () => {
      window.removeEventListener("hermes:open-help", onOpenHelpDom as EventListener);
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let active = true;
    const syncTheme = async () => {
      try {
        const savedTheme = await getSavedTheme();
        if (!savedTheme || !active) return;
        setTheme((prev) => (prev === savedTheme ? prev : savedTheme));
      } catch {
        // Ignore transient invoke failures during startup/shutdown.
      }
    };

    void syncTheme();
    const intervalId = window.setInterval(() => {
      void syncTheme();
    }, 400);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    updateTableViewportHeight();
    const node = tableContainerRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      const onResize = () => updateTableViewportHeight();
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }

    const observer = new ResizeObserver(() => updateTableViewportHeight());
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setTableScrollTop(0);
    if (tableContainerRef.current) {
      tableContainerRef.current.scrollTop = 0;
    }
  }, [activeTab, tableEvents.length, sortState, activeFilters.dateFrom, activeFilters.dateTo, activeFilters.logType]);

  useEffect(() => {
    setCopyEventTextStatus("idle");
  }, [selected?.id]);

  useEffect(() => {
    if (llmSettings.profiles.length === 0) {
      if (llmSelectedProfileId !== "") setLlmSelectedProfileId("");
      return;
    }
    const currentExists = llmSettings.profiles.some((profile) => profile.id === llmSelectedProfileId);
    if (currentExists) return;
    const fallback =
      llmSettings.profiles.find((profile) => profile.id === llmSettings.defaultProfileId)?.id ??
      llmSettings.profiles[0].id;
    setLlmSelectedProfileId(fallback);
  }, [llmSelectedProfileId, llmSettings.defaultProfileId, llmSettings.profiles]);

  useEffect(() => {
    setLlmApiKeyDraft("");
    setLlmTestResult(null);
  }, [llmSelectedProfile?.id]);

  useEffect(() => {
    if (!llmWindowOpen) return;
    if (llmLocalProfiles.length === 0) {
      if (llmRunProfileId !== "") setLlmRunProfileId("");
      return;
    }
    if (llmLocalProfiles.some((profile) => profile.id === llmRunProfileId)) return;
    const preferred =
      llmLocalProfiles.find((profile) => profile.id === llmSettings.defaultProfileId)?.id ??
      llmLocalProfiles[0].id;
    setLlmRunProfileId(preferred);
  }, [llmLocalProfiles, llmRunProfileId, llmSettings.defaultProfileId, llmWindowOpen]);

  async function refreshLlmNetworkInterfaces(
    includeNonPrivate = llmIncludeNonPrivateInterfaces,
    includeLoopback = llmIncludeLoopbackInterfaces
  ): Promise<boolean> {
    setIsDetectingNetworks(true);
    try {
      const interfaces = await listLlmNetworkInterfaces(includeNonPrivate, includeLoopback);
      setLlmNetworks(interfaces);

      const preferredId = llmSettings.preferredLanInterfaceId.trim();
      const saved = interfaces.find((entry) => entry.id === preferredId);
      const defaultCandidate = interfaces.find((entry) => entry.isDefaultCandidate);
      const fallback = interfaces[0];
      const next = saved?.id ?? defaultCandidate?.id ?? fallback?.id ?? "";
      setLlmSelectedNetworkId(next);
      return true;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to detect LAN interfaces.");
      return false;
    } finally {
      setIsDetectingNetworks(false);
    }
  }

  async function initialize(): Promise<void> {
    setIsLoading(true);
    setLastError("");
    dismissCollectorWarning();

    try {
      const os = await getHostOs();
      setHostOs(os);
      const version = await getHostOsVersion().catch(() => "Unknown (not provided by host)");
      setHostOsVersion(version);
      setIngestWindowDaysState(await getIngestWindowDays());
      const profile = await getIngestProfile();
      setIngestProfileState(profile);
      const llm = await getLlmSettings();
      setLlmSettingsState(llm);
      const nextProfileId =
        llm.profiles.find((entry) => entry.id === llm.defaultProfileId)?.id ??
        llm.profiles[0]?.id ??
        "";
      setLlmSelectedProfileId(nextProfileId);
      const interfaces = await listLlmNetworkInterfaces(false, false);
      setLlmNetworks(interfaces);
      const networkId =
        interfaces.find((entry) => entry.id === llm.preferredLanInterfaceId)?.id ??
        interfaces.find((entry) => entry.isDefaultCandidate)?.id ??
        interfaces[0]?.id ??
        "";
      setLlmSelectedNetworkId(networkId);
      if (profile.autoSyncOnStartup) {
        const syncResult = await refreshLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined);
        applyCollectorWarnings("Startup sync warning", syncResult);
      }
      const collected = await getLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined, LOCAL_FETCH_LIMIT);
      if (collected.length > 0) {
        applyLocalEventsCache(collected, "Startup load");
      } else {
        setLocalEvents([]);
        setMemoryNotice("");
      }
      setRangeViewActive(false);
      setRangeLoadMessage("");
      await refreshCrashes();
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to initialize host collector.");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshNow(): Promise<void> {
    setIsLoading(true);
    setLastError("");
    dismissCollectorWarning();

    try {
      const result = await refreshLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined);
      applyCollectorWarnings("Refresh warning", result);
      applyLocalEventsCache(await getLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined, LOCAL_FETCH_LIMIT), "Refresh load");
      if (rangeViewActive) {
        clearAppliedDateRangeFilters();
      }
      setRangeViewActive(false);
      setRangeLoadMessage("");
      setExportStatus(`Refresh complete: ${result.collected.toLocaleString()} events collected.`);
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Refresh failed.");
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshCrashes(): Promise<void> {
    const records = await getCrashes(targetHostId !== "localhost" ? targetHostId : undefined);
    setCrashes(records);

    if (records.length === 0) {
      setSelectedCrashId("");
      setCorrelatedEvents([]);
      setPreCrashFocusEnabled(false);
      return;
    }

    const targetId = selectedCrashId && records.some((record) => record.id === selectedCrashId)
      ? selectedCrashId
      : records[0].id;

    setSelectedCrashId(targetId);
    setCorrelatedEvents(await getCrashRelatedEvents(targetId, 15, 250));
  }

  async function importHostCrashesNow(): Promise<void> {
    setLastError("");
    try {
      const count = await importHostCrashes(targetHostId !== "localhost" ? targetHostId : undefined, 300);
      await refreshCrashes();
      setExportStatus(
        count > 0
          ? `Imported ${count} crash report${count === 1 ? "" : "s"} from host.`
          : "No host crash reports found."
      );
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to import host crashes.");
    }
  }

  async function onCrashSelectionChange(crashId: string): Promise<void> {
    setSelectedCrashId(crashId);
    setPreCrashEvents([]);
    if (!crashId) {
      setCorrelatedEvents([]);
      setPreCrashFocusEnabled(false);
      return;
    }

    try {
      setCorrelatedEvents(await getCrashRelatedEvents(crashId, 15, 250));
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to load correlated events.");
    }
  }

  async function applyPreCrashFocus(): Promise<void> {
    if (!selectedCrash) {
      setLastError("Select a crash first to focus pre-crash events.");
      return;
    }

    const crashTime = Date.parse(selectedCrash.timestamp);
    if (!Number.isFinite(crashTime)) {
      setLastError("Selected crash has an invalid timestamp.");
      return;
    }

    const windowStart = crashTime - preCrashWindowMinutes * 60 * 1000;
    const windowEnd = crashTime;

    const startIso = new Date(windowStart).toISOString();
    const endIso = new Date(windowEnd).toISOString();
    const from = formatDateInputValue(windowStart);
    const to = formatDateInputValue(windowEnd);
    setBackfillFrom(from);
    setBackfillTo(to);

    setLastError("");
    dismissCollectorWarning();
    setRangeLoadMessage(`Loading crash-adjacent events for ${new Date(selectedCrash.timestamp).toLocaleString()}...`);
    setIsRangeLoading(true);
    try {
      const syncResult = await syncLocalEventsWindow(
        startIso,
        endIso,
        targetHostId !== "localhost" ? targetHostId : undefined
      );
      applyCollectorWarnings("Crash window warning", syncResult);
      const [windowEvents, related] = await Promise.all([
        getLocalEventsWindow(
          startIso,
          endIso,
          LOCAL_FETCH_LIMIT,
          targetHostId !== "localhost" ? targetHostId : undefined
        ),
        getCrashRelatedEvents(selectedCrash.id, 15, 250)
      ]);
      setPreCrashEvents(windowEvents);
      setCorrelatedEvents(related);
      applyLocalEventsCache(
        await getLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined, LOCAL_FETCH_LIMIT),
        "Crash window load"
      );
      setRangeLoadMessage(
        windowEvents.length > 0
          ? `Loaded ${windowEvents.length.toLocaleString()} events in the ${preCrashWindowMinutes}-minute pre-crash window.`
          : `Crash window loaded, but no events were found in the ${preCrashWindowMinutes}-minute pre-crash window.`
      );
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to load crash investigation window.");
      setRangeLoadMessage("");
      return;
    } finally {
      setIsRangeLoading(false);
    }

    setLastError("");
    setPreCrashFocusEnabled(true);
  }

  function clearPreCrashFocus(): void {
    setPreCrashFocusEnabled(false);
    setPreCrashEvents([]);
  }

  function updateFilter<K extends keyof EventFilters>(key: K, value: EventFilters[K]): void {
    setFilterDraft((prev) => ({ ...prev, [key]: value }));
  }

  function applyFilterChanges(): void {
    setActiveFilters({
      ...filterDraft,
      severities: { ...filterDraft.severities }
    });
  }

  function resetFilterDraft(): void {
    setFilterDraft(createDefaultFilters());
  }

  function clearAppliedDateRangeFilters(): void {
    setFilterDraft((prev) => {
      if (!prev.dateFrom && !prev.dateTo) return prev;
      return { ...prev, dateFrom: "", dateTo: "" };
    });
    setActiveFilters((prev) => {
      if (!prev.dateFrom && !prev.dateTo) return prev;
      return { ...prev, dateFrom: "", dateTo: "" };
    });
  }

  async function onImport(fileList: FileList | null): Promise<void> {
    const file = fileList?.[0];
    if (!file) return;

    setLastError("");
    try {
      const imported = await importSessionEvents(file, hostOs);
      const mergedImported = [...imported, ...importedEvents];
      const capped = capEvents(mergedImported, MAX_IMPORTED_EVENTS_IN_MEMORY);
      setImportedEvents(capped.kept);
      setExportStatus(
        `Imported ${imported.length.toLocaleString()} event${imported.length === 1 ? "" : "s"} from ${file.name}.`
      );
      window.setTimeout(() => setExportStatus(""), 3000);
      if (capped.truncated > 0) {
        setMemoryNotice(
          `Imported event cache is capped at ${MAX_IMPORTED_EVENTS_IN_MEMORY.toLocaleString()} events; ${capped.truncated.toLocaleString()} imported events were omitted from memory.`
        );
      }
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Import failed.");
    }
  }

  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.setAttribute("readonly", "true");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      document.body.removeChild(textarea);
      if (!copied) {
        throw new Error("Clipboard copy failed.");
      }
    }
  }

  async function copyPrompt(): Promise<void> {
    if (!selected) return;
    setLastError("");
    try {
      await copyText(buildLlmPrompt(selected, hostOsVersion));
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to copy prompt.");
      setCopyStatus("idle");
    }
  }

  function openLlmAnalysisWindow(): void {
    if (!selected) return;
    const prompt = buildLlmPrompt(selected, hostOsVersion, false);
    const preferredProfileId =
      llmLocalProfiles.find((profile) => profile.id === llmSettings.defaultProfileId)?.id ??
      llmLocalProfiles[0]?.id ??
      "";

    setLlmPromptDraft(prompt);
    setLlmPromptWasRedacted(false);
    setLlmPromptPreRedactionDraft("");
    setLlmRunProfileId(preferredProfileId);
    setLlmRunResult(null);
    setLlmRunError("");
    setLlmGuardrailBlock(null);
    setLlmResponseViewMode("guide");
    setLlmWindowOpen(true);
  }

  function rebuildPrompt(): void {
    if (!selected) return;
    setLlmPromptDraft(buildLlmPrompt(selected, hostOsVersion, false));
    setLlmPromptWasRedacted(false);
    setLlmPromptPreRedactionDraft("");
    setLlmRunError("");
    setLlmGuardrailBlock(null);
    setExportStatus("Prompt reset (unredacted).");
    window.setTimeout(() => setExportStatus(""), 2000);
  }

  function togglePromptRedaction(): void {
    if (llmPromptWasRedacted) {
      if (llmPromptPreRedactionDraft.trim()) {
        setLlmPromptDraft(llmPromptPreRedactionDraft);
      } else if (selected) {
        setLlmPromptDraft(buildLlmPrompt(selected, hostOsVersion, false));
      }
      setLlmPromptWasRedacted(false);
      setLlmPromptPreRedactionDraft("");
      setExportStatus("Redaction removed from prompt.");
      window.setTimeout(() => setExportStatus(""), 2000);
      return;
    }

    setLlmPromptDraft((current) => {
      const redacted = redactSensitiveText(current);
      if (redacted !== current) {
        setLlmPromptPreRedactionDraft(current);
        setLlmPromptWasRedacted(true);
        setExportStatus("Prompt redaction applied.");
      } else {
        setLlmPromptPreRedactionDraft("");
        setLlmPromptWasRedacted(false);
        setExportStatus("No sensitive values detected to redact.");
      }
      window.setTimeout(() => setExportStatus(""), 2000);
      return redacted;
    });
  }

  function onLlmPromptDraftChange(nextValue: string): void {
    setLlmPromptDraft(nextValue);
    setLlmGuardrailBlock(null);
    if (llmPromptWasRedacted && llmPromptPreRedactionDraft.trim()) {
      // User edited the redacted prompt; restoring original draft no longer maps cleanly.
      setLlmPromptPreRedactionDraft("");
    }
    if (llmPromptWasRedacted && !nextValue.includes("<sensitive info redacted>")) {
      setLlmPromptWasRedacted(false);
    }
  }

  async function runLlmAnalysisNow(options?: { allowUntrustedRawOnce?: boolean }): Promise<void> {
    if (!selected) return;
    if (!llmRunProfileId) {
      setLlmRunError("No local LLM profile is selected.");
      setLlmGuardrailBlock(null);
      setLastError("No local LLM profile is selected.");
      return;
    }
    const outboundPrompt = llmPromptDraft.trim();
    if (!outboundPrompt) {
      setLlmRunError("LLM prompt is empty.");
      setLlmGuardrailBlock(null);
      setLastError("LLM prompt is empty.");
      return;
    }

    const profile = llmSettings.profiles.find((p) => p.id === llmRunProfileId);
    if (
      !options?.allowUntrustedRawOnce &&
      profile &&
      llmSettings.neverSendRawEventToUntrusted &&
      profile.scope !== "local"
    ) {
      try {
        const url = new URL(profile.baseUrl);
        const host = url.hostname.toLowerCase();
        const isLocalhost = host === "localhost" || host === "127.0.0.1" || host === "::1";
        const isTrusted = llmSettings.trustedHosts.some((trusted: string) => trusted.toLowerCase() === host);
        if (!isLocalhost && !isTrusted) {
          const isRaw = redactSensitiveText(outboundPrompt) !== outboundPrompt;
          if (isRaw) {
            const message = `Guardrail block: Target host '${host}' is untrusted, and prompt contains sensitive raw data. Please apply redaction or add to trusted hosts.`;
            setLlmRunError(message);
            setLlmGuardrailBlock({ host, message });
            setLastError(message);
            return;
          }
        }
      } catch {
        setLlmRunError("Guardrail block: Profile base URL is invalid.");
        setLlmGuardrailBlock(null);
        setLastError("Guardrail block: Profile base URL is invalid.");
        return;
      }
    }

    setLlmRunError("");
    setLlmGuardrailBlock(null);
    setLastError("");
    setLlmRunResult(null);
    setIsRunningLlmAnalysis(true);
    try {
      const result = await analyzeWithLocalLlm(outboundPrompt, llmRunProfileId);
      setLlmRunResult(result);
      setExportStatus(
        result.fallbackUsed
          ? `LLM analysis complete via fallback profile (${result.profileName}).`
          : `LLM analysis complete (${result.profileName}).`
      );
      window.setTimeout(() => setExportStatus(""), 3500);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to run local LLM analysis.";
      setLlmRunError(message);
      setLastError(message);
    } finally {
      setIsRunningLlmAnalysis(false);
    }
  }

  async function copyLlmGuideNow(): Promise<void> {
    if (!llmRunResult) return;
    setLastError("");
    try {
      await copyText(buildGuidePlainText(llmParsedGuide, llmRunResult));
      setExportStatus("Troubleshooting guide copied.");
      window.setTimeout(() => setExportStatus(""), 2000);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to copy troubleshooting guide.");
    }
  }

  async function exportLlmGuideTextNow(): Promise<void> {
    if (!llmRunResult) return;
    setLastError("");
    try {
      const filename = `troubleshooting-guide-${formatExportTimestamp()}.txt`;
      const location = await saveTextWithDialog(filename, buildGuidePlainText(llmParsedGuide, llmRunResult));
      if (!location) {
        setExportStatus("Export canceled.");
        window.setTimeout(() => setExportStatus(""), 2000);
        return;
      }
      setExportStatus(`Guide exported: ${location}`);
      window.setTimeout(() => setExportStatus(""), 2600);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export guide.");
    }
  }

  async function exportLlmGuideHtmlNow(): Promise<void> {
    if (!llmRunResult) return;
    setLastError("");
    try {
      const filename = `troubleshooting-guide-${formatExportTimestamp()}.html`;
      const location = await saveTextWithDialog(filename, buildGuideHtml(llmParsedGuide, llmRunResult));
      if (!location) {
        setExportStatus("Export canceled.");
        window.setTimeout(() => setExportStatus(""), 2000);
        return;
      }
      setExportStatus(`PDF-ready guide exported: ${location}`);
      window.setTimeout(() => setExportStatus(""), 2600);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export PDF-ready guide.");
    }
  }

  async function copySelectedEventText(): Promise<void> {
    if (!selected) return;
    setLastError("");
    try {
      await copyText(selected.message);
      setCopyEventTextStatus("copied");
      window.setTimeout(() => setCopyEventTextStatus("idle"), 1800);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to copy event text.");
      setCopyEventTextStatus("idle");
    }
  }

  async function openGoogle(): Promise<void> {
    if (!selected) return;
    setLastError("");
    try {
      await openExternalUrl(`https://www.google.com/search?q=${buildGoogleQuery(selected)}`);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to open Google search.");
    }
  }

  function onColumnSort(column: SortColumn): void {
    setSortState((current) => {
      if (!current || current.column !== column) {
        return { column, direction: "asc" };
      }
      return { column, direction: current.direction === "asc" ? "desc" : "asc" };
    });
  }

  function resetSort(): void {
    setSortState(null);
  }

  function toggleSelectedEvent(event: NormalizedEvent): void {
    setSelected((current) => (current?.id === event.id ? null : event));
    setMessageViewMode("raw");
  }

  function sortIndicator(column: SortColumn): string {
    if (!sortState || sortState.column !== column) return "↕";
    return sortState.direction === "asc" ? "↑" : "↓";
  }

  function toggleWindowsChannel(channel: string, enabled: boolean): void {
    setIngestProfileState((current) => {
      if (enabled) {
        if (current.windowsChannels.includes(channel)) return current;
        return { ...current, windowsChannels: [...current.windowsChannels, channel] };
      }
      return { ...current, windowsChannels: current.windowsChannels.filter((entry) => entry !== channel) };
    });
  }

  function jumpToEventsWithFilters(patch: Partial<EventFilters>): void {
    const next = createDefaultFilters();
    const merged: EventFilters = {
      ...next,
      ...patch,
      severities: patch.severities ? { ...patch.severities } : { ...next.severities }
    };
    setFilterDraft(merged);
    setActiveFilters(merged);
    setSelected(null);
    setMessageViewMode("raw");
    setSortState(null);
    setActiveTab("events");
  }

  function applySeverityFocus(level: EventSeverity): void {
    jumpToEventsWithFilters({
      severities: {
        information: level === "information",
        warning: level === "warning",
        error: level === "error",
        critical: level === "critical"
      }
    });
  }

  function applyTimelineFocus(date: string): void {
    jumpToEventsWithFilters({
      dateFrom: date,
      dateTo: date
    });
  }

  function applyProviderFocus(provider: string): void {
    jumpToEventsWithFilters({
      source: provider
    });
  }

  function applyLogTypeFocus(logType: string): void {
    jumpToEventsWithFilters({
      logType
    });
  }

  function applyEventIdFocus(eventId: string): void {
    jumpToEventsWithFilters({
      eventId
    });
  }

  async function exportOpsSummaryTextNow(): Promise<void> {
    if (exportPreviewEvents.length === 0) {
      setLastError("There are no events in the selected summary scope.");
      return;
    }
    setLastError("");
    try {
      const filename = `${formatExportTimestamp()}-hermes-ops-summary.txt`;
      const location = await saveTextWithDialog(filename, buildOpsSummaryText(exportOpsSummary));
      if (!location) {
        setExportStatus("Summary export canceled.");
        window.setTimeout(() => setExportStatus(""), 2000);
        return;
      }
      setExportStatus(`Ops summary exported: ${location}`);
      window.setTimeout(() => setExportStatus(""), 2600);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export ops summary.");
    }
  }

  async function exportOpsSummaryHtmlNow(): Promise<void> {
    if (exportPreviewEvents.length === 0) {
      setLastError("There are no events in the selected summary scope.");
      return;
    }
    setLastError("");
    try {
      const filename = `${formatExportTimestamp()}-hermes-ops-summary.html`;
      const location = await saveTextWithDialog(filename, buildOpsSummaryHtml(exportOpsSummary));
      if (!location) {
        setExportStatus("Summary export canceled.");
        window.setTimeout(() => setExportStatus(""), 2000);
        return;
      }
      setExportStatus(`PDF-ready summary exported: ${location}`);
      window.setTimeout(() => setExportStatus(""), 2600);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export PDF-ready summary.");
    }
  }

  function updateLlmProfile(profileId: string, patch: Partial<LlmConnectionProfile>): void {
    setLlmSettingsState((current) => ({
      ...current,
      profiles: current.profiles.map((profile) =>
        profile.id === profileId
          ? {
              ...profile,
              ...patch
            }
          : profile
      )
    }));
  }

  function updateSelectedLlmProfile(
    field: "name" | "provider" | "scope" | "baseUrl" | "model" | "enabled",
    value: string | boolean
  ): void {
    if (!llmSelectedProfile) return;

    if (field === "provider" && typeof value === "string") {
      const nextProvider = value;
      const defaultScope = defaultScopeForProvider(nextProvider);
      const currentUrl = llmSelectedProfile.baseUrl.trim();
      const currentDefault = defaultBaseUrlForProvider(llmSelectedProfile.provider);
      const nextDefault = defaultBaseUrlForProvider(nextProvider);
      const currentDefaultName = defaultProfileName(llmSelectedProfile.provider, llmSelectedProfile.scope);
      const nextDefaultName = defaultProfileName(nextProvider, defaultScope);
      updateLlmProfile(llmSelectedProfile.id, {
        provider: nextProvider,
        scope: defaultScope,
        name:
          !llmSelectedProfile.name.trim() || llmSelectedProfile.name.trim() === currentDefaultName
            ? nextDefaultName
            : llmSelectedProfile.name,
        baseUrl: !currentUrl || currentUrl === currentDefault ? nextDefault : currentUrl
      });
      return;
    }

    if (field === "scope" && typeof value === "string") {
      const nextScope = value;
      const currentDefaultName = defaultProfileName(llmSelectedProfile.provider, llmSelectedProfile.scope);
      const nextDefaultName = defaultProfileName(llmSelectedProfile.provider, nextScope);
      updateLlmProfile(llmSelectedProfile.id, {
        scope: nextScope,
        name:
          !llmSelectedProfile.name.trim() || llmSelectedProfile.name.trim() === currentDefaultName
            ? nextDefaultName
            : llmSelectedProfile.name
      });
      return;
    }

    updateLlmProfile(llmSelectedProfile.id, { [field]: value } as Partial<LlmConnectionProfile>);
  }

  function addLlmProfile(): void {
    const provider = llmSelectedProfile?.provider ?? "ollama";
    const scope = defaultScopeForProvider(provider);
    const profile: LlmConnectionProfile = {
      id: newProfileId(),
      name: defaultProfileName(provider, scope),
      provider,
      scope,
      baseUrl: defaultBaseUrlForProvider(provider),
      model: "",
      enabled: true,
      apiKeyConfigured: false
    };
    setLlmSettingsState((current) => ({
      ...current,
      profiles: [...current.profiles, profile]
    }));
    setLlmSelectedProfileId(profile.id);
    setLlmApiKeyDraft("");
  }

  function deleteSelectedLlmProfile(): void {
    if (!llmSelectedProfile) return;
    setLlmSettingsState((current) => {
      if (current.profiles.length <= 1) return current;
      const remaining = current.profiles.filter((profile) => profile.id !== llmSelectedProfile.id);
      const fallbackId = remaining[0]?.id ?? "";
      const defaultProfileId = current.defaultProfileId === llmSelectedProfile.id ? fallbackId : current.defaultProfileId;
      const backupProfileId =
        current.backupProfileId === llmSelectedProfile.id || current.backupProfileId === defaultProfileId
          ? ""
          : current.backupProfileId;
      setLlmSelectedProfileId(defaultProfileId);
      return {
        ...current,
        profiles: remaining,
        defaultProfileId,
        backupProfileId
      };
    });
    setLlmApiKeyDraft("");
  }

  function applyCandidateToSelectedProfile(candidate: LlmEndpointCandidate): void {
    if (!llmSelectedProfile) return;
    const mappedScope = candidate.scope === "localhost" ? "local" : "lan";
    const nextProvider = candidate.providerId;
    const currentDefaultName = defaultProfileName(llmSelectedProfile.provider, llmSelectedProfile.scope);
    const nextDefaultName = defaultProfileName(nextProvider, mappedScope);
    const nextProfile: LlmConnectionProfile = {
      ...llmSelectedProfile,
      name:
        !llmSelectedProfile.name.trim() || llmSelectedProfile.name.trim() === currentDefaultName
          ? nextDefaultName
          : llmSelectedProfile.name,
      provider: nextProvider,
      scope: mappedScope,
      baseUrl: candidate.endpoint,
      model: "",
      enabled: true
    };
    updateLlmProfile(llmSelectedProfile.id, {
      name:
        !llmSelectedProfile.name.trim() || llmSelectedProfile.name.trim() === currentDefaultName
          ? nextDefaultName
          : llmSelectedProfile.name,
      provider: nextProvider,
      scope: mappedScope,
      baseUrl: candidate.endpoint,
      model: "",
      enabled: true
    });
    if (candidate.interfaceId.trim()) {
      setLlmSelectedNetworkId(candidate.interfaceId);
    }
    setLlmTestResult(null);
    void runLlmConnectionTest(nextProfile);
  }

  function applyDetectedModel(model: string): void {
    if (!llmSelectedProfile) return;
    const trimmed = model.trim();
    if (!trimmed) return;
    updateLlmProfile(llmSelectedProfile.id, { model: trimmed });
    setExportStatus(`Model set to ${trimmed}.`);
    window.setTimeout(() => setExportStatus(""), 2000);
  }

  async function runLlmConnectionTest(profileOverride?: LlmConnectionProfile): Promise<void> {
    const profile = profileOverride ?? llmSelectedProfile;
    if (!profile) return;

    setLastError("");
    setIsTestingLlmProfile(true);
    try {
      const result = await testLlmProfileConnection(profile);
      setLlmTestResult(result);
      if (result.ok && result.detectedModels.length > 0) {
        const currentModel = profile.model.trim();
        const autoModel = result.detectedModels[0];
        if (!currentModel) {
          updateLlmProfile(profile.id, { model: autoModel });
          setExportStatus(`${result.message} Auto-selected model: ${autoModel}.`);
        } else if (!result.detectedModels.includes(currentModel)) {
          updateLlmProfile(profile.id, { model: autoModel });
          setExportStatus(
            `${result.message} Model '${currentModel}' was not found on this endpoint. Auto-selected: ${autoModel}.`
          );
        } else {
          setExportStatus(result.message);
        }
      } else {
        setExportStatus(result.message);
      }
      window.setTimeout(() => setExportStatus(""), 3500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to test LLM connection.");
    } finally {
      setIsTestingLlmProfile(false);
    }
  }

  async function saveLlmSettingsNow(): Promise<void> {
    setLastError("");
    try {
      const trustedHosts = llmSettings.trustedHosts
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      let saved = await setLlmSettings({
        ...llmSettings,
        trustedHosts,
        preferredLanInterfaceId: llmSelectedNetworkId
      });
      if (llmSelectedProfile && llmApiKeyDraft.trim()) {
        saved = await setLlmProfileApiKey(llmSelectedProfile.id, llmApiKeyDraft.trim());
        setLlmApiKeyDraft("");
      }
      setLlmSettingsState(saved);
      setExportStatus("LLM settings saved.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to save LLM settings.");
    }
  }

  async function clearLlmApiKeyNow(): Promise<void> {
    if (!llmSelectedProfile) return;
    setLastError("");
    try {
      const saved = await clearLlmProfileApiKey(llmSelectedProfile.id);
      setLlmSettingsState(saved);
      setLlmApiKeyDraft("");
      setExportStatus("API key removed from OS keychain.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to clear API key.");
    }
  }

  async function detectLocalProvidersNow(): Promise<void> {
    setLastError("");
    try {
      const candidates = await detectLocalLlmProviders();
      setLlmCandidates(candidates);
      setExportStatus(
        candidates.length > 0
          ? `Detected ${candidates.length} local LLM endpoint${candidates.length === 1 ? "" : "s"}.`
          : "No local Ollama/LM Studio endpoints detected."
      );
      if (
        candidates.length > 0 &&
        llmSelectedProfile &&
        (llmSelectedProfile.provider === "ollama" || llmSelectedProfile.provider === "lmstudio")
      ) {
        void runLlmConnectionTest();
      }
      window.setTimeout(() => setExportStatus(""), 3000);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to detect local LLM providers.");
    }
  }

  async function detectNetworksNow(): Promise<void> {
    setLastError("");
    const success = await refreshLlmNetworkInterfaces();
    if (success) {
      setExportStatus("Network interfaces refreshed.");
      window.setTimeout(() => setExportStatus(""), 2000);
    }
  }

  async function scanLanProvidersNow(): Promise<void> {
    setLastError("");
    setIsScanningLan(true);
    try {
      const candidates = await scanLanLlmProviders(llmSelectedNetworkId || undefined, 256);
      setLlmCandidates(candidates);
      setExportStatus(
        candidates.length > 0
          ? `Detected ${candidates.length} LAN LLM endpoint${candidates.length === 1 ? "" : "s"}.`
          : "No LAN Ollama/LM Studio endpoints detected."
      );
      window.setTimeout(() => setExportStatus(""), 3000);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to scan LAN for LLM providers.");
    } finally {
      setIsScanningLan(false);
    }
  }

  async function saveIngestCollectionSettings(): Promise<void> {
    setLastError("");
    try {
      const maxEvents = Math.max(100, Math.min(20000, Math.floor(ingestProfile.maxEventsPerSync)));
      let channels = ingestProfile.windowsChannels.filter((value) =>
        windowsChannelOptions.some((option) => option === value)
      );
      if (channels.length === 0) {
        channels = ["Application"];
      }

      const saved = await setIngestProfile({
        autoSyncOnStartup: ingestProfile.autoSyncOnStartup,
        maxEventsPerSync: maxEvents,
        windowsChannels: channels,
        requestElevation: ingestProfile.requestElevation ?? false
      });
      setIngestProfileState(saved);
      setExportStatus("Collection settings saved.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to save collection settings.");
    }
  }



  async function saveRemoteHostSettings(): Promise<void> {
    try {
      await saveRemoteSettings(remoteSettings);
      setExportStatus("Remote settings saved successfully.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (e: any) {
      setLastError(e.message || "Failed to save remote settings");
    }
  }

  function addRemoteProfile() {
    const newProfile = {
      id: crypto.randomUUID(),
      name: "New Profile",
      host: "192.168.1.100",
      os: "linux",
      protocol: "ssh",
      username: "root",
      ssh_key_path: "",
      auth_type: "key"
    };
    setRemoteSettingsState(prev => ({ profiles: [...prev.profiles, newProfile] }));
    setRemoteSelectedId(newProfile.id);
  }

  function deleteSelectedRemoteProfile() {
    setRemoteSettingsState(prev => {
      const arr = prev.profiles.filter(p => p.id !== remoteSelectedId);
      return { profiles: arr };
    });
    setRemoteSelectedId("");
  }
  
  function updateSelectedRemoteProfile(key: string, value: string) {
    setRemoteSettingsState(prev => {
      const idx = prev.profiles.findIndex(p => p.id === remoteSelectedId);
      if (idx === -1) return prev;
      const clone = [...prev.profiles];
      clone[idx] = { ...clone[idx], [key]: value };
      return { profiles: clone };
    });
  }

  const selectedRemoteProfile = remoteSettings.profiles.find(p => p.id === remoteSelectedId);

  async function performSaveIngestWindow(): Promise<void> {
    setLastError("");
    dismissCollectorWarning();
    try {
      const days = Math.max(1, Math.min(365, Math.floor(ingestWindowDays)));
      const saved = await setIngestWindowDays(days);
      setIngestWindowDaysState(saved);
      const syncResult = await refreshLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined);
      applyCollectorWarnings("Sync warning", syncResult);
      applyLocalEventsCache(await getLocalEvents(targetHostId !== "localhost" ? targetHostId : undefined, LOCAL_FETCH_LIMIT), "Sync load");
      if (rangeViewActive) {
        clearAppliedDateRangeFilters();
      }
      setRangeViewActive(false);
      setRangeLoadMessage("");
      setExportStatus(
        `Ingest window set to ${saved} days and synced (${syncResult.collected.toLocaleString()} events).`
      );
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to update ingest window.");
    }
  }

  async function trustGuardrailHostAndRun(): Promise<void> {
    if (!llmGuardrailBlock) return;
    const host = llmGuardrailBlock.host.toLowerCase();
    setLlmSettingsState((current) => {
      if (current.trustedHosts.some((entry) => entry.toLowerCase() === host)) {
        return current;
      }
      return {
        ...current,
        trustedHosts: [...current.trustedHosts, host]
      };
    });
    setExportStatus(`Added '${host}' to trusted hosts for this session. Save LLM Settings to persist.`);
    window.setTimeout(() => setExportStatus(""), 3500);
    await runLlmAnalysisNow();
  }

  async function sendLlmAnalysisOnceAnyway(): Promise<void> {
    if (!llmGuardrailBlock) return;
    setExportStatus(`Bypassing untrusted-host guardrail once for ${llmGuardrailBlock.host}.`);
    window.setTimeout(() => setExportStatus(""), 3000);
    await runLlmAnalysisNow({ allowUntrustedRawOnce: true });
  }

  async function previewRollingSyncLoad(): Promise<void> {
    if (targetHostId !== "localhost") {
      await performSaveIngestWindow();
      return;
    }

    setLastError("");
    dismissCollectorWarning();
    setIsEstimatingLoad(true);
    setPendingLoadEstimate(null);
    try {
      const days = Math.max(1, Math.min(365, Math.floor(ingestWindowDays)));
      const saved = await setIngestWindowDays(days);
      setIngestWindowDaysState(saved);
      const estimate = await estimateRefreshLocalEvents();
      setPendingLoadEstimate({
        mode: "rolling-sync",
        actionLabel: "Save & Sync",
        description: `Rolling sync estimate for the current ${saved}-day ingest window.`,
        estimate,
        normalizedFrom: formatDateInputValue(new Date(estimate.windowStart).getTime()),
        normalizedTo: formatDateInputValue(new Date(estimate.windowEnd).getTime())
      });
      setRangeLoadMessage("");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to preview ingest window.");
    } finally {
      setIsEstimatingLoad(false);
    }
  }

  function applyViewDateRange(from: string, to: string): void {
    const normalized = normalizeDateRange(from, to);
    setFilterDraft((prev) => ({ ...prev, dateFrom: normalized.from, dateTo: normalized.to }));
    setActiveFilters((prev) => ({ ...prev, dateFrom: normalized.from, dateTo: normalized.to }));
    setRangeViewActive(true);
  }

  async function loadEventsForResolvedRange(
    from: string,
    to: string,
    options?: { applyToFilters?: boolean; contextLabel?: string }
  ): Promise<boolean> {
    const normalized = normalizeDateRange(from, to);
    const applyToFilters = options?.applyToFilters ?? true;
    const contextLabel = options?.contextLabel ?? "Range load";
    setLastError("");
    dismissCollectorWarning();
    setRangeLoadMessage(`Loading events for ${normalized.from} to ${normalized.to}...`);
    setIsRangeLoading(true);
    try {
      const syncResult = await syncLocalEventsRange(normalized.from, normalized.to, false);
      applyCollectorWarnings(`${contextLabel} warning`, syncResult);
      const events = await getLocalEventsRange(targetHostId !== "localhost" ? targetHostId : undefined, normalized.from, normalized.to, LOCAL_FETCH_LIMIT);
      const truncated = applyLocalEventsCache(events, contextLabel);
      if (applyToFilters) {
        applyViewDateRange(normalized.from, normalized.to);
      }
      setRangeLoadMessage(
        truncated > 0
          ? `Data loaded with memory cap: ${MAX_LOCAL_EVENTS_IN_MEMORY.toLocaleString()} events shown for this range.`
          : `Data loaded and ready: ${events.length.toLocaleString()} events in range.`
      );
      setExportStatus(`Data loaded and ready for ${normalized.from} to ${normalized.to}.`);
      window.setTimeout(() => setExportStatus(""), 3000);
      return true;
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to load selected range.");
      setRangeLoadMessage("");
      return false;
    } finally {
      setIsRangeLoading(false);
    }
  }

  async function previewRangeLoad(): Promise<void> {
    if (!backfillFrom || !backfillTo) {
      setLastError("Range actions require both From and To dates.");
      return;
    }

    if (targetHostId !== "localhost") {
      await loadEventsForResolvedRange(backfillFrom, backfillTo, {
        applyToFilters: true,
        contextLabel: "Range load"
      });
      return;
    }

    const normalized = normalizeDateRange(backfillFrom, backfillTo);
    setLastError("");
    dismissCollectorWarning();
    setIsEstimatingLoad(true);
    setPendingLoadEstimate(null);
    try {
      const estimate = await estimateLocalEventsRange(normalized.from, normalized.to);
      setPendingLoadEstimate({
        mode: "range-load",
        actionLabel: "Load Events",
        description: "Exact-range estimate for the selected investigation window.",
        estimate,
        normalizedFrom: normalized.from,
        normalizedTo: normalized.to
      });
      setRangeLoadMessage("");
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to preview selected range.");
    } finally {
      setIsEstimatingLoad(false);
    }
  }

  async function confirmPendingLoadEstimate(): Promise<void> {
    if (!pendingLoadEstimate) return;

    if (pendingLoadEstimate.mode === "rolling-sync") {
      await performSaveIngestWindow();
    } else {
      await loadEventsForResolvedRange(pendingLoadEstimate.normalizedFrom, pendingLoadEstimate.normalizedTo, {
        applyToFilters: true,
        contextLabel: "Range load"
      });
    }

    setPendingLoadEstimate(null);
  }

  async function autoLoadCoverageForActiveFilters(): Promise<void> {
    if (!coverageAutoLoadRange) {
      setLastError("Applied date filters must include at least one valid date.");
      return;
    }
    setBackfillFrom(coverageAutoLoadRange.from);
    setBackfillTo(coverageAutoLoadRange.to);
    await loadEventsForResolvedRange(coverageAutoLoadRange.from, coverageAutoLoadRange.to, {
      applyToFilters: true,
      contextLabel: "Coverage auto-load"
    });
  }

  function updateExportFilter<K extends keyof ExportWizardFilters>(
    key: K,
    value: ExportWizardFilters[K]
  ): void {
    setExportFilters((current) => ({ ...current, [key]: value }));
  }

  function getExportTypeTag(filters: ExportWizardFilters): string {
    if (filters.category !== "all") return sanitizeFileTag(filters.category, "category");
    if (filters.logType !== "all") return sanitizeFileTag(filters.logType, "logtype");
    const selectedLevels = (["information", "warning", "error", "critical"] as EventSeverity[])
      .filter((level) => filters.severities[level]);
    if (selectedLevels.length === 1) {
      return sanitizeFileTag(selectedLevels[0], "severity");
    }
    return "mixed";
  }

  function buildSuggestedExportFilename(format: ExportFormat, scope: ExportScope, filters: ExportWizardFilters): string {
    const timestamp = formatExportTimestamp();
    const scopeTag = scope === "loaded" ? "loaded" : getExportTypeTag(filters);
    return `${timestamp}-hermes-${scopeTag}.${format}`;
  }

  async function exportEvents(format: ExportFormat, events: NormalizedEvent[], filename: string): Promise<void> {
    if (events.length === 0) {
      setLastError("There are no events in the selected export scope.");
      return;
    }
    setLastError("");
    try {
      if (isTauriRuntime()) {
        const location = await exportEventsWithDialog(format, filename, events);
        if (!location) {
          setExportStatus("Export canceled.");
          window.setTimeout(() => setExportStatus(""), 2000);
          return;
        }
        setExportStatus(`Exported to ${location}`);
        window.setTimeout(() => setExportStatus(""), 2500);
        return;
      }

      if (format === "json") {
        exportAsJson(events, filename);
      } else if (format === "csv") {
        exportAsCsv(events, filename);
      } else {
        exportAsText(events, filename);
      }
      setExportStatus("Export complete.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export events.");
    }
  }

  async function runExportWizard(): Promise<void> {
    const filename = buildSuggestedExportFilename(exportFormat, exportScope, exportFilters);
    await exportEvents(exportFormat, exportPreviewEvents, filename);
  }

  function openHelpTab(section: HelpSectionId = "quick-start"): void {
    setHelpTabOpen(true);
    setActiveHelpTopic(helpSectionToTopicMap[section]);
    setActiveTab("help");
  }

  function closeHelpTab(): void {
    setHelpTabOpen(false);
    if (activeTab === "help") {
      setActiveTab("home");
    }
  }

  return (
    <div className="h-screen overflow-hidden">
      <div className="mx-auto flex h-full max-w-screen-2xl flex-col gap-4 px-4 py-4">
        <header className={cn(panelClass, "flex flex-wrap items-center justify-between gap-4 px-5 py-4")}> 
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Hermes Log Analyst</h1>
            <p className="text-sm text-muted">Host OS: {hostOs} ({hostOsVersion})</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 border-r border-panel-border pr-3">
              <span className="text-xs font-semibold text-muted">Target Node</span>
              <select
                className="rounded-md border border-panel-border bg-[var(--field-bg)] px-2 py-1 text-[11px] text-text outline-none"
                value={targetHostId}
                onChange={(e) => {
                  setTargetHostId(e.target.value);
                  setLocalEvents([]);
                  setCrashes([]);
                  setCorrelatedEvents([]);
                  setSelected(null);
                  dismissCollectorWarning();
                }}
              >
                <option value="localhost">Local Machine</option>
                {remoteSettings.profiles.map(p => (
                  <option key={p.id} value={p.id}>{p.name} ({p.host})</option>
                ))}
              </select>
            </div>
            <Button variant="primary" onClick={() => void refreshNow()} disabled={isLoading}>
              {isLoading ? "Refreshing..." : "Refresh Logs"}
            </Button>
            <Button onClick={() => openHelpTab("quick-start")}>Help</Button>
            <Button variant="danger" onClick={() => void quitApp()}>Exit</Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {lastError && (
          <div className={cn(panelClass, "border-danger text-danger")}>{lastError}</div>
        )}
        {privilegedAccessWarning && (
          <div className={cn(panelClass, "border-panel-border bg-[var(--sev-warning)] px-4 py-3 text-sm text-text")}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Restricted Logs</div>
                <div className="text-sm font-semibold text-text">{privilegedAccessWarning.title}</div>
                <div className="text-sm text-text">{privilegedAccessWarning.detail}</div>
                <div className="text-xs text-muted">
                  Restricted source{privilegedAccessWarning.restrictedSources.length === 1 ? "" : "s"}:{" "}
                  {privilegedAccessWarning.restrictedSources.join(", ")}.
                </div>
                <div className="text-xs text-muted">{privilegedAccessWarning.rawMessage}</div>
                {targetHostId !== "localhost" && (
                  <div className="text-xs text-muted">
                    Elevated restart is only available for local collection. Remote targets must be handled on the remote host.
                  </div>
                )}
                {targetHostId === "localhost" && !ingestProfile.requestElevation && (
                  <div className="text-xs text-muted">
                    Enable `Allow elevated restart for restricted logs` in Settings to use one-click restart assistance.
                  </div>
                )}
                {targetHostId === "localhost" && ingestProfile.requestElevation && isDevHostedRuntime && (
                  <div className="text-xs text-muted">
                    Elevated restart is unavailable during `npm run tauri dev`. Start Hermes from an elevated terminal to test restricted-log access in development.
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {targetHostId === "localhost" && ingestProfile.requestElevation && !isDevHostedRuntime && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void restartElevatedNow()}
                    disabled={isRestartingElevated}
                  >
                    {isRestartingElevated ? "Restarting..." : "Restart with Elevated Access"}
                  </Button>
                )}
                {targetHostId === "localhost" &&
                  privilegedAccessWarning.platform === "windows" &&
                  privilegedAccessWarning.restrictedSources.some((source) => source.toLowerCase() === "security") && (
                    <Button size="sm" onClick={() => void disableSecurityCollectionNow()}>
                      Disable Security Collection
                    </Button>
                  )}
                <Button size="sm" onClick={dismissCollectorWarning}>Dismiss</Button>
              </div>
            </div>
          </div>
        )}
        {!privilegedAccessWarning && collectorWarning && (
          <div className={cn(panelClass, "border-panel-border bg-[var(--sev-warning)] text-text px-4 py-3 text-sm")}>
            {collectorWarning}
          </div>
        )}
        {memoryNotice && (
          <div className={cn(panelClass, "border-panel-border bg-accent/10 px-4 py-3 text-sm text-text")}>
            {memoryNotice}
          </div>
        )}
        {exportStatus && (
          <div className={cn(panelClass, "border-ok text-ok")}>{exportStatus}</div>
        )}

        <section className={cn(panelClass, "flex flex-wrap items-center gap-2 px-4 py-3")}>
          {workspaceTabs.map((tab) => (
            <Button
              key={tab.id}
              size="sm"
              variant={activeTab === tab.id ? "primary" : "secondary"}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </Button>
          ))}
          {helpTabOpen && (
            <div
              className={cn(
                "inline-flex items-center overflow-hidden rounded-lg border text-xs font-semibold",
                activeTab === "help" ? "border-transparent bg-accent text-white" : "border-panel-border bg-transparent text-text"
              )}
            >
              <button
                type="button"
                className="px-3 py-1"
                onClick={() => setActiveTab("help")}
                aria-current={activeTab === "help" ? "page" : undefined}
              >
                Help
              </button>
              <button
                type="button"
                className={cn(
                  "border-l px-2 py-1 text-[11px] transition",
                  activeTab === "help"
                    ? "border-white/30 hover:bg-white/20"
                    : "border-panel-border text-muted hover:bg-accent/10 hover:text-text"
                )}
                onClick={closeHelpTab}
                aria-label="Close Help tab"
                title="Close Help tab"
              >
                x
              </button>
            </div>
          )}
        </section>

        {activeTab === "help" && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-semibold">Help</div>
              <Button size="sm" onClick={closeHelpTab}>Close Help Tab</Button>
            </div>
            <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
              <aside className="space-y-2 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">Help Topics</div>
                {helpTopics.map((topic) => (
                  <button
                    key={topic.id}
                    type="button"
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left text-xs transition",
                      activeHelpTopic === topic.id
                        ? "border-transparent bg-accent text-white"
                        : "border-panel-border bg-transparent text-text hover:border-accent"
                    )}
                    onClick={() => setActiveHelpTopic(topic.id)}
                  >
                    <div className="font-semibold">{topic.label}</div>
                    <div className={cn("mt-1", activeHelpTopic === topic.id ? "text-white/90" : "text-muted")}>
                      {topic.summary}
                    </div>
                  </button>
                ))}
              </aside>

              <div className="space-y-3">
                <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                    {selectedHelpTopic.label}
                  </div>
                  <p className="mt-2 text-xs text-muted">{selectedHelpTopic.summary}</p>
                </div>

                {selectedHelpTopic.sections.map((section) => (
                  <article
                    key={`${selectedHelpTopic.id}-${section.id}`}
                    className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3"
                  >
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {section.title}
                    </div>
                    {section.paragraphs.map((paragraph, index) => (
                      <p key={`${section.id}-p-${index}`} className="mt-2 text-xs text-muted">
                        {paragraph}
                      </p>
                    ))}
                    {section.steps && section.steps.length > 0 && (
                      <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs text-muted">
                        {section.steps.map((step, index) => (
                          <li key={`${section.id}-s-${index}`}>{step}</li>
                        ))}
                      </ol>
                    )}
                    {section.tips && section.tips.length > 0 && (
                      <div className="mt-2 space-y-1 text-xs text-muted">
                        {section.tips.map((tip, index) => (
                          <div key={`${section.id}-t-${index}`}>Tip: {tip}</div>
                        ))}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {activeTab === "home" && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}>
            <div className="text-sm font-semibold">Dashboard</div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">Local Cache</div>
                <div className="mt-1 text-lg font-semibold">{localEvents.length.toLocaleString()} events</div>
                <div className="mt-1 text-xs text-muted">{localCoverageSummary}</div>
              </div>
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">Imported Session Data</div>
                <div className="mt-1 text-lg font-semibold">{importedEvents.length.toLocaleString()} events</div>
                <div className="mt-1 text-xs text-muted">Imported files are merged with local events in Event views.</div>
              </div>
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-[11px] uppercase tracking-wide text-muted">Crash Records</div>
                <div className="mt-1 text-lg font-semibold">{crashes.length.toLocaleString()} crashes</div>
                <div className="mt-1 text-xs text-muted">
                  {preCrashFocusEnabled ? `Pre-crash focus active: ${crashVisibleEvents.length.toLocaleString()} events in range.` : "No pre-crash focus active."}
                </div>
              </div>
            </div>
            <div className="grid gap-3 xl:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Event Volume Timeline</div>
                  <div className="text-[11px] text-muted">Click a day to focus Events tab</div>
                </div>
                {dashboardTimeline.length === 0 ? (
                  <div className="mt-3 text-xs text-muted">No timeline data available yet.</div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {dashboardTimeline.map((entry) => {
                      const maxCount = Math.max(...dashboardTimeline.map((item) => item.count), 1);
                      const width = Math.max(10, Math.round((entry.count / maxCount) * 100));
                      return (
                        <button
                          key={entry.date}
                          type="button"
                          className="grid w-full grid-cols-[120px_1fr_72px] items-center gap-3 text-left text-xs"
                          onClick={() => applyTimelineFocus(entry.date)}
                        >
                          <span className="text-muted">{entry.label}</span>
                          <span className="h-3 overflow-hidden rounded-full bg-black/5">
                            <span
                              className="block h-full rounded-full bg-accent/80 transition"
                              style={{ width: `${width}%` }}
                            />
                          </span>
                          <span className="text-right font-semibold text-text">{entry.count.toLocaleString()}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Severity Distribution</div>
                {dashboardSeverityMetrics.length === 0 ? (
                  <div className="mt-3 text-xs text-muted">No severity data available yet.</div>
                ) : (
                  <div className="mt-3 space-y-2">
                    {dashboardSeverityMetrics.map((metric) => (
                      <button
                        key={metric.value}
                        type="button"
                        className="flex w-full items-center justify-between rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                        onClick={() => applySeverityFocus(metric.value as EventSeverity)}
                      >
                        <span className="capitalize">{metric.label}</span>
                        <span className="font-semibold text-text">{metric.count.toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Top Providers</div>
                <div className="mt-2 space-y-2">
                  {dashboardProviderMetrics.length === 0 ? (
                    <div className="text-xs text-muted">No provider data available yet.</div>
                  ) : (
                    dashboardProviderMetrics.map((metric) => (
                      <button
                        key={metric.value}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                        onClick={() => applyProviderFocus(metric.value)}
                      >
                        <span className="truncate">{metric.label}</span>
                        <span className="font-semibold text-text">{metric.count.toLocaleString()}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Top Log Types</div>
                <div className="mt-2 space-y-2">
                  {dashboardLogTypeMetrics.length === 0 ? (
                    <div className="text-xs text-muted">No log type data available yet.</div>
                  ) : (
                    dashboardLogTypeMetrics.map((metric) => (
                      <button
                        key={metric.value}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                        onClick={() => applyLogTypeFocus(metric.value)}
                      >
                        <span className="truncate">{metric.label}</span>
                        <span className="font-semibold text-text">{metric.count.toLocaleString()}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
              {hasWindowsEvents && (
                <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Top Windows Event IDs</div>
                  <div className="mt-2 space-y-2">
                    {dashboardEventIdMetrics.length === 0 ? (
                      <div className="text-xs text-muted">No Windows event IDs available yet.</div>
                    ) : (
                      dashboardEventIdMetrics.map((metric) => (
                        <button
                          key={metric.value}
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                          onClick={() => applyEventIdFocus(metric.value)}
                        >
                          <span>{metric.label}</span>
                          <span className="font-semibold text-text">{metric.count.toLocaleString()}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Noisy Sources</div>
                <div className="mt-2 space-y-2">
                  {dashboardNoisySources.length === 0 ? (
                    <div className="text-xs text-muted">No repeated warning/error sources detected yet.</div>
                  ) : (
                    dashboardNoisySources.map((metric) => (
                      <button
                        key={metric.value}
                        type="button"
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                        onClick={() => applyProviderFocus(metric.label.replace(/\s+\((?:information|warning|error|critical)\)$/i, ""))}
                      >
                        <span className="truncate">{metric.label}</span>
                        <span className="font-semibold text-text">{metric.count.toLocaleString()}</span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">Recent Events</div>
              {dashboardRecentEvents.length === 0 ? (
                <div className="mt-2 text-xs text-muted">No events loaded yet. Click Refresh Logs to ingest current host logs.</div>
              ) : (
                <div className="mt-2 space-y-2">
                  {dashboardRecentEvents.map((event) => (
                    <button
                      key={event.id}
                      className="flex w-full items-center justify-between gap-3 rounded-lg border border-panel-border px-3 py-2 text-left text-xs transition hover:border-accent"
                      onClick={() => {
                        setSelected(event);
                        setActiveTab("events");
                      }}
                      title={event.message}
                    >
                      <span className="truncate text-muted">{new Date(event.timestamp).toLocaleString()}</span>
                      <span className="truncate font-semibold">{event.provider}</span>
                      <span className="truncate capitalize">{event.severity}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "import" && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}>
            <div>
              <div className="text-sm font-semibold">Import Logs</div>
              <p className="mt-1 text-xs text-muted">
                Import previously exported `JSON` or `CSV` files to merge them into this investigation session.
              </p>
            </div>
            <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
              <label className="grid gap-2 text-xs text-muted">
                Select file
                <input
                  className={cn(inputClass, "text-xs")}
                  type="file"
                  accept=".json,.csv"
                  onChange={(event) => void onImport(event.target.files)}
                />
              </label>
              <div className="mt-3 text-[11px] text-muted">
                Imported events in memory: {importedEvents.length.toLocaleString()} / {MAX_IMPORTED_EVENTS_IN_MEMORY.toLocaleString()}.
              </div>
            </div>
          </section>
        )}

        {activeTab === "export" && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}>
            <div>
              <div className="text-sm font-semibold">Export Logs</div>
              <p className="mt-1 text-xs text-muted">
                Use this workflow to export either the full loaded cache or a custom filtered subset for this {hostOs} host.
              </p>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Step 1: Scope</div>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === "loaded"}
                    onChange={() => setExportScope("loaded")}
                  />
                  Current loaded list ({allEvents.length.toLocaleString()} events)
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="export-scope"
                    checked={exportScope === "custom"}
                    onChange={() => setExportScope("custom")}
                  />
                  Custom filtered export (host OS options)
                </label>
                <div className="text-[11px] text-muted">
                  Custom export options are generated from currently loaded {hostOs} events.
                </div>
              </div>
              <div className="space-y-3 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Step 2: Format</div>
                <select
                  className={selectClass}
                  value={exportFormat}
                  onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                >
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="txt">Plain Text (.txt)</option>
                </select>
                <div className="text-[11px] text-muted">
                  Export opens a save dialog so you can pick destination and filename before writing.
                </div>
              </div>
            </div>
            {exportScope === "custom" && (
              <div className="space-y-3 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Step 3: Custom Filters</div>
                <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
                  <label className="flex w-full items-center gap-2 text-xs text-muted">
                    <span className="shrink-0">From</span>
                    <input
                      className={inputClass}
                      type="date"
                      value={exportFilters.dateFrom}
                      onChange={(event) => {
                        updateExportFilter("dateFrom", event.currentTarget.value);
                        blurDateInputIfComplete(event.currentTarget);
                      }}
                    />
                  </label>
                  <label className="flex w-full items-center gap-2 text-xs text-muted">
                    <span className="shrink-0">To</span>
                    <input
                      className={inputClass}
                      type="date"
                      value={exportFilters.dateTo}
                      onChange={(event) => {
                        updateExportFilter("dateTo", event.currentTarget.value);
                        blurDateInputIfComplete(event.currentTarget);
                      }}
                    />
                  </label>
                  <label className="text-xs text-muted">
                    Log type
                    <select
                      className={selectClass}
                      value={exportFilters.logType}
                      onChange={(event) => updateExportFilter("logType", event.target.value)}
                    >
                      <option value="all">All log types</option>
                      {exportLogTypeOptions.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted">
                    Category
                    <select
                      className={selectClass}
                      value={exportFilters.category}
                      onChange={(event) =>
                        updateExportFilter("category", event.target.value as "all" | EventCategory)
                      }
                    >
                      <option value="all">All categories</option>
                      {exportCategoryOptions.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-muted md:col-span-2">
                    Provider/source contains
                    <input
                      className={inputClass}
                      value={exportFilters.source}
                      onChange={(event) => updateExportFilter("source", event.target.value)}
                      placeholder="Example: kernel, systemd, node"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  {(["information", "warning", "error", "critical"] as const).map((level) => (
                    <label key={level} className="flex items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={exportFilters.severities[level]}
                        onChange={(event) =>
                          updateExportFilter("severities", {
                            ...exportFilters.severities,
                            [level]: event.target.checked
                          })
                        }
                      />
                      <span className="capitalize">{level}</span>
                    </label>
                  ))}
                </div>
                <div>
                  <Button size="sm" onClick={() => setExportFilters(createDefaultExportFilters())}>
                    Reset Custom Filters
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
              <div className="space-y-1">
                <div className="text-sm text-muted">
                  Preview: <span className="font-semibold text-text">{exportPreviewEvents.length.toLocaleString()}</span> events ready
                </div>
                <div className="text-xs text-muted">{exportPreviewExplanation}</div>
              </div>
              <Button
                variant="primary"
                onClick={() => void runExportWizard()}
                disabled={exportPreviewEvents.length === 0}
              >
                Export Logs
              </Button>
            </div>
            <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-1">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted">Ops Summary</div>
                  <div className="text-sm text-text">
                    Summary scope: {exportOpsSummary.coverageLabel}
                  </div>
                  <div className="text-xs text-muted">
                    Includes totals, severity mix, top providers/log types, noisy sources, timeline spikes, and selected-event findings when applicable.
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => void exportOpsSummaryTextNow()}
                    disabled={exportPreviewEvents.length === 0}
                  >
                    Export Summary TXT
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void exportOpsSummaryHtmlNow()}
                    disabled={exportPreviewEvents.length === 0}
                  >
                    Export Summary HTML (PDF-ready)
                  </Button>
                </div>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="rounded-lg border border-panel-border bg-panel px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Events In Scope</div>
                  <div className="mt-1 text-lg font-semibold text-text">
                    {exportOpsSummary.totalEvents.toLocaleString()}
                  </div>
                </div>
                <div className="rounded-lg border border-panel-border bg-panel px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Notable Spike</div>
                  <div className="mt-1 text-xs text-text">{exportOpsSummary.notableSpike}</div>
                </div>
                <div className="rounded-lg border border-panel-border bg-panel px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted">Selected Event</div>
                  <div className="mt-1 text-xs text-text">{exportOpsSummary.selectedEventFinding}</div>
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === "settings" && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}> 
            <div className="text-sm font-semibold">Settings</div>
            <div className="grid gap-3">
              <div className="text-sm font-semibold">Collection</div>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={ingestProfile.autoSyncOnStartup}
                  onChange={(e) => setIngestProfileState((current) => ({ ...current, autoSyncOnStartup: e.target.checked }))}
                />
                Auto-sync logs on app startup
              </label>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={Boolean(ingestProfile.requestElevation)}
                  onChange={(e) =>
                    setIngestProfileState((current) => ({ ...current, requestElevation: e.target.checked }))
                  }
                />
                Allow elevated restart for restricted logs
              </label>
              <div className="grid gap-2 md:grid-cols-[220px_1fr]">
                <label className="text-xs text-muted">Max events per sync</label>
                <input
                  className={inputClass}
                  type="number"
                  min={100}
                  max={20000}
                  value={ingestProfile.maxEventsPerSync}
                  onChange={(e) =>
                    setIngestProfileState((current) => ({
                      ...current,
                      maxEventsPerSync: Number(e.target.value)
                    }))
                  }
                />
              </div>
              {hostOs === "windows" && (
                <div className="grid gap-2">
                  <div className="text-xs text-muted">Windows Event Logs to ingest</div>
                  <div className="flex flex-wrap gap-3">
                    {windowsChannelOptions.map((channel) => (
                      <label key={channel} className="flex items-center gap-2 text-xs text-muted">
                        <input
                          type="checkbox"
                          checked={ingestProfile.windowsChannels.includes(channel)}
                          onChange={(e) => toggleWindowsChannel(channel, e.target.checked)}
                        />
                        {channel}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void saveIngestCollectionSettings()}>
                  Save Collection Settings
                </Button>
              </div>
            </div>
            <div className="grid gap-3 border-t border-panel-border pt-4">
              <div className="text-sm font-semibold">Remote Hosts (Connections)</div>
              <div className="grid gap-2 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Hosts</div>
                <div className="grid gap-3 md:grid-cols-[280px_1fr]">
                  <div className="space-y-2">
                    <select
                      className={cn(selectClass, "h-[220px]")}
                      size={8}
                      value={remoteSelectedId}
                      onChange={(e) => setRemoteSelectedId(e.target.value)}
                    >
                      {remoteSettings.profiles.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.host})</option>
                      ))}
                    </select>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={addRemoteProfile}>Add Host</Button>
                      <Button size="sm" onClick={deleteSelectedRemoteProfile} disabled={!remoteSelectedId}>Remove</Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {!selectedRemoteProfile ? <div className="text-xs text-muted">No host selected.</div> : (
                      <>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="text-xs text-muted">Name
                            <input className={inputClass} value={selectedRemoteProfile.name} onChange={e => updateSelectedRemoteProfile("name", e.target.value)} />
                          </label>
                          <label className="text-xs text-muted">Host IP / FQDN
                            <input className={inputClass} value={selectedRemoteProfile.host} onChange={e => updateSelectedRemoteProfile("host", e.target.value)} />
                          </label>
                          <label className="text-xs text-muted">Target OS
                            <select className={selectClass} value={selectedRemoteProfile.os} onChange={e => updateSelectedRemoteProfile("os", e.target.value)}>
                              <option value="windows">Windows</option>
                              <option value="linux">Linux</option>
                              <option value="macos">macOS</option>
                            </select>
                          </label>
                          <label className="text-xs text-muted">Protocol
                            <select className={selectClass} value={selectedRemoteProfile.protocol} onChange={e => updateSelectedRemoteProfile("protocol", e.target.value)}>
                              <option value="ssh">SSH</option>
                              <option value="winrm">WinRM (HTTPS)</option>
                            </select>
                          </label>
                          <label className="text-xs text-muted">Username
                            <input className={inputClass} value={selectedRemoteProfile.username} onChange={e => updateSelectedRemoteProfile("username", e.target.value)} />
                          </label>
                          <label className="text-xs text-muted">Auth Type
                            <select className={selectClass} value={selectedRemoteProfile.auth_type} onChange={e => updateSelectedRemoteProfile("auth_type", e.target.value)}>
                              <option value="key">SSH Key / OS Keychain</option>
                              <option value="password">Password</option>
                            </select>
                          </label>
                        </div>
                        {selectedRemoteProfile.auth_type === "key" && selectedRemoteProfile.protocol === "ssh" && (
                          <label className="text-xs text-muted block mt-2">SSH Key Path (IdentityFile)
                            <input className={inputClass} placeholder="~/.ssh/id_rsa" value={selectedRemoteProfile.ssh_key_path || ""} onChange={e => updateSelectedRemoteProfile("ssh_key_path", e.target.value)} />
                          </label>
                        )}
                        <Button variant="primary" size="sm" className="mt-3" onClick={() => void saveRemoteHostSettings()}>Save Remote Layout</Button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3 border-t border-panel-border pt-4">
              <div className="text-sm font-semibold">Research Assistant (LLM)</div>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="text-xs text-muted">
                  Default profile
                  <select
                    className={selectClass}
                    value={llmSettings.defaultProfileId}
                    onChange={(e) =>
                      setLlmSettingsState((current) => ({
                        ...current,
                        defaultProfileId: e.target.value,
                        backupProfileId:
                          current.backupProfileId === e.target.value ? "" : current.backupProfileId
                      }))
                    }
                  >
                    {llmSettings.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Backup profile (global fallback)
                  <select
                    className={selectClass}
                    value={llmSettings.backupProfileId}
                    onChange={(e) =>
                      setLlmSettingsState((current) => ({
                        ...current,
                        backupProfileId: e.target.value
                      }))
                    }
                  >
                    <option value="">None</option>
                    {llmSettings.profiles
                      .filter((profile) => profile.id !== llmSettings.defaultProfileId)
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted">
                <input
                  type="checkbox"
                  checked={llmSettings.neverSendRawEventToUntrusted}
                  onChange={(e) =>
                    setLlmSettingsState((current) => ({
                      ...current,
                      neverSendRawEventToUntrusted: e.target.checked
                    }))
                  }
                />
                Never send raw event message to untrusted hosts
              </label>
              <div className="grid gap-2 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Profiles
                </div>
                <div className="grid gap-3 md:grid-cols-[280px_1fr]">
                  <div className="space-y-2">
                    <label className="text-xs text-muted">
                      Saved profiles
                      <select
                        className={cn(selectClass, "h-[220px]")}
                        size={8}
                        value={llmSelectedProfile?.id ?? ""}
                        onChange={(e) => setLlmSelectedProfileId(e.target.value)}
                      >
                        {llmSettings.profiles.map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.name} ({profile.provider}, {profile.scope})
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={addLlmProfile}>Add Profile</Button>
                      <Button
                        size="sm"
                        onClick={deleteSelectedLlmProfile}
                        disabled={!llmSelectedProfile || llmSettings.profiles.length <= 1}
                      >
                        Delete Profile
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {!llmSelectedProfile && (
                      <div className="text-xs text-muted">No profile selected.</div>
                    )}
                    {llmSelectedProfile && (
                      <>
                        <div className="grid gap-2 md:grid-cols-2">
                          <label className="text-xs text-muted">
                            Name
                            <input
                              className={inputClass}
                              value={llmSelectedProfile.name}
                              onChange={(e) => updateSelectedLlmProfile("name", e.target.value)}
                            />
                          </label>
                          <label className="text-xs text-muted">
                            Provider
                            <select
                              className={selectClass}
                              value={llmSelectedProfile.provider}
                              onChange={(e) => updateSelectedLlmProfile("provider", e.target.value)}
                            >
                              {llmProviderOptions.map((provider) => (
                                <option key={provider.id} value={provider.id}>
                                  {provider.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs text-muted">
                            Scope
                            <select
                              className={selectClass}
                              value={llmSelectedProfile.scope}
                              onChange={(e) => updateSelectedLlmProfile("scope", e.target.value)}
                            >
                              {llmScopeOptions.map((scope) => (
                                <option key={scope.id} value={scope.id}>
                                  {scope.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="text-xs text-muted">
                            Default model
                            <input
                              className={inputClass}
                              value={llmSelectedProfile.model}
                              onChange={(e) => updateSelectedLlmProfile("model", e.target.value)}
                              placeholder="model id"
                            />
                          </label>
                        </div>
                        <label className="text-xs text-muted">
                          Base URL
                          <input
                            className={inputClass}
                            value={llmSelectedProfile.baseUrl}
                            onChange={(e) => updateSelectedLlmProfile("baseUrl", e.target.value)}
                            placeholder="https://host/v1"
                          />
                        </label>
                        <div className="grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-end">
                          <label className="text-xs text-muted">
                            API key (stored in OS keychain)
                            <input
                              className={inputClass}
                              type="password"
                              autoComplete="off"
                              value={llmApiKeyDraft}
                              onChange={(e) => setLlmApiKeyDraft(e.target.value)}
                              placeholder={
                                llmSelectedProfile.apiKeyConfigured
                                  ? "Configured in keychain (enter to replace)"
                                  : "Enter API key"
                              }
                            />
                          </label>
                          <Button
                            size="sm"
                            onClick={() => void clearLlmApiKeyNow()}
                            disabled={!llmSelectedProfile.apiKeyConfigured}
                          >
                            Clear API Key
                          </Button>
                          <label className="flex items-center gap-2 text-xs text-muted">
                            <input
                              type="checkbox"
                              checked={llmSelectedProfile.enabled}
                              onChange={(e) => updateSelectedLlmProfile("enabled", e.target.checked)}
                            />
                            Profile enabled
                          </label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => void runLlmConnectionTest()}
                            disabled={isTestingLlmProfile}
                          >
                            {isTestingLlmProfile ? "Testing..." : "Test Connection"}
                          </Button>
                          {llmTestResult && (
                            <span
                              className={cn(
                                "text-xs",
                                llmTestResult.ok ? "text-ok" : "text-[var(--sev-error)]"
                              )}
                            >
                              {llmTestResult.message}
                            </span>
                          )}
                        </div>
                        {llmTestResult && llmTestResult.detectedModels.length > 0 && (
                          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-panel-border px-2 py-2 text-xs text-muted">
                            <span>Detected models:</span>
                            {llmTestResult.detectedModels.map((model) => (
                              <button
                                key={model}
                                type="button"
                                className="rounded-full border border-panel-border px-2 py-1 text-xs text-text hover:bg-white/30"
                                onClick={() => applyDetectedModel(model)}
                              >
                                {model}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
              <div className="grid gap-2 rounded-lg border border-panel-border bg-[var(--field-bg)] p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                  Local + LAN Discovery
                </div>
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={llmSettings.allowLanDiscovery}
                    onChange={(e) =>
                      setLlmSettingsState((current) => ({
                        ...current,
                        allowLanDiscovery: e.target.checked
                      }))
                    }
                  />
                  Allow LAN provider discovery (use only on trusted networks)
                </label>
                <div className="flex flex-wrap items-center gap-4">
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={llmIncludeNonPrivateInterfaces}
                      onChange={(e) => setLlmIncludeNonPrivateInterfaces(e.target.checked)}
                    />
                    Include non-private/VPN interfaces
                  </label>
                  <label className="flex items-center gap-2 text-xs text-muted">
                    <input
                      type="checkbox"
                      checked={llmIncludeLoopbackInterfaces}
                      onChange={(e) => setLlmIncludeLoopbackInterfaces(e.target.checked)}
                    />
                    Include loopback interfaces
                  </label>
                  <Button size="sm" onClick={() => void detectNetworksNow()}>
                    {isDetectingNetworks ? "Detecting..." : "Detect Networks"}
                  </Button>
                </div>
                <label className="text-xs text-muted">
                  Scan interface
                  <select
                    className={selectClass}
                    value={llmSelectedNetworkId}
                    onChange={(e) => setLlmSelectedNetworkId(e.target.value)}
                  >
                    {llmNetworks.length === 0 && <option value="">No interfaces detected</option>}
                    {llmNetworks.map((network) => (
                      <option key={network.id} value={network.id}>
                        {network.name}: {network.ip} ({network.cidr})
                        {network.isDefaultCandidate ? " [default]" : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="text-xs text-muted">
                Trusted LAN hosts (comma-separated host/IP)
                <input
                  className={inputClass}
                  value={llmSettings.trustedHosts.join(", ")}
                  onChange={(e) =>
                    setLlmSettingsState((current) => ({
                      ...current,
                      trustedHosts: e.target.value
                        .split(",")
                        .map((entry) => entry.trim())
                        .filter((entry) => entry.length > 0)
                    }))
                  }
                  placeholder="192.168.1.20, llm-node.local"
                />
              </label>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => void saveLlmSettingsNow()}>
                  Save LLM Settings
                </Button>
                <Button onClick={() => void detectLocalProvidersNow()}>
                  Detect Local Providers
                </Button>
                <Button
                  onClick={() => void scanLanProvidersNow()}
                  disabled={!llmSettings.allowLanDiscovery || isScanningLan || !llmSelectedNetworkId}
                >
                  {isScanningLan ? "Scanning LAN..." : "Scan LAN Providers"}
                </Button>
              </div>
              {llmCandidates.length > 0 && (
                <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] p-3 text-xs text-muted">
                  <div className="mb-1 font-semibold text-text">Detected endpoints</div>
                  {llmCandidates.map((candidate) => (
                    <div
                      key={`${candidate.providerId}-${candidate.endpoint}`}
                      className="mb-1 flex flex-wrap items-center justify-between gap-2"
                    >
                      <span>
                        {candidate.providerId} ({candidate.scope}): {candidate.endpoint}
                        {candidate.networkCidr ? ` | ${candidate.networkCidr}` : ""}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => applyCandidateToSelectedProfile(candidate)}
                        disabled={!llmSelectedProfile}
                      >
                        Apply to Selected Profile
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {activeTab === "crashes" && (
          <section className={cn(panelClass, "space-y-3 px-5 py-4")}>
            <div className="text-sm font-semibold">Crash Correlation</div>
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="primary" onClick={() => void importHostCrashesNow()}>Import Host Crashes</Button>
              <label className="text-xs text-muted">Crash</label>
              <select className={cn(selectClass, "max-w-xs text-xs")} value={selectedCrashId} onChange={(e) => void onCrashSelectionChange(e.target.value)}>
                {crashes.length === 0 && <option value="">No crashes recorded</option>}
                {crashes.map((crash) => (
                  <option key={crash.id} value={crash.id}>
                    {new Date(crash.timestamp).toLocaleString()} - {crash.crashType} {crash.code ? `(${crash.code})` : ""}
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">Related in +/-15m: {correlatedEvents.length}</span>
              {selectedCrash && (
                <span className="text-xs text-muted">Suspected: {selectedCrash.suspectedComponent ?? "Unknown"}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-panel-border pt-3">
              <label className="text-xs text-muted">Pre-crash window</label>
              <select
                className={cn(selectClass, "w-28 text-xs")}
                value={preCrashWindowMinutes}
                onChange={(e) => setPreCrashWindowMinutes(Number(e.target.value))}
              >
                <option value={5}>5 min</option>
                <option value={15}>15 min</option>
                <option value={30}>30 min</option>
                <option value={60}>60 min</option>
              </select>
              <Button size="sm" variant="primary" onClick={() => void applyPreCrashFocus()} disabled={!selectedCrash || isRangeLoading}>
                {isRangeLoading ? "Loading Crash Window..." : "Investigate Pre-Crash"}
              </Button>
              <Button size="sm" onClick={clearPreCrashFocus} disabled={!preCrashFocusEnabled}>
                Clear Pre-Crash View
              </Button>
              {preCrashFocusEnabled && selectedCrash && (
                <span className="text-xs text-muted">
                  Showing {crashVisibleEvents.length.toLocaleString()} events in the {preCrashWindowMinutes} minutes before the selected crash.
                </span>
              )}
            </div>
            {preCrashFocusEnabled && useCrashCorrelatedFallback && (
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2 text-xs text-muted">
                No events were found in the selected pre-crash window. Showing correlated events from the wider +/-15m crash window below.
              </div>
            )}
            {!preCrashFocusEnabled && (
              <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2 text-xs text-muted">
                Select a crash and click Investigate Pre-Crash to load matching events below.
              </div>
            )}
            {selectedCrash && correlatedEvents.length > 0 && (
              <div className="flex flex-wrap gap-2 border-t border-panel-border pt-3">
                <div className="w-full text-sm font-semibold">Top Correlated Events (+/-15m)</div>
                {correlatedEvents.slice(0, 8).map((event) => (
                  <button
                    key={event.id}
                    className={cn(
                      "inline-flex items-center gap-2 rounded-full border border-panel-border px-3 py-1 text-xs text-text transition",
                      severityTint(event.severity)
                    )}
                    onClick={() => setSelected(event)}
                    title={event.message}
                  >
                    <span className="font-semibold">{event.provider}</span>
                    <span className="uppercase text-[10px] text-muted">{event.severity}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {activeTab === "events" && (
          <section className={cn(panelClass, "space-y-3 px-5 py-4")}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm font-semibold">Filters</div>
              <span className="text-xs text-muted">{hasPendingFilterChanges ? "Changes not applied" : "Applied"}</span>
            </div>
            <div className={filterGridClass}>
              <input
                className={inputClass}
                value={filterDraft.text}
                placeholder="Search message/log text"
                onChange={(e) => updateFilter("text", e.target.value)}
              />
              {hasWindowsEvents && (
                <input
                  className={inputClass}
                  value={filterDraft.eventId}
                  placeholder="Event ID (Windows)"
                  onChange={(e) => updateFilter("eventId", e.target.value)}
                />
              )}
              <input
                className={inputClass}
                value={filterDraft.source}
                placeholder="Provider/source"
                onChange={(e) => updateFilter("source", e.target.value)}
              />
              <select className={selectClass} value={filterDraft.logType} onChange={(e) => updateFilter("logType", e.target.value)}>
                <option value="all">All log types</option>
                {logTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <label className="flex w-full items-center gap-2 text-xs text-muted">
                <span className="shrink-0">From</span>
                <input
                  className={inputClass}
                  type="date"
                  value={filterDraft.dateFrom}
                  onChange={(e) => {
                    updateFilter("dateFrom", e.currentTarget.value);
                    blurDateInputIfComplete(e.currentTarget);
                  }}
                />
              </label>
              <label className="flex w-full items-center gap-2 text-xs text-muted">
                <span className="shrink-0">To</span>
                <input
                  className={inputClass}
                  type="date"
                  value={filterDraft.dateTo}
                  onChange={(e) => {
                    updateFilter("dateTo", e.currentTarget.value);
                    blurDateInputIfComplete(e.currentTarget);
                  }}
                />
              </label>
              <select className={selectClass} value={filterDraft.category} onChange={(e) => updateFilter("category", e.target.value as EventFilters["category"])}>
                <option value="all">All categories</option>
                <option value="application">Application</option>
                <option value="security">Security</option>
                <option value="system">System</option>
                <option value="audit">Audit</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {(["information", "warning", "error", "critical"] as const).map((level) => (
                <label key={level} className="flex items-center gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={filterDraft.severities[level]}
                    onChange={(e) =>
                      updateFilter("severities", {
                        ...filterDraft.severities,
                        [level]: e.target.checked
                      })
                    }
                  />
                  <span className="capitalize">{level}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={resetFilterDraft}>Reset Inputs</Button>
              <Button size="sm" variant="primary" onClick={applyFilterChanges} disabled={!hasPendingFilterChanges}>
                Apply Filters
              </Button>
            </div>
            {activeDateCoverageWarning && (
              <div className="rounded-lg border border-panel-border bg-[var(--sev-warning)] px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{activeDateCoverageWarning}</span>
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void autoLoadCoverageForActiveFilters()}
                    disabled={isRangeLoading || !coverageAutoLoadRange}
                  >
                    {isRangeLoading ? "Loading..." : "Auto-Load Filter Range"}
                  </Button>
                </div>
              </div>
            )}
          </section>
        )}

        {activeTab === "data" && (
          <section className={cn(panelClass, "space-y-3 px-5 py-4")}>
            <div className="text-sm font-semibold">Data Window</div>
            <p className="text-xs text-muted">{localCoverageSummary}</p>
            <p className="text-[11px] text-muted">
              Filters apply to the local cache shown above. Load/Sync data first if your filter dates are older than coverage.
            </p>
            <div className="grid gap-2 md:grid-cols-[160px_1fr]">
              <label className="text-xs text-muted">Ingest Window (days)</label>
              <div className="flex flex-wrap gap-2">
                <input
                  className={inputClass}
                  type="number"
                  min={1}
                  max={365}
                  value={ingestWindowDays}
                  onChange={(e) => {
                    setIngestWindowDaysState(Number(e.target.value));
                    setPendingLoadEstimate(null);
                  }}
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void previewRollingSyncLoad()}
                  disabled={isEstimatingLoad || isRangeLoading}
                >
                  {isEstimatingLoad && pendingLoadEstimate?.mode !== "range-load" ? "Estimating..." : "Save & Sync"}
                </Button>
                <div className="w-full text-[11px] text-muted">
                  Rolling default window. `Save & Sync` now previews the estimated load first, then confirms before collecting.
                </div>
              </div>
            </div>
            <div className="grid gap-2">
              <label className="text-xs text-muted">Backfill Range</label>
              <div className="text-[11px] text-muted">
                One-time explicit date span for investigations. `Load Events` fetches this exact range.
              </div>
              <div className="grid gap-2 md:grid-cols-2">
                <label className="flex w-full items-center gap-2 text-xs text-muted">
                  <span className="shrink-0">From</span>
                  <input
                    className={inputClass}
                    type="date"
                    value={backfillFrom}
                    onChange={(e) => {
                      setBackfillFrom(e.currentTarget.value);
                      setPendingLoadEstimate(null);
                      blurDateInputIfComplete(e.currentTarget);
                    }}
                  />
                </label>
                <label className="flex w-full items-center gap-2 text-xs text-muted">
                  <span className="shrink-0">To</span>
                  <input
                    className={inputClass}
                    type="date"
                    value={backfillTo}
                    onChange={(e) => {
                      setBackfillTo(e.currentTarget.value);
                      setPendingLoadEstimate(null);
                      blurDateInputIfComplete(e.currentTarget);
                    }}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void previewRangeLoad()}
                  disabled={isRangeLoading || isEstimatingLoad}
                >
                  {isEstimatingLoad ? "Estimating..." : "Load Events"}
                </Button>
              </div>
              {pendingLoadEstimate && (
                <div className="space-y-3 rounded-xl border border-panel-border bg-panel px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="text-sm font-semibold">Load estimate ready</div>
                      <div className="text-xs text-muted">{pendingLoadEstimate.description}</div>
                    </div>
                    <div className="rounded-lg border border-panel-border px-2 py-1 text-xs font-semibold">
                      Impact: {classifyLoadImpact(
                        pendingLoadEstimate.estimate.estimatedCount,
                        pendingLoadEstimate.estimate.estimatedBytes
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg border border-panel-border px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted">Estimated events</div>
                      <div className="text-sm font-semibold">
                        {pendingLoadEstimate.estimate.estimatedCount.toLocaleString()}
                      </div>
                    </div>
                    <div className="rounded-lg border border-panel-border px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted">Approx. payload</div>
                      <div className="text-sm font-semibold">
                        {formatBytesApprox(pendingLoadEstimate.estimate.estimatedBytes)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-panel-border px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted">Current sync cap</div>
                      <div className="text-sm font-semibold">
                        {ingestProfile.maxEventsPerSync.toLocaleString()} events
                      </div>
                    </div>
                    <div className="rounded-lg border border-panel-border px-3 py-2">
                      <div className="text-[11px] uppercase tracking-wide text-muted">Target window</div>
                      <div className="text-sm font-semibold">
                        {formatEstimateWindowLabel(pendingLoadEstimate.estimate)}
                      </div>
                    </div>
                  </div>
                  {pendingLoadEstimate.estimate.estimatedCount > ingestProfile.maxEventsPerSync && (
                    <div className="rounded-lg border border-danger px-3 py-2 text-xs text-text">
                      The selected window likely contains more events than the current sync cap. This action will only
                      ingest the newest {ingestProfile.maxEventsPerSync.toLocaleString()} events unless you raise
                      `Max events per sync` first.
                    </div>
                  )}
                  {Math.min(
                    pendingLoadEstimate.estimate.estimatedCount,
                    ingestProfile.maxEventsPerSync
                  ) > MAX_LOCAL_EVENTS_IN_MEMORY && (
                    <div className="rounded-lg border border-panel-border px-3 py-2 text-xs text-text">
                      Hermes will still cap the in-memory table view to{" "}
                      {MAX_LOCAL_EVENTS_IN_MEMORY.toLocaleString()} events to keep RAM stable.
                    </div>
                  )}
                  {pendingLoadEstimate.estimate.warnings.length > 0 && (
                    <div className="rounded-lg border border-danger px-3 py-2 text-xs text-text">
                      {pendingLoadEstimate.estimate.warnings.join(" ")}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => void confirmPendingLoadEstimate()}
                      disabled={isRangeLoading}
                    >
                      Continue {pendingLoadEstimate.actionLabel}
                    </Button>
                    <Button size="sm" onClick={() => setPendingLoadEstimate(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
              {rangeLoadMessage && (
                <div className={cn("text-xs", isRangeLoading ? "text-muted animate-pulse" : "text-ok")}>
                  {rangeLoadMessage}
                </div>
              )}
              {rangeViewActive && (
                <div className="text-xs text-muted">
                  Range-focused view is active. Use Refresh Logs to return to rolling ingest-window view.
                </div>
              )}
            </div>
          </section>
        )}

        {(activeTab === "events" || activeTab === "crashes") && (
          <section className={cn(panelClass, "flex flex-wrap items-center justify-between gap-3 px-5 py-3")}> 
            <Button size="sm" onClick={resetSort} disabled={!sortState}>Reset Sort</Button>
            {activeTab === "crashes" && (
              <span className="text-xs font-semibold text-muted">{crashResultsModeLabel}</span>
            )}
            {sortState && (
              <span className="text-xs text-muted">Sorted by {sortLabels[sortState.column]} ({sortState.direction})</span>
            )}
            <span className="text-xs text-muted">
              Selected event: {selected ? formatSelectedSummary(selected) : "None"}
            </span>
          </section>
        )}

        {(activeTab === "events" || activeTab === "crashes") && (
          <section
            ref={tableContainerRef}
            onScroll={(event) => setTableScrollTop(event.currentTarget.scrollTop)}
            className={cn(panelClass, "overflow-auto")}
          >
          {activeTab === "crashes" && (
            <div className="border-b border-panel-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted">
              {useCrashCorrelatedFallback ? "Correlated Results View (+/-15m)" : "Pre-Crash Results View"}
            </div>
          )}
          <table className={cn("w-full table-fixed", hasWindowsEvents ? "min-w-[1100px]" : "min-w-[1000px]")}>
            <thead className="sticky top-0 z-10 bg-panel backdrop-blur">
              <tr className="text-left text-xs uppercase tracking-wide text-muted">
                <th className="w-40 px-3 py-2">
                  <button onClick={() => onColumnSort("timestamp")} className="flex items-center gap-2 font-semibold">
                    Time <span className="text-muted">{sortIndicator("timestamp")}</span>
                  </button>
                </th>
                <th className="w-40 px-3 py-2">
                  <button onClick={() => onColumnSort("type")} className="flex items-center gap-2 font-semibold">
                    Type <span className="text-muted">{sortIndicator("type")}</span>
                  </button>
                </th>
                <th className="w-40 px-3 py-2">
                  <button onClick={() => onColumnSort("provider")} className="flex items-center gap-2 font-semibold">
                    Provider <span className="text-muted">{sortIndicator("provider")}</span>
                  </button>
                </th>
                {hasWindowsEvents && (
                  <th className="w-24 px-3 py-2">
                    <button onClick={() => onColumnSort("eventId")} className="flex items-center gap-2 font-semibold">
                      Event ID <span className="text-muted">{sortIndicator("eventId")}</span>
                    </button>
                  </th>
                )}
                <th className="w-24 px-3 py-2">
                  <button onClick={() => onColumnSort("severity")} className="flex items-center gap-2 font-semibold">
                    Severity <span className="text-muted">{sortIndicator("severity")}</span>
                  </button>
                </th>
                <th className="px-3 py-2">
                  <button onClick={() => onColumnSort("message")} className="flex items-center gap-2 font-semibold">
                    Message <span className="text-muted">{sortIndicator("message")}</span>
                  </button>
                </th>
                <th className="w-28 px-3 py-2">
                  <button onClick={() => onColumnSort("source")} className="flex items-center gap-2 font-semibold">
                    Source <span className="text-muted">{sortIndicator("source")}</span>
                  </button>
                </th>
              </tr>
            </thead>
            <tbody className="text-sm">
              {tableEvents.length === 0 && (
                <tr>
                  <td colSpan={tableColumnCount} className="px-3 py-6 text-center text-sm text-muted">
                    {activeTab === "crashes"
                      ? preCrashFocusEnabled
                        ? "No events found in the selected pre-crash window."
                        : "Click Investigate Pre-Crash to show events for the selected crash."
                      : "No events match the current filters."}
                  </td>
                </tr>
              )}
              {tableEvents.length > 0 && virtualRows.topSpacer > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={tableColumnCount} style={{ height: `${virtualRows.topSpacer}px`, padding: 0 }} />
                </tr>
              )}
              {virtualRows.slice.map((event) => (
                <tr
                  key={event.id}
                  style={{ height: `${VIRTUAL_ROW_HEIGHT}px` }}
                  className={cn(
                    "border-b border-panel-border transition hover:bg-white/30",
                    severityTint(event.severity),
                    selected?.id === event.id && "ring-2 ring-accent"
                  )}
                  onClick={() => toggleSelectedEvent(event)}
                >
                  <td className="truncate px-3 py-2 text-xs text-muted">{new Date(event.timestamp).toLocaleString()}</td>
                  <td className="truncate px-3 py-2">
                    {event.logName} / <span className="text-muted">{event.category}</span>
                  </td>
                  <td className="truncate px-3 py-2">{event.provider}</td>
                  {hasWindowsEvents && (
                    <td className="truncate px-3 py-2">{event.eventId ?? "-"}</td>
                  )}
                  <td className="truncate px-3 py-2 capitalize">{event.severity}</td>
                  <td className="truncate px-3 py-2" title={event.message}>{event.message}</td>
                  <td className="truncate px-3 py-2 text-xs text-muted">{event.imported ? "Imported" : "Live/Local"}</td>
                </tr>
              ))}
              {tableEvents.length > 0 && virtualRows.bottomSpacer > 0 && (
                <tr aria-hidden="true">
                  <td colSpan={tableColumnCount} style={{ height: `${virtualRows.bottomSpacer}px`, padding: 0 }} />
                </tr>
              )}
            </tbody>
          </table>
          </section>
        )}
        </div>

        {(activeTab === "events" || activeTab === "crashes") && (
          <footer className={cn(panelClass, "flex flex-wrap items-start justify-between gap-4 px-5 py-4")}> 
          <div className="min-w-[240px] flex-1 space-y-2">
            <div className="text-sm font-semibold">
              Selected event: {selected ? formatSelectedSummary(selected) : "None"}
            </div>
            {!selected && (
              <div className="text-xs text-muted">Select a row to enable actions and see details.</div>
            )}
            {selected && (
              <>
                <div className="grid gap-2 text-xs text-muted sm:grid-cols-2 lg:grid-cols-4">
                  {selectedDetails.map((detail) => (
                    <div key={detail.label} className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted">{detail.label}</div>
                      <div className="text-sm text-text">{detail.value}</div>
                    </div>
                  ))}
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[10px] uppercase tracking-wide text-muted">Message</div>
                    <div className="inline-flex rounded-md border border-panel-border bg-[var(--field-bg)] p-0.5">
                      <button
                        type="button"
                        className={cn(
                          "rounded px-2 py-1 text-[11px] transition",
                          messageViewMode === "raw" ? "bg-accent text-white" : "text-text hover:bg-accent/10"
                        )}
                        onClick={() => setMessageViewMode("raw")}
                      >
                        Raw
                      </button>
                      <button
                        type="button"
                        disabled={selectedEventParsedFields.length === 0}
                        className={cn(
                          "rounded px-2 py-1 text-[11px] transition",
                          messageViewMode === "parsed" ? "bg-accent text-white" : "text-text hover:bg-accent/10",
                          selectedEventParsedFields.length === 0 && "cursor-not-allowed opacity-50 hover:bg-transparent"
                        )}
                        onClick={() => {
                          if (selectedEventParsedFields.length === 0) return;
                          setMessageViewMode("parsed");
                        }}
                      >
                        Parsed
                      </button>
                    </div>
                  </div>
                  {messageViewMode === "raw" ? (
                    <div className="max-h-24 overflow-auto text-sm text-text">{selected.message}</div>
                  ) : selectedEventParsedFields.length > 0 ? (
                    <div className="grid max-h-36 gap-2 overflow-auto sm:grid-cols-2">
                      {selectedEventParsedFields.map((field) => (
                        <div key={`${field.key}-${field.value}`} className="rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-wide text-muted">{field.key}</div>
                          <div className="mt-1 break-all text-sm text-text">{field.value}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-muted">No structured fields detected in this message.</div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setSelected(null)} disabled={!selected}>Clear Selection</Button>
            <Button size="sm" onClick={() => void copySelectedEventText()} disabled={!selected}>
              {copyEventTextStatus === "copied" ? "Text Copied" : "Copy Event Text"}
            </Button>
            <Button size="sm" onClick={() => void openGoogle()} disabled={!selected}>Search Google</Button>
            <Button size="sm" onClick={() => void copyPrompt()} disabled={!selected}>
              {copyStatus === "copied" ? "Prompt Copied" : "Copy LLM Prompt"}
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={openLlmAnalysisWindow}
              disabled={!selected}
            >
              Send To LLM
            </Button>
            <Button
              size="sm"
              onClick={() => selected && void exportEvents("json", [selected], `event-${selected.id}.json`)}
              disabled={!selected}
            >
              Export Event JSON
            </Button>
            <Button
              size="sm"
              onClick={() => selected && void exportEvents("csv", [selected], `event-${selected.id}.csv`)}
              disabled={!selected}
            >
              Export Event CSV
            </Button>
            {copyStatus === "copied" && (
              <span className="text-xs font-semibold text-ok">Prompt copied to clipboard.</span>
            )}
          </div>
          </footer>
        )}

        {llmWindowOpen && selected && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/35 px-4 py-6">
            <div className="flex max-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-panel-border bg-[var(--panel-solid)] shadow-xl">
              <div className="flex items-center justify-between border-b border-panel-border px-4 py-3">
                <div>
                  <div className="text-sm font-semibold">LLM Analysis</div>
                  <div className="text-xs text-muted">
                    Review original vs redacted context side-by-side, then edit prompt before send. `Copy Event Text` remains unredacted.
                  </div>
                </div>
                <Button size="sm" onClick={() => setLlmWindowOpen(false)}>
                  Close
                </Button>
              </div>
              <div className="grid gap-3 overflow-y-auto p-4">
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="text-xs text-muted">
                    Original Event Context (local only, unredacted)
                    <textarea
                      className={cn(inputClass, "min-h-40 resize-y font-mono text-xs")}
                      value={selectedEventOriginalContext}
                      readOnly
                    />
                  </label>
                  <label className="text-xs text-muted">
                    Redacted Event Context Preview
                    <textarea
                      className={cn(inputClass, "min-h-40 resize-y font-mono text-xs")}
                      value={selectedEventRedactedContext}
                      readOnly
                    />
                  </label>
                </div>

                <div className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end">
                  <label className="text-xs text-muted">
                    Target profile
                    <select
                      className={selectClass}
                      value={llmRunProfileId}
                      onChange={(e) => setLlmRunProfileId(e.target.value)}
                    >
                      {llmLocalProfiles.length === 0 && <option value="">No local profiles configured</option>}
                      {llmLocalProfiles.map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} ({profile.provider}, {profile.scope})
                        </option>
                      ))}
                    </select>
                  </label>
                  {(() => {
                    const activeProfile = llmLocalProfiles.find((profile) => profile.id === llmRunProfileId);
                    if (!activeProfile) return null;
                    return (
                      <div className="text-right text-xs text-muted">
                        <div>Provider: {activeProfile.provider}</div>
                        <div>Endpoint: {activeProfile.baseUrl || "Not set"}</div>
                        <div>Model: {activeProfile.model || "Auto-detect"}</div>
                      </div>
                    );
                  })()}
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button size="sm" onClick={rebuildPrompt}>
                      Reset Prompt
                    </Button>
                    <Button size="sm" onClick={togglePromptRedaction}>
                      {llmPromptWasRedacted ? "Remove Redaction" : "Redact Now"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => void copyText(llmPromptDraft)}
                      disabled={!llmPromptDraft.trim()}
                    >
                      Copy Prompt
                    </Button>
                  </div>
                </div>

                <label className="text-xs text-muted">
                  Outbound Prompt (editable before send)
                  <textarea
                    className={cn(inputClass, "min-h-52 resize-y font-mono text-xs")}
                    value={llmPromptDraft}
                    onChange={(e) => onLlmPromptDraftChange(e.target.value)}
                  />
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() => void runLlmAnalysisNow()}
                    disabled={isRunningLlmAnalysis || !llmRunProfileId || !llmPromptDraft.trim()}
                  >
                    {isRunningLlmAnalysis ? "Running..." : "Run Analysis"}
                  </Button>
                  <span className="rounded-md border border-panel-border bg-[var(--field-bg)] px-2 py-1 text-xs font-semibold text-text">
                    {llmPromptWasRedacted
                      ? "Prompt is redacted. Run Analysis sends redacted text."
                      : "Prompt is unredacted. Run Analysis sends it as shown."}
                  </span>
                </div>

                {llmRunError && (
                  <div className="rounded-lg border border-danger bg-danger-bg px-3 py-2 text-xs text-danger">
                    <div className="font-semibold">LLM analysis failed</div>
                    <div className="mt-1 whitespace-pre-wrap">{llmRunError}</div>
                    {llmGuardrailBlock && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={() => void sendLlmAnalysisOnceAnyway()}
                          disabled={isRunningLlmAnalysis}
                        >
                          Send Once Anyway
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void trustGuardrailHostAndRun()}
                          disabled={isRunningLlmAnalysis}
                        >
                          Trust Host and Send
                        </Button>
                      </div>
                    )}
                  </div>
                )}

                {llmRunResult && (
                  <div className="rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2 text-xs text-muted">
                    <div className="font-semibold text-text">
                      Response from {llmRunResult.profileName} ({llmRunResult.model})
                    </div>
                    {llmRunResult.warning && (
                      <div className="mt-1 rounded-md border border-panel-border bg-[var(--sev-warning)] px-2 py-1 text-xs font-semibold text-text">
                        {llmRunResult.warning}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid gap-2 text-xs text-muted">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>Troubleshooting Guide</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-md border border-panel-border bg-[var(--field-bg)] p-0.5">
                        <button
                          type="button"
                          className={cn(
                            "rounded px-2 py-1 text-xs transition",
                            llmResponseViewMode === "guide"
                              ? "bg-accent text-white"
                              : "text-text hover:bg-accent/10"
                          )}
                          onClick={() => setLlmResponseViewMode("guide")}
                        >
                          Guide
                        </button>
                        <button
                          type="button"
                          className={cn(
                            "rounded px-2 py-1 text-xs transition",
                            llmResponseViewMode === "raw"
                              ? "bg-accent text-white"
                              : "text-text hover:bg-accent/10"
                          )}
                          onClick={() => setLlmResponseViewMode("raw")}
                        >
                          Raw
                        </button>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void copyLlmGuideNow()}
                        disabled={!llmRunResult}
                      >
                        Copy Guide
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void exportLlmGuideTextNow()}
                        disabled={!llmRunResult}
                      >
                        Export TXT
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void exportLlmGuideHtmlNow()}
                        disabled={!llmRunResult}
                      >
                        Export HTML (PDF-ready)
                      </Button>
                    </div>
                  </div>
                  {llmResponseViewMode === "raw" ? (
                    <textarea
                      className={cn(inputClass, "max-h-[45vh] min-h-52 resize-y font-mono text-xs")}
                      value={llmRunResult?.response ?? ""}
                      readOnly
                    />
                  ) : (
                    <div className="max-h-[45vh] min-h-52 overflow-y-auto rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2 text-sm text-text">
                      {!llmRunResult ? (
                        <p className="text-muted">No response yet. Run analysis to generate a guide.</p>
                      ) : (
                      <div className="space-y-3">
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">1) Summary</div>
                          <p className="mt-1">{llmParsedGuide.summary}</p>
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">2) Likely Causes</div>
                          {llmParsedGuide.likelyCauses.length > 0 ? (
                            <ul className="mt-1 ml-5 list-disc space-y-1">
                              {llmParsedGuide.likelyCauses.map((item, index) => (
                                <li key={`guide-cause-${index}`}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-muted">Not provided.</p>
                          )}
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">3) Risk Level</div>
                          <p className="mt-1">{llmParsedGuide.riskLevel}</p>
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">4) Security Impact</div>
                          <p className="mt-1">{llmParsedGuide.securityImpact}</p>
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">5) Verify First</div>
                          {llmParsedGuide.verifyFirst.length > 0 ? (
                            <ul className="mt-1 ml-5 list-disc space-y-1">
                              {llmParsedGuide.verifyFirst.map((item, index) => (
                                <li key={`guide-verify-${index}`}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-muted">Not provided.</p>
                          )}
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">6) Remediation Options</div>
                          {llmParsedGuide.remediationOptions.length > 0 ? (
                            <ul className="mt-1 ml-5 list-disc space-y-1">
                              {llmParsedGuide.remediationOptions.map((item, index) => (
                                <li key={`guide-remediate-${index}`}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-muted">Not provided.</p>
                          )}
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">7) Escalate If</div>
                          {llmParsedGuide.escalateIf.length > 0 ? (
                            <ul className="mt-1 ml-5 list-disc space-y-1">
                              {llmParsedGuide.escalateIf.map((item, index) => (
                                <li key={`guide-escalate-${index}`}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-muted">Not provided.</p>
                          )}
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">8) Confidence</div>
                          <p className="mt-1">{llmParsedGuide.confidence}</p>
                        </section>
                        <section>
                          <div className="text-xs font-semibold uppercase tracking-wide text-muted">9) Missing Data</div>
                          {llmParsedGuide.missingData.length > 0 ? (
                            <ul className="mt-1 ml-5 list-disc space-y-1">
                              {llmParsedGuide.missingData.map((item, index) => (
                                <li key={`guide-missing-${index}`}>{item}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-muted">Not provided.</p>
                          )}
                        </section>
                      </div>
                      )}
                    </div>
                  )}
                  <span className="text-[11px]">
                    `Export HTML (PDF-ready)` creates a clean report file you can open in a browser and print to PDF.
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const helpSectionToTopicMap: Record<HelpSectionId, HelpTopicId> = {
  "quick-start": "getting-started",
  "filters": "events",
  "ingest-vs-backfill": "data",
  "coverage-warning": "data",
  "crash-flow": "crashes",
  "export-prompt": "export",
  "settings-collection": "settings-llm"
};

const helpTopics: HelpTopic[] = [
  {
    id: "getting-started",
    label: "Getting Started",
    summary: "First-time workflow to move from app launch to useful findings quickly.",
    sections: [
      {
        id: "first-ten-minutes",
        title: "First 10 Minutes",
        paragraphs: [
          "Hermes works best when you treat it as a workflow: collect logs, confirm coverage, narrow with filters, then investigate details.",
          "The top row tabs are your main navigation. Most analysis starts in Data and Events, then moves to Crashes or Export as needed."
        ],
        steps: [
          "Click Refresh Logs to collect live host logs into local cache.",
          "Open Data and verify the current cache date range covers the incident window you care about.",
          "Open Events and apply filters (date range, severity, provider, log type).",
          "Select an event row and use bottom actions (search, prompt, export, send to LLM).",
          "Use Export for shareable reports or filtered subsets."
        ]
      },
      {
        id: "what-this-tool-is",
        title: "What Hermes Is and Is Not",
        paragraphs: [
          "Hermes is a host-centric investigation workspace. It is optimized for live log triage, crash correlation, and actionable exports.",
          "It is not a SIEM replacement and does not perform remote endpoint management in this release."
        ]
      }
    ]
  },
  {
    id: "navigation",
    label: "Navigation & Layout",
    summary: "How to move through screens and interpret shared UI patterns.",
    sections: [
      {
        id: "top-bar",
        title: "Top Actions",
        paragraphs: [
          "Refresh Logs runs host collection and updates local cache.",
          "Help opens this guide. Exit closes the app."
        ]
      },
      {
        id: "tab-row",
        title: "Main Tabs",
        paragraphs: [
          "Home: high-level cache/health snapshot and recent events.",
          "Events: detailed log table and filter workflow.",
          "Crashes: crash records plus pre-crash/correlated event analysis.",
          "Data: ingest window and explicit range-load controls.",
          "Import/Export: file-based ingest and guided output.",
          "Settings: collection and LLM provider configuration."
        ]
      },
      {
        id: "status-banners",
        title: "Status Banners",
        paragraphs: [
          "Error banners indicate failures that need action.",
          "Warning banners indicate partial success (for example, collector warnings).",
          "Green status banners indicate successful operations."
        ]
      }
    ]
  },
  {
    id: "home",
    label: "Home Dashboard",
    summary: "Understand current cache health and jump into analysis with context.",
    sections: [
      {
        id: "cards",
        title: "Dashboard Cards",
        paragraphs: [
          "Local Cache card shows number of collected events and date coverage in local memory.",
          "Imported Session Data card shows additional imported records merged into current session views.",
          "Crash Records card summarizes crash count and pre-crash focus status."
        ]
      },
      {
        id: "recent-events",
        title: "Recent Events List",
        paragraphs: [
          "Recent events provide a quick anomaly scan immediately after refresh.",
          "Clicking a recent event opens it in Events with that row selected for deeper analysis."
        ]
      }
    ]
  },
  {
    id: "events",
    label: "Events",
    summary: "Primary event triage workspace with filters, sorting, selection, and actions.",
    sections: [
      {
        id: "filters-usage",
        title: "Filters and Apply Model",
        paragraphs: [
          "Filter inputs are draft values until Apply Filters is clicked.",
          "Reset Inputs clears draft filter controls. Apply Filters updates the active event table."
        ],
        tips: [
          "Use date filters first to keep result sets focused.",
          "Provider/source and Event ID are high-signal narrowing controls on noisy systems."
        ]
      },
      {
        id: "table-usage",
        title: "Event Table and Selection",
        paragraphs: [
          "Click column headers to sort; click rows to select/deselect.",
          "Selected row details appear in the bottom panel with quick investigation/export actions."
        ]
      },
      {
        id: "event-actions",
        title: "Bottom Action Bar",
        paragraphs: [
          "Copy Event Text copies original event message (unredacted).",
          "Search Google and Copy LLM Prompt use redaction rules.",
          "Send To LLM opens an analysis window with side-by-side original context and redacted outbound prompt editing."
        ]
      }
    ]
  },
  {
    id: "crashes",
    label: "Crashes",
    summary: "Crash-to-log correlation to identify probable lead-up conditions.",
    sections: [
      {
        id: "import-crashes",
        title: "Crash Import and Selection",
        paragraphs: [
          "Import Host Crashes loads crash records from host sources and stores them locally.",
          "Select a crash to inspect metadata and load related events."
        ]
      },
      {
        id: "pre-crash",
        title: "Pre-Crash Investigation",
        paragraphs: [
          "Investigate Pre-Crash narrows results to events in the selected pre-crash time window.",
          "If strict window results are empty, Hermes can show correlated fallback events from a wider crash window."
        ]
      },
      {
        id: "triage-pattern",
        title: "Recommended Crash Triage Pattern",
        steps: [
          "Import crashes and select one crash entry.",
          "Run pre-crash investigation with a short window first (5-15 minutes).",
          "Inspect warning/error spikes and repeated providers.",
          "Use row actions to build external searches or LLM-assisted analysis.",
          "Export selected evidence for handoff."
        ],
        paragraphs: []
      }
    ]
  },
  {
    id: "data",
    label: "Data Collection",
    summary: "Control what period is collected by default and when to perform explicit historical loads.",
    sections: [
      {
        id: "ingest-window",
        title: "Ingest Window (Rolling)",
        paragraphs: [
          "Ingest Window (days) defines the rolling default range used by Save & Sync and Refresh flows.",
          "Use this for normal daily operation where recent events are most important."
        ]
      },
      {
        id: "backfill-range",
        title: "Backfill / Explicit Range Load",
        paragraphs: [
          "Backfill Range is a one-time exact period loader for investigations outside current coverage.",
          "Load Events fetches that exact span and updates local cache view for analysis."
        ],
        tips: [
          "Use backfill when a date warning appears in Events.",
          "Prefer narrow date ranges first for faster turnaround."
        ]
      }
    ]
  },
  {
    id: "import",
    label: "Import",
    summary: "Merge external JSON/CSV event files into the current session.",
    sections: [
      {
        id: "supported",
        title: "Supported Import Use",
        paragraphs: [
          "Import accepts JSON/CSV event files and merges them into in-memory session data.",
          "Imported data appears together with local data in analysis views."
        ]
      },
      {
        id: "import-notes",
        title: "Operational Notes",
        paragraphs: [
          "Imported memory is capped for stability; large imports may be truncated in active memory view.",
          "Use exports to persist analysis subsets after combining imported and local records."
        ]
      }
    ]
  },
  {
    id: "export",
    label: "Export",
    summary: "Create reproducible evidence packages from loaded or custom-filtered event sets.",
    sections: [
      {
        id: "export-scope",
        title: "Export Scopes",
        paragraphs: [
          "Loaded scope exports exactly what is currently in session.",
          "Custom scope exports records matching wizard criteria (date, severity, type, category, source)."
        ]
      },
      {
        id: "formats",
        title: "Formats and Usage",
        paragraphs: [
          "JSON is best for machine processing and re-import.",
          "CSV is best for spreadsheets and quick sorting.",
          "TXT is best for narrative or ticket attachments."
        ]
      },
      {
        id: "export-workflow",
        title: "Export Workflow",
        steps: [
          "Pick scope and format.",
          "Review preview counts and explanatory text.",
          "Run export and choose save location in dialog.",
          "Attach output to incident/ticket or team handoff."
        ],
        paragraphs: []
      }
    ]
  },
  {
    id: "settings-llm",
    label: "Settings & LLM",
    summary: "Configure collection behavior, local/cloud profiles, testing, and safe analysis routing.",
    sections: [
      {
        id: "collection-settings",
        title: "Collection Settings",
        paragraphs: [
          "Auto-sync on startup controls whether log collection runs automatically at launch.",
          "Max events per sync limits per-run collector volume.",
          "On Windows, selectable channels define which event logs are collected."
        ]
      },
      {
        id: "profiles",
        title: "LLM Profiles and Priority",
        paragraphs: [
          "Profiles let you store provider-specific endpoints/models and enabled state.",
          "Default profile is primary. Global backup profile is used as fallback when primary is unavailable."
        ],
        tips: [
          "Use Test Connection before running analysis.",
          "For local providers, apply detected endpoint results directly into a selected profile."
        ]
      },
      {
        id: "network-discovery",
        title: "Network Discovery",
        paragraphs: [
          "Detect Local Providers probes localhost defaults for Ollama and LM Studio.",
          "LAN scan can search selected interface subnet for provider endpoints when enabled."
        ]
      },
      {
        id: "key-security",
        title: "API Keys and Secret Storage",
        paragraphs: [
          "API keys are stored in OS keychain rather than plain settings files.",
          "Profile key status shows whether a key is configured; clear/remove is supported per profile."
        ]
      }
    ]
  },
  {
    id: "security",
    label: "Privacy & Security",
    summary: "Understand redaction rules, trusted-host controls, and safe operational boundaries.",
    sections: [
      {
        id: "redaction-model",
        title: "Redaction Model",
        paragraphs: [
          "Google search and LLM prompt paths redact sensitive values with `<sensitive info redacted>`.",
          "Send To LLM window shows original local context and redacted outbound prompt so users can review before send."
        ]
      },
      {
        id: "trusted-hosts",
        title: "Trusted Host Policy",
        paragraphs: [
          "Trusted LAN hosts list identifies allowed internal endpoints for safer analysis routing.",
          "When strict setting is enabled, Hermes warns when outbound target host is not trusted."
        ]
      },
      {
        id: "safety-practices",
        title: "Recommended Safety Practices",
        steps: [
          "Keep auto-redact enabled unless you have a controlled exception process.",
          "Use local profiles for sensitive incidents whenever possible.",
          "Review prompt text before send and remove anything unnecessary.",
          "Export minimal evidence needed for the receiving audience."
        ],
        paragraphs: []
      }
    ]
  },
  {
    id: "troubleshooting",
    label: "Troubleshooting",
    summary: "Common issues, likely causes, and fastest next actions.",
    sections: [
      {
        id: "no-events",
        title: "No Events After Refresh",
        paragraphs: [
          "Check OS permissions and collector access to log sources.",
          "Increase ingest window, then refresh again.",
          "Review warning banners for partial-collection errors."
        ]
      },
      {
        id: "date-warning",
        title: "Date Coverage Warning in Events",
        paragraphs: [
          "Your active filters request dates outside loaded cache.",
          "Use Data tab to load explicit range, then re-apply filters."
        ]
      },
      {
        id: "llm-fail",
        title: "LLM Connection or Analysis Fails",
        paragraphs: [
          "Run Test Connection first to validate endpoint and model discovery.",
          "Confirm selected profile is enabled and API key is set when required.",
          "Verify local service is running and base URL/port is reachable."
        ]
      },
      {
        id: "help-not-opening",
        title: "Help Menu Item Does Not Open",
        paragraphs: [
          "Use header Help button as immediate fallback.",
          "If Tools > Help fails after update, relaunch app to ensure latest build is loaded."
        ]
      }
    ]
  }
];
