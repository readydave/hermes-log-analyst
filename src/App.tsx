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
  listLlmNetworkInterfaces
} from "./lib/backend";
import type {
  IngestProfile,
  LlmAnalysisResult,
  LlmConnectionProfile,
  LlmConnectionTestResult,
  LlmEndpointCandidate,
  LlmNetworkInterface,
  LlmSettings,
  SyncOperationResult
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
type LlmResponseViewMode = "formatted" | "markdown";
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
  const [helpTabOpen, setHelpTabOpen] = useState(false);
  const [activeHelpTopic, setActiveHelpTopic] = useState<HelpTopicId>("getting-started");
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
  const [rangeViewActive, setRangeViewActive] = useState(false);
  const [rangeLoadMessage, setRangeLoadMessage] = useState<string>("");
  const [isRangeLoading, setIsRangeLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [lastError, setLastError] = useState<string>("");
  const [collectorWarning, setCollectorWarning] = useState<string>("");
  const [memoryNotice, setMemoryNotice] = useState<string>("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied">("idle");
  const [copyEventTextStatus, setCopyEventTextStatus] = useState<"idle" | "copied">("idle");
  const [llmWindowOpen, setLlmWindowOpen] = useState(false);
  const [llmPromptDraft, setLlmPromptDraft] = useState("");
  const [llmAutoRedactBeforeSend, setLlmAutoRedactBeforeSend] = useState(true);
  const [llmRunProfileId, setLlmRunProfileId] = useState("");
  const [llmRunResult, setLlmRunResult] = useState<LlmAnalysisResult | null>(null);
  const [llmResponseViewMode, setLlmResponseViewMode] = useState<LlmResponseViewMode>("formatted");
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
    setCollectorWarning("");

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

  function openLlmAnalysisWindow(): void {
    if (!selected) return;
    const prompt = buildLlmPrompt(selected, hostOsVersion);
    const preferredProfileId =
      llmLocalProfiles.find((profile) => profile.id === llmSettings.defaultProfileId)?.id ??
      llmLocalProfiles[0]?.id ??
      "";

    setLlmPromptDraft(prompt);
    setLlmAutoRedactBeforeSend(true);
    setLlmRunProfileId(preferredProfileId);
    setLlmRunResult(null);
    setLlmResponseViewMode("formatted");
    setLlmWindowOpen(true);
  }

  function rebuildRedactedPrompt(): void {
    if (!selected) return;
    setLlmPromptDraft(buildLlmPrompt(selected, hostOsVersion));
    setExportStatus("Prompt reset using redacted event context.");
    window.setTimeout(() => setExportStatus(""), 2000);
  }

  function redactPromptNow(): void {
    setLlmPromptDraft((current) => redactSensitiveText(current));
    setExportStatus("Prompt redaction applied.");
    window.setTimeout(() => setExportStatus(""), 2000);
  }

  async function runLlmAnalysisNow(): Promise<void> {
    if (!selected) return;
    if (!llmRunProfileId) {
      setLastError("No local LLM profile is selected.");
      return;
    }
    const outboundPrompt = (
      llmAutoRedactBeforeSend ? redactSensitiveText(llmPromptDraft) : llmPromptDraft
    ).trim();
    if (!outboundPrompt) {
      setLastError("LLM prompt is empty.");
      return;
    }
    if (llmAutoRedactBeforeSend && outboundPrompt !== llmPromptDraft) {
      setLlmPromptDraft(outboundPrompt);
    }

    setLastError("");
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
      setLastError(error instanceof Error ? error.message : "Failed to run local LLM analysis.");
    } finally {
      setIsRunningLlmAnalysis(false);
    }
  }

  async function copyLlmResponseNow(): Promise<void> {
    if (!llmRunResult?.response.trim()) return;
    setLastError("");
    try {
      await copyText(llmRunResult.response);
      setExportStatus("Analysis response copied.");
      window.setTimeout(() => setExportStatus(""), 2000);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to copy analysis response.");
    }
  }

  async function copyLlmContextAndResponseNow(): Promise<void> {
    if (!llmRunResult) return;
    setLastError("");
    try {
      const promptForShare = redactSensitiveText(llmPromptDraft);
      const bundle = buildLlmShareBundle(selectedEventRedactedContext, promptForShare, llmRunResult);
      await copyText(bundle);
      setExportStatus("Redacted context + response copied.");
      window.setTimeout(() => setExportStatus(""), 2200);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to copy context and response.");
    }
  }

  async function saveLlmContextAndResponseNow(): Promise<void> {
    if (!llmRunResult) return;
    setLastError("");
    try {
      const promptForShare = redactSensitiveText(llmPromptDraft);
      const bundle = buildLlmShareBundle(selectedEventRedactedContext, promptForShare, llmRunResult);
      const filename = `llm-analysis-${formatExportTimestamp()}.txt`;
      const location = await saveTextWithDialog(filename, bundle);
      if (!location) {
        setExportStatus("Save canceled.");
        window.setTimeout(() => setExportStatus(""), 2000);
        return;
      }
      setExportStatus(`Saved context + response to ${location}`);
      window.setTimeout(() => setExportStatus(""), 2600);
    } catch (error) {
      setLastError(error instanceof Error ? error.message : "Failed to save context and response.");
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
      updateLlmProfile(llmSelectedProfile.id, {
        provider: nextProvider,
        scope: defaultScope,
        baseUrl: !currentUrl || currentUrl === currentDefault ? nextDefault : currentUrl
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
      name: `${providerLabel(provider)} ${scope === "local" ? "Local" : scope === "cloud" ? "Cloud" : "Generic"}`,
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
    const nextProfile: LlmConnectionProfile = {
      ...llmSelectedProfile,
      provider: nextProvider,
      scope: mappedScope,
      baseUrl: candidate.endpoint,
      enabled: true
    };
    updateLlmProfile(llmSelectedProfile.id, {
      provider: nextProvider,
      scope: mappedScope,
      baseUrl: candidate.endpoint,
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
      if (result.ok && result.detectedModels.length > 0 && !profile.model.trim()) {
        const autoModel = result.detectedModels[0];
        updateLlmProfile(profile.id, { model: autoModel });
        setExportStatus(`${result.message} Auto-selected model: ${autoModel}.`);
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
            <div className="w-full max-w-5xl rounded-xl border border-panel-border bg-[var(--panel-solid)] shadow-xl">
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
              <div className="grid gap-3 p-4">
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
                    Target local profile
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
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <Button size="sm" onClick={rebuildRedactedPrompt}>
                      Reset Prompt
                    </Button>
                    <Button size="sm" onClick={redactPromptNow}>
                      Redact Now
                    </Button>
                    <label className="inline-flex items-center gap-2 whitespace-nowrap text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={llmAutoRedactBeforeSend}
                        onChange={(e) => setLlmAutoRedactBeforeSend(e.target.checked)}
                      />
                      Auto-redact prompt before send (recommended)
                    </label>
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
                    onChange={(e) => setLlmPromptDraft(e.target.value)}
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
                  {!llmAutoRedactBeforeSend && (
                    <span className="rounded-md border border-panel-border bg-[var(--sev-warning)] px-2 py-1 text-xs font-semibold text-text">
                      Auto-redaction is off. Prompt will be sent exactly as written.
                    </span>
                  )}
                </div>

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
                    <span>Analysis Response</span>
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="inline-flex rounded-md border border-panel-border bg-[var(--field-bg)] p-0.5">
                        <button
                          type="button"
                          className={cn(
                            "rounded px-2 py-1 text-xs transition",
                            llmResponseViewMode === "formatted"
                              ? "bg-accent text-white"
                              : "text-text hover:bg-accent/10"
                          )}
                          onClick={() => setLlmResponseViewMode("formatted")}
                        >
                          Formatted
                        </button>
                        <button
                          type="button"
                          className={cn(
                            "rounded px-2 py-1 text-xs transition",
                            llmResponseViewMode === "markdown"
                              ? "bg-accent text-white"
                              : "text-text hover:bg-accent/10"
                          )}
                          onClick={() => setLlmResponseViewMode("markdown")}
                        >
                          Markdown
                        </button>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => void copyLlmResponseNow()}
                        disabled={!llmRunResult?.response.trim()}
                      >
                        Copy Response
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void copyLlmContextAndResponseNow()}
                        disabled={!llmRunResult}
                      >
                        Copy Context + Response
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void saveLlmContextAndResponseNow()}
                        disabled={!llmRunResult}
                      >
                        Save Context + Response
                      </Button>
                    </div>
                  </div>
                  {llmResponseViewMode === "markdown" ? (
                    <textarea
                      className={cn(inputClass, "min-h-52 resize-y font-mono text-xs")}
                      value={llmRunResult?.response ?? ""}
                      readOnly
                    />
                  ) : (
                    <div className="min-h-52 overflow-auto rounded-lg border border-panel-border bg-[var(--field-bg)] px-3 py-2">
                      {renderMarkdownPreview(llmRunResult?.response ?? "")}
                    </div>
                  )}
                  <span className="text-[11px]">
                    Context + response copy/save uses redacted event context and redacted prompt for safer sharing.
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
