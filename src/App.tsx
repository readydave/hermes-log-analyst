import { useEffect, useMemo, useState } from "react";
import {
  chooseExportDirectory,
  importHostCrashes,
  exportEventsToFile,
  getCrashRelatedEvents,
  getCrashes,
  getExportDirectory,
  getHostOs,
  getHostOsVersion,
  getLocalEvents,
  getSavedTheme,
  isTauriRuntime,
  openExternalUrl,
  quitApp,
  refreshLocalEvents,
  setExportDirectory,
  syncLocalEventsRange,
  getLocalEventsRange,
  getIngestProfile,
  setIngestProfile,
  getIngestWindowDays,
  setIngestWindowDays
} from "./lib/backend";
import type { IngestProfile } from "./lib/backend";
import { exportAsCsv, exportAsJson } from "./lib/export";
import { applyFilters, defaultFilters } from "./lib/filters";
import { importSessionEvents } from "./lib/import";
import { buildGoogleQuery, buildLlmPrompt } from "./lib/llmPrompt";
import { cn } from "./lib/cn";
import { Button } from "./components/Button";
import type { CrashRecord, EventFilters, NormalizedEvent, SupportedOs, ThemeMode } from "./types/events";

const browserDefaultOs: SupportedOs = navigator.userAgent.includes("Windows")
  ? "windows"
  : navigator.userAgent.includes("Mac")
    ? "macos"
    : "linux";

const windowsChannelOptions = ["Application", "System", "Security"] as const;

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

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [hostOs, setHostOs] = useState<SupportedOs>(browserDefaultOs);
  const [hostOsVersion, setHostOsVersion] = useState<string>("Unknown");
  const [filterDraft, setFilterDraft] = useState<EventFilters>(createDefaultFilters);
  const [activeFilters, setActiveFilters] = useState<EventFilters>(createDefaultFilters);
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [crashCollapsed, setCrashCollapsed] = useState(false);
  const [filtersCollapsed, setFiltersCollapsed] = useState(false);
  const [dataCollapsed, setDataCollapsed] = useState(true);
  const [localEvents, setLocalEvents] = useState<NormalizedEvent[]>([]);
  const [importedEvents, setImportedEvents] = useState<NormalizedEvent[]>([]);
  const [crashes, setCrashes] = useState<CrashRecord[]>([]);
  const [selectedCrashId, setSelectedCrashId] = useState<string>("");
  const [correlatedEvents, setCorrelatedEvents] = useState<NormalizedEvent[]>([]);
  const [preCrashWindowMinutes, setPreCrashWindowMinutes] = useState<number>(15);
  const [preCrashFocusEnabled, setPreCrashFocusEnabled] = useState(false);
  const [selected, setSelected] = useState<NormalizedEvent | null>(null);
  const [sortState, setSortState] = useState<SortState | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exportDirectory, setExportDirectoryState] = useState<string | null>(null);
  const [ingestWindowDays, setIngestWindowDaysState] = useState<number>(7);
  const [ingestProfile, setIngestProfileState] = useState<IngestProfile>({
    autoSyncOnStartup: true,
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
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [exportStatus, setExportStatus] = useState<string>("");

  document.documentElement.dataset.theme = theme;

  const mergedEvents = useMemo(() => [...importedEvents, ...localEvents], [importedEvents, localEvents]);
  const filtered = useMemo(() => applyFilters(mergedEvents, activeFilters), [mergedEvents, activeFilters]);
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
  const eventListInput = useMemo(() => {
    if (!preCrashFocus) return filtered;

    return filtered.filter((event) => {
      const eventTime = Date.parse(event.timestamp);
      if (!Number.isFinite(eventTime)) return false;
      if (event.os !== preCrashFocus.os) return false;
      return eventTime >= preCrashFocus.start && eventTime <= preCrashFocus.end;
    });
  }, [filtered, preCrashFocus]);
  const visibleEvents = useMemo(() => sortEvents(eventListInput, sortState), [eventListInput, sortState]);
  const hasWindowsEvents = useMemo(
    () => mergedEvents.some((event) => event.os === "windows"),
    [mergedEvents]
  );
  const logTypes = useMemo(() => {
    const values = new Set<string>();
    for (const event of mergedEvents) {
      if (event.logName.trim()) values.add(event.logName);
    }
    return Array.from(values).sort((left, right) => left.localeCompare(right));
  }, [mergedEvents]);
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
      return `Active date filters are outside local coverage (${formatLocalDate(localCoverage.start)} - ${formatLocalDate(localCoverage.end)}).`;
    }

    const startsBefore = start !== null && start < localCoverage.start;
    const endsAfter = end !== null && end > localCoverage.end;
    if (startsBefore || endsAfter) {
      return `Active date filters extend beyond local coverage (${formatLocalDate(localCoverage.start)} - ${formatLocalDate(localCoverage.end)}). Results may be incomplete.`;
    }

    return "";
  }, [activeFilters.dateFrom, activeFilters.dateTo, localCoverage]);
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

  const panelClass = "rounded-2xl border border-panel-border bg-panel backdrop-blur-xl shadow-glass";
  const inputClass = "h-9 w-full rounded-lg border border-panel-border bg-transparent px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-accent/50";
  const selectClass = `${inputClass} pr-8`;
  const filterGridClass = hasWindowsEvents
    ? "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_1fr_0.9fr_0.9fr_1fr]"
    : "grid gap-2 lg:grid-cols-[1.35fr_1fr_1fr_0.9fr_0.9fr_1fr]";

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
    const unlisteners: Array<() => void> = [];
    const onTheme = (mode: string) => {
      if (mode === "system" || mode === "light" || mode === "dark") {
        setTheme(mode);
      }
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

  async function initialize(): Promise<void> {
    setIsLoading(true);
    setLastError("");

    try {
      const os = await getHostOs();
      setHostOs(os);
      const version = await getHostOsVersion().catch(() => "Unknown (not provided by host)");
      setHostOsVersion(version);
      setExportDirectoryState(await getExportDirectory());
      setIngestWindowDaysState(await getIngestWindowDays());
      const profile = await getIngestProfile();
      setIngestProfileState(profile);
      if (profile.autoSyncOnStartup) {
        await refreshLocalEvents();
      }
      const collected = await getLocalEvents(50000);
      if (collected.length > 0) setLocalEvents(collected);
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
      await refreshLocalEvents();
      setLocalEvents(await getLocalEvents(50000));
      setRangeViewActive(false);
      setRangeLoadMessage("");
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

  function applyPreCrashFocus(): void {
    if (!selectedCrash) {
      setLastError("Select a crash first to focus pre-crash events.");
      return;
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

  async function onImport(fileList: FileList | null): Promise<void> {
    const file = fileList?.[0];
    if (!file) return;

    try {
      const imported = await importSessionEvents(file, hostOs);
      setImportedEvents((prev) => [...imported, ...prev]);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Import failed");
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

  function toggleAllPanels(): void {
    const collapse = !(crashCollapsed && filtersCollapsed && dataCollapsed);
    setCrashCollapsed(collapse);
    setFiltersCollapsed(collapse);
    setDataCollapsed(collapse);
  }

  function toggleSelectedEvent(event: NormalizedEvent): void {
    setSelected((current) => (current?.id === event.id ? null : event));
  }

  function sortIndicator(column: SortColumn): string {
    if (!sortState || sortState.column !== column) return "↕";
    return sortState.direction === "asc" ? "↑" : "↓";
  }

  async function chooseExportFolder(): Promise<void> {
    setLastError("");
    try {
      const selectedPath = await chooseExportDirectory();
      if (!selectedPath) return;
      setExportDirectoryState(selectedPath);
      setExportStatus(`Export folder saved: ${selectedPath}`);
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to choose export folder.");
    }
  }

  async function clearExportFolder(): Promise<void> {
    setLastError("");
    try {
      await setExportDirectory(null);
      setExportDirectoryState(null);
      setExportStatus("Export folder cleared. Using default Downloads.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to clear export folder.");
    }
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
      await refreshLocalEvents();
      setLocalEvents(await getLocalEvents(50000));
      setRangeViewActive(false);
      setRangeLoadMessage("");
      setExportStatus(`Ingest window set to ${saved} days and synced.`);
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

  async function loadEventsForRange(): Promise<void> {
    if (!backfillFrom || !backfillTo) {
      setLastError("Range actions require both From and To dates.");
      return;
    }

    const normalized = normalizeDateRange(backfillFrom, backfillTo);
    setLastError("");
    setRangeLoadMessage(`Loading events for ${normalized.from} to ${normalized.to}...`);
    setIsRangeLoading(true);
    try {
      await syncLocalEventsRange(normalized.from, normalized.to, false);
      const events = await getLocalEventsRange(normalized.from, normalized.to);
      setLocalEvents(events);
      applyViewDateRange(normalized.from, normalized.to);
      setRangeLoadMessage(`Data loaded and ready: ${events.length.toLocaleString()} events in range.`);
      setExportStatus(`Data loaded and ready for ${normalized.from} to ${normalized.to}.`);
      window.setTimeout(() => setExportStatus(""), 3000);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to load selected range.");
      setRangeLoadMessage("");
    } finally {
      setIsRangeLoading(false);
    }
  }

  async function exportEvents(format: "json" | "csv", events: NormalizedEvent[], filename: string): Promise<void> {
    setLastError("");
    try {
      if (isTauriRuntime()) {
        const location = await exportEventsToFile(format, filename, events);
        setExportStatus(`Exported to ${location}`);
        window.setTimeout(() => setExportStatus(""), 2500);
        return;
      }

      if (format === "json") {
        exportAsJson(events, filename);
      } else {
        exportAsCsv(events, filename);
      }
      setExportStatus("Export complete.");
      window.setTimeout(() => setExportStatus(""), 2500);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to export events.");
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
            <label className="text-sm text-muted">
              <span className="mr-2">Import</span>
              <input className={cn(inputClass, "w-56 text-xs")} type="file" accept=".json,.csv" onChange={(e) => void onImport(e.target.files)} />
            </label>
            <Button variant="primary" onClick={() => void refreshNow()} disabled={isLoading}>
              {isLoading ? "Refreshing..." : "Refresh Logs"}
            </Button>
            <Button onClick={() => void exportEvents("json", visibleEvents, "hermes-events.json")}>Export JSON</Button>
            <Button onClick={() => void exportEvents("csv", visibleEvents, "hermes-events.csv")}>Export CSV</Button>
            <Button onClick={() => setSettingsOpen((prev) => !prev)}>
              {settingsOpen ? "Hide Settings" : "Settings"}
            </Button>
            <Button variant="danger" onClick={() => void quitApp()}>Exit</Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {lastError && (
          <div className={cn(panelClass, "border-danger text-danger")}>{lastError}</div>
        )}
        {exportStatus && (
          <div className={cn(panelClass, "border-ok text-ok")}>{exportStatus}</div>
        )}

        {settingsOpen && (
          <section className={cn(panelClass, "space-y-4 px-5 py-4")}> 
            <div className="text-sm font-semibold">Settings</div>
            <div className="grid gap-2">
              <label className="text-xs text-muted">Export Folder</label>
              <input className={inputClass} value={exportDirectory ?? "Downloads (default)"} readOnly />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void chooseExportFolder()}>Choose Folder</Button>
                <Button onClick={() => void clearExportFolder()}>Use Downloads Default</Button>
              </div>
            </div>
            <div className="grid gap-3 border-t border-panel-border pt-3">
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

        <section className={cn(panelClass, "space-y-4 px-5 py-4")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold">Analysis Panels</div>
            <div className="flex flex-wrap items-center gap-2">
              {!controlsCollapsed && (
                <Button size="sm" onClick={toggleAllPanels}>
                  {crashCollapsed && filtersCollapsed && dataCollapsed ? "Expand All Panels" : "Collapse All Panels"}
                </Button>
              )}
              <Button size="sm" onClick={() => setControlsCollapsed((prev) => !prev)}>
                {controlsCollapsed ? "Show Panels" : "Hide Panels"}
              </Button>
            </div>
          </div>

          {controlsCollapsed ? (
            <div className="text-xs text-muted">
              Crash Correlation, Filters, and Data Window are hidden to maximize event list space.
            </div>
          ) : (
            <div className="space-y-3">
              <section className="rounded-xl border border-panel-border/70 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Crash Correlation</div>
                  <Button size="sm" onClick={() => setCrashCollapsed((prev) => !prev)}>
                    {crashCollapsed ? "Show Crash Panel" : "Hide Crash Panel"}
                  </Button>
                </div>

                {!crashCollapsed && (
                  <div className="mt-3 space-y-3">
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
                      <Button size="sm" variant="primary" onClick={applyPreCrashFocus} disabled={!selectedCrash}>
                        Investigate Pre-Crash
                      </Button>
                      <Button size="sm" onClick={clearPreCrashFocus} disabled={!preCrashFocusEnabled}>
                        Clear Pre-Crash View
                      </Button>
                      {preCrashFocusEnabled && selectedCrash && (
                        <span className="text-xs text-muted">
                          Showing events in the {preCrashWindowMinutes} minutes before the selected crash.
                        </span>
                      )}
                    </div>

                    {selectedCrash && correlatedEvents.length > 0 && (
                      <div className="flex flex-wrap gap-2 border-t border-panel-border pt-3">
                        <div className="w-full text-sm font-semibold">Top Correlated Events</div>
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
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-panel-border/70 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm font-semibold">Filters</div>
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <span>{hasPendingFilterChanges ? "Changes not applied" : "Applied"}</span>
                    <Button size="sm" onClick={() => setFiltersCollapsed((prev) => !prev)}>
                      {filtersCollapsed ? "Show Filters" : "Hide Filters"}
                    </Button>
                  </div>
                </div>

                {!filtersCollapsed && (
                  <div className="mt-3 space-y-3">
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
                      <label className="text-xs text-muted">
                        From
                        <input className={inputClass} type="date" value={filterDraft.dateFrom} onChange={(e) => updateFilter("dateFrom", e.target.value)} />
                      </label>
                      <label className="text-xs text-muted">
                        To
                        <input className={inputClass} type="date" value={filterDraft.dateTo} onChange={(e) => updateFilter("dateTo", e.target.value)} />
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
                        {activeDateCoverageWarning}
                      </div>
                    )}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-panel-border/70 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Data Window</div>
                  <Button size="sm" onClick={() => setDataCollapsed((prev) => !prev)}>
                    {dataCollapsed ? "Show Data" : "Hide Data"}
                  </Button>
                </div>
                <p className="mt-2 text-xs text-muted">{localCoverageSummary}</p>

                {!dataCollapsed && (
                  <div className="mt-3 space-y-3">
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
                      </div>
                    </div>
                    <div className="grid gap-2">
                      <label className="text-xs text-muted">Backfill Range</label>
                      <div className="grid gap-2 md:grid-cols-2">
                        <input className={inputClass} type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)} />
                        <input className={inputClass} type="date" value={backfillTo} onChange={(e) => setBackfillTo(e.target.value)} />
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
                  </div>
                )}
              </section>
            </div>
          )}
        </section>

        <section className={cn(panelClass, "flex flex-wrap items-center justify-between gap-3 px-5 py-3")}> 
          <Button size="sm" onClick={resetSort} disabled={!sortState}>Reset Sort</Button>
          {sortState && (
            <span className="text-xs text-muted">Sorted by {sortLabels[sortState.column]} ({sortState.direction})</span>
          )}
        </section>

        <section className={cn(panelClass, "overflow-auto")}> 
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
              {visibleEvents.length === 0 && (
                <tr>
                  <td colSpan={hasWindowsEvents ? 7 : 6} className="px-3 py-6 text-center text-sm text-muted">
                    No events match the current filters.
                  </td>
                </tr>
              )}
              {visibleEvents.map((event) => (
                <tr
                  key={event.id}
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
            </tbody>
          </table>
        </section>
        </div>

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
      </div>
    </div>
  );
}
