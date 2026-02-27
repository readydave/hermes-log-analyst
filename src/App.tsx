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
  isTauriRuntime,
  openExternalUrl,
  quitApp,
  refreshLocalEvents,
  syncLocalEventsRange,
  getLocalEventsRange,
  getIngestProfile,
  setIngestProfile,
  getIngestWindowDays,
  setIngestWindowDays
} from "./lib/backend";
import type { IngestProfile, SyncOperationResult } from "./lib/backend";
import { exportAsCsv, exportAsJson, exportAsText } from "./lib/export";
import { applyFilters, defaultFilters } from "./lib/filters";
import { importSessionEvents } from "./lib/import";
import { buildGoogleQuery, buildLlmPrompt } from "./lib/llmPrompt";
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

type SortDirection = "asc" | "desc";
type SortColumn = "timestamp" | "type" | "provider" | "eventId" | "severity" | "message" | "source";

interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

type WorkspaceTab = "home" | "events" | "crashes" | "data" | "import" | "export" | "settings" | "help";
type ExportScope = "loaded" | "custom";
type HelpSectionId =
  | "quick-start"
  | "filters"
  | "ingest-vs-backfill"
  | "coverage-warning"
  | "crash-flow"
  | "export-prompt"
  | "settings-collection";

interface WorkspaceTabDescriptor {
  id: Exclude<WorkspaceTab, "help">;
  label: string;
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

function formatExportTimestamp(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
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

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [hostOs, setHostOs] = useState<SupportedOs>(browserDefaultOs);
  const [hostOsVersion, setHostOsVersion] = useState<string>("Unknown");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("home");
  const [helpTabOpen, setHelpTabOpen] = useState(false);
  const [pendingHelpSection, setPendingHelpSection] = useState<HelpSectionId | null>(null);
  const [highlightedHelpSection, setHighlightedHelpSection] = useState<HelpSectionId | null>(null);
  const [filterDraft, setFilterDraft] = useState<EventFilters>(createDefaultFilters);
  const [activeFilters, setActiveFilters] = useState<EventFilters>(createDefaultFilters);
  const [localEvents, setLocalEvents] = useState<NormalizedEvent[]>([]);
  const [importedEvents, setImportedEvents] = useState<NormalizedEvent[]>([]);
  const [crashes, setCrashes] = useState<CrashRecord[]>([]);
  const [selectedCrashId, setSelectedCrashId] = useState<string>("");
  const [correlatedEvents, setCorrelatedEvents] = useState<NormalizedEvent[]>([]);
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
    windowsChannels: ["Application", "System", "Security"]
  });
  const [backfillFrom, setBackfillFrom] = useState("");
  const [backfillTo, setBackfillTo] = useState("");
  const [rangeViewActive, setRangeViewActive] = useState(false);
  const [rangeLoadMessage, setRangeLoadMessage] = useState<string>("");
  const [isRangeLoading, setIsRangeLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string>("");
  const [collectorWarning, setCollectorWarning] = useState<string>("");
  const [memoryNotice, setMemoryNotice] = useState<string>("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [copyEventTextStatus, setCopyEventTextStatus] = useState<"idle" | "copied">("idle");
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
  const preCrashFocus = useMemo(() => {
    if (!preCrashFocusEnabled) return null;
    const crash = crashes.find((entry) => entry.id === selectedCrashId);
    if (!crash) return null;
    const crashTime = Date.parse(crash.timestamp);
    if (!Number.isFinite(crashTime)) return null;
    return {
      start: crashTime - preCrashWindowMinutes * 60 * 1000,
      end: crashTime,
      os: crash.os
    };
  }, [preCrashFocusEnabled, preCrashWindowMinutes, crashes, selectedCrashId]);
  const crashFocusEvents = useMemo(() => {
    if (!preCrashFocus) return [];
    return allEvents.filter((event) => {
      const eventTime = Date.parse(event.timestamp);
      if (!Number.isFinite(eventTime)) return false;
      if (event.os !== preCrashFocus.os) return false;
      return eventTime >= preCrashFocus.start && eventTime <= preCrashFocus.end;
    });
  }, [allEvents, preCrashFocus]);
  const visibleEvents = useMemo(() => sortEvents(filtered, sortState), [filtered, sortState]);
  const crashVisibleEvents = useMemo(() => sortEvents(crashFocusEvents, sortState), [crashFocusEvents, sortState]);
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
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [hostOsEventPool]);
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
  const filterGridClass = hasWindowsEvents
    ? "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_0.9fr_0.9fr_1fr]"
    : "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_0.9fr_0.9fr_1fr]";

  function applyCollectorWarnings(context: string, result: SyncOperationResult): void {
    if (result.warnings.length === 0) {
      setCollectorWarning("");
      return;
    }

    const preview = result.warnings.slice(0, 2).join(" ");
    const suffix = result.warnings.length > 2
      ? ` (+${result.warnings.length - 2} more; see diagnostics logs.)`
      : " (see diagnostics logs).";
    setCollectorWarning(`${context}: ${preview}${suffix}`);
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

    void (async () => {
      try {
        if (isTauriRuntime()) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const offWindow = await getCurrentWindow().listen<string>("hla://theme-changed", (event) => {
            onTheme(event.payload);
          });
          unlisteners.push(offWindow);
        }

        const { listen } = await import("@tauri-apps/api/event");
        const offApp = await listen<string>("hla://theme-changed", (event) => {
          onTheme(event.payload);
        });
        unlisteners.push(offApp);
        const offHelp = await listen<string | null>("hla://open-help", (event) => {
          onOpenHelp(event.payload);
        });
        unlisteners.push(offHelp);
      } catch {
        // Ignore when Tauri event bridge is unavailable.
      }
    })();

    return () => {
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
    if (activeTab !== "help" || !pendingHelpSection) return;
    const targetId = `help-${pendingHelpSection}`;
    window.requestAnimationFrame(() => {
      const node = document.getElementById(targetId);
      if (node) {
        node.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    setPendingHelpSection(null);
  }, [activeTab, pendingHelpSection]);

  useEffect(() => {
    if (!highlightedHelpSection) return;
    const timeoutId = window.setTimeout(() => {
      setHighlightedHelpSection((current) => (current === highlightedHelpSection ? null : current));
    }, 1800);
    return () => window.clearTimeout(timeoutId);
  }, [highlightedHelpSection]);

  useEffect(() => {
    setCopyEventTextStatus("idle");
  }, [selected?.id]);

  async function initialize(): Promise<void> {
    setIsLoading(true);
    setLastError("");
    setCollectorWarning("");

    try {
      const os = await getHostOs();
      setHostOs(os);
      const version = await getHostOsVersion().catch(() => "Unknown (not provided by host)");
      setHostOsVersion(version);
      setIngestWindowDaysState(await getIngestWindowDays());
      const profile = await getIngestProfile();
      setIngestProfileState(profile);
      if (profile.autoSyncOnStartup) {
        const syncResult = await refreshLocalEvents();
        applyCollectorWarnings("Startup sync warning", syncResult);
      }
      const collected = await getLocalEvents(LOCAL_FETCH_LIMIT);
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

    try {
      const result = await refreshLocalEvents();
      applyCollectorWarnings("Refresh warning", result);
      applyLocalEventsCache(await getLocalEvents(LOCAL_FETCH_LIMIT), "Refresh load");
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
    const records = await getCrashes();
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
      const count = await importHostCrashes(300);
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
    const outsideCoverage =
      !localCoverage || windowStart < localCoverage.start || windowEnd > localCoverage.end;

    if (outsideCoverage) {
      const from = formatDateInputValue(windowStart);
      const to = formatDateInputValue(windowEnd);
      setBackfillFrom(from);
      setBackfillTo(to);
      const loaded = await loadEventsForResolvedRange(from, to, {
        applyToFilters: false,
        contextLabel: "Crash pre-window load"
      });
      if (!loaded) {
        return;
      }
      try {
        setCorrelatedEvents(await getCrashRelatedEvents(selectedCrash.id, 15, 250));
      } catch (error) {
        setLastError(error instanceof Error ? error.message : "Failed to refresh correlated events after loading crash range.");
        return;
      }
    }

    setLastError("");
    setPreCrashFocusEnabled(true);
  }

  function clearPreCrashFocus(): void {
    setPreCrashFocusEnabled(false);
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
        windowsChannels: channels
      });
      setIngestProfileState(saved);
      setExportStatus("Collection settings saved.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to save collection settings.");
    }
  }


  async function saveIngestWindow(): Promise<void> {
    setLastError("");
    try {
      const days = Math.max(1, Math.min(365, Math.floor(ingestWindowDays)));
      const saved = await setIngestWindowDays(days);
      setIngestWindowDaysState(saved);
      const syncResult = await refreshLocalEvents();
      applyCollectorWarnings("Sync warning", syncResult);
      applyLocalEventsCache(await getLocalEvents(LOCAL_FETCH_LIMIT), "Sync load");
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
    setRangeLoadMessage(`Loading events for ${normalized.from} to ${normalized.to}...`);
    setIsRangeLoading(true);
    try {
      const syncResult = await syncLocalEventsRange(normalized.from, normalized.to, false);
      applyCollectorWarnings(`${contextLabel} warning`, syncResult);
      const events = await getLocalEventsRange(normalized.from, normalized.to, LOCAL_FETCH_LIMIT);
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

  async function loadEventsForRange(): Promise<void> {
    if (!backfillFrom || !backfillTo) {
      setLastError("Range actions require both From and To dates.");
      return;
    }
    await loadEventsForResolvedRange(backfillFrom, backfillTo, {
      applyToFilters: true,
      contextLabel: "Range load"
    });
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
    setPendingHelpSection(section);
    setHighlightedHelpSection(section);
    setActiveTab("help");
  }

  function closeHelpTab(): void {
    setHelpTabOpen(false);
    setPendingHelpSection(null);
    setHighlightedHelpSection(null);
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
        {collectorWarning && (
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
            <div className="grid gap-3 text-sm">
              <div
                id="help-quick-start"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "quick-start" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Quick Start</div>
                <p className="mt-2 text-xs text-muted">
                  1) Click Refresh Logs. 2) Open Data to confirm local coverage dates. 3) Go to Events and apply filters.
                </p>
              </div>
              <div
                id="help-filters"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "filters" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Events Filters</div>
                <p className="mt-2 text-xs text-muted">
                  Filters are applied only when you click Apply Filters. They narrow the currently loaded local/imported events.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Example: Set From 2026-02-22 and To 2026-02-27, check Error + Critical, enter provider "krusader", then click Apply Filters.
                </p>
              </div>
              <div
                id="help-ingest-vs-backfill"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "ingest-vs-backfill" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Ingest Window vs Backfill Range</div>
                <p className="mt-2 text-xs text-muted">
                  Ingest Window is your rolling default sync (for example, 7 = now minus 7 days through now when you Save & Sync).
                  Backfill Range is a one-time exact date span for investigations (Load Events fetches only that range).
                </p>
                <p className="mt-2 text-xs text-muted">
                  Example: Set ingest to 7 for daily operations. For an incident on 2026-01-15, set backfill 2026-01-14 to 2026-01-16 and click Load Events.
                </p>
              </div>
              <div
                id="help-coverage-warning"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "coverage-warning" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Why You See Date Coverage Warnings</div>
                <p className="mt-2 text-xs text-muted">
                  Filters only run against logs currently in local cache. If your filter dates are older/newer than local coverage, the warning appears.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Example: Coverage is 2/27/2026 only, but Filters From is 2/08/2026. Load that older range in Data first, then re-apply filters.
                </p>
              </div>
              <div
                id="help-crash-flow"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "crash-flow" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Crash Correlation Flow</div>
                <p className="mt-2 text-xs text-muted">
                  In Crashes, import host crashes, select one, then Investigate Pre-Crash to narrow events to the minutes before the crash.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Use correlated event chips to jump to suspicious events, then use the bottom action bar in Crashes to search/export/copy prompts.
                </p>
              </div>
              <div
                id="help-export-prompt"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "export-prompt" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Export & Prompt</div>
                <p className="mt-2 text-xs text-muted">
                  In Events or Crashes, select an event row and use the bottom action bar to copy an LLM prompt, open a Google search, or export the selected event.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Use the Export tab for guided exports (loaded list or custom range/severity/category/source), then choose JSON/CSV/TXT and save location.
                </p>
              </div>
              <div
                id="help-settings-collection"
                className={cn(
                  "rounded-lg border border-panel-border bg-[var(--field-bg)] p-3",
                  highlightedHelpSection === "settings-collection" && "ring-2 ring-accent"
                )}
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-muted">Settings & Collection</div>
                <p className="mt-2 text-xs text-muted">
                  Collection settings control startup sync behavior and max events per sync.
                </p>
                <p className="mt-2 text-xs text-muted">
                  Example: Enable Auto-sync on startup, set Max events per sync to 5000, and save. Use Data for older ranges and Export for save-dialog exports.
                </p>
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
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => setActiveTab("events")}>Open Events</Button>
              <Button size="sm" onClick={() => setActiveTab("crashes")}>Open Crashes</Button>
              <Button size="sm" onClick={() => setActiveTab("data")}>Open Data</Button>
              <Button size="sm" onClick={() => setActiveTab("import")}>Open Import</Button>
              <Button size="sm" onClick={() => setActiveTab("export")}>Open Export</Button>
              <Button size="sm" onClick={() => openHelpTab("quick-start")}>Open Help</Button>
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
                  onChange={(e) => setIngestWindowDaysState(Number(e.target.value))}
                />
                <Button size="sm" variant="primary" onClick={() => void saveIngestWindow()}>
                  Save & Sync
                </Button>
                <div className="w-full text-[11px] text-muted">
                  Rolling default window. `Save & Sync` loads logs from now minus N days through now.
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
                      blurDateInputIfComplete(e.currentTarget);
                    }}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" onClick={() => void loadEventsForRange()} disabled={isRangeLoading}>
                  {isRangeLoading ? "Loading Events..." : "Load Events"}
                </Button>
              </div>
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
                  <div className="text-[10px] uppercase tracking-wide text-muted">Message</div>
                  <div className="max-h-24 overflow-auto text-sm text-text">{selected.message}</div>
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
      </div>
    </div>
  );
}
